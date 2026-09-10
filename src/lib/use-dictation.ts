import { useCallback, useEffect, useRef, useState } from "react"

// Web Speech is still prefixed in Chrome and is not included in lib.dom.
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  start(): void
  stop(): void
  abort(): void
}

type RecognitionConstructor = new () => Recognition
type DictationPhase = "idle" | "starting" | "listening" | "stopping"
export type DictationError = "unsupported" | "permission" | "network" | "microphone" | "noSpeech" | "failed"

function getRecognitionConstructor() {
  const speechWindow = window as Window & {
    SpeechRecognition?: RecognitionConstructor
    webkitSpeechRecognition?: RecognitionConstructor
  }
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
}

export function useDictation(lang: string, onText: (text: string) => void) {
  const [phase, setPhase] = useState<DictationPhase>("idle")
  const [error, setError] = useState<DictationError | null>(null)
  const recognitionRef = useRef<Recognition | null>(null)
  const stopRequestedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const release = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    const recognition = recognitionRef.current
    recognitionRef.current = null
    if (recognition) {
      recognition.onstart = recognition.onend = recognition.onerror = recognition.onresult = null
      try { recognition.abort() } catch { /* The service may already be closed. */ }
    }
  }, [])

  const cancel = useCallback(() => {
    release()
    setPhase("idle")
  }, [release])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") cancel()
    }
    window.addEventListener("pagehide", cancel)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener("pagehide", cancel)
      document.removeEventListener("visibilitychange", onVisibilityChange)
      release()
    }
  }, [cancel, release])

  const start = useCallback((text: string, selectionStart = text.length, selectionEnd = selectionStart) => {
    if (recognitionRef.current) return
    setError(null)
    const Constructor = getRecognitionConstructor()
    if (!Constructor) {
      setError("unsupported")
      return
    }

    try {
      const recognition = new Constructor()
      recognitionRef.current = recognition
      stopRequestedRef.current = false
      recognition.lang = lang
      recognition.continuous = true
      recognition.interimResults = true
      const before = text.slice(0, selectionStart)
      const after = text.slice(selectionEnd)
      setPhase("starting")

      recognition.onstart = () => {
        if (stopRequestedRef.current) return
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = null
        setPhase((current) => current === "starting" ? "listening" : current)
      }
      recognition.onresult = (event) => {
        // Rebuild the session text: interim hypotheses replace each other.
        // Keep the original draft/selection untouched until speech is received.
        const transcript = Array.from(event.results, (result) => result[0]?.transcript ?? "").join("")
        if (!transcript) return
        const leftSpace = /[a-z0-9]$/i.test(before) && /^[a-z0-9]/i.test(transcript) ? " " : ""
        const rightSpace = /[a-z0-9]$/i.test(transcript) && /^[a-z0-9]/i.test(after) ? " " : ""
        onTextRef.current(`${before}${leftSpace}${transcript}${rightSpace}${after}`)
      }
      recognition.onerror = (event) => {
        const errors: Record<string, DictationError> = {
          "not-allowed": "permission",
          "service-not-allowed": "permission",
          "audio-capture": "microphone",
          "no-speech": "noSpeech",
          network: "network"
        }
        if (event.error !== "aborted") setError(errors[event.error] ?? "failed")
        cancel()
      }
      recognition.onend = cancel
      // A dismissed permission prompt or stalled service must not lock the draft.
      timerRef.current = setTimeout(() => {
        setError("failed")
        cancel()
      }, 15000)
      recognition.start()
    } catch {
      setError("failed")
      cancel()
    }
  }, [cancel, lang])

  const stop = useCallback(() => {
    const recognition = recognitionRef.current
    if (!recognition) return
    stopRequestedRef.current = true
    setPhase("stopping")
    if (timerRef.current) clearTimeout(timerRef.current)
    // Allow the final result to arrive before making the draft editable/sendable.
    timerRef.current = setTimeout(cancel, 2000)
    try {
      recognition.stop()
    } catch {
      cancel()
    }
  }, [cancel])

  return { phase, active: phase !== "idle", error, start, stop, cancel }
}
