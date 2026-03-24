import type { ModelMessage, UIMessage } from "ai"
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ClipboardEvent as ReactClipboardEvent, ReactNode } from "react"
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
import { composeFlowPrompt, dispatchStatusPayload, getFlowContextMode, getProviderModel, isAutoSendEnabled, providerLabels } from "../lib/prompt-builder"
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
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6
type TableAlignment = "left" | "center" | "right"
type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: HeadingLevel; text: string }
  | { type: "blockquote"; text: string }
  | { type: "code"; language: string | null; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; alignments: TableAlignment[]; rows: string[][] }

const UNSUPPORTED_MODEL_IMAGE_MEDIA_TYPES = new Set(["image/svg+xml"])

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

function createMessage(role: UIMessage["role"], text: string, fileParts: FileUIPart[] = [], id = crypto.randomUUID()): UIMessage {
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

function getAttachmentLabel(attachment: FlowContextAttachmentMeta, index: number) {
  return attachment.captionText || attachment.altText || attachment.titleText || `Captured image ${index + 1}`
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

function isMarkdownBoundary(line: string) {
  return /^#{1,6}\s+/.test(line) || /^>\s?/.test(line) || /^```/.test(line) || /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

function isMarkdownTableDivider(line: string) {
  const cells = splitMarkdownTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function parseMarkdownTableAlignment(cell: string): TableAlignment {
  const trimmed = cell.trim()
  const hasLeft = trimmed.startsWith(":")
  const hasRight = trimmed.endsWith(":")

  if (hasLeft && hasRight) {
    return "center"
  }

  if (hasRight) {
    return "right"
  }

  return "left"
}

function normalizeMarkdownTableRow<T>(cells: T[], width: number, fallback: T) {
  if (cells.length === width) {
    return cells
  }

  if (cells.length > width) {
    return cells.slice(0, width)
  }

  return [...cells, ...Array.from({ length: width - cells.length }, () => fallback)]
}

function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const normalized = source.replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  const blocks: MarkdownBlock[] = []

  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      index += 1
      continue
    }

    const codeFenceMatch = line.match(/^```([\w-]+)?\s*$/)
    if (codeFenceMatch) {
      const codeLines: string[] = []
      index += 1

      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index])
        index += 1
      }

      if (index < lines.length && /^```/.test(lines[index])) {
        index += 1
      }

      blocks.push({
        type: "code",
        language: codeFenceMatch[1] || null,
        text: codeLines.join("\n")
      })
      continue
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length as HeadingLevel,
        text: headingMatch[2].trim()
      })
      index += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []

      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""))
        index += 1
      }

      blocks.push({
        type: "blockquote",
        text: quoteLines.join("\n").trim()
      })
      continue
    }

    const nextLine = lines[index + 1]
    if (line.includes("|") && nextLine && isMarkdownTableDivider(nextLine)) {
      const headers = splitMarkdownTableRow(line)
      const alignments = splitMarkdownTableRow(nextLine).map(parseMarkdownTableAlignment)
      const rows: string[][] = []
      index += 2

      while (index < lines.length) {
        const currentLine = lines[index]
        if (!currentLine.trim()) {
          index += 1
          break
        }

        if (!currentLine.includes("|") || isMarkdownBoundary(currentLine) || isMarkdownTableDivider(currentLine)) {
          break
        }

        rows.push(normalizeMarkdownTableRow(splitMarkdownTableRow(currentLine), headers.length, ""))
        index += 1
      }

      blocks.push({
        type: "table",
        headers,
        alignments: normalizeMarkdownTableRow(alignments, headers.length, "left"),
        rows
      })
      continue
    }

    const orderedStartMatch = line.match(/^\d+\.\s+(.+)$/)
    const unorderedStartMatch = line.match(/^[-*+]\s+(.+)$/)
    if (orderedStartMatch || unorderedStartMatch) {
      const ordered = Boolean(orderedStartMatch)
      const items: string[] = []

      while (index < lines.length) {
        const currentLine = lines[index]
        const orderedMatch = currentLine.match(/^\d+\.\s+(.+)$/)
        const unorderedMatch = currentLine.match(/^[-*+]\s+(.+)$/)
        const itemMatch = ordered ? orderedMatch : unorderedMatch

        if (itemMatch) {
          items.push(itemMatch[1].trim())
          index += 1
          continue
        }

        if (/^\s{2,}\S+/.test(currentLine) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]}\n${currentLine.trim()}`
          index += 1
          continue
        }

        break
      }

      blocks.push({
        type: "list",
        ordered,
        items
      })
      continue
    }

    const paragraphLines = [line]
    index += 1

    while (index < lines.length) {
      const nextLine = lines[index]
      if (!nextLine.trim()) {
        index += 1
        break
      }

      if (isMarkdownBoundary(nextLine)) {
        break
      }

      paragraphLines.push(nextLine)
      index += 1
    }

    blocks.push({
      type: "paragraph",
      text: paragraphLines.join("\n").trim()
    })
  }

  return blocks
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

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`\n]+`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+)\*|_([^_\n]+)_)/g
  let cursor = 0
  let key = 0

  const pushPlainText = (segment: string) => {
    const parts = segment.split("\n")
    parts.forEach((part, partIndex) => {
      if (part) {
        nodes.push(<Fragment key={`text-${key += 1}`}>{part}</Fragment>)
      }

      if (partIndex < parts.length - 1) {
        nodes.push(<br key={`br-${key += 1}`} />)
      }
    })
  }

  for (const match of text.matchAll(pattern)) {
    const matchIndex = match.index ?? 0
    if (matchIndex > cursor) {
      pushPlainText(text.slice(cursor, matchIndex))
    }

    const token = match[0]
    const linkLabel = match[2]
    const linkHref = match[3]
    const boldText = match[4] || match[5]
    const italicText = match[6] || match[7]

    if (token.startsWith("`")) {
      nodes.push(
        <code key={`code-${key += 1}`} className="ichat-inline-code">
          {token.slice(1, -1)}
        </code>
      )
    } else if (linkLabel && linkHref) {
      const safeHref = getSafeMarkdownHref(linkHref)
      if (safeHref) {
        nodes.push(
          <a
            key={`link-${key += 1}`}
            href={safeHref}
            target="_blank"
            rel="noreferrer noopener"
            className="ichat-markdown-link">
            {renderInlineMarkdown(linkLabel)}
          </a>
        )
      } else {
        pushPlainText(token)
      }
    } else if (boldText) {
      nodes.push(<strong key={`strong-${key += 1}`}>{renderInlineMarkdown(boldText)}</strong>)
    } else if (italicText) {
      nodes.push(<em key={`em-${key += 1}`}>{renderInlineMarkdown(italicText)}</em>)
    } else {
      pushPlainText(token)
    }

    cursor = matchIndex + token.length
  }

  if (cursor < text.length) {
    pushPlainText(text.slice(cursor))
  }

  return nodes
}

const HEADING_TAGS: Record<HeadingLevel, "h1" | "h2" | "h3" | "h4" | "h5" | "h6"> = {
  1: "h1",
  2: "h2",
  3: "h3",
  4: "h4",
  5: "h5",
  6: "h6"
}

function MarkdownMessage({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text])

  return (
    <div className="ichat-message-text is-markdown">
      {blocks.map((block, index) => {
        if (block.type === "paragraph") {
          return <p key={`p-${index}`}>{renderInlineMarkdown(block.text)}</p>
        }

        if (block.type === "heading") {
          const HeadingTag = HEADING_TAGS[block.level]
          return <HeadingTag key={`h-${index}`}>{renderInlineMarkdown(block.text)}</HeadingTag>
        }

        if (block.type === "blockquote") {
          return <blockquote key={`q-${index}`}>{renderInlineMarkdown(block.text)}</blockquote>
        }

        if (block.type === "code") {
          return (
            <pre key={`code-${index}`} className="ichat-code-block">
              <code data-language={block.language || undefined}>{block.text}</code>
            </pre>
          )
        }

        if (block.type === "table") {
          return (
            <div key={`table-${index}`} className="ichat-table-scroll">
              <table className="ichat-markdown-table">
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={`head-${index}-${headerIndex}`} data-align={block.alignments[headerIndex]}>
                        {renderInlineMarkdown(header)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`row-${index}-${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td key={`cell-${index}-${rowIndex}-${cellIndex}`} data-align={block.alignments[cellIndex]}>
                          {renderInlineMarkdown(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }

        const ListTag = block.ordered ? "ol" : "ul"
        return (
          <ListTag key={`list-${index}`}>
            {block.items.map((item, itemIndex) => <li key={`item-${index}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>)}
          </ListTag>
        )
      })}
    </div>
  )
}

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
  const { part } = props

  return (
    <ResolvedAttachmentImage
      url={part.url}
      mediaType={part.mediaType}
      alt={part.filename || "Attached image"}
      className="ichat-message-image"
    />
  )
}

function ChatBubble({ message }: { message: UIMessage }) {
  const text = extractUiMessageText(message)
  const role = message.role
  const fileParts = extractUiMessageFiles(message)
  const rendersMarkdown = role === "assistant"

  if (!text && fileParts.length === 0) {
    return null
  }

  return (
    <article className={`ichat-message is-${role}`}>
      <div className="ichat-bubble">
        {fileParts.length > 0 ? (
          <div className="ichat-message-media-grid">
            {fileParts.map((part, index) => <AttachmentPreview key={`${message.id}-${index}-${part.url}`} part={part} />)}
          </div>
        ) : null}
        {text ? (rendersMarkdown ? <MarkdownMessage text={text} /> : <div className="ichat-message-text">{text}</div>) : null}
      </div>
    </article>
  )
}

function DraftContextItem(props: {
  open: boolean
  onOpen: () => void
  onRemove: () => void
}) {
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
          <strong>IChat Ctx</strong>
          <small>Open FlowContext</small>
        </span>
      </button>
      <button
        className="ichat-attachment-dismiss"
        type="button"
        aria-label="Remove FlowContext"
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
  const { attachment, removable, onRemove, onPreview } = props

  return (
    <div className="ichat-image-card">
      <button className="ichat-image-card-main" type="button" onClick={onPreview} aria-label={`Preview ${attachment.label}`}>
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
          <small>Click to preview</small>
        </span>
      </button>
      {removable ? (
        <button
          className="ichat-attachment-dismiss"
          type="button"
          aria-label={`Remove ${attachment.label}`}
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
  const { attachment, onClose } = props

  return (
    <div className="ichat-modal-overlay" role="presentation" onClick={onClose}>
      <section
        className="ichat-image-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${attachment.filename || attachment.label}`}
        onClick={(event) => event.stopPropagation()}>
        <button className="ichat-icon-button is-dismiss" type="button" aria-label="Close image preview" onClick={onClose}>
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
  const { flowContext, promptPreview, pendingPrompt, editorState, readOnly, onChange, onClose } = props
  const mode = getFlowContextMode(flowContext)

  return (
    <div className="ichat-modal-overlay" role="presentation" onClick={onClose}>
      <section
        className="ichat-context-modal"
        role="dialog"
        aria-modal="true"
        aria-label="FlowContext editor"
        onClick={(event) => event.stopPropagation()}>
        <button className="ichat-icon-button is-dismiss" type="button" aria-label="Close FlowContext editor" onClick={onClose}>
          <svg className="ichat-dismiss-icon" aria-hidden="true" viewBox="0 0 20 20" fill="none">
            <path d="M5 5L15 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <div className="ichat-context-modal-head">
          <div>
            <p className="ichat-eyebrow">IChat Ctx</p>
            <h3>{flowContext.page.title || "Untitled page"}</h3>
            <p className="ichat-subtitle">
              Live-synced editor for the current FlowContext draft. Long fields stay scrollable so the modal height remains stable.
            </p>
          </div>
          <div className="ichat-context-modal-head-meta">
            <span className="ichat-badge">{mode === "selection" ? "Selection + DOM" : "Smart DOM"}</span>
          </div>
        </div>

        <div className="ichat-context-modal-scroll">
          <div className="ichat-context-editor-grid">
            <label className="ichat-context-editor-field is-full">
              <span>URL</span>
              <input
                className="ichat-context-editor-input"
                type="text"
                value={editorState.pageUrl}
                disabled={readOnly}
                onChange={(event) => onChange("pageUrl", event.target.value)}
              />
            </label>

            <label className="ichat-context-editor-field is-full">
              <span>Locator</span>
              <textarea
                className="ichat-context-editor-textarea is-compact"
                rows={2}
                value={editorState.locator}
                disabled={readOnly}
                onChange={(event) => onChange("locator", event.target.value)}
              />
            </label>

            <label className="ichat-context-editor-field is-full">
              <span>Selected text</span>
              <textarea
                className="ichat-context-editor-textarea"
                rows={5}
                value={editorState.selectedText}
                disabled={readOnly}
                onChange={(event) => onChange("selectedText", event.target.value)}
              />
              <small>{snippet(editorState.selectedText, 96, "Empty")}</small>
            </label>

            <label className="ichat-context-editor-field">
              <span>Smart target</span>
              <textarea
                className="ichat-context-editor-textarea"
                rows={5}
                value={editorState.smartTargetText}
                disabled={readOnly}
                onChange={(event) => onChange("smartTargetText", event.target.value)}
              />
              <small>{snippet(editorState.smartTargetText, 96, "Empty")}</small>
            </label>

            <label className="ichat-context-editor-field">
              <span>Implicit context</span>
              <textarea
                className="ichat-context-editor-textarea"
                rows={5}
                value={editorState.implicitContextText}
                disabled={readOnly}
                onChange={(event) => onChange("implicitContextText", event.target.value)}
              />
              <small>{snippet(editorState.implicitContextText, 96, "Empty")}</small>
            </label>
          </div>

          <div className="ichat-prompt-preview is-modal-preview">
            <span>Prompt preview</span>
            <pre>{promptPreview}</pre>
          </div>

          {pendingPrompt.error ? <div className="ichat-banner is-warning">{pendingPrompt.error}</div> : null}
        </div>
      </section>
    </div>
  )
}

export function ProviderConversation({ provider, settings, apiKeys, pendingPrompt, flowContext, threadClearSignal }: ProviderConversationProps) {
  const currentModel = getProviderModel(settings, provider)
  const currentKey = getProviderKey(provider, apiKeys)
  const [hydrated, setHydrated] = useState(false)
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [composerText, setComposerText] = useState("")
  const [isBusy, setIsBusy] = useState(false)
  const [errorBanner, setErrorBanner] = useState<string | null>(null)
  const [draftContextOpen, setDraftContextOpen] = useState(false)
  const [editorState, setEditorState] = useState<FlowContextEditorState | null>(null)
  const [composerAttachments, setComposerAttachments] = useState<LocalImageAttachment[]>([])
  const [previewAttachment, setPreviewAttachment] = useState<LocalImageAttachment | null>(null)

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const threadContentRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<UIMessage[]>([])
  const isBusyRef = useRef(false)
  const shouldStickToBottomRef = useRef(true)
  const lastPersistedJsonRef = useRef("[]")
  const abortControllerRef = useRef<AbortController | null>(null)
  const activePendingIdRef = useRef<string | null>(null)
  const activeEditorContextIdRef = useRef<string | null>(null)
  const lastEditorSignatureRef = useRef("")

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
        label: getAttachmentLabel(attachment, index),
        url: getAttachmentUrl(attachment.id),
        source: "flow-context"
      }))
  }, [attachmentFlowContext])

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
  const visionBlockedMessage = getVisionBlockedMessage(provider, currentModel)

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
  }, [threadClearSignal])

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
      setDispatchStatus(dispatchStatusPayload("idle", "Cleared the current FlowContext draft", provider, null))
    ])
  }, [provider])

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
        const message = getVisionBlockedMessage(provider, currentModel)
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
        const message = `Missing ${providerLabels[provider]} API key. Add it in Settings before sending.`
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
      const assistantMessageId = crypto.randomUUID()
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
          dispatchStatusPayload("sending", `Sending FlowContext to ${providerLabels[provider]}`, provider, pending.flowContextId)
        )
      }

      try {
        const modelMessages = await toModelMessages(requestMessages)
        const responseText = await streamProviderResponse(provider, apiKeys, settings, modelMessages, controller.signal, (partialText) => {
          const streamedMessages = replaceMessageText(messagesRef.current, assistantMessageId, partialText)
          messagesRef.current = streamedMessages
          setMessages(streamedMessages)
        })

        const finalText = responseText || "No response returned."
        const finalMessages = replaceMessageText(messagesRef.current, assistantMessageId, finalText)
        messagesRef.current = finalMessages
        setMessages(finalMessages)

        if (pending) {
          await setPendingPrompt(null)
          await setDispatchStatus(
            dispatchStatusPayload("sent", `FlowContext sent to ${providerLabels[provider]}`, provider, pending.flowContextId)
          )
        }

        return true
      } catch (error) {
        const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError")
        const message = cancelled ? "Request cancelled." : formatProviderError(provider, currentModel, currentKey, error)
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
    [apiKeys, currentKey, currentModel, provider, settings]
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
        label: getAttachmentLabel(attachment, index),
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
  }, [buildFilePartsForAttachments, flowContext, hydrated, pendingPrompt, provider, runSendPipeline])

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

      const attachmentId = crypto.randomUUID()
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
  }, [attachmentFlowContext, attachmentPrompt, buildFilePartsForAttachments, composerAttachments, composerText, contextImageAttachments, currentKey, editorState, runSendPipeline])

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort()
  }, [])

  const missingKey = !currentKey
  const modalReadOnly = isBusy || attachmentPrompt?.status === "processing"
  const canSubmit = !isBusy && !visionBlocked && (Boolean(composerText.trim()) || Boolean(attachmentPrompt) || composerAttachments.length > 0)
  const activeBanner = visionBlocked ? visionBlockedMessage : errorBanner

  return (
    <div className="ichat-conversation-shell">
      {missingKey ? (
        <div className="ichat-banner is-warning">
          Add a {providerLabels[provider]} API key in Settings to start chatting.
        </div>
      ) : null}

      {!missingKey && activeBanner ? <div className="ichat-banner is-warning">{activeBanner}</div> : null}

      <div className="ichat-thread-root">
        <div ref={viewportRef} className="ichat-thread-viewport">
          <div ref={threadContentRef}>
            {!hydrated ? (
              <div className="ichat-thread-empty">
                <p className="ichat-empty-kicker">Loading</p>
                <h2>Preparing your conversation</h2>
              </div>
            ) : null}

            {hydrated && messages.length === 0 ? (
              <div className="ichat-thread-empty">
                <p className="ichat-empty-kicker">IChat Native Chat</p>
                <h2>Context stays here, not in your clipboard</h2>
                <p>
                  Capture page context, review the generated prompt, and keep chatting with {providerLabels[provider]} using <code>{currentModel}</code>.
                </p>
              </div>
            ) : null}

            {hydrated ? messages.map((message) => <ChatBubble key={message.id} message={message} />) : null}
          </div>
        </div>
      </div>

      <div className="ichat-composer-shell">
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
          className="ichat-composer-input"
          rows={3}
          value={composerText}
          placeholder={attachmentPrompt ? "Ask with the attached FlowContext..." : composerAttachments.length ? "Add a prompt for the attached image..." : "Ask a follow-up or type directly here..."}
          onChange={(event) => setComposerText(event.target.value)}
          onPaste={(event) => void handleComposerPaste(event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              void handleComposerSubmit()
            }
          }}
        />
        <div className="ichat-composer-actions">
          <button className="ichat-secondary-button" type="button" onClick={handleStop} disabled={!isBusy}>
            Stop
          </button>
          <button className="ichat-primary-button" type="button" onClick={() => void handleComposerSubmit()} disabled={!canSubmit}>
            {isBusy ? "Sending..." : allActiveAttachments.length > 0 ? "Send with images" : attachmentPrompt ? "Send with context" : "Send"}
          </button>
        </div>
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
