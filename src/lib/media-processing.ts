import type { RectDescriptor } from "./types"

const MAX_IMAGE_DIMENSION = 2048

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function guessImageExtension(mediaType: string | null | undefined) {
  switch ((mediaType || "").toLowerCase()) {
    case "image/jpeg":
      return "jpg"
    case "image/webp":
      return "webp"
    case "image/gif":
      return "gif"
    case "image/svg+xml":
      return "svg"
    default:
      return "png"
  }
}

export function parseDataUrlMediaType(value: string | null | undefined) {
  if (!value?.startsWith("data:")) {
    return null
  }

  const match = value.match(/^data:([^;,]+)[;,]/i)
  return match?.[1] ?? null
}

export async function fetchImageBlob(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`Image request failed with ${response.status}`)
  }

  const mediaType = response.headers.get("content-type") || ""
  if (!mediaType.toLowerCase().startsWith("image/")) {
    throw new Error(`Expected image content but received '${mediaType || "unknown"}'`)
  }

  const blob = await response.blob()
  if (!blob.size) {
    throw new Error("Image response body was empty")
  }

  return blob
}

async function blobToImageBitmap(blob: Blob) {
  return createImageBitmap(blob)
}

function createCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height)
  }

  throw new Error("OffscreenCanvas is not available in this runtime")
}

export async function normalizeImageBlob(blob: Blob, preferredFileName?: string | null) {
  let workingBlob = blob
  let mediaType = blob.type || "image/png"

  const shouldRasterize = mediaType === "image/svg+xml"
  const shouldResize = true

  try {
    const bitmap = await blobToImageBitmap(blob)
    const longestSide = Math.max(bitmap.width, bitmap.height)
    const scale = shouldResize && longestSide > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION / longestSide : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    if (shouldRasterize || scale !== 1) {
      const canvas = createCanvas(width, height)
      const context = canvas.getContext("2d")
      if (!context) {
        throw new Error("Unable to acquire 2D context for normalization")
      }

      context.drawImage(bitmap, 0, 0, width, height)
      workingBlob = await canvas.convertToBlob({ type: "image/png", quality: 0.92 })
      mediaType = "image/png"
    }

    return {
      blob: workingBlob,
      mediaType,
      width,
      height,
      filename: preferredFileName ?? `attachment.${guessImageExtension(mediaType)}`
    }
  } catch {
    return {
      blob: workingBlob,
      mediaType,
      width: null,
      height: null,
      filename: preferredFileName ?? `attachment.${guessImageExtension(mediaType)}`
    }
  }
}

export async function cropVisibleTabDataUrl(options: {
  screenshotDataUrl: string
  cropRect: RectDescriptor
  devicePixelRatio: number
  viewportWidth: number
  viewportHeight: number
}) {
  const { screenshotDataUrl, cropRect, devicePixelRatio, viewportWidth, viewportHeight } = options
  const screenshotBlob = await fetch(screenshotDataUrl).then((response) => response.blob())
  const bitmap = await blobToImageBitmap(screenshotBlob)
  const dpr = devicePixelRatio || 1

  const sourceX = Math.round(clamp(cropRect.left, 0, viewportWidth) * dpr)
  const sourceY = Math.round(clamp(cropRect.top, 0, viewportHeight) * dpr)
  const sourceRight = Math.round(clamp(cropRect.right, 0, viewportWidth) * dpr)
  const sourceBottom = Math.round(clamp(cropRect.bottom, 0, viewportHeight) * dpr)
  const sourceWidth = Math.max(1, sourceRight - sourceX)
  const sourceHeight = Math.max(1, sourceBottom - sourceY)

  const canvas = createCanvas(sourceWidth, sourceHeight)
  const context = canvas.getContext("2d")
  if (!context) {
    throw new Error("Unable to acquire 2D context for screenshot crop")
  }

  context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight)
  return canvas.convertToBlob({ type: "image/png", quality: 0.92 })
}