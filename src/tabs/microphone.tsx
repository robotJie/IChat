import { useEffect, useRef, useState } from "react"
import { createI18n } from "../lib/i18n-core"
import "../components/ichat.css"

// A regular extension tab can show the permission prompt when a side panel cannot.
export default function MicrophonePermissionPage() {
  const { t } = createI18n(new URLSearchParams(location.search).get("lang") === "zh-CN" ? "zh-CN" : "en")
  const [status, setStatus] = useState<"idle" | "waiting" | "ready" | "failed">("idle")
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    const onPageHide = () => { mountedRef.current = false }
    window.addEventListener("pagehide", onPageHide)
    return () => {
      mountedRef.current = false
      window.removeEventListener("pagehide", onPageHide)
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

  return (
    <main className="ichat-microphone-page">
      <h1>{t("chat.dictation.permission.title")}</h1>
      <p>{t("chat.dictation.permission.description")}</p>
      <p>{t("chat.dictation.permission.privacy")}</p>
      <button className="ichat-primary-button" type="button" disabled={status === "waiting" || status === "ready"} onClick={() => void requestMicrophone()}>
        {t("chat.dictation.permission.open")}
      </button>
      <p role="status">{status !== "idle" ? t(`chat.dictation.permission.${status}`) : null}</p>
    </main>
  )
}
