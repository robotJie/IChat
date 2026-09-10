import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { streamText, type ModelMessage, type ToolSet } from "ai"
import type { TranslateFn } from "./i18n"
import type { IChatApiKeys, IChatSettings, ProviderId } from "./types"
import { getProviderModel, providerLabels } from "./prompt-builder"

function providerErrorBody(provider: ProviderId, message: string) {
  switch (provider) {
    case "openai":
      return { error: { message, type: "network_error", code: "network_error" } }
    case "gemini":
      return { error: { code: 503, message, status: "UNAVAILABLE" } }
    case "anthropic":
      return { type: "error", error: { type: "api_error", message } }
    default:
      return { error: { message } }
  }
}

function createProviderFetch(provider: ProviderId): typeof fetch {
  return async (input, init) => {
    try {
      return await fetch(input, init)
    } catch (error) {
      const cancelled = init?.signal?.aborted || (error instanceof Error && error.name === "AbortError")
      const message = cancelled
        ? "The provider request was cancelled."
        : `The provider network request failed: ${error instanceof Error ? error.message : String(error)}`

      // Keep native fetch rejections out of the AI SDK stream pipeline. Provider
      // adapters turn this synthetic HTTP response into their normal API error,
      // which the conversation UI already catches and displays.
      return new Response(JSON.stringify(providerErrorBody(provider, message)), {
        status: cancelled ? 499 : 503,
        statusText: cancelled ? "Request Cancelled" : "Provider Network Error",
        headers: { "content-type": "application/json" }
      })
    }
  }
}

export function getProviderKey(provider: ProviderId, apiKeys: IChatApiKeys) {
  return apiKeys[provider]?.trim() || ""
}

export function createProviderModel(provider: ProviderId, apiKeys: IChatApiKeys, settings: IChatSettings) {
  const apiKey = getProviderKey(provider, apiKeys)
  const modelId = getProviderModel(settings, provider)
  const openaiEndpoint = settings.providers.openaiEndpoint.trim()
  const providerFetch = createProviderFetch(provider)

  switch (provider) {
    case "openai": {
      const openai = createOpenAI({
        apiKey,
        baseURL: openaiEndpoint || undefined,
        fetch: providerFetch
      })
      return settings.providers.searchEnabled.openai ? openai.responses(modelId) : openai.chat(modelId)
    }
    case "gemini":
      return createGoogleGenerativeAI({ apiKey, fetch: providerFetch }).chat(modelId)
    case "anthropic":
      return createAnthropic({ apiKey, fetch: providerFetch }).messages(modelId)
    default:
      throw new Error(`Unsupported provider: ${provider satisfies never}`)
  }
}

function createProviderTools(provider: ProviderId, apiKeys: IChatApiKeys, settings: IChatSettings): ToolSet | undefined {
  if (!settings.providers.searchEnabled[provider]) {
    return undefined
  }

  const apiKey = getProviderKey(provider, apiKeys)
  const openaiEndpoint = settings.providers.openaiEndpoint.trim()
  const providerFetch = createProviderFetch(provider)

  switch (provider) {
    case "openai":
      return {
        web_search: createOpenAI({
          apiKey,
          baseURL: openaiEndpoint || undefined,
          fetch: providerFetch
        }).tools.webSearch()
      } as ToolSet
    case "gemini":
      return {
        google_search: createGoogleGenerativeAI({ apiKey, fetch: providerFetch }).tools.googleSearch({})
      } as ToolSet
    case "anthropic":
      return {
        web_search: createAnthropic({ apiKey, fetch: providerFetch }).tools.webSearch_20260209()
      } as ToolSet
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
  abortSignal.throwIfAborted()

  const modelId = getProviderModel(settings, provider)
  const model = createProviderModel(provider, apiKeys, settings)
  const tools = createProviderTools(provider, apiKeys, settings)
  const systemInstructions = settings.context.systemInstructions || ""
  let streamError: unknown = null

  const result = streamText({
    model,
    system: `${systemInstructions}${systemInstructions ? "\n" : ""}Provider: ${providerLabels[provider]}\nModel: ${modelId}`,
    messages,
    abortSignal,
    // The conversation pipeline already catches and displays stream errors.
    // Avoid AI SDK's default console.error duplicating them in chrome://extensions.
    onError: ({ error }) => {
      streamError ??= error
    },
    ...(tools ? { tools } : {})
  })

  let text = ""

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      text += part.text
      onTextDelta?.(text)
    } else if (part.type === "error") {
      streamError ??= part.error
    }
  }

  abortSignal.throwIfAborted()

  if (streamError !== null) {
    throw streamError
  }

  return text.trim()
}

export function formatProviderError(provider: ProviderId, modelId: string, apiKey: string, error: unknown, t?: TranslateFn) {
  const rawMessage = error instanceof Error ? error.message : String(error)

  if (provider === "gemini") {
    if (!apiKey.startsWith("AIza")) {
      return t ? t("errors.gemini.expectedKey") : "Gemini expects a Google AI Studio API key, which usually starts with 'AIza'. Please paste that key in Settings."
    }

    if (rawMessage.includes("unregistered callers") || rawMessage.includes("established identity")) {
      return t
        ? t("errors.gemini.rejectedRequest")
        : "Gemini rejected the request. This usually means the key is missing, invalid, or not a Google AI Studio Gemini API key. Please verify the key in Settings and make sure the Gemini API is enabled for it."
    }

    if (rawMessage.includes("is not found for API version v1beta") || rawMessage.includes("not supported for generateContent")) {
      return t
        ? t("errors.gemini.modelUnavailable", { modelId })
        : `The Gemini model '${modelId}' is not available for the Generative AI API. Try 'gemini-2.5-flash' or 'gemini-3-flash-preview'.`
    }
  }

  return rawMessage
}
