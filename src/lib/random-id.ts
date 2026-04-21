function byteToHex(byte: number) {
  return byte.toString(16).padStart(2, "0")
}

function formatUuidFromBytes(bytes: Uint8Array) {
  const normalized = new Uint8Array(bytes)

  // RFC 4122 version 4
  normalized[6] = (normalized[6] & 0x0f) | 0x40
  normalized[8] = (normalized[8] & 0x3f) | 0x80

  const hex = Array.from(normalized, byteToHex)
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join("")
  ].join("-")
}

export function createRandomId() {
  const cryptoApi = globalThis.crypto

  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID()
  }

  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    return formatUuidFromBytes(cryptoApi.getRandomValues(new Uint8Array(16)))
  }

  const fallback = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`
  return fallback
}
