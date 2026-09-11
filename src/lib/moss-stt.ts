import { SttServiceError } from "./fun-asr"

export const MOSS_STT_MODEL = "moss-transcribe-1.0"
export const MOSS_STT_ENDPOINT = "https://api.mosi.cn/v1/audio/transcriptions"

export async function transcribeMoss(audio: Blob, apiKey: string, signal: AbortSignal): Promise<string> {
  if (!apiKey.trim()) throw new SttServiceError("apiKey")
  // The shared recorder caps input at three minutes; keep a matching upload guard.
  if (audio.size > 7_000_000) throw new SttServiceError("audioTooLarge")
  signal.throwIfAborted()
  const form = new FormData()
  form.append("model", MOSS_STT_MODEL)
  form.append("response_format", "json")
  form.append("file", audio, "dictation.wav")
  let response: Response
  try {
    response = await fetch(MOSS_STT_ENDPOINT, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal,
      // The browser adds Content-Type with the multipart boundary.
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      body: form
    })
  } catch {
    signal.throwIfAborted()
    throw new SttServiceError("network")
  }
  let body: { text?: unknown; request_id?: unknown; error?: { code?: unknown; type?: unknown } } | null = null
  try { body = await response.json() } catch { signal.throwIfAborted() }
  signal.throwIfAborted()
  // Raw error messages may echo request data. Show only safe diagnostic identifiers.
  const identifier = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) && !value.includes(apiKey.trim()) && !/sk-/i.test(value) ? value : undefined
  const code = identifier(body?.error?.code)
  const requestId = identifier(body?.request_id) ?? identifier(response.headers.get("x-request-id"))
  const details = [`HTTP ${response.status}`, code ?? identifier(body?.error?.type), requestId ? `Request ID: ${requestId}` : undefined].filter(Boolean).join(" · ")
  if (response.status === 401 || response.status === 403) throw new SttServiceError("unauthorized", details)
  if (response.status === 402 || response.status === 429) throw new SttServiceError("quota", details)
  if (!response.ok) throw new SttServiceError(response.status >= 500 ? "network" : "rejected", details)
  if (body?.error) throw new SttServiceError("rejected", details)
  if (typeof body?.text !== "string") throw new SttServiceError("invalidResponse", details)
  const text = body.text.trim()
  if (!text) throw new SttServiceError("noSpeech", details)
  return text
}
