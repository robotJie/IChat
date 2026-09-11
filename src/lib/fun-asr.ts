export const FUN_ASR_MODEL = "fun-asr-flash-2026-06-15"
export const FUN_ASR_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
export const MAX_RECORDING_SECONDS = 180

export type SttServiceErrorCode = "apiKey" | "unauthorized" | "quota" | "timeout" | "rejected" | "invalidResponse" | "audioTooLarge" | "noSpeech" | "network"

export class SttServiceError extends Error {
  constructor(public code: SttServiceErrorCode, public details?: string) {
    super(code)
    this.name = "SttServiceError"
  }
}

export async function transcribeFunAsr(audio: Blob, apiKey: string, language: string, signal: AbortSignal): Promise<string> {
  if (!apiKey.trim()) throw new SttServiceError("apiKey")
  // Leave room for the data URI and request envelope below the API's 10 MB limit.
  if (audio.size > 7_000_000) throw new SttServiceError("audioTooLarge")
  const bytes = new Uint8Array(await audio.arrayBuffer())
  signal.throwIfAborted()
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  let response: Response
  try {
    response = await fetch(FUN_ASR_ENDPOINT, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "disable"
      },
      body: JSON.stringify({
        model: FUN_ASR_MODEL,
        input: { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: `data:audio/wav;base64,${btoa(binary)}` } }] }] },
        parameters: { format: "wav", sample_rate: "16000", language_hints: [language.startsWith("zh") ? "zh" : "en"] }
      })
    })
  } catch (error) {
    signal.throwIfAborted()
    throw new SttServiceError("network")
  }
  let body: { code?: unknown; message?: unknown; request_id?: unknown; output?: { text?: unknown } } | null = null
  try {
    body = await response.json()
  } catch {
    signal.throwIfAborted()
  }
  signal.throwIfAborted()
  // Only expose diagnostic identifiers, never raw messages that may echo audio or keys.
  const identifier = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) && !value.includes(apiKey.trim()) && !/sk-/i.test(value) ? value : undefined
  const providerCode = identifier(body?.code)
  const requestId = identifier(body?.request_id) ?? identifier(response.headers.get("x-request-id"))
  // Fun-ASR reports an empty recognition as a client error, including for valid silent WAVs.
  const noWords = body?.message === "ASR_RESPONSE_HAVE_NO_WORDS"
  const details = [`HTTP ${response.status}`, providerCode, noWords ? "ASR_RESPONSE_HAVE_NO_WORDS" : undefined, requestId ? `Request ID: ${requestId}` : undefined].filter(Boolean).join(" · ")
  if (response.status === 401 || response.status === 403) throw new SttServiceError("unauthorized", details)
  if (response.status === 402 || response.status === 429) throw new SttServiceError("quota", details)
  if ((response.status === 400 || response.ok) && noWords) throw new SttServiceError("noSpeech", details)
  if (!response.ok) throw new SttServiceError(response.status >= 500 ? "network" : "rejected", details)
  if (body?.code) throw new SttServiceError("rejected", details)
  if (typeof body?.output?.text !== "string") throw new SttServiceError("invalidResponse", details)
  const text = body.output.text.trim()
  if (!text) throw new SttServiceError("noSpeech")
  return text
}
