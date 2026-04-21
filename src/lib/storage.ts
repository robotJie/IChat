import { Storage } from "@plasmohq/storage"
import type { UIMessage } from "ai"
import {
  getDefaultFlowContextSystemInstructionsForSettings,
  isDefaultFlowContextSystemInstructions
} from "./flowcontext-system-instructions"
import type {
  AppState,
  CaptureStatus,
  DispatchStatus,
  FlowContext,
  FlowContextAttachmentMeta,
  FlowContextCandidate,
  IChatApiKeys,
  IChatSettings,
  IChatSettingsUpdate,
  PendingPrompt,
  ProviderId,
  ProviderThreads,
  RectDescriptor,
  UiLanguage
} from "./types"
import {
  captureStatusPayload,
  composeFlowPrompt,
  DEFAULT_SETTINGS,
  dispatchStatusPayload,
  EMPTY_API_KEYS,
  EMPTY_THREADS
} from "./prompt-builder"
import { createRandomId } from "./random-id"
import { STORAGE_KEYS } from "./storage-keys"

export const storage = new Storage({ area: "local" })

const DEFAULT_CAPTURE_STATUS: CaptureStatus = captureStatusPayload("idle", "Ready to capture context")
const DEFAULT_DISPATCH_STATUS: DispatchStatus = dispatchStatusPayload("idle", "Prompt is ready", null, null)
const LEGACY_MODEL_ALIASES: Partial<Record<ProviderId, Record<string, string>>> = {
  gemini: {
    "gemini-3.0-flash-preview": "gemini-3-flash-preview",
    "gemini-3.0-pro-preview": "gemini-3-pro-preview"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isProvider(value: unknown): value is ProviderId {
  return value === "openai" || value === "gemini" || value === "anthropic"
}

function isUiLanguage(value: unknown): value is UiLanguage {
  return value === "system" || value === "en" || value === "zh-CN"
}

function normalizeRect(value: unknown): RectDescriptor | null {
  if (!isRecord(value)) {
    return null
  }

  return {
    x: typeof value.x === "number" ? value.x : 0,
    y: typeof value.y === "number" ? value.y : 0,
    top: typeof value.top === "number" ? value.top : 0,
    right: typeof value.right === "number" ? value.right : 0,
    bottom: typeof value.bottom === "number" ? value.bottom : 0,
    left: typeof value.left === "number" ? value.left : 0,
    width: typeof value.width === "number" ? value.width : 0,
    height: typeof value.height === "number" ? value.height : 0
  }
}

function normalizeAttachment(value: unknown): FlowContextAttachmentMeta | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null
  }

  return {
    id: value.id,
    kind: value.kind === "video" ? "video" : "image",
    blobStoreKey: typeof value.blobStoreKey === "string" ? value.blobStoreKey : null,
    mimeType: typeof value.mimeType === "string" ? value.mimeType : null,
    normalizedMimeType: typeof value.normalizedMimeType === "string" ? value.normalizedMimeType : null,
    filename: typeof value.filename === "string" ? value.filename : null,
    bytes: typeof value.bytes === "number" ? value.bytes : null,
    width: typeof value.width === "number" ? value.width : null,
    height: typeof value.height === "number" ? value.height : null,
    naturalWidth: typeof value.naturalWidth === "number" ? value.naturalWidth : null,
    naturalHeight: typeof value.naturalHeight === "number" ? value.naturalHeight : null,
    sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : null,
    altText: typeof value.altText === "string" ? value.altText : null,
    titleText: typeof value.titleText === "string" ? value.titleText : null,
    ariaLabel: typeof value.ariaLabel === "string" ? value.ariaLabel : null,
    captionText: typeof value.captionText === "string" ? value.captionText : null,
    nearbyText: typeof value.nearbyText === "string" ? value.nearbyText : null,
    locator: isRecord(value.locator)
      ? {
          tag: typeof value.locator.tag === "string" ? value.locator.tag : null,
          xpath: typeof value.locator.xpath === "string" ? value.locator.xpath : null,
          cssPath: typeof value.locator.cssPath === "string" ? value.locator.cssPath : null,
          textPreview: typeof value.locator.textPreview === "string" ? value.locator.textPreview : null
        }
      : null,
    rect: normalizeRect(value.rect),
    origin: typeof value.origin === "string" ? value.origin as FlowContextAttachmentMeta["origin"] : null,
    captureIntegrity:
      value.captureIntegrity === "full" || value.captureIntegrity === "partial" || value.captureIntegrity === "unknown"
        ? value.captureIntegrity
        : "unknown",
    unsupportedReason: typeof value.unsupportedReason === "string" ? value.unsupportedReason : null,
    resolutionHint: isRecord(value.resolutionHint)
      ? {
          strategy: typeof value.resolutionHint.strategy === "string" ? value.resolutionHint.strategy as NonNullable<FlowContextAttachmentMeta["resolutionHint"]>["strategy"] : "capture-visible-tab",
          sourceUrl: typeof value.resolutionHint.sourceUrl === "string" ? value.resolutionHint.sourceUrl : null,
          pageFetchUrl: typeof value.resolutionHint.pageFetchUrl === "string" ? value.resolutionHint.pageFetchUrl : null,
          inlineDataUrl: typeof value.resolutionHint.inlineDataUrl === "string" ? value.resolutionHint.inlineDataUrl : null,
          mediaType: typeof value.resolutionHint.mediaType === "string" ? value.resolutionHint.mediaType : null,
          cropRect: normalizeRect(value.resolutionHint.cropRect)
        }
      : null
  }
}

function normalizeCandidate(value: unknown): FlowContextCandidate | null {
  if (!isRecord(value)) {
    return null
  }

  return {
    kind: value.kind === "image" || value.kind === "video" ? value.kind : "text",
    tag: typeof value.tag === "string" ? value.tag : null,
    text: typeof value.text === "string" ? value.text : "",
    textLength: typeof value.textLength === "number" ? value.textLength : 0,
    rect: normalizeRect(value.rect),
    locator: isRecord(value.locator)
      ? {
          tag: typeof value.locator.tag === "string" ? value.locator.tag : null,
          xpath: typeof value.locator.xpath === "string" ? value.locator.xpath : null,
          cssPath: typeof value.locator.cssPath === "string" ? value.locator.cssPath : null,
          textPreview: typeof value.locator.textPreview === "string" ? value.locator.textPreview : null
        }
      : null,
    score: typeof value.score === "number" ? value.score : 0,
    depth: typeof value.depth === "number" ? value.depth : 0,
    attachmentId: typeof value.attachmentId === "string" ? value.attachmentId : null,
    sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : null,
    mediaType: typeof value.mediaType === "string" ? value.mediaType : null
  }
}

function inferFlowContextMode(flowContext: Record<string, unknown>): FlowContext["trigger"]["mode"] {
  const selection = isRecord(flowContext.selection) ? flowContext.selection : null
  const selectionText = typeof selection?.text === "string" ? selection.text.trim() : ""
  return selectionText ? "selection" : "smart-dom"
}

export function normalizeFlowContext(value: unknown): FlowContext | null {
  if (!isRecord(value)) {
    return null
  }

  const page = isRecord(value.page) ? value.page : {}
  const trigger = isRecord(value.trigger) ? value.trigger : {}
  const metadata = isRecord(value.metadata) ? value.metadata : {}
  const viewport = isRecord(metadata.viewport) ? metadata.viewport : {}
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(normalizeAttachment).filter((attachment): attachment is FlowContextAttachmentMeta => attachment !== null)
    : []

  return {
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : 1,
    id: typeof value.id === "string" ? value.id : createRandomId(),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    page: {
      tabId: typeof page.tabId === "number" ? page.tabId : null,
      windowId: typeof page.windowId === "number" ? page.windowId : null,
      title: typeof page.title === "string" ? page.title : "",
      url: typeof page.url === "string" ? page.url : "",
      host: typeof page.host === "string" ? page.host : null
    },
    trigger: {
      command: typeof trigger.command === "string" ? trigger.command : "capture-flow-context",
      source: typeof trigger.source === "string" ? trigger.source : "keyboard-shortcut",
      mode: trigger.mode === "selection" || trigger.mode === "smart-dom" ? trigger.mode : inferFlowContextMode(value)
    },
    primaryCaptureKind: value.primaryCaptureKind === "image" || value.primaryCaptureKind === "video" ? value.primaryCaptureKind : "text",
    primaryAttachmentId: typeof value.primaryAttachmentId === "string" ? value.primaryAttachmentId : null,
    attachments,
    selection: isRecord(value.selection)
      ? {
          text: typeof value.selection.text === "string" ? value.selection.text : "",
          textLength: typeof value.selection.textLength === "number" ? value.selection.textLength : 0,
          anchorLocator: isRecord(value.selection.anchorLocator)
            ? {
                tag: typeof value.selection.anchorLocator.tag === "string" ? value.selection.anchorLocator.tag : null,
                xpath: typeof value.selection.anchorLocator.xpath === "string" ? value.selection.anchorLocator.xpath : null,
                cssPath: typeof value.selection.anchorLocator.cssPath === "string" ? value.selection.anchorLocator.cssPath : null,
                textPreview: typeof value.selection.anchorLocator.textPreview === "string" ? value.selection.anchorLocator.textPreview : null
              }
            : null,
          focusLocator: isRecord(value.selection.focusLocator)
            ? {
                tag: typeof value.selection.focusLocator.tag === "string" ? value.selection.focusLocator.tag : null,
                xpath: typeof value.selection.focusLocator.xpath === "string" ? value.selection.focusLocator.xpath : null,
                cssPath: typeof value.selection.focusLocator.cssPath === "string" ? value.selection.focusLocator.cssPath : null,
                textPreview: typeof value.selection.focusLocator.textPreview === "string" ? value.selection.focusLocator.textPreview : null
              }
            : null,
          rects: Array.isArray(value.selection.rects)
            ? value.selection.rects.map(normalizeRect).filter((rect): rect is RectDescriptor => rect !== null)
            : [],
          unionRect: normalizeRect(value.selection.unionRect)
        }
      : null,
    smartTarget: isRecord(value.smartTarget)
      ? {
          kind: value.smartTarget.kind === "image" || value.smartTarget.kind === "video" ? value.smartTarget.kind : "text",
          text: typeof value.smartTarget.text === "string" ? value.smartTarget.text : "",
          textLength: typeof value.smartTarget.textLength === "number" ? value.smartTarget.textLength : 0,
          tag: typeof value.smartTarget.tag === "string" ? value.smartTarget.tag : null,
          rect: normalizeRect(value.smartTarget.rect),
          locator: isRecord(value.smartTarget.locator)
            ? {
                tag: typeof value.smartTarget.locator.tag === "string" ? value.smartTarget.locator.tag : null,
                xpath: typeof value.smartTarget.locator.xpath === "string" ? value.smartTarget.locator.xpath : null,
                cssPath: typeof value.smartTarget.locator.cssPath === "string" ? value.smartTarget.locator.cssPath : null,
                textPreview: typeof value.smartTarget.locator.textPreview === "string" ? value.smartTarget.locator.textPreview : null
              }
            : null,
          mediaType: typeof value.smartTarget.mediaType === "string" ? value.smartTarget.mediaType : null,
          sourceUrl: typeof value.smartTarget.sourceUrl === "string" ? value.smartTarget.sourceUrl : null,
          attachmentId: typeof value.smartTarget.attachmentId === "string" ? value.smartTarget.attachmentId : null,
          activeCandidateIndex: typeof value.smartTarget.activeCandidateIndex === "number" ? value.smartTarget.activeCandidateIndex : undefined,
          candidates: Array.isArray(value.smartTarget.candidates)
            ? value.smartTarget.candidates.map(normalizeCandidate).filter((candidate): candidate is FlowContextCandidate => candidate !== null)
            : []
        }
      : null,
    implicitContext: isRecord(value.implicitContext)
      ? {
          text: typeof value.implicitContext.text === "string" ? value.implicitContext.text : "",
          textLength: typeof value.implicitContext.textLength === "number" ? value.implicitContext.textLength : 0,
          locator: isRecord(value.implicitContext.locator)
            ? {
                tag: typeof value.implicitContext.locator.tag === "string" ? value.implicitContext.locator.tag : null,
                xpath: typeof value.implicitContext.locator.xpath === "string" ? value.implicitContext.locator.xpath : null,
                cssPath: typeof value.implicitContext.locator.cssPath === "string" ? value.implicitContext.locator.cssPath : null,
                textPreview: typeof value.implicitContext.locator.textPreview === "string" ? value.implicitContext.locator.textPreview : null
              }
            : null
        }
      : null,
    metadata: {
      documentLang: typeof metadata.documentLang === "string" ? metadata.documentLang : null,
      viewport: {
        width: typeof viewport.width === "number" ? viewport.width : 0,
        height: typeof viewport.height === "number" ? viewport.height : 0,
        devicePixelRatio: typeof viewport.devicePixelRatio === "number" ? viewport.devicePixelRatio : 1
      }
    }
  }
}

function normalizeModelId(provider: ProviderId, modelId: unknown): string {
  const raw = typeof modelId === "string" ? modelId.trim() : ""
  if (!raw) {
    return DEFAULT_SETTINGS.providers.models[provider]
  }

  const alias = LEGACY_MODEL_ALIASES[provider]?.[raw]
  return alias || raw
}

function clampHistoryMessageLimit(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SETTINGS.data.historyMessageLimit
  }

  return Math.min(100, Math.max(0, Math.trunc(numeric)))
}

export function normalizeSettings(value: unknown): IChatSettings {
  const settings = isRecord(value) ? value : {}
  const providers = isRecord(settings.providers) ? settings.providers : {}
  const nestedModels = isRecord(providers.models) ? providers.models : {}
  const nestedSearchEnabled = isRecord(providers.searchEnabled) ? providers.searchEnabled : {}
  const legacyModels = isRecord(settings.models) ? settings.models : {}
  const context = isRecord(settings.context) ? settings.context : {}
  const shortcuts = isRecord(settings.shortcuts) ? settings.shortcuts : {}
  const data = isRecord(settings.data) ? settings.data : {}

  const activeProvider = isProvider(providers.active)
    ? providers.active
    : isProvider(settings.provider)
      ? settings.provider
      : DEFAULT_SETTINGS.providers.active
  const uiLanguage = isUiLanguage(settings.uiLanguage)
    ? settings.uiLanguage
    : DEFAULT_SETTINGS.uiLanguage
  const openaiEndpoint = typeof providers.openaiEndpoint === "string"
    ? providers.openaiEndpoint.trim()
    : typeof settings.openaiEndpoint === "string"
      ? settings.openaiEndpoint.trim()
      : DEFAULT_SETTINGS.providers.openaiEndpoint

  const autoSend = typeof context.autoSend === "boolean"
    ? context.autoSend
    : typeof settings.autoSend === "boolean"
      ? settings.autoSend
      : DEFAULT_SETTINGS.context.autoSend

  const previewDensity = context.previewDensity === "full" || context.previewDensity === "compact"
    ? context.previewDensity
    : DEFAULT_SETTINGS.context.previewDensity
  const explicitSystemInstructions = typeof context.systemInstructions === "string"
    ? context.systemInstructions
    : null
  const systemInstructionsCustomized = typeof context.systemInstructionsCustomized === "boolean"
    ? context.systemInstructionsCustomized
    : explicitSystemInstructions === null
      ? false
      : !isDefaultFlowContextSystemInstructions(explicitSystemInstructions)
  const systemInstructions = systemInstructionsCustomized
    ? explicitSystemInstructions ?? DEFAULT_SETTINGS.context.systemInstructions
    : getDefaultFlowContextSystemInstructionsForSettings({ uiLanguage })

  return {
    schemaVersion: 5,
    uiLanguage,
    providers: {
      active: activeProvider,
      models: {
        openai: normalizeModelId("openai", nestedModels.openai ?? legacyModels.openai),
        gemini: normalizeModelId("gemini", nestedModels.gemini ?? legacyModels.gemini),
        anthropic: normalizeModelId("anthropic", nestedModels.anthropic ?? legacyModels.anthropic)
      },
      searchEnabled: {
        openai: typeof nestedSearchEnabled.openai === "boolean" ? nestedSearchEnabled.openai : DEFAULT_SETTINGS.providers.searchEnabled.openai,
        gemini: typeof nestedSearchEnabled.gemini === "boolean" ? nestedSearchEnabled.gemini : DEFAULT_SETTINGS.providers.searchEnabled.gemini,
        anthropic: typeof nestedSearchEnabled.anthropic === "boolean" ? nestedSearchEnabled.anthropic : DEFAULT_SETTINGS.providers.searchEnabled.anthropic
      },
      openaiEndpoint
    },
    context: {
      autoSend,
      previewDensity,
      showLocator: typeof context.showLocator === "boolean" ? context.showLocator : DEFAULT_SETTINGS.context.showLocator,
      showImplicitContext:
        typeof context.showImplicitContext === "boolean"
          ? context.showImplicitContext
          : DEFAULT_SETTINGS.context.showImplicitContext,
      systemInstructions,
      systemInstructionsCustomized
    },
    shortcuts: {
      showHints: typeof shortcuts.showHints === "boolean" ? shortcuts.showHints : DEFAULT_SETTINGS.shortcuts.showHints
    },
    data: {
      historyMessageLimit: clampHistoryMessageLimit(data.historyMessageLimit)
    }
  }
}

export function normalizeApiKeys(value: unknown): IChatApiKeys {
  const apiKeys = isRecord(value) ? value : {}

  return {
    openai: typeof apiKeys.openai === "string" ? apiKeys.openai : "",
    gemini: typeof apiKeys.gemini === "string" ? apiKeys.gemini : "",
    anthropic: typeof apiKeys.anthropic === "string" ? apiKeys.anthropic : ""
  }
}

function normalizeCaptureStatus(value: unknown): CaptureStatus {
  if (!isRecord(value)) {
    return DEFAULT_CAPTURE_STATUS
  }

  return {
    state:
      value.state === "idle" ||
      value.state === "capturing" ||
      value.state === "captured" ||
      value.state === "error"
        ? value.state
        : DEFAULT_CAPTURE_STATUS.state,
    message: typeof value.message === "string" ? value.message : DEFAULT_CAPTURE_STATUS.message,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
  }
}

function normalizeDispatchStatus(value: unknown): DispatchStatus {
  if (!isRecord(value)) {
    return DEFAULT_DISPATCH_STATUS
  }

  return {
    state:
      value.state === "idle" ||
      value.state === "draft" ||
      value.state === "sending" ||
      value.state === "sent" ||
      value.state === "error"
        ? value.state
        : DEFAULT_DISPATCH_STATUS.state,
    message: typeof value.message === "string" ? value.message : DEFAULT_DISPATCH_STATUS.message,
    provider: isProvider(value.provider) ? value.provider : null,
    flowContextId: typeof value.flowContextId === "string" ? value.flowContextId : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
  }
}

function normalizePendingPrompt(value: unknown): PendingPrompt | null {
  if (!isRecord(value)) {
    return null
  }

  const attachmentIds = Array.isArray(value.attachmentIds)
    ? value.attachmentIds.filter((item): item is string => typeof item === "string")
    : []

  return {
    id: typeof value.id === "string" ? value.id : createRandomId(),
    flowContextId: typeof value.flowContextId === "string" ? value.flowContextId : "",
    provider: isProvider(value.provider) ? value.provider : DEFAULT_SETTINGS.providers.active,
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    attachmentIds,
    requiresVision: typeof value.requiresVision === "boolean" ? value.requiresVision : attachmentIds.length > 0,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    status:
      value.status === "draft" ||
      value.status === "pending" ||
      value.status === "processing" ||
      value.status === "sent" ||
      value.status === "error"
        ? value.status
        : "draft",
    error: typeof value.error === "string" ? value.error : null
  }
}

function normalizeMessagePart(part: unknown): UIMessage["parts"][number] | null {
  if (!isRecord(part)) {
    return null
  }

  if (part.type === "text") {
    return {
      type: "text" as const,
      text: typeof part.text === "string" ? part.text : "",
      state: part.state === "streaming" || part.state === "done" ? part.state : "done"
    }
  }

  if (part.type === "file") {
    return {
      type: "file" as const,
      mediaType: typeof part.mediaType === "string" ? part.mediaType : "application/octet-stream",
      filename: typeof part.filename === "string" ? part.filename : undefined,
      url: typeof part.url === "string" ? part.url : ""
    }
  }

  return null
}

function normalizeUIMessage(message: unknown): UIMessage | null {
  if (!isRecord(message)) {
    return null
  }

  const role = message.role === "system" || message.role === "user" || message.role === "assistant"
    ? message.role
    : null

  if (!role) {
    return null
  }

  const parts = Array.isArray(message.parts)
    ? message.parts.map(normalizeMessagePart).filter((part): part is UIMessage["parts"][number] => part !== null)
    : typeof message.content === "string" && message.content.trim()
      ? [{ type: "text" as const, text: message.content, state: "done" as const }]
      : []

  if (!parts.length) {
    return null
  }

  return {
    id: typeof message.id === "string" ? message.id : createRandomId(),
    role,
    parts
  }
}

function normalizeChatThreads(value: unknown): ProviderThreads {
  const threads = isRecord(value) ? value : {}
  const normalizeThread = (thread: unknown) => Array.isArray(thread)
    ? thread.map(normalizeUIMessage).filter((message): message is UIMessage => message !== null)
    : []

  return {
    openai: normalizeThread(threads.openai),
    gemini: normalizeThread(threads.gemini),
    anthropic: normalizeThread(threads.anthropic)
  }
}

function shouldPatch(original: unknown, normalized: unknown) {
  return JSON.stringify(original ?? null) !== JSON.stringify(normalized ?? null)
}

function mergeSettings(current: IChatSettings, partial: IChatSettingsUpdate): IChatSettings {
  return normalizeSettings({
    ...current,
    schemaVersion: 5,
    uiLanguage: partial.uiLanguage ?? current.uiLanguage,
    providers: {
      ...current.providers,
      ...(partial.providers ?? {}),
      models: {
        ...current.providers.models,
        ...(partial.providers?.models ?? {})
      },
      searchEnabled: {
        ...current.providers.searchEnabled,
        ...(partial.providers?.searchEnabled ?? {})
      }
    },
    context: {
      ...current.context,
      ...(partial.context ?? {})
    },
    shortcuts: {
      ...current.shortcuts,
      ...(partial.shortcuts ?? {})
    },
    data: {
      ...current.data,
      ...(partial.data ?? {})
    }
  })
}

export async function ensureDefaults() {
  const existing = await storage.getMany<string | object>(Object.values(STORAGE_KEYS))
  const patch: Record<string, unknown> = {}

  const nextSettings = normalizeSettings(existing[STORAGE_KEYS.settings])
  if (!existing[STORAGE_KEYS.settings] || shouldPatch(existing[STORAGE_KEYS.settings], nextSettings)) {
    patch[STORAGE_KEYS.settings] = nextSettings
  }

  const nextApiKeys = normalizeApiKeys(existing[STORAGE_KEYS.apiKeys])
  if (!existing[STORAGE_KEYS.apiKeys] || shouldPatch(existing[STORAGE_KEYS.apiKeys], nextApiKeys)) {
    patch[STORAGE_KEYS.apiKeys] = nextApiKeys
  }

  const nextCaptureStatus = normalizeCaptureStatus(existing[STORAGE_KEYS.captureStatus])
  if (!existing[STORAGE_KEYS.captureStatus] || shouldPatch(existing[STORAGE_KEYS.captureStatus], nextCaptureStatus)) {
    patch[STORAGE_KEYS.captureStatus] = nextCaptureStatus
  }

  const nextDispatchStatus = normalizeDispatchStatus(existing[STORAGE_KEYS.dispatchStatus])
  if (!existing[STORAGE_KEYS.dispatchStatus] || shouldPatch(existing[STORAGE_KEYS.dispatchStatus], nextDispatchStatus)) {
    patch[STORAGE_KEYS.dispatchStatus] = nextDispatchStatus
  }

  const nextChatThreads = normalizeChatThreads(existing[STORAGE_KEYS.chatThreads])
  if (!existing[STORAGE_KEYS.chatThreads] || shouldPatch(existing[STORAGE_KEYS.chatThreads], nextChatThreads)) {
    patch[STORAGE_KEYS.chatThreads] = nextChatThreads
  }

  const nextPendingPrompt = normalizePendingPrompt(existing[STORAGE_KEYS.pendingPrompt])
  if (!(STORAGE_KEYS.pendingPrompt in existing) || shouldPatch(existing[STORAGE_KEYS.pendingPrompt], nextPendingPrompt)) {
    patch[STORAGE_KEYS.pendingPrompt] = nextPendingPrompt
  }

  const nextFlowContext = normalizeFlowContext(existing[STORAGE_KEYS.flowContext])
  if (!(STORAGE_KEYS.flowContext in existing) || shouldPatch(existing[STORAGE_KEYS.flowContext], nextFlowContext)) {
    patch[STORAGE_KEYS.flowContext] = nextFlowContext
  }

  if (Object.keys(patch).length > 0) {
    await storage.setMany(patch)
  }
}

export async function getAppState(): Promise<AppState> {
  await ensureDefaults()
  const stored = await storage.getMany<unknown>(Object.values(STORAGE_KEYS))

  return {
    flowContext: normalizeFlowContext(stored[STORAGE_KEYS.flowContext]),
    settings: normalizeSettings(stored[STORAGE_KEYS.settings]),
    apiKeys: normalizeApiKeys(stored[STORAGE_KEYS.apiKeys]),
    captureStatus: normalizeCaptureStatus(stored[STORAGE_KEYS.captureStatus]),
    dispatchStatus: normalizeDispatchStatus(stored[STORAGE_KEYS.dispatchStatus]),
    pendingPrompt: normalizePendingPrompt(stored[STORAGE_KEYS.pendingPrompt]),
    chatThreads: normalizeChatThreads(stored[STORAGE_KEYS.chatThreads])
  }
}

export async function updateSettings(partial: IChatSettingsUpdate) {
  const current = normalizeSettings(await storage.get<IChatSettings>(STORAGE_KEYS.settings))
  const next = mergeSettings(current, partial)

  await storage.set(STORAGE_KEYS.settings, next)
  return next
}

export async function updateApiKeys(partial: Partial<IChatApiKeys>) {
  const current = normalizeApiKeys(await storage.get<IChatApiKeys>(STORAGE_KEYS.apiKeys))
  const next = {
    ...EMPTY_API_KEYS,
    ...current,
    ...partial
  }

  await storage.set(STORAGE_KEYS.apiKeys, next)
  return next
}

export async function updateFlowContextDraft(flowContext: FlowContext | null) {
  const nextFlowContext = normalizeFlowContext(flowContext)
  const patch: Record<string, unknown> = {
    [STORAGE_KEYS.flowContext]: nextFlowContext
  }

  const currentPendingPrompt = normalizePendingPrompt(await storage.get<PendingPrompt>(STORAGE_KEYS.pendingPrompt))
  if (
    nextFlowContext &&
    currentPendingPrompt &&
    currentPendingPrompt.flowContextId === nextFlowContext.id &&
    currentPendingPrompt.status !== "pending" &&
    currentPendingPrompt.status !== "sent"
  ) {
    patch[STORAGE_KEYS.pendingPrompt] = {
      ...currentPendingPrompt,
      attachmentIds: nextFlowContext.attachments.filter((attachment) => attachment.kind === "image" && attachment.blobStoreKey).map((attachment) => attachment.id),
      requiresVision: nextFlowContext.attachments.some((attachment) => attachment.kind === "image" && attachment.blobStoreKey),
      prompt: composeFlowPrompt(nextFlowContext)
    }
  }

  await storage.setMany(patch)
  return nextFlowContext
}

export async function setFlowContext(flowContext: FlowContext | null) {
  await storage.set(STORAGE_KEYS.flowContext, normalizeFlowContext(flowContext))
}

export async function setCaptureStatus(status: CaptureStatus) {
  await storage.set(STORAGE_KEYS.captureStatus, normalizeCaptureStatus(status))
}

export async function setDispatchStatus(status: DispatchStatus) {
  await storage.set(STORAGE_KEYS.dispatchStatus, normalizeDispatchStatus(status))
}

export async function setPendingPrompt(pendingPrompt: PendingPrompt | null) {
  await storage.set(STORAGE_KEYS.pendingPrompt, normalizePendingPrompt(pendingPrompt))
}

export async function getChatThreads() {
  return normalizeChatThreads(await storage.get<ProviderThreads>(STORAGE_KEYS.chatThreads))
}

export async function setChatThread(provider: ProviderId, messages: ProviderThreads[ProviderId]) {
  const threads = await getChatThreads()
  await storage.set(STORAGE_KEYS.chatThreads, {
    ...EMPTY_THREADS,
    ...threads,
    [provider]: Array.isArray(messages) ? messages.map(normalizeUIMessage).filter((message): message is UIMessage => message !== null) : []
  })
}

export async function clearChatThread(provider: ProviderId) {
  await setChatThread(provider, [])
}
