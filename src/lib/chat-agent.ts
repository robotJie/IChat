import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { streamText, type ModelMessage } from "ai"
import type { IChatApiKeys, IChatSettings, ProviderId } from "./types"
import { getProviderModel, providerLabels } from "./prompt-builder"

export function getProviderKey(provider: ProviderId, apiKeys: IChatApiKeys) {
  return apiKeys[provider]?.trim() || ""
}

export function createProviderModel(provider: ProviderId, apiKeys: IChatApiKeys, settings: IChatSettings) {
  const apiKey = getProviderKey(provider, apiKeys)
  const modelId = getProviderModel(settings, provider)

  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey }).chat(modelId)
    case "gemini":
      return createGoogleGenerativeAI({ apiKey }).chat(modelId)
    case "anthropic":
      return createAnthropic({ apiKey }).messages(modelId)
    default:
      throw new Error(`Unsupported provider: ${provider satisfies never}`)
  }
}

export async function streamProviderResponse(
  provider: ProviderId,
  apiKeys: IChatApiKeys,
  settings: IChatSettings,
  messages: ModelMessage[],
  abortSignal: AbortSignal,
  onTextDelta?: (nextText: string) => void
) {
  const modelId = getProviderModel(settings, provider)
  const model = createProviderModel(provider, apiKeys, settings)
  const systemInstructions = settings.context.systemInstructions || ""

  const result = streamText({
    model,
    system: `${systemInstructions}${systemInstructions ? "\n" : ""}Provider: ${providerLabels[provider]}\nModel: ${modelId}`,
    messages,
    abortSignal
  })

  let text = ""

  for await (const chunk of result.textStream) {
    text += chunk
    onTextDelta?.(text)
  }

  return text.trim()
}

export function formatProviderError(provider: ProviderId, modelId: string, apiKey: string, error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error)

  if (provider === "gemini") {
    if (!apiKey.startsWith("AIza")) {
      return "Gemini expects a Google AI Studio API key, which usually starts with 'AIza'. Please paste that key in Settings."
    }

    if (rawMessage.includes("unregistered callers") || rawMessage.includes("established identity")) {
      return "Gemini rejected the request. This usually means the key is missing, invalid, or not a Google AI Studio Gemini API key. Please verify the key in Settings and make sure the Gemini API is enabled for it."
    }

    if (rawMessage.includes("is not found for API version v1beta") || rawMessage.includes("not supported for generateContent")) {
      return `The Gemini model '${modelId}' is not available for the Generative AI API. Try 'gemini-2.5-flash' or 'gemini-3-flash-preview'.`
    }
  }

  return rawMessage
}
