import type { UIMessage } from "ai"

export type ProviderId = "openai" | "gemini" | "anthropic"
export type UiLanguage = "system" | "en" | "zh-CN"
export type CaptureMode = "selection" | "smart-dom"
export type CaptureStatusState = "idle" | "capturing" | "captured" | "error"
export type DispatchStatusState = "idle" | "draft" | "sending" | "sent" | "error"
export type PendingPromptState = "draft" | "pending" | "processing" | "sent" | "error"
export type FlowContextCandidateKind = "text" | "image" | "video"
export type FlowContextAttachmentKind = "image" | "video"
export type FlowContextAttachmentOrigin =
  | "network-fetch"
  | "page-fetch"
  | "data-url"
  | "blob-url"
  | "canvas-blob"
  | "screenshot-fallback"
  | "video-poster"
  | "unsupported-video"
  | "pending"

export type AttachmentResolutionStrategy =
  | "network-url"
  | "page-url"
  | "data-url"
  | "blob-url"
  | "canvas-data-url"
  | "background-image-url"
  | "capture-visible-tab"
  | "video-poster-url"
  | "unsupported-video"

export interface LocatorDescriptor {
  tag?: string | null
  xpath?: string | null
  cssPath?: string | null
  textPreview?: string | null
}

export interface RectDescriptor {
  x: number
  y: number
  top: number
  right: number
  bottom: number
  left: number
  width: number
  height: number
}

export interface AttachmentResolutionHint {
  strategy: AttachmentResolutionStrategy
  sourceUrl?: string | null
  pageFetchUrl?: string | null
  inlineDataUrl?: string | null
  mediaType?: string | null
  cropRect?: RectDescriptor | null
}

export interface FlowContextAttachmentMeta {
  id: string
  kind: FlowContextAttachmentKind
  blobStoreKey: string | null
  mimeType: string | null
  normalizedMimeType?: string | null
  filename?: string | null
  bytes?: number | null
  width?: number | null
  height?: number | null
  naturalWidth?: number | null
  naturalHeight?: number | null
  sourceUrl?: string | null
  altText?: string | null
  titleText?: string | null
  ariaLabel?: string | null
  captionText?: string | null
  nearbyText?: string | null
  locator?: LocatorDescriptor | null
  rect?: RectDescriptor | null
  origin?: FlowContextAttachmentOrigin | null
  captureIntegrity?: "full" | "partial" | "unknown"
  unsupportedReason?: string | null
  resolutionHint?: AttachmentResolutionHint | null
}

export interface FlowContextCandidate {
  kind: FlowContextCandidateKind
  tag?: string | null
  text?: string
  textLength?: number
  rect?: RectDescriptor | null
  locator?: LocatorDescriptor | null
  score?: number
  depth?: number
  attachmentId?: string | null
  sourceUrl?: string | null
  mediaType?: string | null
}

export interface FlowContext {
  schemaVersion: number
  id: string
  createdAt: string
  page: {
    tabId: number | null
    windowId: number | null
    title: string
    url: string
    host: string | null
  }
  trigger: {
    command: string
    source: string
    mode: CaptureMode
  }
  primaryCaptureKind: FlowContextCandidateKind
  primaryAttachmentId: string | null
  attachments: FlowContextAttachmentMeta[]
  selection: {
    text: string
    textLength: number
    anchorLocator: LocatorDescriptor | null
    focusLocator: LocatorDescriptor | null
    rects: RectDescriptor[]
    unionRect: RectDescriptor | null
  } | null
  smartTarget: {
    kind: FlowContextCandidateKind
    text: string
    textLength: number
    tag: string | null
    rect: RectDescriptor | null
    locator: LocatorDescriptor | null
    mediaType?: string | null
    sourceUrl?: string | null
    attachmentId?: string | null
    activeCandidateIndex?: number
    candidates?: FlowContextCandidate[]
  } | null
  implicitContext: {
    text: string
    textLength: number
    locator: LocatorDescriptor | null
  } | null
  metadata: {
    documentLang: string | null
    viewport: {
      width: number
      height: number
      devicePixelRatio?: number
    }
  }
}

export interface IChatSettings {
  schemaVersion: 5
  uiLanguage: UiLanguage
  providers: {
    active: ProviderId
    models: Record<ProviderId, string>
    searchEnabled: Record<ProviderId, boolean>
    openaiEndpoint: string
  }
  context: {
    autoSend: boolean
    previewDensity: "compact" | "full"
    showLocator: boolean
    showImplicitContext: boolean
    systemInstructions: string
    systemInstructionsCustomized: boolean
  }
  shortcuts: {
    showHints: boolean
  }
  data: {
    historyMessageLimit: number
  }
}

export interface IChatSettingsUpdate {
  uiLanguage?: UiLanguage
  providers?: {
    active?: ProviderId
    models?: Partial<Record<ProviderId, string>>
    searchEnabled?: Partial<Record<ProviderId, boolean>>
    openaiEndpoint?: string
  }
  context?: Partial<IChatSettings["context"]>
  shortcuts?: Partial<IChatSettings["shortcuts"]>
  data?: Partial<IChatSettings["data"]>
}

export interface IChatApiKeys {
  openai: string
  gemini: string
  anthropic: string
}

export interface CaptureStatus {
  state: CaptureStatusState
  message: string
  updatedAt: string
}

export interface DispatchStatus {
  state: DispatchStatusState
  flowContextId: string | null
  provider: ProviderId | null
  message: string
  updatedAt: string
}

export interface PendingPrompt {
  id: string
  flowContextId: string
  provider: ProviderId
  prompt: string
  attachmentIds: string[]
  requiresVision: boolean
  createdAt: string
  status: PendingPromptState
  error: string | null
}

export type ProviderThreads = Record<ProviderId, UIMessage[]>

export interface AppState {
  flowContext: FlowContext | null
  settings: IChatSettings
  apiKeys: IChatApiKeys
  captureStatus: CaptureStatus
  dispatchStatus: DispatchStatus
  pendingPrompt: PendingPrompt | null
  chatThreads: ProviderThreads
}
