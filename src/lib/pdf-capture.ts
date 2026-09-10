import { createRandomId } from "./random-id"
import type { FlowContext } from "./types"
import type { TranslateFn } from "./i18n-core"

// Used only when Chrome refuses even the small document-type probe.
export function hasPdfUrl(url: string) {
  const parsed = new URL(url)
  return /\.pdf$/i.test(parsed.pathname) ||
    (parsed.hostname === "arxiv.org" && /^\/pdf\/[^/]+\/?$/.test(parsed.pathname))
}

export async function isPdfTab(tab: chrome.tabs.Tab) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: () => {
        if (document.contentType === "application/pdf") return true
        // Chrome's native viewer exposes an embed shell, not its text selection.
        const embed = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]')
        if (!embed) return false
        const rect = embed.getBoundingClientRect()
        return rect.width >= innerWidth * 0.9 && rect.height >= innerHeight * 0.9 &&
          !(document.body?.innerText || "").trim()
      }
    })
    return results[0]?.result === true
  } catch {
    return hasPdfUrl(tab.url || "https://invalid.local/")
  }
}

export async function capturePdfViewport(tab: chrome.tabs.Tab, t: TranslateFn): Promise<FlowContext> {
  async function assertSameActiveTab() {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
    if (active?.id !== tab.id || active?.url !== tab.url || active?.status === "loading") {
      throw new Error(t("capture.pdf.tabChanged"))
    }
  }

  // captureVisibleTab targets a window's active tab, not a tab id.
  await assertSameActiveTab()
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  await assertSameActiveTab()
  const description = t("capture.pdf.description")
  const attachmentId = createRandomId()
  return {
    schemaVersion: 2, id: createRandomId(), createdAt: new Date().toISOString(),
    page: { tabId: tab.id!, windowId: tab.windowId, title: tab.title || "PDF", url: tab.url!, host: new URL(tab.url!).host },
    trigger: { command: "capture-flow-context", source: "pdf-viewport", mode: "smart-dom" },
    primaryCaptureKind: "image", primaryAttachmentId: attachmentId, selection: null,
    smartTarget: {
      kind: "image", tag: "embed", text: description, textLength: description.length,
      rect: null, locator: null, attachmentId, mediaType: "image/png"
    },
    implicitContext: null,
    metadata: { documentLang: null, viewport: { width: tab.width || 0, height: tab.height || 0 } },
    attachments: [{
      id: attachmentId, kind: "image", blobStoreKey: null, mimeType: "image/png",
      filename: "pdf-visible-area.png", origin: "screenshot-fallback", captureIntegrity: "partial",
      captionText: description,
      resolutionHint: { strategy: "capture-visible-tab", inlineDataUrl: dataUrl }
    }]
  }
}
