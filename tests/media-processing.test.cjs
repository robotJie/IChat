const assert = require("node:assert/strict")
const { test } = require("node:test")
const { loadModule } = require("./helpers/load-module.cjs")

function svgHarness() {
  const decoded = []
  const canvases = []
  class Image {
    set src(value) {
      // Chromium's SVG image fallback must use a data URL, including for foreignObject.
      assert.ok(value.startsWith("data:image/svg+xml;charset=utf-8,"))
      decoded.push(decodeURIComponent(value.slice(value.indexOf(",") + 1)))
      this.onload()
    }
  }
  class OffscreenCanvas {
    constructor(width, height) {
      this.width = width
      this.height = height
      canvases.push(this)
    }
    getContext() { return { drawImage() {} } }
    async convertToBlob({ type }) { return new Blob(["png"], { type }) }
  }
  const globals = {
    document: {}, Image, OffscreenCanvas,
    createImageBitmap: async () => { throw new Error("The source image could not be decoded") }
  }
  return { ...loadModule("media-processing.ts", globals), decoded, canvases }
}

test("SVG MIME parameters are recognized and normalized for model requests", async () => {
  const { normalizeImageBlob, isSvgMediaType, guessImageExtension } = svgHarness()
  assert.equal(isSvgMediaType("IMAGE/SVG+XML; charset=utf-8"), true)
  assert.equal(isSvgMediaType("image/png"), false)
  assert.equal(guessImageExtension("image/svg+xml;charset=utf-8"), "svg")
  const result = await normalizeImageBlob(new Blob([
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"/>'
  ], { type: "image/svg+xml;charset=utf-8" }), "diagram.svg")
  assert.equal(result.mediaType, "image/png")
  assert.equal(result.blob.type, "image/png")
  assert.equal(result.filename, "diagram.png")
  assert.equal(result.width, 160)
  assert.equal(result.height, 80)
})

test("missing namespaces and percentage dimensions use the SVG viewBox", async () => {
  const { normalizeImageBlob, decoded } = svgHarness()
  const result = await normalizeImageBlob(new Blob([
    '<svg width = "100%" height="100%" viewBox = "0 0 600 300"><rect width="600" height="300"/></svg>'
  ], { type: "image/svg+xml" }))
  assert.equal(result.width, 600)
  assert.equal(result.height, 300)
  assert.match(decoded[0], /xmlns="http:\/\/www.w3.org\/2000\/svg"/)
  assert.match(decoded[0], /width="600" height="300"/)
  assert.equal(decoded[0].includes("100%"), false)
})

test("HTML labels and Unicode survive SVG normalization", async () => {
  const { normalizeImageBlob, decoded } = svgHarness()
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><foreignObject width="160" height="80"><div xmlns="http://www.w3.org/1999/xhtml">中文 &amp; labels</div></foreignObject></svg>'
  const result = await normalizeImageBlob(new Blob([svg], { type: "image/svg+xml" }))
  assert.equal(result.mediaType, "image/png")
  assert.match(decoded[0], /<foreignObject/)
  assert.match(decoded[0], /中文 &amp; labels/)
  assert.equal((decoded[0].match(/xmlns="http:\/\/www.w3.org\/2000\/svg"/g) || []).length, 1)
})

test("large SVGs shrink the output without clipping their original coordinate space", async () => {
  const { normalizeImageBlob, decoded, canvases } = svgHarness()
  const result = await normalizeImageBlob(new Blob([
    '<svg width="4096px" height="2048px"><rect x="3000" width="1096" height="2048"/></svg>'
  ], { type: "image/svg+xml" }))
  assert.equal(result.width, 2048)
  assert.equal(result.height, 1024)
  assert.equal(canvases[0].width, 2048)
  assert.match(decoded[0], /width="4096" height="2048"/)
  assert.match(decoded[0], /x="3000"/)
})

test("worker captures retain SVG data until the chat document can rasterize it", async () => {
  const { normalizeImageBlob } = loadModule("media-processing.ts", {
    createImageBitmap: async () => { throw new Error("Cannot decode SVG in a worker") }
  })
  const svg = new Blob(['<svg viewBox="0 0 160 80"/>'], { type: "image/svg+xml;charset=utf-8" })
  const result = await normalizeImageBlob(svg, "diagram.svg")
  assert.equal(result.blob, svg)
  assert.equal(result.mediaType, "image/svg+xml")
  assert.equal(result.filename, "diagram.svg")
})

test("raster images keep their existing data when no resizing is required", async () => {
  const { normalizeImageBlob } = loadModule("media-processing.ts", {
    createImageBitmap: async () => ({ width: 320, height: 240 })
  })
  const png = new Blob(["png"], { type: "image/png" })
  const result = await normalizeImageBlob(png, "screenshot.png")
  assert.equal(result.blob, png)
  assert.equal(result.mediaType, "image/png")
  assert.equal(result.width, 320)
  assert.equal(result.height, 240)
})
