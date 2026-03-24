import type { RectDescriptor } from "./types"

const MAX_IMAGE_DIMENSION = 2048
type CanvasLike = OffscreenCanvas | HTMLCanvasElement

function stripExtension(filename: string) {
  return filename.replace(/\.[^./\\]+$/, "")
}

function withExtension(filename: string, extension: string) {
  const base = stripExtension(filename)
  return `${base}.${extension}`
}

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

function resolveAttachmentFilename(preferredFileName: string | null | undefined, mediaType: string) {
  if (!preferredFileName) {
    return `attachment.${guessImageExtension(mediaType)}`
  }

  return withExtension(preferredFileName, guessImageExtension(mediaType))
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

function parseSvgDimension(value: string | null | undefined) {
  if (!value) {
    return null
  }

  const normalized = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)/)
  if (!normalized) {
    return null
  }

  const parsed = Number.parseFloat(normalized[1])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function getSvgIntrinsicSize(svgMarkup: string) {
  const svgTagMatch = svgMarkup.match(/<svg\b[^>]*>/i)
  const svgTag = svgTagMatch?.[0] ?? ""
  const width = parseSvgDimension(svgTag.match(/\bwidth=["']([^"']+)["']/i)?.[1])
  const height = parseSvgDimension(svgTag.match(/\bheight=["']([^"']+)["']/i)?.[1])
  const viewBox = svgTag.match(/\bviewBox=["']([^"']+)["']/i)?.[1]

  if (width && height) {
    return { width, height }
  }

  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map((value) => Number.parseFloat(value))
      .filter((value) => Number.isFinite(value))

    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      if (width) {
        return { width, height: (width * parts[3]) / parts[2] }
      }

      if (height) {
        return { width: (height * parts[2]) / parts[3], height }
      }

      return { width: parts[2], height: parts[3] }
    }
  }

  if (width) {
    return { width, height: width }
  }

  if (height) {
    return { width: height, height }
  }

  return { width: 1024, height: 1024 }
}

function createCanvas(width: number, height: number): CanvasLike {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height)
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    return canvas
  }

  throw new Error("Canvas is not available in this runtime")
}

async function canvasToBlob(canvas: CanvasLike, type: string, quality: number) {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type, quality })
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Canvas export failed"))
        return
      }

      resolve(blob)
    }, type, quality)
  })
}

async function rasterizeSvgWithImageElement(blob: Blob) {
  if (typeof document === "undefined" || typeof Image === "undefined") {
    throw new Error("DOM image rasterization is not available in this runtime")
  }

  const svgMarkup = await blob.text()
  const intrinsicSize = getSvgIntrinsicSize(svgMarkup)
  const longestSide = Math.max(intrinsicSize.width, intrinsicSize.height)
  const scale = longestSide > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION / longestSide : 1
  const width = Math.max(1, Math.round(intrinsicSize.width * scale))
  const height = Math.max(1, Math.round(intrinsicSize.height * scale))
  const objectUrl = URL.createObjectURL(new Blob([svgMarkup], { type: "image/svg+xml" }))

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error("Failed to decode SVG image"))
      element.src = objectUrl
    })

    const canvas = createCanvas(width, height)
    const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
    if (!context || typeof context.drawImage !== "function") {
      throw new Error("Unable to acquire 2D context for SVG normalization")
    }

    context.drawImage(image, 0, 0, width, height)
    return {
      blob: await canvasToBlob(canvas, "image/png", 0.92),
      mediaType: "image/png",
      width,
      height
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
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
      const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
      if (!context) {
        throw new Error("Unable to acquire 2D context for normalization")
      }
      if (typeof context.drawImage !== "function") {
        throw new Error("Canvas context does not support drawImage")
      }

      context.drawImage(bitmap, 0, 0, width, height)
      workingBlob = await canvasToBlob(canvas, "image/png", 0.92)
      mediaType = "image/png"
    }

    return {
      blob: workingBlob,
      mediaType,
      width,
      height,
      filename: resolveAttachmentFilename(preferredFileName, mediaType)
    }
  } catch {
    if (shouldRasterize) {
      try {
        const rasterized = await rasterizeSvgWithImageElement(blob)
        return {
          ...rasterized,
          filename: resolveAttachmentFilename(preferredFileName, rasterized.mediaType)
        }
      } catch {
        // Fall back to the original blob so callers can decide how to handle the unsupported type.
      }
    }

    return {
      blob: workingBlob,
      mediaType,
      width: null,
      height: null,
      filename: resolveAttachmentFilename(preferredFileName, mediaType)
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
  const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (!context) {
    throw new Error("Unable to acquire 2D context for screenshot crop")
  }
  if (typeof context.drawImage !== "function") {
    throw new Error("Canvas context does not support drawImage")
  }

  context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight)
  return canvasToBlob(canvas, "image/png", 0.92)
}
