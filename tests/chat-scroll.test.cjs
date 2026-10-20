const assert = require("node:assert/strict")
const { test } = require("node:test")
const { loadModule } = require("./helpers/load-module.cjs")
const { captureChatReadingPosition, getChatReadingScrollTop, isChatAtBottom } = loadModule("chat-scroll.ts")

function viewportFixture() {
  const viewport = {
    scrollTop: 230, scrollHeight: 1200, clientHeight: 200, clientTop: 2,
    getBoundingClientRect: () => ({ top: 20 }),
    querySelectorAll: () => messages
  }
  const makeBlock = (top, height) => ({
    top, height,
    getBoundingClientRect() { return { top: 22 + this.top - viewport.scrollTop, bottom: 22 + this.top + this.height - viewport.scrollTop } }
  })
  const makeMessage = (id, top, height, blocks = []) => ({
    ...makeBlock(top, height), dataset: { messageId: id }, querySelectorAll: () => blocks, blocks
  })
  const messages = [
    makeMessage("old", 0, 120),
    makeMessage("reading", 140, 400, [makeBlock(140, 60), makeBlock(210, 90), makeBlock(310, 200)]),
    makeMessage("latest", 850, 200)
  ]
  return { viewport, messages }
}

test("reading position identifies the visible paragraph, including its clipped offset", () => {
  const { viewport } = viewportFixture()
  const position = captureChatReadingPosition(viewport)
  assert.equal(position.messageId, "reading")
  assert.equal(position.blockIndex, 1)
  assert.equal(position.offset, -20)
  assert.equal(getChatReadingScrollTop(viewport, position), 230)
})

test("reading stays on the same paragraph when content above it changes size", () => {
  const { viewport, messages } = viewportFixture()
  const position = captureChatReadingPosition(viewport)
  messages[1].top += 80
  messages[1].blocks.forEach(block => { block.top += 80 })
  assert.equal(getChatReadingScrollTop(viewport, position), 310)
})

test("image-only messages provide an anchor and deleted messages invalidate it", () => {
  const { viewport, messages } = viewportFixture()
  viewport.scrollTop = 40
  const position = captureChatReadingPosition(viewport)
  assert.equal(position.messageId, "old")
  assert.equal(position.blockIndex, null)
  assert.equal(getChatReadingScrollTop(viewport, position), 40)
  messages.shift()
  assert.equal(getChatReadingScrollTop(viewport, position), null)
  messages.length = 0
  assert.equal(captureChatReadingPosition(viewport), null)
})

test("following tolerates a small bottom gap but stops while reading earlier messages", () => {
  const { viewport } = viewportFixture()
  assert.equal(isChatAtBottom(viewport), false)
  viewport.scrollTop = 928
  assert.equal(isChatAtBottom(viewport), true)
  viewport.scrollTop = 927
  assert.equal(isChatAtBottom(viewport), false)
})

test("jumping to a reply keeps its opening as the target while its content grows", () => {
  const { viewport, messages } = viewportFixture()
  const start = { messageId: "latest", blockIndex: null, offset: 16 }
  assert.equal(getChatReadingScrollTop(viewport, start), 834)
  messages[2].height = 1200
  viewport.scrollHeight += 1000
  assert.equal(getChatReadingScrollTop(viewport, start), 834)
  messages[2].top += 100
  assert.equal(getChatReadingScrollTop(viewport, start), 934)
})
