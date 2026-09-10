// Run after npm run build, with Playwright available on NODE_PATH.
// Exercises DOM events in the production UI with fake speech/storage/provider APIs.
// No real keyboard, microphone, extension permission prompt, or provider request is used.
const { chromium } = require("playwright")
const assert = require("node:assert/strict")
const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "../build/chrome-mv3-prod")
const server = http.createServer((req, res) => {
  const file = path.resolve(root, `.${new URL(req.url, "http://localhost").pathname}`)
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404).end()
    return
  }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }
  res.setHeader("content-type", types[path.extname(file)] || "application/octet-stream")
  fs.createReadStream(file).pipe(res)
})

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 820 } })
    await context.route("**/*", (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort())
    await context.addInitScript(() => {
      const values = {
        "ichat.settings": JSON.stringify({ uiLanguage: "zh-CN", providers: { active: "openai", searchEnabled: { openai: false } } }),
        "ichat.apiKeys": JSON.stringify({ openai: "test-key-not-a-secret" })
      }
      const listeners = new Set()
      window.chrome = {
        runtime: { getManifest: () => ({ manifest_version: 3 }), getURL: (p) => `${location.origin}/${p}`, sendMessage: async () => ({}) },
        i18n: { getUILanguage: () => "zh-CN" },
        storage: {
          local: {
            get: async (keys) => Object.fromEntries((keys || Object.keys(values)).filter((key) => key in values).map((key) => [key, values[key]])),
            set: async (patch) => {
              const changes = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { oldValue: values[key], newValue: value }]))
              Object.assign(values, patch)
              listeners.forEach((listener) => listener(changes, "local"))
            }
          },
          onChanged: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) }
        }
      }
      window.speechSessions = []
      window.webkitSpeechRecognition = class {
        constructor() { window.speechSessions.push(this) }
        start() {}
        stop() { this.stopped = true }
        abort() { this.aborted = true }
      }
      window.SpeechRecognition = undefined
      window.providerCalls = 0
      window.fetch = (_url, options) => {
        window.providerCalls++
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
      }
      window.microphoneTracksStopped = 0
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop: () => window.microphoneTracksStopped++ }] })
    })
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`${origin}/sidepanel.html`)
    const input = page.getByRole("textbox", { name: "消息输入框" })
    const fill = (value) => input.evaluate((el, text) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, text)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    }, value)
    const send = page.getByRole("button", { name: "发送", exact: true })
    const mic = page.getByRole("button", { name: "开始听写", exact: true })
    await input.waitFor()
    await page.waitForFunction(() => !document.body.textContent.includes("正在加载"))
    assert(await send.isDisabled(), "empty draft must not send")
    await fill("原有草稿")
    await input.evaluate((el) => el.setSelectionRange(2, 2))
    await mic.evaluate((el) => el.click())
    assert(await input.getAttribute("readonly") !== null)
    assert(await send.isDisabled(), "cannot send partial dictation")
    await page.evaluate(() => window.speechSessions.at(-1).onstart())
    assert.equal(await page.evaluate(() => window.speechSessions.at(-1).lang), "zh-CN")
    const result = async (...text) => page.evaluate((parts) => window.speechSessions.at(-1).onresult({ results: parts.map((transcript) => [{ transcript }]) }), text)
    await result("语")
    assert.equal(await input.inputValue(), "原有语草稿")
    await result("语音")
    assert.equal(await input.inputValue(), "原有语音草稿", "interim text must replace its previous hypothesis")
    await result("语音", "输入")
    assert.equal(await input.inputValue(), "原有语音输入草稿", "multiple results must not duplicate the draft")
    await page.getByRole("button", { name: "停止听写" }).evaluate((el) => el.click())
    assert(await send.isDisabled(), "wait for the final speech result")
    await result("语音", "输入。")
    await page.evaluate(() => window.speechSessions.at(-1).onend())
    await page.waitForFunction(() => !document.querySelector("textarea.ichat-composer-input").readOnly)
    assert.equal(await input.inputValue(), "原有语音输入。草稿")
    assert(await send.isEnabled())
    assert.equal(await page.evaluate(() => window.providerCalls), 0, "dictation must never auto-send")

    await fill("替换选中部分")
    await input.evaluate((el) => el.setSelectionRange(2, 4))
    await mic.evaluate((el) => el.click())
    await result("语音")
    await page.evaluate(() => window.speechSessions.at(-1).onerror({ error: "network" }))
    await page.getByRole("alert").waitFor()
    assert.equal(await input.inputValue(), "替换语音部分")
    assert(await send.isEnabled(), "network error unlocks the retained draft")
    await mic.evaluate((el) => el.click())
    await page.evaluate(() => window.speechSessions.at(-1).onerror({ error: "not-allowed" }))
    const permission = page.getByRole("link", { name: "授权麦克风" })
    await permission.waitFor()
    const permissionPage = await context.newPage()
    await permissionPage.goto(await permission.getAttribute("href"))
    await permissionPage.getByRole("button", { name: "授权麦克风" }).evaluate((el) => el.click())
    await permissionPage.getByText("麦克风已授权。", { exact: false }).waitFor()
    assert.equal(await permissionPage.evaluate(() => window.microphoneTracksStopped), 1)
    await permissionPage.close()

    await mic.evaluate((el) => el.click())
    await page.getByRole("button", { name: "停止听写" }).evaluate((el) => el.click())
    // A late start event must not cancel the stop watchdog and leave the draft locked.
    await page.evaluate(() => window.speechSessions.at(-1).onstart())
    await page.waitForFunction(() => !document.querySelector("textarea.ichat-composer-input").readOnly)
    assert(await send.isEnabled())

    await mic.evaluate((el) => el.click())
    await page.waitForFunction(() => !document.querySelector("textarea.ichat-composer-input").readOnly, null, { timeout: 20000 })
    await page.getByText("听写未能启动或已中断", { exact: false }).waitFor()
    assert.equal(await input.inputValue(), "替换语音部分", "startup timeout keeps the draft")
    await mic.evaluate((el) => el.click())
    await page.evaluate(() => window.speechSessions.at(-1).onerror({ error: "no-speech" }))
    await page.getByText("未检测到语音", { exact: false }).waitFor()

    await mic.evaluate((el) => el.click())
    await page.getByRole("button", { name: "设置", exact: true }).evaluate((el) => el.click())
    assert(await page.evaluate(() => window.speechSessions.at(-1).aborted), "opening settings stops the microphone")
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    await mic.waitFor()
    await mic.evaluate((el) => el.click())
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
    assert(await page.evaluate(() => window.speechSessions.at(-1).aborted))

    await fill("中文输入确认")
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true })
    assert.equal(await page.evaluate(() => window.providerCalls), 0)
    assert(await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }))), "Shift+Enter must allow the native newline")
    await input.dispatchEvent("keydown", { key: "Enter", bubbles: true })
    const stop = page.getByRole("button", { name: "停止", exact: true })
    await stop.waitFor()
    await page.waitForFunction(() => window.providerCalls === 1)
    assert.equal(await stop.locator("svg rect").count(), 1, "sending displays the square stop icon")
    await fill("下一条草稿")
    await input.dispatchEvent("keydown", { key: "Enter", bubbles: true })
    assert.equal(await input.inputValue(), "下一条草稿", "Enter while busy must keep the next draft")
    await stop.evaluate((el) => el.click())
    await send.waitFor()
    assert.equal(await input.inputValue(), "下一条草稿")

    const output = path.resolve(__dirname, "../build/composer-checks")
    fs.mkdirSync(output, { recursive: true })
    for (const width of [320, 390, 960]) {
      await page.setViewportSize({ width, height: 820 })
      const layout = await page.evaluate(() => {
        const shell = document.querySelector(".ichat-composer-shell").getBoundingClientRect()
        const buttons = Array.from(document.querySelectorAll(".ichat-composer-button"), (el) => el.getBoundingClientRect())
        return { fits: buttons.every((b) => b.x >= shell.x && b.right <= shell.right && b.bottom <= shell.bottom), overflow: document.documentElement.scrollWidth > innerWidth }
      })
      assert(layout.fits && !layout.overflow, `composer must fit at ${width}px`)
      await page.screenshot({ path: path.join(output, `composer-${width}.png`) })
    }
    await fill(Array(40).fill("长草稿测试").join("\n"))
    assert(await input.evaluate((el) => el.clientHeight <= 220 && el.scrollHeight > el.clientHeight))
    await fill("短草稿")
    assert(await input.evaluate((el) => el.clientHeight < 100), "composer shrinks after clearing long text")
    await fill("支持语音输入，点击麦克风开始听写。")
    await page.locator(".ichat-composer-shell").screenshot({ path: path.join(output, "composer.png") })
    await fill("短草稿")
    await page.evaluate(() => { window.webkitSpeechRecognition = undefined })
    await mic.evaluate((el) => el.click())
    await page.getByText("当前浏览器不支持语音识别", { exact: false }).waitFor()
    assert.equal(await input.inputValue(), "短草稿")
    assert.deepEqual(errors, [], "no browser runtime errors")
    console.log("PASS: production composer, dictation lifecycle, permission page, IME, stop/send, and 320/390/960px layout. Speech and provider APIs were mocked.")
  } finally {
    await browser.close()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => server.close())
