import type { ModelMessage, UIMessage } from "ai"
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import type { ClipboardEvent as ReactClipboardEvent } from "react"
import ReactMarkdown from "react-markdown"
import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import "katex/dist/katex.min.css"
import { formatProviderError, getProviderKey, streamProviderResponse } from "../lib/chat-agent"
import {
  attachmentIdFromUrl,
  attachmentUrlFromId,
  blobToUint8Array,
  createObjectUrlForBlob,
  dataUrlToBlob,
  getAttachmentBlob,
  putAttachmentBlob,
  revokeObjectUrl
} from "../lib/attachment-repository"
import { normalizeImageBlob } from "../lib/media-processing"
import { useI18n } from "../lib/i18n"
import { useDictation } from "../lib/use-dictation"
import { composeFlowPrompt, dispatchStatusPayload, getFlowContextMode, getProviderModel, isAutoSendEnabled, providerLabels } from "../lib/prompt-builder"
import { createRandomId } from "../lib/random-id"
import { getChatThreads, setChatThread, setDispatchStatus, setFlowContext, setPendingPrompt, updateFlowContextDraft } from "../lib/storage"
import { getVisionBlockedMessage, supportsVisionInput } from "../lib/vision-capabilities"
import type { FlowContext, FlowContextAttachmentMeta, IChatApiKeys, IChatSettings, PendingPrompt, ProviderId } from "../lib/types"

interface ProviderConversationProps {
  provider: ProviderId
  settings: IChatSettings
  apiKeys: IChatApiKeys
  pendingPrompt: PendingPrompt | null
  flowContext: FlowContext | null
  threadClearSignal: number
  searchOpenSignal: number
  settingsOpen: boolean
}

interface FlowContextEditorState {
  pageUrl: string
  locator: string
  selectedText: string
  smartTargetText: string
  implicitContextText: string
}

interface LocalImageAttachment {
  id: string
  mediaType: string
  filename?: string
  label: string
  url: string
  source: "flow-context" | "composer"
}

type FileUIPart = Extract<UIMessage["parts"][number], { type: "file" }>
type TextUIPart = Extract<UIMessage["parts"][number], { type: "text" }>
const UNSUPPORTED_MODEL_IMAGE_MEDIA_TYPES = new Set(["image/svg+xml"])
const SEARCH_MATCH_HIGHLIGHT = "ichat-search-match"
const SEARCH_ACTIVE_HIGHLIGHT = "ichat-search-active"

type SearchHighlightRegistry = HighlightRegistry & {
  delete(name: string): boolean
  set(name: string, highlight: Highlight): SearchHighlightRegistry
}

function getSearchHighlightRegistry() {
  if (typeof CSS === "undefined" || !CSS.highlights) {
    return null
  }

  return CSS.highlights as SearchHighlightRegistry
}

function extractUiMessageText(message: UIMessage) {
  return message.parts
    .filter((part): part is TextUIPart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim()
}

function extractUiMessageFiles(message: UIMessage) {
  return message.parts.filter((part): part is FileUIPart => part.type === "file")
}

function createTextPart(text: string): TextUIPart {
  return {
    type: "text",
    text,
    state: "done"
  }
}

function createFilePart(attachment: LocalImageAttachment): FileUIPart {
  return {
    type: "file",
    mediaType: attachment.mediaType,
    filename: attachment.filename,
    url: attachment.url
  }
}

function createMessage(role: UIMessage["role"], text: string, fileParts: FileUIPart[] = [], id = createRandomId()): UIMessage {
  const parts: UIMessage["parts"] = []
  const cleanText = text.trim()

  if (cleanText) {
    parts.push(createTextPart(cleanText))
  }

  parts.push(...fileParts)

  return {
    id,
    role,
    parts
  }
}

function replaceMessageText(messages: UIMessage[], messageId: string, text: string) {
  return messages.map((message) => {
    if (message.id !== messageId) {
      return message
    }

    const fileParts = extractUiMessageFiles(message)
    return {
      ...message,
      parts: [createTextPart(text), ...fileParts]
    }
  })
}

function removeMessage(messages: UIMessage[], messageId: string) {
  return messages.filter((message) => message.id !== messageId)
}

function limitHistoryMessages(messages: UIMessage[], limit: number) {
  if (limit <= 0) {
    return []
  }

  return messages.slice(-limit)
}

function getConversationSearchMatches(messages: UIMessage[], query: string) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) {
    return []
  }

  return messages
    .filter((message) => extractUiMessageText(message).toLocaleLowerCase().includes(needle))
    .map((message) => message.id)
}

function clearConversationSearchHighlights(content: HTMLElement | null) {
  content?.querySelectorAll(".ichat-message.is-search-match, .ichat-message.is-active-search-match").forEach((element) => {
    element.classList.remove("is-search-match", "is-active-search-match")
  })

  const highlights = getSearchHighlightRegistry()
  highlights?.delete(SEARCH_MATCH_HIGHLIGHT)
  highlights?.delete(SEARCH_ACTIVE_HIGHLIGHT)
}

function getTextSearchRanges(container: HTMLElement, query: string) {
  const ranges: Range[] = []
  const needle = query.toLocaleLowerCase()
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!node.nodeValue || !parent || parent.closest(".katex-mathml, .ichat-message-tools")) {
        return NodeFilter.FILTER_REJECT
      }

      return NodeFilter.FILTER_ACCEPT
    }
  })

  let node = walker.nextNode()
  while (node) {
    const value = node.nodeValue || ""
    const haystack = value.toLocaleLowerCase()
    let start = haystack.indexOf(needle)

    while (start !== -1) {
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + query.length)
      ranges.push(range)
      start = haystack.indexOf(needle, start + Math.max(query.length, 1))
    }

    node = walker.nextNode()
  }

  return ranges
}

async function filePartToModelPart(part: FileUIPart) {
  const url = part.url
  if (part.mediaType.startsWith("image/")) {
    const normalizeUnsupportedModelImage = async (blob: Blob, fallbackMediaType: string) => {
      const normalized = await normalizeImageBlob(blob, part.filename)
      const nextMediaType = normalized.mediaType || fallbackMediaType || blob.type || "image/png"

      if (UNSUPPORTED_MODEL_IMAGE_MEDIA_TYPES.has(nextMediaType)) {
        throw new Error(`Unsupported image attachment type: ${nextMediaType}`)
      }

      return {
        type: "image" as const,
        image: await blobToUint8Array(normalized.blob),
        mediaType: nextMediaType
      }
    }

    if (UNSUPPORTED_MODEL_IMAGE_MEDIA_TYPES.has(part.mediaType)) {
      if (url.startsWith("data:")) {
        return normalizeUnsupportedModelImage(await dataUrlToBlob(url), part.mediaType)
      }

      const attachmentId = attachmentIdFromUrl(url)
      if (attachmentId) {
        const blob = await getAttachmentBlob(attachmentId)
        if (!blob) {
          throw new Error(`Attachment '${attachmentId}' is no longer available.`)
        }

        return normalizeUnsupportedModelImage(blob, part.mediaType)
      }

      const blob = await fetch(url).then((response) => response.blob())
      return normalizeUnsupportedModelImage(blob, part.mediaType)
    }

    if (url.startsWith("data:")) {
      return {
        type: "image" as const,
        image: url,
        mediaType: part.mediaType
      }
    }

    const attachmentId = attachmentIdFromUrl(url)
    if (attachmentId) {
      const blob = await getAttachmentBlob(attachmentId)
      if (!blob) {
        throw new Error(`Attachment '${attachmentId}' is no longer available.`)
      }

      return {
        type: "image" as const,
        image: await blobToUint8Array(blob),
        mediaType: part.mediaType || blob.type || "image/png"
      }
    }

    return {
      type: "image" as const,
      image: new URL(url),
      mediaType: part.mediaType
    }
  }

  return {
    type: "file" as const,
    data: new URL(url),
    mediaType: part.mediaType,
    filename: part.filename
  }
}

async function toModelMessages(messages: UIMessage[]): Promise<ModelMessage[]> {
  const modelMessages: ModelMessage[] = []

  for (const message of messages) {
    if (message.role === "system") {
      modelMessages.push({
        role: "system",
        content: extractUiMessageText(message)
      })
      continue
    }

    if (message.role === "assistant") {
      modelMessages.push({
        role: "assistant",
        content: extractUiMessageText(message)
      })
      continue
    }

    const parts = [] as Array<{ type: "text"; text: string } | Awaited<ReturnType<typeof filePartToModelPart>>>
    const text = extractUiMessageText(message)
    if (text) {
      parts.push({ type: "text", text })
    }

    for (const filePart of extractUiMessageFiles(message)) {
      parts.push(await filePartToModelPart(filePart))
    }

    modelMessages.push({
      role: "user",
      content: parts
    })
  }

  return modelMessages
}

function snippet(value?: string | null, maxLength = 120, fallback = "-") {
  if (!value?.trim()) {
    return fallback
  }

  return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}...` : value
}

function getAttachmentLabel(attachment: FlowContextAttachmentMeta, index: number, t: ReturnType<typeof useI18n>["t"]) {
  return attachment.captionText || attachment.altText || attachment.titleText || t("chat.attachments.capturedImage", { index: index + 1 })
}

function getAttachmentUrl(attachmentId: string) {
  return attachmentUrlFromId(attachmentId)
}

function buildContextAwarePrompt(attachmentPrompt: PendingPrompt | null, userText: string) {
  const cleanUserText = userText.trim()

  if (!attachmentPrompt) {
    return cleanUserText || "Please analyze the attached image."
  }

  if (!cleanUserText) {
    return attachmentPrompt.prompt
  }

  return `${attachmentPrompt.prompt}\n\n[User request]\n"""\n${cleanUserText}\n"""`
}

function getDisplayedLocator(flowContext: FlowContext) {
  return (
    flowContext.smartTarget?.locator?.xpath ||
    flowContext.smartTarget?.locator?.cssPath ||
    flowContext.selection?.anchorLocator?.xpath ||
    flowContext.selection?.anchorLocator?.cssPath ||
    flowContext.implicitContext?.locator?.xpath ||
    flowContext.implicitContext?.locator?.cssPath ||
    ""
  )
}

function createEditorState(flowContext: FlowContext): FlowContextEditorState {
  return {
    pageUrl: flowContext.page.url || "",
    locator: getDisplayedLocator(flowContext),
    selectedText: flowContext.selection?.text || "",
    smartTargetText: flowContext.smartTarget?.text || "",
    implicitContextText: flowContext.implicitContext?.text || ""
  }
}

function buildLocatorDescriptor(
  flowContext: FlowContext,
  locatorValue: string,
  textPreview: string
): NonNullable<NonNullable<FlowContext["smartTarget"]>["locator"]> | null {
  const cleanLocator = locatorValue.trim()
  if (!cleanLocator) {
    return null
  }

  const baseLocator = flowContext.smartTarget?.locator || flowContext.selection?.anchorLocator || flowContext.implicitContext?.locator || null
  return {
    ...(baseLocator ?? {}),
    xpath: cleanLocator,
    textPreview: textPreview || baseLocator?.textPreview || null
  }
}

function applyEditorState(flowContext: FlowContext, editorState: FlowContextEditorState): FlowContext {
  const pageUrl = editorState.pageUrl.trim()
  const selectedText = editorState.selectedText.trim()
  const smartTargetText = editorState.smartTargetText.trim()
  const implicitContextText = editorState.implicitContextText.trim()
  const textPreview = smartTargetText || selectedText || implicitContextText
  const locator = buildLocatorDescriptor(flowContext, editorState.locator, textPreview)

  return {
    ...flowContext,
    page: {
      ...flowContext.page,
      url: pageUrl
    },
    selection: selectedText || flowContext.selection
      ? {
          text: selectedText,
          textLength: selectedText.length,
          anchorLocator: locator,
          focusLocator: locator,
          rects: flowContext.selection?.rects ?? [],
          unionRect: flowContext.selection?.unionRect ?? null
        }
      : null,
    smartTarget:
      smartTargetText || locator || flowContext.smartTarget
        ? {
            kind: flowContext.smartTarget?.kind ?? "text",
            text: smartTargetText,
            textLength: smartTargetText.length,
            tag: flowContext.smartTarget?.tag ?? null,
            rect: flowContext.smartTarget?.rect ?? null,
            locator,
            mediaType: flowContext.smartTarget?.mediaType ?? null,
            sourceUrl: flowContext.smartTarget?.sourceUrl ?? null,
            attachmentId: flowContext.smartTarget?.attachmentId,
            activeCandidateIndex: flowContext.smartTarget?.activeCandidateIndex,
            candidates: flowContext.smartTarget?.candidates
          }
        : null,
    implicitContext: implicitContextText
      ? {
          text: implicitContextText,
          textLength: implicitContextText.length,
          locator
        }
      : null
  }
}

function getSafeMarkdownHref(href: string) {
  try {
    const parsed = new URL(href)
    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      return href
    }
  } catch {
    return null
  }

  return null
}

function normalizeDisplayMath(source: string) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  let codeFence: { marker: string; length: number } | null = null

  return lines.flatMap((line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      const length = fenceMatch[1].length
      if (!codeFence) {
        codeFence = { marker, length }
      } else if (marker === codeFence.marker && length >= codeFence.length && !fenceMatch[2].trim()) {
        codeFence = null
      }
      return [line]
    }

    if (!codeFence) {
      const displayMathMatch = line.match(/^\s*\$\$\s*(.+?)\s*\$\$\s*$/)
      if (displayMathMatch) {
        return ["$$", displayMathMatch[1], "$$"]
      }
    }

    return [line]
  }).join("\n")
}

const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  const normalizedText = useMemo(() => normalizeDisplayMath(text), [text])

  return (
    <div className="ichat-message-text is-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false, trust: false }]]}
        components={{
          a: ({ node: _node, href, children, className, ...props }) => {
            const safeHref = href ? getSafeMarkdownHref(href) : null
            if (!safeHref) {
              return <>{children}</>
            }

            return (
              <a
                {...props}
                href={safeHref}
                target="_blank"
                rel="noreferrer noopener"
                className={["ichat-markdown-link", className].filter(Boolean).join(" ")}>
                {children}
              </a>
            )
          },
          table: ({ node: _node, children, className, ...props }) => (
            <div className="ichat-table-scroll">
              <table {...props} className={["ichat-markdown-table", className].filter(Boolean).join(" ")}>
                {children}
              </table>
            </div>
          )
        }}>
        {normalizedText}
      </ReactMarkdown>
    </div>
  )
})

function ResolvedAttachmentImage(props: {
  url: string
  mediaType: string
  alt: string
  className: string
}) {
  const { url, mediaType, alt, className } = props
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    let objectUrl: string | null = null

    const load = async () => {
      if (url.startsWith("data:")) {
        setPreviewUrl(url)
        return
      }

      const attachmentId = attachmentIdFromUrl(url)
      if (!attachmentId) {
        setPreviewUrl(url)
        return
      }

      const blob = await getAttachmentBlob(attachmentId)
      if (!blob || !mounted) {
        return
      }

      objectUrl = createObjectUrlForBlob(blob)
      setPreviewUrl(objectUrl)
    }

    void load()

    return () => {
      mounted = false
      if (objectUrl) {
        revokeObjectUrl(objectUrl)
      }
    }
  }, [mediaType, url])

  if (!previewUrl || !mediaType.startsWith("image/")) {
    return null
  }

  return <img className={className} src={previewUrl} alt={alt} />
}

function AttachmentPreview(props: { part: FileUIPart }) {
  const { t } = useI18n()
  const { part } = props

  return (
    <ResolvedAttachmentImage
      url={part.url}
      mediaType={part.mediaType}
      alt={part.filename || t("chat.message.attachedImageAlt")}
      className="ichat-message-image"
    />
  )
}

const ChatBubble = memo(function ChatBubble({ message }: { message: UIMessage }) {
  const { t } = useI18n()
  const text = extractUiMessageText(message)
  const role = message.role
  const fileParts = extractUiMessageFiles(message)
  const rendersMarkdown = role === "assistant" || role === "user"
  const [copied, setCopied] = useState(false)

  if (!text && fileParts.length === 0) {
    return null
  }

  const handleCopy = async () => {
    if (!text) {
      return
    }

    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <article className={`ichat-message is-${role}`} data-message-id={message.id}>
      <div className="ichat-bubble">
        {fileParts.length > 0 ? (
          <div className="ichat-message-media-grid">
            {fileParts.map((part, index) => <AttachmentPreview key={`${message.id}-${index}-${part.url}`} part={part} />)}
          </div>
        ) : null}
        {text ? (rendersMarkdown ? <MarkdownMessage text={text} /> : <div className="ichat-message-text">{text}</div>) : null}
      </div>
      {text ? (
        <div className="ichat-message-tools">
          <button className="ichat-message-tool" type="button" aria-label={copied ? t("chat.message.copied") : t("chat.message.copy")} onClick={() => void handleCopy()}>
            {copied ? (
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.75 8.25L6.5 11L12.25 5.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="5.25" y="3.25" width="7.5" height="9" rx="1.75" stroke="currentColor" strokeWidth="1.4" />
                <path d="M10.25 3V2.75C10.25 1.7835 9.4665 1 8.5 1H4.75C3.7835 1 3 1.7835 3 2.75V9.25C3 10.2165 3.7835 11 4.75 11H5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            )}
          </button>
        </div>
      ) : null}
    </article>
  )
})

const ConversationHistory = memo(function ConversationHistory(props: {
  hydrated: boolean
  messages: UIMessage[]
  provider: ProviderId
  currentModel: string
}) {
  const { t } = useI18n()
  const { hydrated, messages, provider, currentModel } = props

  if (!hydrated) {
    return (
      <div className="ichat-thread-empty">
        <p className="ichat-empty-kicker">{t("chat.loading.kicker")}</p>
        <h2>{t("chat.loading.heading")}</h2>
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="ichat-thread-empty">
        <p className="ichat-empty-kicker">{t("chat.empty.kicker")}</p>
        <h2>{t("chat.empty.heading")}</h2>
        <p>
          {t("chat.empty.description", { providerLabel: providerLabels[provider], modelId: currentModel })}
        </p>
      </div>
    )
  }

  return <>{messages.map((message) => <ChatBubble key={message.id} message={message} />)}</>
})

function DraftContextItem(props: {
  open: boolean
  onOpen: () => void
  onRemove: () => void
}) {
  const { t } = useI18n()
  const { open, onOpen, onRemove } = props

  return (
    <div className="ichat-context-attachment-shell">
      <button
        className={`ichat-context-attachment ${open ? "is-open" : ""}`}
        type="button"
        onClick={onOpen}
        aria-expanded={open}
        aria-haspopup="dialog">
        <span className="ichat-context-card-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M4.75 2.75H9.5L12.25 5.5V12.25C12.25 12.6642 11.9142 13 11.5 13H4.5C4.08579 13 3.75 12.6642 3.75 12.25V3.75C3.75 3.33579 4.08579 3 4.5 3H8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9.25 2.75V5.75H12.25" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M5.75 8H10.25" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            <path d="M5.75 10.25H8.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </span>
        <span className="ichat-context-card-copy">
          <strong>{t("chat.attachments.contextTitle")}</strong>
          <small>{t("chat.attachments.contextSubtitle")}</small>
        </span>
      </button>
      <button
        className="ichat-attachment-dismiss"
        type="button"
        aria-label={t("chat.attachments.removeFlowContext")}
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4L12 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

function ImageAttachmentCard(props: {
  attachment: LocalImageAttachment
  removable: boolean
  onRemove?: () => void
  onPreview: () => void
}) {
  const { t } = useI18n()
  const { attachment, removable, onRemove, onPreview } = props

  return (
    <div className="ichat-image-card">
      <button className="ichat-image-card-main" type="button" onClick={onPreview} aria-label={t("chat.attachments.preview", { label: attachment.label })}>
        <span className="ichat-image-card-thumb-shell" aria-hidden="true">
          <ResolvedAttachmentImage
            url={attachment.url}
            mediaType={attachment.mediaType}
            alt={attachment.filename || attachment.label}
            className="ichat-image-card-thumb"
          />
        </span>
        <span className="ichat-image-card-copy">
          <strong>{attachment.filename || attachment.label}</strong>
          <small>{t("chat.attachments.clickToPreview")}</small>
        </span>
      </button>
      {removable ? (
        <button
          className="ichat-attachment-dismiss"
          type="button"
          aria-label={t("chat.attachments.remove", { label: attachment.label })}
          onClick={(event) => {
            event.stopPropagation()
            onRemove?.()
          }}>
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4L12 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}

function ImagePreviewModal(props: {
  attachment: LocalImageAttachment
  onClose: () => void
}) {
  const { t } = useI18n()
  const { attachment, onClose } = props

  return (
    <div className="ichat-modal-overlay" role="presentation" onClick={onClose}>
      <section
        className="ichat-image-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.attachments.preview", { label: attachment.filename || attachment.label })}
        onClick={(event) => event.stopPropagation()}>
        <button className="ichat-icon-button is-dismiss" type="button" aria-label={t("chat.attachments.closeImagePreview")} onClick={onClose}>
          <svg className="ichat-dismiss-icon" aria-hidden="true" viewBox="0 0 20 20" fill="none">
            <path d="M5 5L15 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <div className="ichat-image-modal-meta">
          <strong>{attachment.filename || attachment.label}</strong>
        </div>
        <ResolvedAttachmentImage
          url={attachment.url}
          mediaType={attachment.mediaType}
          alt={attachment.filename || attachment.label}
          className="ichat-image-modal-preview"
        />
      </section>
    </div>
  )
}

function DraftContextModal(props: {
  flowContext: FlowContext
  promptPreview: string
  pendingPrompt: PendingPrompt
  editorState: FlowContextEditorState
  readOnly: boolean
  onChange: (field: keyof FlowContextEditorState, value: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const { flowContext, promptPreview, pendingPrompt, editorState, readOnly, onChange, onClose } = props
  const mode = getFlowContextMode(flowContext)

  return (
    <div className="ichat-modal-overlay" role="presentation" onClick={onClose}>
      <section
        className="ichat-context-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.contextModal.ariaLabel")}
        onClick={(event) => event.stopPropagation()}>
        <button className="ichat-icon-button is-dismiss" type="button" aria-label={t("chat.contextModal.close")} onClick={onClose}>
          <svg className="ichat-dismiss-icon" aria-hidden="true" viewBox="0 0 20 20" fill="none">
            <path d="M5 5L15 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <div className="ichat-context-modal-head">
          <div>
            <p className="ichat-eyebrow">{t("chat.attachments.contextTitle")}</p>
            <h3>{flowContext.page.title || t("settings.context.pageUntitled")}</h3>
            <p className="ichat-subtitle">
              {t("chat.contextModal.subtitle")}
            </p>
          </div>
          <div className="ichat-context-modal-head-meta">
            <span className="ichat-badge">{mode === "selection" ? t("chat.contextModal.mode.selection") : t("chat.contextModal.mode.smartDom")}</span>
          </div>
        </div>

        <div className="ichat-context-modal-scroll">
          <div className="ichat-context-editor-grid">
            <label className="ichat-context-editor-field is-full">
              <span>{t("chat.contextModal.url")}</span>
              <input
                className="ichat-context-editor-input"
                type="text"
                value={editorState.pageUrl}
                disabled={readOnly}
                onChange={(event) => onChange("pageUrl", event.target.value)}
              />
            </label>

            <label className="ichat-context-editor-field is-full">
              <span>{t("chat.contextModal.locator")}</span>
              <textarea
                className="ichat-context-editor-textarea is-compact"
                rows={2}
                value={editorState.locator}
                disabled={readOnly}
                onChange={(event) => onChange("locator", event.target.value)}
              />
            </label>

            <label className="ichat-context-editor-field is-full">
              <span>{t("chat.contextModal.selectedText")}</span>
              <textarea
                className="ichat-context-editor-textarea"
                rows={5}
                value={editorState.selectedText}
                disabled={readOnly}
                onChange={(event) => onChange("selectedText", event.target.value)}
              />
              <small>{snippet(editorState.selectedText, 96, t("common.empty"))}</small>
            </label>

            <label className="ichat-context-editor-field">
              <span>{t("chat.contextModal.smartTarget")}</span>
              <textarea
                className="ichat-context-editor-textarea"
                rows={5}
                value={editorState.smartTargetText}
                disabled={readOnly}
                onChange={(event) => onChange("smartTargetText", event.target.value)}
              />
              <small>{snippet(editorState.smartTargetText, 96, t("common.empty"))}</small>
            </label>

            <label className="ichat-context-editor-field">
              <span>{t("chat.contextModal.implicitContext")}</span>
              <textarea
                className="ichat-context-editor-textarea"
                rows={5}
                value={editorState.implicitContextText}
                disabled={readOnly}
                onChange={(event) => onChange("implicitContextText", event.target.value)}
              />
              <small>{snippet(editorState.implicitContextText, 96, t("common.empty"))}</small>
            </label>
          </div>

          <div className="ichat-prompt-preview is-modal-preview">
            <span>{t("chat.contextModal.promptPreview")}</span>
            <pre>{promptPreview}</pre>
          </div>

          {pendingPrompt.error ? <div className="ichat-banner is-warning">{pendingPrompt.error}</div> : null}
        </div>
      </section>
    </div>
  )
}

export function ProviderConversation({ provider, settings, apiKeys, pendingPrompt, flowContext, threadClearSignal, searchOpenSignal, settingsOpen }: ProviderConversationProps) {
  const { t, locale } = useI18n()
  const currentModel = getProviderModel(settings, provider)
  const currentKey = getProviderKey(provider, apiKeys)
  const [hydrated, setHydrated] = useState(false)
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [composerText, setComposerText] = useState("")
  const dictation = useDictation(locale === "zh-CN" ? "zh-CN" : "en-US", setComposerText)
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [errorBanner, setErrorBanner] = useState<string | null>(null)
  const [draftContextOpen, setDraftContextOpen] = useState(false)
  const [editorState, setEditorState] = useState<FlowContextEditorState | null>(null)
  const [composerAttachments, setComposerAttachments] = useState<LocalImageAttachment[]>([])
  const [previewAttachment, setPreviewAttachment] = useState<LocalImageAttachment | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchSessionActive, setSearchSessionActive] = useState(false)
  const [activeSearchIndex, setActiveSearchIndex] = useState(0)
  const [searchNavigationSignal, setSearchNavigationSignal] = useState(0)

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const threadContentRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const messagesRef = useRef<UIMessage[]>([])
  const isBusyRef = useRef(false)
  const shouldStickToBottomRef = useRef(true)
  const lastPersistedJsonRef = useRef("[]")
  const abortControllerRef = useRef<AbortController | null>(null)
  const activePendingIdRef = useRef<string | null>(null)
  const activeEditorContextIdRef = useRef<string | null>(null)
  const lastEditorSignatureRef = useRef("")
  const lastSearchOpenSignalRef = useRef(searchOpenSignal)

  useEffect(() => {
    dictation.cancel()
  }, [provider, locale, threadClearSignal, isBusy, settingsOpen, dictation.cancel])

  useEffect(() => {
    const input = composerInputRef.current
    if (!input) return
    input.style.height = "auto"
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`
  }, [composerText])

  const closeConversationSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchSessionActive(false)
    setActiveSearchIndex(0)
  }, [])

  useEffect(() => {
    const abortActiveRequest = () => {
      abortControllerRef.current?.abort()
    }

    window.addEventListener("pagehide", abortActiveRequest)

    return () => {
      window.removeEventListener("pagehide", abortActiveRequest)
      abortActiveRequest()
    }
  }, [])

  const attachmentPrompt = useMemo(() => {
    if (!pendingPrompt || pendingPrompt.provider !== provider) {
      return null
    }

    if (!["draft", "processing", "error"].includes(pendingPrompt.status)) {
      return null
    }

    if (isAutoSendEnabled(settings) && !pendingPrompt.requiresVision && pendingPrompt.attachmentIds.length === 0) {
      return null
    }

    return pendingPrompt
  }, [pendingPrompt, provider, settings])

  const attachmentFlowContext = useMemo(() => {
    if (!attachmentPrompt || !flowContext || flowContext.id !== attachmentPrompt.flowContextId) {
      return null
    }

    return flowContext
  }, [attachmentPrompt, flowContext])

  const contextImageAttachments = useMemo<LocalImageAttachment[]>(() => {
    const attachments = attachmentFlowContext?.attachments ?? []
    return attachments
      .filter((attachment) => attachment.kind === "image" && attachment.blobStoreKey)
      .map((attachment, index) => ({
        id: attachment.id,
        mediaType: attachment.normalizedMimeType || attachment.mimeType || "image/png",
        filename: attachment.filename || undefined,
        label: getAttachmentLabel(attachment, index, t),
        url: getAttachmentUrl(attachment.id),
        source: "flow-context"
      }))
  }, [attachmentFlowContext, t])

  const liveEditedFlowContext = useMemo(() => {
    if (!attachmentFlowContext) {
      return null
    }

    if (!editorState) {
      return attachmentFlowContext
    }

    return applyEditorState(attachmentFlowContext, editorState)
  }, [attachmentFlowContext, editorState])

  const livePromptPreview = useMemo(() => {
    if (!liveEditedFlowContext) {
      return attachmentPrompt?.prompt ?? ""
    }

    return composeFlowPrompt(liveEditedFlowContext)
  }, [attachmentPrompt?.prompt, liveEditedFlowContext])

  const allActiveAttachments = useMemo(() => [...contextImageAttachments, ...composerAttachments], [composerAttachments, contextImageAttachments])
  const visionBlocked = allActiveAttachments.length > 0 && !supportsVisionInput(provider, currentModel)
  const visionBlockedMessage = getVisionBlockedMessage(provider, currentModel, t)
  const normalizedSearchQuery = searchQuery.trim()
  const deferredSearchQuery = useDeferredValue(normalizedSearchQuery)
  const activeSearchQuery = searchSessionActive && normalizedSearchQuery ? deferredSearchQuery : ""
  const searchMatches = useMemo(
    () => getConversationSearchMatches(messages, activeSearchQuery),
    [activeSearchQuery, messages]
  )
  const activeSearchMessageId = searchMatches[activeSearchIndex] ?? null

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    isBusyRef.current = isBusy
  }, [isBusy])

  useEffect(() => {
    if (threadClearSignal === 0) {
      return
    }

    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    activePendingIdRef.current = null
    shouldStickToBottomRef.current = true
    lastPersistedJsonRef.current = "[]"
    messagesRef.current = []
    setMessages([])
    setIsBusy(false)
    setErrorBanner(null)
    setSearchOpen(false)
    setSearchQuery("")
    setSearchSessionActive(false)
    setActiveSearchIndex(0)
  }, [threadClearSignal])

  useEffect(() => {
    if (!searchOpen) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [searchOpen])

  useEffect(() => {
    if (searchOpenSignal === lastSearchOpenSignalRef.current) {
      return
    }

    lastSearchOpenSignalRef.current = searchOpenSignal
    setSearchOpen(true)

    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [searchOpenSignal])

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f" && hydrated && messages.length > 0) {
        event.preventDefault()
        setSearchOpen(true)
        return
      }

      if (event.key === "Escape" && searchOpen) {
        event.preventDefault()
        closeConversationSearch()
      }
    }

    window.addEventListener("keydown", handleSearchShortcut)
    return () => window.removeEventListener("keydown", handleSearchShortcut)
  }, [closeConversationSearch, hydrated, messages.length, searchOpen])

  useEffect(() => {
    setActiveSearchIndex(0)
  }, [activeSearchQuery])

  useEffect(() => {
    setActiveSearchIndex((current) => {
      if (searchMatches.length === 0) {
        return 0
      }

      return Math.min(current, searchMatches.length - 1)
    })
  }, [searchMatches.length])

  useEffect(() => {
    const content = threadContentRef.current
    clearConversationSearchHighlights(content)

    if (!searchOpen || !activeSearchQuery || !content || searchMatches.length === 0) {
      return
    }

    const matchingIds = new Set(searchMatches)
    const regularRanges: Range[] = []
    const activeRanges: Range[] = []

    content.querySelectorAll<HTMLElement>(".ichat-message[data-message-id]").forEach((messageElement) => {
      const messageId = messageElement.dataset.messageId
      if (!messageId || !matchingIds.has(messageId)) {
        return
      }

      const isActive = messageId === activeSearchMessageId
      messageElement.classList.add("is-search-match")
      messageElement.classList.toggle("is-active-search-match", isActive)

      messageElement.querySelectorAll<HTMLElement>(".ichat-message-text").forEach((textElement) => {
        const ranges = getTextSearchRanges(textElement, activeSearchQuery)
        if (isActive) {
          activeRanges.push(...ranges)
        } else {
          regularRanges.push(...ranges)
        }
      })
    })

    const highlights = getSearchHighlightRegistry()
    if (highlights && typeof Highlight !== "undefined") {
      if (regularRanges.length > 0) {
        highlights.set(SEARCH_MATCH_HIGHLIGHT, new Highlight(...regularRanges))
      }
      if (activeRanges.length > 0) {
        highlights.set(SEARCH_ACTIVE_HIGHLIGHT, new Highlight(...activeRanges))
      }
    }

    const activeElement = Array.from(content.querySelectorAll<HTMLElement>(".ichat-message[data-message-id]"))
      .find((element) => element.dataset.messageId === activeSearchMessageId)
    const viewport = viewportRef.current
    if (activeElement && viewport) {
      shouldStickToBottomRef.current = false
      const viewportRect = viewport.getBoundingClientRect()
      const activeRect = activeElement.getBoundingClientRect()
      const targetTop = viewport.scrollTop + activeRect.top - viewportRect.top - (viewport.clientHeight - activeRect.height) / 2
      viewport.scrollTo({
        top: Math.max(0, targetTop),
        behavior: "smooth"
      })
    }

    return () => clearConversationSearchHighlights(content)
  }, [activeSearchMessageId, activeSearchQuery, searchMatches, searchNavigationSignal, searchOpen])

  const scrollThreadToBottom = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: "auto"
    })
  }, [])

  useEffect(() => {
    if (!attachmentPrompt || !attachmentFlowContext) {
      setDraftContextOpen(false)
      setEditorState(null)
      activeEditorContextIdRef.current = null
      lastEditorSignatureRef.current = ""
      return
    }

    if (draftContextOpen && activeEditorContextIdRef.current !== attachmentFlowContext.id) {
      const nextEditorState = createEditorState(attachmentFlowContext)
      setEditorState(nextEditorState)
      activeEditorContextIdRef.current = attachmentFlowContext.id
      lastEditorSignatureRef.current = JSON.stringify(nextEditorState)
    }
  }, [attachmentFlowContext, attachmentPrompt, draftContextOpen])

  useEffect(() => {
    if (!draftContextOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDraftContextOpen(false)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [draftContextOpen])

  useEffect(() => {
    if (!previewAttachment) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewAttachment(null)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [previewAttachment])

  useEffect(() => {
    if (!draftContextOpen || !attachmentFlowContext || !editorState) {
      return
    }

    const nextSignature = JSON.stringify(editorState)
    if (nextSignature === lastEditorSignatureRef.current) {
      return
    }

    const timer = window.setTimeout(() => {
      lastEditorSignatureRef.current = nextSignature
      void updateFlowContextDraft(applyEditorState(attachmentFlowContext, editorState))
    }, 180)

    return () => window.clearTimeout(timer)
  }, [attachmentFlowContext, draftContextOpen, editorState])

  useEffect(() => {
    if (!hydrated) {
      return
    }

    if (!shouldStickToBottomRef.current) {
      return
    }

    const frame = window.requestAnimationFrame(scrollThreadToBottom)

    return () => window.cancelAnimationFrame(frame)
  }, [hydrated, messages, scrollThreadToBottom])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const updateStickiness = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      shouldStickToBottomRef.current = distanceFromBottom <= 72
    }

    updateStickiness()
    viewport.addEventListener("scroll", updateStickiness, { passive: true })
    return () => viewport.removeEventListener("scroll", updateStickiness)
  }, [])

  useEffect(() => {
    if (!hydrated) {
      return
    }

    const content = threadContentRef.current
    if (!content || typeof ResizeObserver === "undefined") {
      return
    }

    const observer = new ResizeObserver(() => {
      if (shouldStickToBottomRef.current) {
        scrollThreadToBottom()
      }
    })

    observer.observe(content)
    return () => observer.disconnect()
  }, [hydrated, scrollThreadToBottom])

  useEffect(() => {
    let cancelled = false

    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    activePendingIdRef.current = null
    setIsBusy(false)
    setErrorBanner(null)
    setComposerText("")
    setComposerAttachments([])
    setDraftContextOpen(false)
    setPreviewAttachment(null)
    setSearchOpen(false)
    setSearchQuery("")
    setSearchSessionActive(false)
    setActiveSearchIndex(0)
    setEditorState(null)
    activeEditorContextIdRef.current = null
    lastEditorSignatureRef.current = ""
    setHydrated(false)

    void getChatThreads().then((threads) => {
      if (cancelled) {
        return
      }

      const nextMessages = threads[provider] ?? []
      const nextJson = JSON.stringify(nextMessages)
      lastPersistedJsonRef.current = nextJson
      messagesRef.current = nextMessages
      setMessages(nextMessages)
      setHydrated(true)
    })

    return () => {
      cancelled = true
    }
  }, [provider])

  useEffect(() => {
    if (!hydrated) {
      return
    }

    const nextJson = JSON.stringify(messages)
    if (nextJson === lastPersistedJsonRef.current) {
      return
    }

    const timer = window.setTimeout(() => {
      lastPersistedJsonRef.current = nextJson
      void setChatThread(provider, messages)
    }, 120)

    return () => window.clearTimeout(timer)
  }, [hydrated, messages, provider])

  const removeFlowContextAttachment = useCallback(async (attachmentId: string) => {
    if (!attachmentFlowContext) {
      return
    }

    const nextAttachments = attachmentFlowContext.attachments.filter((attachment) => attachment.id !== attachmentId)
    const nextPrimaryAttachmentId = nextAttachments.find((attachment) => attachment.kind === "image" && attachment.blobStoreKey)?.id || null
    const nextPrimaryCaptureKind = nextPrimaryAttachmentId ? "image" : attachmentFlowContext.selection?.text ? "text" : attachmentFlowContext.smartTarget?.kind === "video" ? "video" : "text"

    const nextFlowContext: FlowContext = {
      ...attachmentFlowContext,
      attachments: nextAttachments,
      primaryAttachmentId: nextPrimaryAttachmentId,
      primaryCaptureKind: nextPrimaryCaptureKind,
      smartTarget: attachmentFlowContext.smartTarget?.attachmentId === attachmentId
        ? {
            ...attachmentFlowContext.smartTarget,
            attachmentId: undefined,
            kind: "text",
            sourceUrl: null,
            mediaType: null
          }
        : attachmentFlowContext.smartTarget
    }

    if (previewAttachment?.id === attachmentId) {
      setPreviewAttachment(null)
    }

    await updateFlowContextDraft(nextFlowContext)
  }, [attachmentFlowContext, previewAttachment?.id])

  const removeDraftContext = useCallback(async () => {
    setDraftContextOpen(false)
    setPreviewAttachment(null)

    await Promise.all([
      setFlowContext(null),
      setPendingPrompt(null),
      setDispatchStatus(dispatchStatusPayload("idle", t("state.clearedContext"), provider, null))
    ])
  }, [provider, t])

  const removeComposerAttachment = useCallback((attachmentId: string) => {
    if (previewAttachment?.id === attachmentId) {
      setPreviewAttachment(null)
    }

    setComposerAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))
  }, [previewAttachment?.id])

  const buildFilePartsForAttachments = useCallback((attachments: LocalImageAttachment[]) => {
    return attachments.map(createFilePart)
  }, [])

  const runSendPipeline = useCallback(
    async (
      text: string,
      origin: "manual" | "pending",
      pending: PendingPrompt | null = null,
      requestText = text,
      fileParts: FileUIPart[] = []
    ) => {
      const displayValue = text.trim()
      const requestValue = requestText.trim()
      const hasImageParts = fileParts.some((part) => part.mediaType.startsWith("image/"))

      if ((!displayValue && !requestValue && fileParts.length === 0) || isBusyRef.current) {
        return false
      }

      if (hasImageParts && !supportsVisionInput(provider, currentModel)) {
        const message = getVisionBlockedMessage(provider, currentModel, t)
        setErrorBanner(message)
        await setDispatchStatus(dispatchStatusPayload("error", message, provider, pending?.flowContextId ?? null))

        if (pending) {
          await setPendingPrompt({
            ...pending,
            status: "error",
            error: message
          })
        }

        return false
      }

      if (!currentKey) {
        const message = t("errors.missingApiKey", { providerLabel: providerLabels[provider] })
        setErrorBanner(message)
        await setDispatchStatus(dispatchStatusPayload("error", message, provider, pending?.flowContextId ?? null))

        if (pending) {
          await setPendingPrompt({
            ...pending,
            status: pending.status === "pending" ? "error" : pending.status,
            error: message
          })
        }

        return false
      }

      const displayMessage = createMessage("user", displayValue || requestValue, fileParts)
      const requestMessage = createMessage("user", requestValue || displayValue, fileParts)
      const displayedHistory = messagesRef.current
      const requestMessages = [...limitHistoryMessages(displayedHistory, settings.data.historyMessageLimit), requestMessage]
      const assistantMessageId = createRandomId()
      const optimisticMessages = [...displayedHistory, displayMessage, createMessage("assistant", "", [], assistantMessageId)]
      shouldStickToBottomRef.current = true
      messagesRef.current = optimisticMessages
      setMessages(optimisticMessages)
      setIsBusy(true)
      setErrorBanner(null)

      const controller = new AbortController()
      abortControllerRef.current = controller

      if (pending) {
        activePendingIdRef.current = pending.id
        await setPendingPrompt({
          ...pending,
          status: "processing",
          error: null
        })
        await setDispatchStatus(
          dispatchStatusPayload("sending", t("state.sendingContext", { providerLabel: providerLabels[provider] }), provider, pending.flowContextId)
        )
      }

      try {
        const modelMessages = await toModelMessages(requestMessages)
        const responseText = await streamProviderResponse(provider, apiKeys, settings, modelMessages, controller.signal, (partialText) => {
          const streamedMessages = replaceMessageText(messagesRef.current, assistantMessageId, partialText)
          messagesRef.current = streamedMessages
          setMessages(streamedMessages)
        })

        const finalText = responseText || t("errors.noResponseReturned")
        const finalMessages = replaceMessageText(messagesRef.current, assistantMessageId, finalText)
        messagesRef.current = finalMessages
        setMessages(finalMessages)

        if (pending) {
          await setPendingPrompt(null)
          await setDispatchStatus(
            dispatchStatusPayload("sent", t("state.sentContext", { providerLabel: providerLabels[provider] }), provider, pending.flowContextId)
          )
        }

        return true
      } catch (error) {
        const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError")
        const message = cancelled ? t("errors.requestCancelled") : formatProviderError(provider, currentModel, currentKey, error, t)
        const currentAssistant = messagesRef.current.find((entry) => entry.id === assistantMessageId)
        const hasPartialAssistantText = Boolean(currentAssistant && extractUiMessageText(currentAssistant))

        setErrorBanner(message)

        if (cancelled) {
          if (!hasPartialAssistantText) {
            const prunedMessages = removeMessage(messagesRef.current, assistantMessageId)
            messagesRef.current = prunedMessages
            setMessages(prunedMessages)
          }
        } else {
          const finalMessages = replaceMessageText(messagesRef.current, assistantMessageId, message)
          messagesRef.current = finalMessages
          setMessages(finalMessages)
        }

        if (pending) {
          await setPendingPrompt({
            ...pending,
            status: cancelled ? "draft" : "error",
            error: message
          })
          await setDispatchStatus(dispatchStatusPayload("error", message, provider, pending.flowContextId))
        } else if (!cancelled) {
          await setDispatchStatus(dispatchStatusPayload("error", message, provider, null))
        }

        return false
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null
        }
        if (pending) {
          activePendingIdRef.current = null
        }
        setIsBusy(false)
      }
    },
    [apiKeys, currentKey, currentModel, provider, settings, t]
  )

  useEffect(() => {
    if (!hydrated || !pendingPrompt || pendingPrompt.provider !== provider) {
      return
    }

    if (pendingPrompt.status !== "pending" || isBusyRef.current) {
      return
    }

    if (activePendingIdRef.current === pendingPrompt.id) {
      return
    }

    const pendingAttachments = (flowContext?.attachments || [])
      .filter((attachment) => pendingPrompt.attachmentIds.includes(attachment.id) && attachment.kind === "image" && attachment.blobStoreKey)
      .map((attachment, index) => ({
        id: attachment.id,
        mediaType: attachment.normalizedMimeType || attachment.mimeType || "image/png",
        filename: attachment.filename || undefined,
        label: getAttachmentLabel(attachment, index, t),
        url: getAttachmentUrl(attachment.id),
        source: "flow-context" as const
      }))

    void runSendPipeline(
      pendingPrompt.prompt,
      "pending",
      pendingPrompt,
      pendingPrompt.prompt,
      buildFilePartsForAttachments(pendingAttachments)
    )
  }, [buildFilePartsForAttachments, flowContext, hydrated, pendingPrompt, provider, runSendPipeline, t])

  const handleEditorChange = useCallback((field: keyof FlowContextEditorState, value: string) => {
    setEditorState((current) => {
      if (!current) {
        return current
      }

      return {
        ...current,
        [field]: value
      }
    })
  }, [])

  const handleComposerPaste = useCallback(async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items || [])
    const imageItems = items.filter((item) => item.type.startsWith("image/"))
    if (!imageItems.length) {
      return
    }

    event.preventDefault()
    const nextAttachments: LocalImageAttachment[] = []

    for (const [index, item] of imageItems.entries()) {
      const file = item.getAsFile()
      if (!file) {
        continue
      }

      const attachmentId = createRandomId()
      const filename = file.name || `pasted-image-${index + 1}.${file.type.includes("svg") ? "svg" : file.type.includes("png") ? "png" : "jpg"}`
      const normalized = await normalizeImageBlob(file, filename)
      await putAttachmentBlob({
        id: attachmentId,
        blob: normalized.blob,
        mediaType: normalized.mediaType,
        filename: normalized.filename
      })

      nextAttachments.push({
        id: attachmentId,
        mediaType: normalized.mediaType,
        filename: normalized.filename,
        label: normalized.filename || filename,
        url: getAttachmentUrl(attachmentId),
        source: "composer"
      })
    }

    if (nextAttachments.length > 0) {
      setComposerAttachments((current) => [...current, ...nextAttachments])
    }
  }, [])

  const handleComposerSubmit = useCallback(async () => {
    if (isBusyRef.current || dictation.active || visionBlocked) return
    const value = composerText.trim()
    const hasComposerImages = composerAttachments.length > 0
    if (!value && !attachmentPrompt && !hasComposerImages) {
      return
    }

    let contextDraft = attachmentPrompt && attachmentFlowContext ? attachmentPrompt : null

    if (contextDraft && attachmentFlowContext) {
      const nextFlowContext = editorState ? applyEditorState(attachmentFlowContext, editorState) : attachmentFlowContext
      await updateFlowContextDraft(nextFlowContext)
      contextDraft = {
        ...contextDraft,
        attachmentIds: nextFlowContext.attachments.filter((attachment) => attachment.kind === "image" && attachment.blobStoreKey).map((attachment) => attachment.id),
        requiresVision: nextFlowContext.attachments.some((attachment) => attachment.kind === "image" && attachment.blobStoreKey),
        prompt: composeFlowPrompt(nextFlowContext)
      }
      setDraftContextOpen(false)
    }

    const requestText = buildContextAwarePrompt(contextDraft, value)
    const fileParts = buildFilePartsForAttachments([...contextImageAttachments, ...composerAttachments])

    if (!currentKey) {
      await runSendPipeline(value || requestText, "manual", contextDraft, requestText, fileParts)
      return
    }

    setComposerText("")
    setComposerAttachments([])
    await runSendPipeline(value || requestText, "manual", contextDraft, requestText, fileParts)
  }, [attachmentFlowContext, attachmentPrompt, buildFilePartsForAttachments, composerAttachments, composerText, contextImageAttachments, currentKey, dictation.active, editorState, runSendPipeline, visionBlocked])

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort()
  }, [])

  const moveSearchResult = useCallback((direction: -1 | 1) => {
    if (searchMatches.length === 0) {
      return
    }

    setActiveSearchIndex((current) => (current + direction + searchMatches.length) % searchMatches.length)
    setSearchNavigationSignal((current) => current + 1)
  }, [searchMatches.length])

  const missingKey = !currentKey
  const modalReadOnly = isBusy || attachmentPrompt?.status === "processing"
  const canSubmit = !isBusy && !dictation.active && !visionBlocked && (Boolean(composerText.trim()) || Boolean(attachmentPrompt) || composerAttachments.length > 0)
  const sendLabel = isBusy ? t("chat.composer.stop") : allActiveAttachments.length > 0 ? t("chat.composer.sendWithImages") : attachmentPrompt ? t("chat.composer.sendWithContext") : t("chat.composer.send")
  const dictationLabel = dictation.active ? t("chat.dictation.stop") : t("chat.dictation.start")
  const activeBanner = visionBlocked ? visionBlockedMessage : errorBanner

  return (
    <div className="ichat-conversation-shell">
      {missingKey ? (
        <div className="ichat-banner is-warning">
          {t("chat.banner.missingApiKey", { providerLabel: providerLabels[provider] })}
        </div>
      ) : null}

      {!missingKey && activeBanner ? <div className="ichat-banner is-warning">{activeBanner}</div> : null}

      <div className="ichat-thread-root">
        {searchOpen ? (
          <div className="ichat-thread-search is-open">
            <label className="ichat-thread-search-field">
                <span className="ichat-thread-search-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none">
                    <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M10.25 10.25L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </span>
                <input
                  ref={searchInputRef}
                  className="ichat-thread-search-input"
                  type="search"
                  value={searchQuery}
                  aria-label={t("chat.search.inputLabel")}
                  placeholder={t("chat.search.placeholder")}
                  onChange={(event) => {
                    setSearchQuery(event.target.value)
                    setSearchSessionActive(true)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      if (!searchSessionActive && normalizedSearchQuery) {
                        setSearchSessionActive(true)
                        return
                      }
                      moveSearchResult(event.shiftKey ? -1 : 1)
                    }
                  }}
                />
            </label>
            <output className={`ichat-thread-search-count ${activeSearchQuery && searchMatches.length === 0 ? "is-empty" : ""}`} aria-live="polite">
                {!activeSearchQuery
                  ? t("chat.search.ready")
                  : searchMatches.length > 0
                    ? t("chat.search.resultCount", { current: activeSearchIndex + 1, total: searchMatches.length })
                    : t("chat.search.noResults")}
            </output>
            <button
                className="ichat-thread-search-button"
                type="button"
                aria-label={t("chat.search.previous")}
                title={t("chat.search.previous")}
                disabled={searchMatches.length === 0}
                onClick={() => moveSearchResult(-1)}>
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3.5 10L8 5.5L12.5 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
            <button
                className="ichat-thread-search-button"
                type="button"
                aria-label={t("chat.search.next")}
                title={t("chat.search.next")}
                disabled={searchMatches.length === 0}
                onClick={() => moveSearchResult(1)}>
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3.5 6L8 10.5L12.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
            <button
                className="ichat-thread-search-button"
                type="button"
                aria-label={t("chat.search.close")}
                title={t("chat.search.close")}
                onClick={closeConversationSearch}>
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4L12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
            </button>
          </div>
        ) : null}
          <div ref={viewportRef} className="ichat-thread-viewport">
          <div ref={threadContentRef} className="ichat-thread-stack">
            <ConversationHistory
              hydrated={hydrated}
              messages={messages}
              provider={provider}
              currentModel={currentModel}
            />
          </div>
        </div>
      </div>

      <div className={`ichat-composer-shell${dictation.active ? " is-listening" : ""}`}>
        {attachmentPrompt || allActiveAttachments.length > 0 ? (
          <div className="ichat-composer-attachments">
            {attachmentPrompt && attachmentFlowContext ? (
              <DraftContextItem
                open={draftContextOpen}
                onOpen={() => setDraftContextOpen(true)}
                onRemove={() => void removeDraftContext()}
              />
            ) : null}
            {contextImageAttachments.map((attachment) => (
              <ImageAttachmentCard
                key={`ctx-${attachment.id}`}
                attachment={attachment}
                removable
                onRemove={() => void removeFlowContextAttachment(attachment.id)}
                onPreview={() => setPreviewAttachment(attachment)}
              />
            ))}
            {composerAttachments.map((attachment) => (
              <ImageAttachmentCard
                key={`composer-${attachment.id}`}
                attachment={attachment}
                removable
                onRemove={() => removeComposerAttachment(attachment.id)}
                onPreview={() => setPreviewAttachment(attachment)}
              />
            ))}
          </div>
        ) : null}

        <textarea
          ref={composerInputRef}
          className="ichat-composer-input"
          rows={2}
          value={composerText}
          aria-label={t("chat.composer.inputLabel")}
          readOnly={dictation.active}
          placeholder={
            attachmentPrompt
              ? t("chat.composer.placeholder.withContext")
              : composerAttachments.length
                ? t("chat.composer.placeholder.withImages")
                : t("chat.composer.placeholder.default")
          }
          onChange={(event) => setComposerText(event.target.value)}
          onPaste={(event) => void handleComposerPaste(event)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && dictation.active) {
              event.preventDefault()
              dictation.stop()
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault()
              if (canSubmit) void handleComposerSubmit()
            }
          }}
        />
        <div className="ichat-composer-actions">
          <span className="ichat-dictation-status" role="status">
            {dictation.phase !== "idle" ? t(`chat.dictation.${dictation.phase}`) : null}
          </span>
          <button
            className={`ichat-composer-button${dictation.active ? " is-recording" : ""}`}
            type="button"
            aria-label={dictationLabel}
            title={dictation.active ? dictationLabel : `${dictationLabel} · ${t("chat.dictation.service")}`}
            aria-pressed={dictation.active}
            disabled={isBusy || dictation.phase === "stopping"}
            onClick={() => {
              if (dictation.active) {
                dictation.stop()
              } else {
                const input = composerInputRef.current
                dictation.start(composerText, input?.selectionStart, input?.selectionEnd)
              }
            }}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.7" />
              <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-3 0h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="ichat-composer-button is-send"
            type="button"
            aria-label={sendLabel}
            title={sendLabel}
            onClick={isBusy ? handleStop : () => void handleComposerSubmit()}
            disabled={!isBusy && !canSubmit}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              {isBusy ? <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" /> :
                <path d="M12 19V5m-6 6 6-6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          </button>
        </div>
        {dictation.error ? (
          <div className="ichat-dictation-error" role="alert">
            {t(`chat.dictation.error.${dictation.error}`)}
            {dictation.error === "permission" ? (
              <a href={chrome.runtime.getURL(`tabs/microphone.html?lang=${locale}`)} target="_blank" rel="noreferrer">
                {t("chat.dictation.permission.open")}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>

      {draftContextOpen && attachmentPrompt && attachmentFlowContext && editorState ? (
        <DraftContextModal
          flowContext={liveEditedFlowContext ?? attachmentFlowContext}
          promptPreview={livePromptPreview}
          pendingPrompt={attachmentPrompt}
          editorState={editorState}
          readOnly={modalReadOnly}
          onChange={handleEditorChange}
          onClose={() => setDraftContextOpen(false)}
        />
      ) : null}

      {previewAttachment ? <ImagePreviewModal attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} /> : null}
    </div>
  )
}
