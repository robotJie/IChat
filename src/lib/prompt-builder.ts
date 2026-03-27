import type { DispatchStatus, FlowContext, FlowContextAttachmentMeta, IChatApiKeys, IChatSettings, PendingPrompt, ProviderId, ProviderThreads } from "./types"
import { DEFAULT_FLOWCONTEXT_SYSTEM_INSTRUCTIONS } from "./flowcontext-system-instructions"
export { STORAGE_KEYS } from "./storage-keys"

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-20250514"
}

export const DEFAULT_SETTINGS: IChatSettings = {
  schemaVersion: 4,
  uiLanguage: "system",
  providers: {
    active: "openai",
    models: { ...DEFAULT_MODELS },
    openaiEndpoint: ""
  },
  context: {
    autoSend: true,
    previewDensity: "compact",
    showLocator: true,
    showImplicitContext: true,
    systemInstructions: DEFAULT_FLOWCONTEXT_SYSTEM_INSTRUCTIONS,
    systemInstructionsCustomized: false
  },
  shortcuts: {
    showHints: true
  },
  data: {
    historyMessageLimit: 6
  }
}

export const EMPTY_API_KEYS: IChatApiKeys = {
  openai: "",
  gemini: "",
  anthropic: ""
}

export const EMPTY_THREADS: ProviderThreads = {
  openai: [],
  gemini: [],
  anthropic: []
}

export const providerLabels: Record<ProviderId, string> = {
  openai: "OpenAI-compatible",
  gemini: "Gemini",
  anthropic: "Anthropic"
}

export function getActiveProvider(settings: IChatSettings): ProviderId {
  return settings.providers.active
}

export function getProviderModel(settings: IChatSettings, provider: ProviderId): string {
  return settings.providers.models[provider]
}

export function isAutoSendEnabled(settings: IChatSettings): boolean {
  return settings.context.autoSend
}

export function getFlowContextMode(flowContext: Partial<FlowContext> | null | undefined): FlowContext["trigger"]["mode"] {
  if (flowContext?.trigger?.mode === "selection" || flowContext?.trigger?.mode === "smart-dom") {
    return flowContext.trigger.mode
  }

  const selectionText = typeof flowContext?.selection?.text === "string" ? flowContext.selection.text.trim() : ""
  return selectionText ? "selection" : "smart-dom"
}

export function captureStatusPayload(state: "idle" | "capturing" | "captured" | "error", message: string) {
  return {
    state,
    message,
    updatedAt: new Date().toISOString()
  }
}

export function dispatchStatusPayload(state: DispatchStatus["state"], message: string, provider: ProviderId | null, flowContextId: string | null): DispatchStatus {
  return {
    state,
    message,
    provider,
    flowContextId,
    updatedAt: new Date().toISOString()
  }
}

function quoteBlock(label: string, content?: string | null) {
  if (!content) {
    return []
  }

  return [label, '"""', content, '"""']
}

function summarizeAttachment(attachment: FlowContextAttachmentMeta, index: number) {
  const bits = [
    `${index + 1}. kind=${attachment.kind}`,
    attachment.altText ? `alt=${attachment.altText}` : null,
    attachment.captionText ? `caption=${attachment.captionText}` : null,
    attachment.nearbyText ? `nearby=${attachment.nearbyText}` : null,
    attachment.sourceUrl ? `source=${attachment.sourceUrl}` : null,
    attachment.normalizedMimeType || attachment.mimeType ? `mime=${attachment.normalizedMimeType || attachment.mimeType}` : null,
    attachment.unsupportedReason ? `note=${attachment.unsupportedReason}` : null
  ].filter(Boolean)

  return `- ${bits.join(" | ")}`
}

export function composeFlowPrompt(flowContext: FlowContext): string {
  const mode = getFlowContextMode(flowContext)
  const modeLabel = mode === "selection" ? "selected text + implicit context" : "smart DOM target"
  const selectionText = flowContext.selection?.text?.trim()
  const smartText = flowContext.smartTarget?.text?.trim()
  const implicitText = flowContext.implicitContext?.text?.trim()
  const locator =
    flowContext.smartTarget?.locator?.xpath ||
    flowContext.selection?.anchorLocator?.xpath ||
    flowContext.smartTarget?.locator?.cssPath ||
    flowContext.selection?.anchorLocator?.cssPath ||
    "-"

  const sections = [
    "[FlowContext]",
    "[Page]",
    `- Title: ${flowContext.page.title || "Untitled page"}`,
    `- URL: ${flowContext.page.url || "Unknown URL"}`,
    `- Host: ${flowContext.page.host || "Unknown host"}`,
    `- Capture mode: ${modeLabel}`,
    `- Locator: ${locator}`,
    `- Primary capture kind: ${flowContext.primaryCaptureKind}`,
    ""
  ]

  sections.push(...quoteBlock("[Selected text]", selectionText))
  if (selectionText) {
    sections.push("")
  }

  sections.push(...quoteBlock("[Smart target]", smartText))
  if (smartText) {
    sections.push("")
  }

  if (implicitText && implicitText !== smartText) {
    sections.push(...quoteBlock("[Implicit context]", implicitText))
    sections.push("")
  }

  if (flowContext.attachments.length > 0) {
    sections.push("[Attachments]")
    sections.push(...flowContext.attachments.map(summarizeAttachment))
    sections.push("")
  }

  return sections.join("\n")
}

export function createPendingPrompt(flowContext: FlowContext, settings: IChatSettings): PendingPrompt {
  const attachmentIds = flowContext.attachments
    .filter((attachment) => attachment.kind === "image" && attachment.blobStoreKey)
    .map((attachment) => attachment.id)

  return {
    id: crypto.randomUUID(),
    flowContextId: flowContext.id,
    provider: getActiveProvider(settings),
    prompt: composeFlowPrompt(flowContext),
    attachmentIds,
    requiresVision: attachmentIds.length > 0,
    createdAt: new Date().toISOString(),
    status: isAutoSendEnabled(settings) ? "pending" : "draft",
    error: null
  }
}
