import type { IChatSettings, ProviderId } from "./types"
import { getActiveProvider, getProviderModel, providerLabels } from "./prompt-builder"

const VISION_MODEL_PATTERNS: Record<ProviderId, RegExp[]> = {
  openai: [/gpt-4o/i, /gpt-4\.1/i, /o1/i, /o3/i, /o4/i],
  gemini: [/gemini-(1\.5|2|2\.5|3)/i],
  anthropic: [/claude-3/i, /claude-4/i, /sonnet/i, /opus/i]
}

export function supportsVisionInput(provider: ProviderId, modelId: string) {
  const normalized = modelId.trim()
  if (!normalized) {
    return false
  }

  return VISION_MODEL_PATTERNS[provider].some((pattern) => pattern.test(normalized))
}

export function currentModelSupportsVision(settings: IChatSettings) {
  const provider = getActiveProvider(settings)
  const modelId = getProviderModel(settings, provider)
  return supportsVisionInput(provider, modelId)
}

export function getVisionBlockedMessage(provider: ProviderId, modelId: string) {
  const label = providerLabels[provider]
  return `${label} model '${modelId}' does not appear to support image input. Switch to a vision-capable model or remove the image attachment.`
}