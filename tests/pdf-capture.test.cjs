const assert = require("node:assert/strict")
const { test } = require("node:test")
const { loadModule } = require("./helpers/load-module.cjs")

const tab = { id: 42, windowId: 7, url: "https://arxiv.org/pdf/2210.03629", title: "ReAct", status: "complete", width: 1000, height: 800 }
const t = (key) => key

test("native PDF MIME and full-page embed are detected, ordinary pages are not", async () => {
  const globals = {
    document: { contentType: "application/pdf" }, innerWidth: 1000, innerHeight: 800,
    chrome: { scripting: { executeScript: async ({ func }) => [{ result: func() }] } }
  }
  const { isPdfTab } = loadModule("pdf-capture.ts", globals)
  assert.equal(await isPdfTab(tab), true)
  globals.document.contentType = "text/html"
  globals.document.querySelector = () => null
  assert.equal(await isPdfTab(tab), false) // URL alone must not override a readable HTML page.
  globals.document.querySelector = () => ({ getBoundingClientRect: () => ({ width: 1000, height: 800 }) })
  globals.document.body = { innerText: "" }
  assert.equal(await isPdfTab(tab), true)
  globals.document.body.innerText = "Article with embedded PDF"
  assert.equal(await isPdfTab(tab), false)
  globals.document.body.innerText = ""
  globals.document.querySelector = () => ({ getBoundingClientRect: () => ({ width: 300, height: 200 }) })
  assert.equal(await isPdfTab(tab), false)
})

test("blocked probes fall back only for recognized PDF URLs", async () => {
  const { isPdfTab } = loadModule("pdf-capture.ts", {
    chrome: { scripting: { executeScript: async () => { throw new Error("Cannot access this page") } } }
  })
  for (const url of [tab.url, "https://example.org/paper.PDF?download=1#page=3"]) {
    assert.equal(await isPdfTab({ ...tab, url }), true)
  }
  for (const url of ["https://arxiv.org/abs/2210.03629", "https://arxiv.org/html/2210.03629", "https://example.org/?file=paper.pdf"]) {
    assert.equal(await isPdfTab({ ...tab, url }), false)
  }
})

test("PDF screenshot becomes a partial image attachment and a vision-required prompt", async () => {
  let captures = 0
  const stored = []
  const dataUrl = "data:image/png;base64,cGRmLWltYWdl"
  const globals = { chrome: { tabs: {
    query: async () => [tab],
    captureVisibleTab: async (windowId, options) => {
      assert.equal(windowId, 7)
      assert.equal(options.format, "png")
      captures++
      return dataUrl
    }
  } } }
  const { capturePdfViewport } = loadModule("pdf-capture.ts", globals)
  const flow = await capturePdfViewport(tab, t)
  assert.equal(flow.selection, null)
  assert.equal(flow.trigger.source, "pdf-viewport")
  const { resolveFlowContextAttachments } = loadModule("flow-context-media.ts", globals, {
    "./attachment-repository": {
      dataUrlToBlob: async (value) => { assert.equal(value, dataUrl); return new Blob(["pdf-image"], { type: "image/png" }) },
      putAttachmentBlob: async (record) => stored.push(record)
    },
    "./media-processing": {
      normalizeImageBlob: async (blob, filename) => ({ blob, filename, mediaType: "image/png", width: 1000, height: 800 })
    }
  })
  const resolved = await resolveFlowContextAttachments(flow)
  assert.equal(captures, 1)
  assert.equal(stored.length, 1)
  const attachment = resolved.attachments[0]
  assert.equal(attachment.blobStoreKey, stored[0].id)
  assert.equal(attachment.origin, "screenshot-fallback")
  assert.equal(attachment.captureIntegrity, "partial")
  assert.equal(attachment.resolutionHint, null)
  assert.equal(JSON.stringify(resolved).includes(dataUrl), false)
  const { createPendingPrompt, DEFAULT_SETTINGS } = loadModule("prompt-builder.ts")
  const prompt = createPendingPrompt(resolved, DEFAULT_SETTINGS)
  assert.equal(prompt.requiresVision, true)
  assert.equal(prompt.attachmentIds[0], attachment.id)
})

test("switches, navigation and loading abort capture without returning a wrong-page attachment", async () => {
  for (const changed of [{ ...tab, id: 43 }, { ...tab, url: "https://example.org" }, { ...tab, status: "loading" }]) {
    for (const switchAfterScreenshot of [false, true]) {
      let queries = 0
      let captures = 0
      const { capturePdfViewport } = loadModule("pdf-capture.ts", { chrome: { tabs: {
        query: async () => [switchAfterScreenshot && queries++ === 0 ? tab : changed],
        captureVisibleTab: async () => { captures++; return "data:image/png;base64," }
      } } })
      await assert.rejects(capturePdfViewport(tab, t), /capture.pdf.tabChanged/)
      assert.equal(captures, switchAfterScreenshot ? 1 : 0)
    }
  }
})

test("screenshot permission errors propagate instead of reporting capture success", async () => {
  const { capturePdfViewport } = loadModule("pdf-capture.ts", { chrome: { tabs: {
    query: async () => [tab],
    captureVisibleTab: async () => { throw new Error("Screenshot permission denied") }
  } } })
  await assert.rejects(capturePdfViewport(tab, t), /Screenshot permission denied/)
})
