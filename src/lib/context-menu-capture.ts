import { createRandomId } from "./random-id"
import type { FlowContext } from "./types"

export const CAPTURE_SELECTION_MENU_ID = "ichat-capture-selection"

export function buildContextMenuSelection(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab
): FlowContext | null {
  const text = info.selectionText?.trim()
  if (!text || tab.id == null) return null

  // Prefer a web frame's source, but keep the PDF URL rather than Chrome's viewer URL.
  const url = info.frameUrl && /^(https?|file):/i.test(info.frameUrl)
    ? info.frameUrl
    : tab.url || info.pageUrl || ""
  let host: string | null = null
  try {
    host = new URL(url).host || null
  } catch {
    // Chrome may omit the page URL; selection text is still usable on its own.
  }

  return {
    schemaVersion: 2,
    id: createRandomId(),
    createdAt: new Date().toISOString(),
    page: { tabId: tab.id, windowId: tab.windowId, title: tab.title || "", url, host },
    trigger: { command: "capture-flow-context", source: "context-menu", mode: "selection" },
    primaryCaptureKind: "text",
    primaryAttachmentId: null,
    attachments: [],
    selection: {
      text, textLength: text.length, anchorLocator: null, focusLocator: null,
      rects: [], unionRect: null
    },
    smartTarget: null,
    implicitContext: null,
    metadata: { documentLang: null, viewport: { width: tab.width || 0, height: tab.height || 0 } }
  }
}
