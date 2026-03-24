const ATTACHMENT_DB_NAME = "ichat-attachments"
const ATTACHMENT_STORE_NAME = "attachments"
const ATTACHMENT_URL_PREFIX = "ichat-attachment://"

interface AttachmentRecord {
  id: string
  blob: Blob
  mediaType: string
  filename?: string | null
  createdAt: string
}

function openAttachmentDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ATTACHMENT_DB_NAME, 1)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ATTACHMENT_STORE_NAME)) {
        db.createObjectStore(ATTACHMENT_STORE_NAME, { keyPath: "id" })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Failed to open attachment database"))
  })
}

export function attachmentUrlFromId(id: string) {
  return `${ATTACHMENT_URL_PREFIX}${id}`
}

export function isAttachmentUrl(url: string | null | undefined) {
  return Boolean(url && url.startsWith(ATTACHMENT_URL_PREFIX))
}

export function attachmentIdFromUrl(url: string) {
  return url.startsWith(ATTACHMENT_URL_PREFIX) ? url.slice(ATTACHMENT_URL_PREFIX.length) : null
}

export async function putAttachmentBlob(options: {
  id: string
  blob: Blob
  mediaType?: string | null
  filename?: string | null
}) {
  const { id, blob, mediaType, filename } = options
  const db = await openAttachmentDb()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(ATTACHMENT_STORE_NAME, "readwrite")
      const store = transaction.objectStore(ATTACHMENT_STORE_NAME)
      store.put({
        id,
        blob,
        mediaType: mediaType || blob.type || "application/octet-stream",
        filename: filename ?? null,
        createdAt: new Date().toISOString()
      } satisfies AttachmentRecord)

      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error("Attachment write aborted"))
      transaction.onerror = () => reject(transaction.error ?? new Error("Attachment write failed"))
    })
  } finally {
    db.close()
  }
}

export async function getAttachmentRecord(id: string): Promise<AttachmentRecord | null> {
  const db = await openAttachmentDb()

  try {
    return await new Promise<AttachmentRecord | null>((resolve, reject) => {
      const transaction = db.transaction(ATTACHMENT_STORE_NAME, "readonly")
      const store = transaction.objectStore(ATTACHMENT_STORE_NAME)
      const request = store.get(id)

      request.onsuccess = () => resolve((request.result as AttachmentRecord | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error("Failed to read attachment blob"))
    })
  } finally {
    db.close()
  }
}

export async function getAttachmentBlob(id: string) {
  const record = await getAttachmentRecord(id)
  return record?.blob ?? null
}

export async function deleteAttachmentBlob(id: string) {
  const db = await openAttachmentDb()

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(ATTACHMENT_STORE_NAME, "readwrite")
      const store = transaction.objectStore(ATTACHMENT_STORE_NAME)
      store.delete(id)
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error("Attachment delete aborted"))
      transaction.onerror = () => reject(transaction.error ?? new Error("Attachment delete failed"))
    })
  } finally {
    db.close()
  }
}

export function createObjectUrlForBlob(blob: Blob) {
  return URL.createObjectURL(blob)
}

export function revokeObjectUrl(url: string) {
  URL.revokeObjectURL(url)
}

export async function blobToUint8Array(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer())
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.onerror = () => reject(reader.error ?? new Error("Failed to convert blob to data URL"))
    reader.readAsDataURL(blob)
  })
}

export async function dataUrlToBlob(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(",")
  if (!dataUrl.startsWith("data:") || commaIndex === -1) {
    throw new Error("Invalid data URL")
  }

  const header = dataUrl.slice(5, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  const headerParts = header.split(";")
  const mediaType = headerParts[0] || "application/octet-stream"
  const isBase64 = headerParts.includes("base64")

  if (isBase64) {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    return new Blob([bytes], { type: mediaType })
  }

  return new Blob([decodeURIComponent(payload)], { type: mediaType })
}