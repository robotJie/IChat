export interface ChatReadingPosition {
  messageId: string
  blockIndex: number | null
  offset: number
}

const MESSAGE_SELECTOR = ".ichat-message[data-message-id]"
const BLOCK_SELECTOR = ".ichat-message-text > *, .ichat-message-media-grid > *"

export function isChatAtBottom(viewport: HTMLElement) {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 72
}

export function captureChatReadingPosition(viewport: HTMLElement): ChatReadingPosition | null {
  const top = viewport.getBoundingClientRect().top + viewport.clientTop
  const bottom = top + viewport.clientHeight
  const message = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)).find((element) => {
    const rect = element.getBoundingClientRect()
    return rect.bottom > top && rect.top < bottom
  })
  if (!message?.dataset.messageId) return null

  const blocks = Array.from(message.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))
  const blockIndex = blocks.findIndex((element) => element.getBoundingClientRect().bottom > top)
  const anchor = blocks[blockIndex] ?? message
  return {
    messageId: message.dataset.messageId,
    blockIndex: blockIndex >= 0 ? blockIndex : null,
    offset: anchor.getBoundingClientRect().top - top
  }
}

export function getChatReadingScrollTop(viewport: HTMLElement, position: ChatReadingPosition) {
  const message = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR))
    .find((element) => element.dataset.messageId === position.messageId)
  if (!message) return null

  const blocks = Array.from(message.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))
  const anchor = position.blockIndex === null ? message : blocks[position.blockIndex] ?? message
  const top = viewport.getBoundingClientRect().top + viewport.clientTop
  return Math.max(0, viewport.scrollTop + anchor.getBoundingClientRect().top - top - position.offset)
}
