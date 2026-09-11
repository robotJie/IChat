import { useCallback, useEffect, useRef, useState } from "react"
import { startAudioRecording, type AudioRecording } from "./audio-recording"
import { MAX_RECORDING_SECONDS, SttServiceError, transcribeFunAsr, type SttServiceErrorCode } from "./fun-asr"
import type { SttProviderId } from "./types"
import { transcribeMoss } from "./moss-stt"

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
type DictationPhase = "idle" | "starting" | "listening" | "stopping" | "recording" | "transcribing"
export type DictationError = "unsupported" | "permission" | "microphone" | "failed" | SttServiceErrorCode

interface CloudSession {
  provider: Exclude<SttProviderId, "chrome">
  controller: AbortController
  recording?: AudioRecording
  finishing: boolean
  apiKey: string
  language: string
  apply: (text: string) => string
}

function getRecognitionConstructor() {
  const speechWindow = window as Window & {
    SpeechRecognition?: RecognitionConstructor
    webkitSpeechRecognition?: RecognitionConstructor
  }
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
}

export function useDictation(lang: string, onText: (text: string) => void, provider: SttProviderId = "chrome", apiKey = "") {
  const [phase, setPhase] = useState<DictationPhase>("idle")
  const [error, setError] = useState<DictationError | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const recognitionRef = useRef<Recognition | null>(null)
  const cloudRef = useRef<CloudSession | null>(null)
  const stopRequestedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onTextRef = useRef(onText)
  const completedTextRef = useRef<string | null>(null)
  const completionRef = useRef<((text: string | null) => void) | null>(null)
  onTextRef.current = onText

  const release = useCallback(() => {
    completionRef.current?.(null)
    completionRef.current = null
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    const cloud = cloudRef.current
    cloudRef.current = null
    cloud?.controller.abort()
    cloud?.recording?.cancel()
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

  const complete = useCallback((text: string | null) => {
    const resolve = completionRef.current
    completionRef.current = null
    cancel()
    resolve?.(text)
  }, [cancel])

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

  useEffect(() => {
    cancel()
    setError(null)
    setErrorDetails(null)
  }, [provider, apiKey, lang, cancel])

  const finishCloud = useCallback(async () => {
    const session = cloudRef.current
    if (!session) return
    if (!session.recording || session.finishing) {
      cancel()
      return
    }
    session.finishing = true
    setPhase("transcribing")
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setError("timeout")
      cancel()
    }, 45000)
    try {
      const audio = await session.recording.stop()
      const transcript = session.provider === "moss"
        ? await transcribeMoss(audio, session.apiKey, session.controller.signal)
        : await transcribeFunAsr(audio, session.apiKey, session.language, session.controller.signal)
      if (cloudRef.current !== session) return
      complete(session.apply(transcript))
    } catch (error) {
      if (cloudRef.current !== session) return
      setError(error instanceof SttServiceError ? error.code : "failed")
      setErrorDetails(error instanceof SttServiceError ? error.details ?? null : null)
      cancel()
    }
  }, [cancel, complete])

  const start = useCallback((text: string, selectionStart = text.length, selectionEnd = selectionStart) => {
    if (recognitionRef.current || cloudRef.current) return
    setError(null)
    setErrorDetails(null)
    completedTextRef.current = null
    const before = text.slice(0, selectionStart)
    const after = text.slice(selectionEnd)
    const apply = (transcript: string) => {
      if (!transcript) return text
      const leftSpace = /[a-z0-9]$/i.test(before) && /^[a-z0-9]/i.test(transcript) ? " " : ""
      const rightSpace = /[a-z0-9]$/i.test(transcript) && /^[a-z0-9]/i.test(after) ? " " : ""
      const merged = `${before}${leftSpace}${transcript}${rightSpace}${after}`
      onTextRef.current(merged)
      return merged
    }
    if (provider !== "chrome") {
      if (!apiKey.trim()) {
        setError("apiKey")
        return
      }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        setError("unsupported")
        return
      }
      const session: CloudSession = { provider, controller: new AbortController(), finishing: false, apiKey, language: lang, apply }
      cloudRef.current = session
      setPhase("starting")
      timerRef.current = setTimeout(() => {
        setError("timeout")
        cancel()
      }, 15000)
      void startAudioRecording(session.controller.signal, () => {
        if (cloudRef.current !== session) return
        setError("microphone")
        cancel()
      }).then((recording) => {
        if (cloudRef.current !== session) {
          recording.cancel()
          return
        }
        session.recording = recording
        if (timerRef.current) clearTimeout(timerRef.current)
        setPhase("recording")
        timerRef.current = setTimeout(() => void finishCloud(), MAX_RECORDING_SECONDS * 1000)
      }).catch((error: unknown) => {
        if (cloudRef.current !== session) return
        const name = error instanceof DOMException ? error.name : ""
        setError(name === "NotAllowedError" || name === "SecurityError" ? "permission" : "microphone")
        cancel()
      })
      return
    }
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
        completedTextRef.current = transcript.trim() ? apply(transcript) : null
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
      recognition.onend = () => {
        if (completionRef.current && completedTextRef.current === null) setError("noSpeech")
        complete(completedTextRef.current)
      }
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
  }, [apiKey, cancel, complete, finishCloud, lang, provider])

  const stop = useCallback(() => {
    if (cloudRef.current) {
      void finishCloud()
      return
    }
    const recognition = recognitionRef.current
    if (!recognition || stopRequestedRef.current) return
    stopRequestedRef.current = true
    setPhase("stopping")
    if (timerRef.current) clearTimeout(timerRef.current)
    // Allow the final result to arrive before making the draft editable/sendable.
    timerRef.current = setTimeout(() => {
      if (completionRef.current) setError("timeout")
      cancel()
    }, 2000)
    try {
      recognition.stop()
    } catch {
      cancel()
    }
  }, [cancel, finishCloud])

  const stopAndGetText = useCallback((): Promise<string | null> => {
    if (completionRef.current || (!cloudRef.current?.recording && !recognitionRef.current)) return Promise.resolve(null)
    return new Promise((resolve) => {
      completionRef.current = resolve
      stop()
    })
  }, [stop])

  return { phase, active: phase !== "idle", error, errorDetails, start, stop, stopAndGetText, cancel }
}
