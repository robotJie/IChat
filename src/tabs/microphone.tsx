import { useEffect, useRef, useState } from "react"
import { createI18n } from "../lib/i18n-core"
import { MICROPHONE_CONSTRAINTS } from "../lib/audio-recording"
import "../components/ichat.css"

// A regular extension tab can show the permission prompt when a side panel cannot.
export default function MicrophonePermissionPage() {
  const { t } = createI18n(new URLSearchParams(location.search).get("lang") === "zh-CN" ? "zh-CN" : "en")
  const [status, setStatus] = useState<"idle" | "waiting" | "ready" | "failed">("idle")
  const mountedRef = useRef(false)
  const [testStatus, setTestStatus] = useState<"idle" | "waiting" | "listening" | "sound" | "quiet" | "failed">("idle")
  const [device, setDevice] = useState("")
  const [level, setLevel] = useState(0)
  const testRef = useRef<{ stop: () => void } | null>(null)
  useEffect(() => {
    mountedRef.current = true
    const onPageHide = () => { mountedRef.current = false; testRef.current?.stop() }
    const onVisibility = () => { if (document.visibilityState === "hidden") testRef.current?.stop() }
    window.addEventListener("pagehide", onPageHide)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      mountedRef.current = false
      testRef.current?.stop()
      window.removeEventListener("pagehide", onPageHide)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  const requestMicrophone = async () => {
    setStatus("waiting")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // This page only grants access; it never records or transcribes audio.
      stream.getTracks().forEach((track) => track.stop())
      if (mountedRef.current) setStatus("ready")
    } catch {
      if (mountedRef.current) setStatus("failed")
    }
  }

  const testMicrophone = async () => {
    if (testRef.current) return
    setTestStatus("waiting")
    setDevice("")
    setLevel(0)
    let context: AudioContext | undefined
    let stream: MediaStream | undefined
    let interval: ReturnType<typeof setInterval> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let heardSound = false
    const session = { stop: () => {
      clearInterval(interval)
      clearTimeout(timeout)
      stream?.getTracks().forEach((track) => track.stop())
      if (context && context.state !== "closed") void context.close().catch(() => {})
      if (testRef.current !== session) return
      testRef.current = null
      if (mountedRef.current) {
        setLevel(0)
        setTestStatus(heardSound ? "sound" : "quiet")
      }
    } }
    testRef.current = session
    try {
      context = new AudioContext()
      await context.resume()
      if (testRef.current !== session) return
      stream = await navigator.mediaDevices.getUserMedia({ audio: MICROPHONE_CONSTRAINTS })
      if (testRef.current !== session) { stream.getTracks().forEach((track) => track.stop()); return }
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      context.createMediaStreamSource(stream).connect(analyser)
      // No speaker connection, recording, or network request: only measure local signal level.
      const samples = new Float32Array(analyser.fftSize)
      setDevice(stream.getAudioTracks()[0]?.label || t("chat.dictation.test.defaultDevice"))
      setTestStatus("listening")
      interval = setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
        if (rms > 0.001) heardSound = true
        setLevel(Math.min(100, rms * 1000))
      }, 100)
      timeout = setTimeout(session.stop, 10000)
    } catch {
      const active = testRef.current === session
      session.stop()
      if (active && mountedRef.current) setTestStatus("failed")
    }
  }

  return (
    <main className="ichat-microphone-page">
      <h1>{t("chat.dictation.permission.title")}</h1>
      <p>{t("chat.dictation.permission.description")}</p>
      <p>{t("chat.dictation.permission.privacy")}</p>
      <p>{t("chat.dictation.permission.scope")}</p>
      <button className="ichat-primary-button" type="button" disabled={status === "waiting" || status === "ready" || testStatus === "waiting" || testStatus === "listening"} onClick={() => void requestMicrophone()}>
        {t("chat.dictation.permission.open")}
      </button>
      <p role="status">{status !== "idle" ? t(`chat.dictation.permission.${status}`) : null}</p>
      <hr />
      <h2>{t("chat.dictation.test.title")}</h2>
      <p>{t("chat.dictation.test.description")}</p>
      <button className="ichat-primary-button" type="button" disabled={status === "waiting" || testStatus === "waiting"} onClick={() => testStatus === "listening" ? testRef.current?.stop() : void testMicrophone()}>
        {t(testStatus === "listening" ? "chat.dictation.test.stop" : "chat.dictation.test.start")}
      </button>
      {device ? <p>{t("chat.dictation.test.device")}: {device}</p> : null}
      <meter aria-label={t("chat.dictation.test.level")} min={0} max={100} value={level} style={{ width: "100%", height: 24 }} />
      <p role="status">{testStatus !== "idle" ? t(`chat.dictation.test.${testStatus}`) : null}</p>
      <p>{t("chat.dictation.test.settings")} <code>chrome://settings/content/microphone</code></p>
    </main>
  )
}
