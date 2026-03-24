import { dataUrlToBlob, putAttachmentBlob } from "./attachment-repository"
import { cropVisibleTabDataUrl, fetchImageBlob, normalizeImageBlob, parseDataUrlMediaType } from "./media-processing"
import type { FlowContext, FlowContextAttachmentMeta, FlowContextAttachmentOrigin, RectDescriptor } from "./types"

type ResolvedImageAttachment = {
  blob: Blob
  origin: FlowContextAttachmentOrigin
  mediaType: string | null
  captureIntegrity?: "full" | "partial" | "unknown"
}

function isVisibleCropRect(rect: RectDescriptor | null | undefined) {
  return Boolean(rect && rect.width > 4 && rect.height > 4)
}

function stripResolutionHint(attachment: FlowContextAttachmentMeta): FlowContextAttachmentMeta {
  return {
    ...attachment,
    resolutionHint: null
  }
}

async function readAttachmentFromPage(flowContext: FlowContext, attachment: FlowContextAttachmentMeta) {
  if (flowContext.page.tabId == null) {
    throw new Error("Current page tab id is unavailable for page-side attachment resolution")
  }

  const response = await chrome.tabs.sendMessage(flowContext.page.tabId, {
    type: "ICHAT_READ_ATTACHMENT_DATA",
    payload: {
      sourceUrl: attachment.sourceUrl,
      locator: attachment.locator,
      strategy: attachment.resolutionHint?.strategy
    }
  })

  if (!response?.ok || typeof response.dataUrl !== "string") {
    throw new Error(response?.error || "Page-side attachment read failed")
  }

  return {
    blob: await dataUrlToBlob(response.dataUrl as string),
    mediaType: typeof response.mediaType === "string" ? response.mediaType : parseDataUrlMediaType(response.dataUrl as string)
  }
}

async function fetchPageAsset(flowContext: FlowContext, url: string) {
  if (flowContext.page.tabId == null) {
    throw new Error("Current page tab id is unavailable for page asset fetch")
  }

  const response = await chrome.tabs.sendMessage(flowContext.page.tabId, {
    type: "ICHAT_FETCH_PAGE_ASSET",
    payload: { url }
  })

  if (!response?.ok || typeof response.dataUrl !== "string") {
    throw new Error(response?.error || "Page-side asset fetch failed")
  }

  return {
    blob: await dataUrlToBlob(response.dataUrl as string),
    mediaType: typeof response.mediaType === "string" ? response.mediaType : parseDataUrlMediaType(response.dataUrl as string)
  }
}

async function resolveFromNetworkUrl(flowContext: FlowContext, attachment: FlowContextAttachmentMeta) {
  const sourceUrl = attachment.resolutionHint?.sourceUrl || attachment.sourceUrl
  if (!sourceUrl) {
    throw new Error("Attachment did not expose a usable source URL")
  }

  try {
    const blob = await fetchImageBlob(sourceUrl, {
      credentials: "include",
      mode: "cors",
      cache: "force-cache"
    })

    return {
      blob,
      origin: "network-fetch" as FlowContextAttachmentOrigin,
      mediaType: blob.type || null
    }
  } catch {
    const pageResult = await fetchPageAsset(flowContext, sourceUrl)
    return {
      blob: pageResult.blob,
      origin: "page-fetch" as FlowContextAttachmentOrigin,
      mediaType: pageResult.mediaType || null
    }
  }
}

async function resolveFromInlineOrPage(flowContext: FlowContext, attachment: FlowContextAttachmentMeta) {
  const inlineDataUrl = attachment.resolutionHint?.inlineDataUrl || attachment.sourceUrl
  if (inlineDataUrl?.startsWith("data:")) {
    return {
      blob: await dataUrlToBlob(inlineDataUrl),
      origin: "data-url" as FlowContextAttachmentOrigin,
      mediaType: parseDataUrlMediaType(inlineDataUrl)
    }
  }

  const pageResult = await readAttachmentFromPage(flowContext, attachment)
  return {
    blob: pageResult.blob,
    origin: (attachment.resolutionHint?.strategy === "blob-url"
      ? "blob-url"
      : attachment.resolutionHint?.strategy === "canvas-data-url"
        ? "canvas-blob"
        : "page-fetch") as FlowContextAttachmentOrigin,
    mediaType: pageResult.mediaType || null
  }
}

async function resolveFromScreenshot(flowContext: FlowContext, attachment: FlowContextAttachmentMeta) {
  const cropRect = attachment.resolutionHint?.cropRect || attachment.rect
  if (!isVisibleCropRect(cropRect)) {
    throw new Error("The target image is not sufficiently visible for screenshot fallback")
  }

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(flowContext.page.windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
    format: "png"
  })

  const blob = await cropVisibleTabDataUrl({
    screenshotDataUrl,
    cropRect: cropRect as RectDescriptor,
    devicePixelRatio: flowContext.metadata.viewport.devicePixelRatio || 1,
    viewportWidth: flowContext.metadata.viewport.width,
    viewportHeight: flowContext.metadata.viewport.height
  })

  const captureIntegrity: "full" | "partial" =
    cropRect && cropRect.left >= 0 && cropRect.top >= 0 && cropRect.right <= flowContext.metadata.viewport.width && cropRect.bottom <= flowContext.metadata.viewport.height
      ? "full"
      : "partial"

  return {
    blob,
    origin: "screenshot-fallback" as FlowContextAttachmentOrigin,
    mediaType: blob.type || null,
    captureIntegrity
  }
}

async function resolveImageAttachment(flowContext: FlowContext, attachment: FlowContextAttachmentMeta) {
  const strategy = attachment.resolutionHint?.strategy
  let resolved: ResolvedImageAttachment

  if (strategy === "data-url" || strategy === "blob-url" || strategy === "canvas-data-url") {
    try {
      resolved = await resolveFromInlineOrPage(flowContext, attachment)
    } catch {
      resolved = await resolveFromScreenshot(flowContext, attachment)
    }
  } else if (strategy === "network-url" || strategy === "background-image-url" || strategy === "video-poster-url") {
    try {
      resolved = await resolveFromNetworkUrl(flowContext, attachment)
    } catch {
      resolved = await resolveFromScreenshot(flowContext, attachment)
    }
  } else if (strategy === "page-url") {
    try {
      const pageResult = await fetchPageAsset(flowContext, attachment.resolutionHint?.pageFetchUrl || attachment.sourceUrl || "")
      resolved = {
        blob: pageResult.blob,
        origin: "page-fetch",
        mediaType: pageResult.mediaType || null
      }
    } catch {
      resolved = await resolveFromScreenshot(flowContext, attachment)
    }
  } else {
    resolved = await resolveFromScreenshot(flowContext, attachment)
  }

  const normalized = await normalizeImageBlob(resolved.blob, attachment.filename)
  await putAttachmentBlob({
    id: attachment.id,
    blob: normalized.blob,
    mediaType: normalized.mediaType,
    filename: normalized.filename
  })

  return stripResolutionHint({
    ...attachment,
    blobStoreKey: attachment.id,
    origin: resolved.origin,
    captureIntegrity: resolved.captureIntegrity ?? attachment.captureIntegrity ?? "unknown",
    mimeType: attachment.mimeType || resolved.mediaType || normalized.mediaType,
    normalizedMimeType: normalized.mediaType,
    filename: normalized.filename,
    width: normalized.width ?? attachment.width ?? null,
    height: normalized.height ?? attachment.height ?? null,
    bytes: normalized.blob.size
  })
}

function resolveVideoAttachmentStub(attachment: FlowContextAttachmentMeta) {
  return stripResolutionHint({
    ...attachment,
    blobStoreKey: null,
    origin: attachment.origin ?? "unsupported-video",
    unsupportedReason: attachment.unsupportedReason || "Video attachments are not sent yet."
  })
}

export async function resolveFlowContextAttachments(flowContext: FlowContext) {
  if (!flowContext.attachments.length) {
    return flowContext
  }

  const attachments: FlowContextAttachmentMeta[] = []

  for (const attachment of flowContext.attachments) {
    if (attachment.kind === "image") {
      attachments.push(await resolveImageAttachment(flowContext, attachment))
    } else {
      attachments.push(resolveVideoAttachmentStub(attachment))
    }
  }

  const primaryAttachmentId = attachments.find((attachment) => attachment.id === flowContext.primaryAttachmentId)?.id
    || attachments.find((attachment) => attachment.kind === "image")?.id
    || null

  return {
    ...flowContext,
    attachments,
    primaryAttachmentId,
    smartTarget: flowContext.smartTarget
      ? {
          ...flowContext.smartTarget,
          attachmentId: flowContext.smartTarget.attachmentId || primaryAttachmentId || undefined
        }
      : null
  }
}

export function flowContextHasImageAttachments(flowContext: FlowContext | null | undefined) {
  return Boolean(flowContext?.attachments.some((attachment) => attachment.kind === "image" && attachment.blobStoreKey))
}

export function getFlowContextImageAttachments(flowContext: FlowContext | null | undefined) {
  return (flowContext?.attachments || []).filter((attachment) => attachment.kind === "image" && attachment.blobStoreKey)
}