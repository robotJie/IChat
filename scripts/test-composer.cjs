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
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu", "--autoplay-policy=no-user-gesture-required"] })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 820 } })
    await context.route("**/*", (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort())
    await context.addInitScript(() => {
      const values = JSON.parse(localStorage.getItem("test-storage") || "null") || {
        "ichat.settings": JSON.stringify({ uiLanguage: "zh-CN", providers: { active: "openai", searchEnabled: { openai: false } } }),
        "ichat.apiKeys": JSON.stringify({ openai: "test-key-not-a-secret" })
      }
      const listeners = new Set()
      window.testStorage = values
      window.chrome = {
        runtime: { getManifest: () => ({ manifest_version: 3 }), getURL: (p) => `${location.origin}/${p}`, sendMessage: async () => ({}) },
        i18n: { getUILanguage: () => "zh-CN" },
        storage: {
          local: {
            get: async (keys) => Object.fromEntries((keys || Object.keys(values)).filter((key) => key in values).map((key) => [key, values[key]])),
            set: async (patch) => {
              const changes = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { oldValue: values[key], newValue: value }]))
              Object.assign(values, patch)
              localStorage.setItem("test-storage", JSON.stringify(values))
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
      window.providerBodies = []
      window.sttRequests = []
      window.sttResponse = "ok"
      window.mossRequests = []
      window.mossResponse = "ok"
      window.fetch = (_url, options) => {
        if (_url === "https://api.mosi.cn/v1/audio/transcriptions") {
          window.mossRequests.push({ body: options.body, headers: options.headers, signal: options.signal })
          if (window.mossResponse === "hold") return new Promise((resolve) => { window.resolveMoss = resolve })
          if (window.mossResponse === "quota") return Promise.resolve(new Response(JSON.stringify({ error: { code: "insufficient_credits", message: "private test-moss-key" } }), { status: 402, headers: { "x-request-id": "moss-test-request" } }))
          return Promise.resolve(new Response(JSON.stringify({ text: "MOSS 识别成功。" })))
        }
        if (_url.includes("multimodal-generation")) {
          window.sttRequests.push(JSON.parse(options.body))
          if (window.sttResponse === "hold") return new Promise((resolve) => { window.resolveStt = resolve })
          if (window.sttResponse === "unauthorized") return Promise.resolve(new Response("{}", { status: 401 }))
          if (window.sttResponse === "silence") return Promise.resolve(new Response(JSON.stringify({ code: "CLIENT_ERROR", message: "ASR_RESPONSE_HAVE_NO_WORDS", request_id: "test-silence-request" }), { status: 400 }))
          if (window.sttResponse === "rejected") return Promise.resolve(new Response(JSON.stringify({ code: "InvalidParameter", message: "Do not display test-stt-key or data:audio/wav;base64,private", request_id: "test-rejected-request" }), { status: 400 }))
          return Promise.resolve(new Response(JSON.stringify({ output: { text: "语音识别成功。" } }), { headers: { "content-type": "application/json" } }))
        }
        window.providerCalls++
        window.providerBodies.push(JSON.parse(options.body))
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
      }
      window.microphoneTracksStopped = 0
      navigator.mediaDevices.getUserMedia = async () => {
        if (!window.useSyntheticAudio) return { getTracks: () => [{ stop: () => window.microphoneTracksStopped++ }] }
        const audio = new AudioContext()
        await audio.resume()
        const oscillator = audio.createOscillator()
        const destination = audio.createMediaStreamDestination()
        const gain = audio.createGain()
        gain.gain.value = window.syntheticSilence ? 0 : 1
        oscillator.connect(gain).connect(destination)
        oscillator.start()
        window.lastAudioStream = destination.stream
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track)
          track.stop = () => { stop(); void audio.close().catch(() => {}) }
        }
        return destination.stream
      }
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
    assert(await send.isDisabled(), "wait for microphone startup before sending")
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
    permissionPage.on("pageerror", (error) => errors.push(error.message))
    await permissionPage.evaluate(() => { window.useSyntheticAudio = true })
    await permissionPage.getByRole("button", { name: "开始麦克风测试" }).evaluate((el) => el.click())
    await permissionPage.waitForFunction(() => document.querySelector("meter").value > 0)
    await permissionPage.getByRole("button", { name: "停止测试" }).evaluate((el) => el.click())
    await permissionPage.getByText("检测到了输入信号", { exact: false }).waitFor()
    assert(await permissionPage.evaluate(() => window.lastAudioStream.getTracks().every((track) => track.readyState === "ended")))
    await permissionPage.evaluate(() => { window.syntheticSilence = true })
    await permissionPage.getByRole("button", { name: "开始麦克风测试" }).evaluate((el) => el.click())
    await permissionPage.getByRole("button", { name: "停止测试" }).waitFor()
    await permissionPage.waitForTimeout(300)
    assert.equal(await permissionPage.locator("meter").evaluate((el) => el.value), 0)
    await permissionPage.getByRole("button", { name: "停止测试" }).evaluate((el) => el.click())
    await permissionPage.getByText("未检测到明显输入信号", { exact: false }).waitFor()
    await permissionPage.getByRole("button", { name: "开始麦克风测试" }).evaluate((el) => el.click())
    await permissionPage.getByRole("button", { name: "停止测试" }).waitFor()
    await permissionPage.evaluate(() => window.dispatchEvent(new Event("pagehide")))
    assert(await permissionPage.evaluate(() => window.lastAudioStream.getTracks().every((track) => track.readyState === "ended")))
    assert.equal(await permissionPage.evaluate(() => window.sttRequests.length + window.providerCalls), 0, "microphone tests must never upload audio")
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
    // Exercise provider settings, migration, and real MediaRecorder → WAV encoding
    // with a generated tone instead of the user's microphone.
    await page.getByRole("button", { name: "设置", exact: true }).evaluate((el) => el.click())
    await page.getByRole("button", { name: "语音识别服务商", exact: true }).evaluate((el) => el.click())
    const builtIn = page.getByRole("radio", { name: /Chrome 内置/ })
    assert(await builtIn.isChecked(), "old settings migrate to Chrome by default")
    assert.equal(await page.evaluate(() => JSON.parse(window.testStorage["ichat.settings"]).schemaVersion), 6)
    await page.getByRole("radio", { name: /Fun-ASR-Flash/ }).evaluate((el) => el.click())
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    await mic.evaluate((el) => el.click())
    await page.getByText("请先在「设置 → 语音识别服务商」", { exact: false }).waitFor()
    assert.equal(await page.evaluate(() => window.sttRequests.length), 0)
    await page.getByRole("button", { name: "设置", exact: true }).evaluate((el) => el.click())
    await page.getByRole("button", { name: "语音识别服务商", exact: true }).evaluate((el) => el.click())
    const sttKey = page.getByLabel("Fun-ASR API Key", { exact: true })
    await sttKey.evaluate((el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "test-stt-key")
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await page.getByRole("button", { name: "保存 API Key", exact: true }).evaluate((el) => el.click())
    await page.getByText("API Key 已保存到本地", { exact: true }).waitFor()
    await page.setViewportSize({ width: 390, height: 820 })
    await page.screenshot({ path: path.join(output, "stt-settings-390.png") })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    assert.equal(await page.evaluate(() => JSON.parse(window.testStorage["ichat.apiKeys"]).openai), "test-key-not-a-secret", "STT save preserves chat keys")
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    await page.reload()
    await input.waitFor()
    await page.evaluate(() => { window.useSyntheticAudio = true })
    await fill("原有草稿")
    await input.evaluate((el) => el.setSelectionRange(2, 2))
    await mic.evaluate((el) => el.click())
    await page.getByText("正在录音……", { exact: false }).waitFor()
    assert.equal(await page.evaluate(() => window.sttRequests.length), 0, "recording is uploaded only after stopping")
    assert(await send.isEnabled(), "recording can be stopped and sent directly")
    await page.waitForTimeout(450)
    await page.getByRole("button", { name: "停止听写" }).evaluate((el) => el.click())
    await page.waitForFunction(() => document.querySelector("textarea.ichat-composer-input").value.includes("语音识别成功。"))
    assert.equal(await input.inputValue(), "原有语音识别成功。草稿")
    const request = await page.evaluate(() => {
      const request = window.sttRequests[0]
      const bytes = Uint8Array.from(atob(request.input.messages[0].content[0].input_audio.data.split(",")[1]), (c) => c.charCodeAt(0))
      const wav = new DataView(bytes.buffer)
      return { model: request.model, rate: wav.getUint32(24, true), channels: wav.getUint16(22, true), size: bytes.length, messageCount: request.input.messages.length, tracksStopped: window.lastAudioStream.getTracks().every((t) => t.readyState === "ended") }
    })
    assert.equal(request.model, "fun-asr-flash-2026-06-15")
    assert.equal(request.rate, 16000)
    assert.equal(request.channels, 1)
    assert(request.size > 44 && request.tracksStopped)
    assert.equal(request.messageCount, 1, "no chat history or page context goes to STT")
    assert.equal(await page.evaluate(() => window.providerCalls), 0)

    await page.evaluate(() => { window.sttResponse = "hold" })
    await mic.evaluate((el) => el.click())
    await page.getByText("正在录音……", { exact: false }).waitFor()
    await page.waitForTimeout(350)
    await page.getByRole("button", { name: "停止听写" }).evaluate((el) => el.click())
    await page.waitForFunction(() => typeof window.resolveStt === "function")
    await page.getByRole("button", { name: "取消转写" }).evaluate((el) => el.click())
    await fill("取消后编辑的草稿")
    await page.evaluate(() => window.resolveStt(new Response(JSON.stringify({ output: { text: "过期结果" } }))))
    await page.waitForTimeout(100)
    assert.equal(await input.inputValue(), "取消后编辑的草稿", "late cancelled results must not overwrite edits")

    await page.evaluate(() => { window.sttResponse = "unauthorized" })
    await mic.evaluate((el) => el.click())
    await page.getByText("正在录音……", { exact: false }).waitFor()
    await page.waitForTimeout(350)
    await page.getByRole("button", { name: "停止听写" }).evaluate((el) => el.click())
    await page.getByText("语音服务访问被拒绝", { exact: false }).waitFor()
    assert.equal(await input.inputValue(), "取消后编辑的草稿")
    assert(await send.isEnabled())
    for (const [response, expected] of [["silence", "ASR_RESPONSE_HAVE_NO_WORDS"], ["rejected", "InvalidParameter"]]) {
      await page.evaluate((response) => { window.sttResponse = response }, response)
      await mic.evaluate((el) => el.click())
      assert.equal(await page.locator(".ichat-dictation-error").count(), 0, "new recording clears prior diagnostics")
      await page.getByText("正在录音……", { exact: false }).waitFor()
      await page.waitForTimeout(350)
      await page.getByRole("button", { name: "停止听写" }).evaluate((el) => el.click())
      await page.getByText(expected, { exact: false }).waitFor()
      const diagnostic = await page.locator(".ichat-dictation-error").innerText()
      assert(diagnostic.includes("HTTP 400") && diagnostic.includes(`test-${response}-request`))
      assert(!diagnostic.includes("test-stt-key") && !diagnostic.includes("data:audio"), "raw response messages must not expose private request data")
      assert(diagnostic.includes(response === "silence" ? "未检测到语音" : "语音服务拒绝了请求"))
      assert.equal(await input.inputValue(), "取消后编辑的草稿")
      assert(await send.isEnabled())
    }
    await page.getByRole("button", { name: "设置", exact: true }).evaluate((el) => el.click())
    await page.getByRole("button", { name: "语音识别服务商", exact: true }).evaluate((el) => el.click())
    assert.equal(await sttKey.inputValue(), "test-stt-key", "STT key survives reload")
    await page.getByRole("radio", { name: "MOSS", exact: false }).evaluate((el) => el.click())
    const mossKey = page.getByLabel("MOSS API Key", { exact: true })
    assert.equal(await mossKey.inputValue(), "", "old installs receive an empty independent MOSS key")
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    await mic.evaluate((el) => el.click())
    await page.getByText("请先在「设置 → 语音识别服务商」", { exact: false }).waitFor()
    assert.equal(await page.evaluate(() => window.mossRequests.length), 0)
    await page.getByRole("button", { name: "设置", exact: true }).evaluate((el) => el.click())
    await page.getByRole("button", { name: "语音识别服务商", exact: true }).evaluate((el) => el.click())
    await mossKey.evaluate((el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "test-moss-key")
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await page.getByRole("radio", { name: /Fun-ASR-Flash/ }).evaluate((el) => el.click())
    assert.equal(await sttKey.inputValue(), "test-stt-key", "provider drafts do not mix")
    await page.getByRole("radio", { name: "MOSS", exact: false }).evaluate((el) => el.click())
    assert.equal(await mossKey.inputValue(), "test-moss-key", "switching retains the unsaved MOSS draft")
    await page.getByRole("button", { name: "保存 API Key", exact: true }).evaluate((el) => el.click())
    await page.getByText("API Key 已保存到本地", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => JSON.parse(window.testStorage["ichat.apiKeys"]).funAsr), "test-stt-key")
    await page.screenshot({ path: path.join(output, "moss-settings-390.png") })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    await page.reload()
    await input.waitFor()
    await page.evaluate(() => { window.useSyntheticAudio = true })
    await fill("草稿")
    await input.evaluate((el) => el.setSelectionRange(2, 2))
    const recordAndStop = async () => {
      await mic.evaluate((el) => el.click())
      await page.getByText("正在录音……", { exact: false }).waitFor()
      await page.waitForTimeout(350)
      await page.getByRole("button", { name: "停止听写" }).evaluate((el) => el.click())
    }
    await recordAndStop()
    await page.waitForFunction(() => document.querySelector("textarea.ichat-composer-input").value.includes("MOSS 识别成功。"))
    const mossRequest = await page.evaluate(async () => {
      const { body, headers } = window.mossRequests[0]
      const file = body.get("file")
      const wav = new DataView(await file.arrayBuffer())
      return { fields: [...body.keys()].sort(), model: body.get("model"), format: body.get("response_format"), filename: file.name, type: file.type, rate: wav.getUint32(24, true), size: file.size, authorization: headers.Authorization, hasContentType: "Content-Type" in headers }
    })
    assert.deepEqual(mossRequest.fields, ["file", "model", "response_format"])
    assert.equal(mossRequest.model, "moss-transcribe-1.0")
    assert.equal(mossRequest.format, "json")
    assert.equal(mossRequest.filename, "dictation.wav")
    assert.equal(mossRequest.type, "audio/wav")
    assert.equal(mossRequest.rate, 16000)
    assert(mossRequest.size > 44 && !mossRequest.hasContentType)
    assert.equal(mossRequest.authorization, "Bearer test-moss-key")
    assert.equal(await page.evaluate(() => window.sttRequests.length + window.providerCalls), 0)
    await page.evaluate(() => { window.mossResponse = "hold" })
    await recordAndStop()
    await page.waitForFunction(() => typeof window.resolveMoss === "function")
    await page.getByRole("button", { name: "取消转写" }).evaluate((el) => el.click())
    assert(await page.evaluate(() => window.mossRequests.at(-1).signal.aborted))
    await fill("取消后的 MOSS 草稿")
    await page.evaluate(() => window.resolveMoss(new Response(JSON.stringify({ text: "过期结果" }))))
    await page.waitForTimeout(100)
    assert.equal(await input.inputValue(), "取消后的 MOSS 草稿")
    await page.evaluate(() => { window.mossResponse = "quota" })
    await recordAndStop()
    await page.getByText("语音服务额度不足", { exact: false }).waitFor()
    const mossError = await page.locator(".ichat-dictation-error").innerText()
    assert(mossError.includes("HTTP 402") && mossError.includes("insufficient_credits") && mossError.includes("moss-test-request"))
    assert(!mossError.includes("test-moss-key"))
    assert.equal(await input.inputValue(), "取消后的 MOSS 草稿")
    await page.getByRole("button", { name: "设置", exact: true }).evaluate((el) => el.click())
    await page.getByRole("button", { name: "语音识别服务商", exact: true }).evaluate((el) => el.click())
    assert.equal(await mossKey.inputValue(), "test-moss-key", "MOSS selection and key survive reload")
    await mossKey.evaluate((el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "")
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await page.getByRole("button", { name: "保存 API Key", exact: true }).evaluate((el) => el.click())
    await page.waitForFunction(() => JSON.parse(window.testStorage["ichat.apiKeys"]).moss === "")
    assert.equal(await page.evaluate(() => JSON.parse(window.testStorage["ichat.apiKeys"]).funAsr), "test-stt-key")
    await builtIn.evaluate((el) => el.click())
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    await mic.evaluate((el) => el.click())
    assert.equal(await page.evaluate(() => window.speechSessions.length), 1, "switching back uses Chrome recognition")
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
    // Send during dictation must wait for completion, preserve selection, and send once.
    const resetSpeechProvider = async (provider) => {
      await page.evaluate((provider) => {
        const values = JSON.parse(localStorage.getItem("test-storage"))
        const settings = JSON.parse(values["ichat.settings"])
        settings.stt.provider = provider
        values["ichat.settings"] = JSON.stringify(settings)
        const keys = JSON.parse(values["ichat.apiKeys"])
        keys.moss = "test-moss-key"
        values["ichat.apiKeys"] = JSON.stringify(keys)
        localStorage.setItem("test-storage", JSON.stringify(values))
      }, provider)
      await page.reload()
      await input.waitFor()
      await page.evaluate(() => { window.useSyntheticAudio = true })
    }
    const stopChat = async () => {
      await page.getByRole("button", { name: "停止", exact: true }).evaluate((el) => el.click())
      await send.waitFor()
    }
    await resetSpeechProvider("chrome")
    await fill("前旧后")
    await input.evaluate((el) => el.setSelectionRange(1, 2))
    await mic.evaluate((el) => el.click())
    await page.evaluate(() => window.speechSessions.at(-1).onstart())
    assert(await send.isEnabled())
    await result("临时")
    await send.evaluate((el) => { el.click(); el.click() })
    assert.equal(await page.evaluate(() => window.providerCalls), 0, "Chrome must finish before the chat request")
    await result("最终")
    await page.evaluate(() => window.speechSessions.at(-1).onend())
    await page.waitForFunction(() => window.providerCalls === 1)
    assert(await page.evaluate(() => JSON.stringify(window.providerBodies[0]).includes("前最终后")), "send the final merged text, not the stale React draft")
    await stopChat()
    await fill("无语音时保留")
    await mic.evaluate((el) => el.click())
    await page.evaluate(() => window.speechSessions.at(-1).onstart())
    await send.evaluate((el) => el.click())
    await page.evaluate(() => window.speechSessions.at(-1).onend())
    await page.getByText("未检测到语音", { exact: false }).waitFor()
    assert.equal(await input.inputValue(), "无语音时保留")
    assert.equal(await page.evaluate(() => window.providerCalls), 1)
    await mic.evaluate((el) => el.click())
    await page.evaluate(() => window.speechSessions.at(-1).onstart())
    await result("未完成")
    await send.evaluate((el) => el.click())
    await page.getByText("语音输入超时", { exact: false }).waitFor()
    assert.equal(await page.evaluate(() => window.providerCalls), 1, "timeout must not send interim text")
    for (const provider of ["fun-asr", "moss"]) {
      await resetSpeechProvider(provider)
      await fill("前旧后")
      await input.evaluate((el) => el.setSelectionRange(1, 2))
      const recordAndSend = async () => {
        await mic.evaluate((el) => el.click())
        await page.getByText("正在录音……", { exact: false }).waitFor()
        assert(await send.isEnabled())
        await page.waitForTimeout(350)
        await send.evaluate((el) => { el.click(); el.click() })
      }
      await recordAndSend()
      await page.waitForFunction(() => window.providerCalls === 1)
      const expected = provider === "moss" ? "前MOSS 识别成功。后" : "前语音识别成功。后"
      assert(await page.evaluate((expected) => JSON.stringify(window.providerBodies[0]).includes(expected), expected))
      assert.equal(await page.evaluate(() => window.sttRequests.length + window.mossRequests.length), 1, "double click must not duplicate transcription")
      await stopChat()
      await fill("失败不发送")
      await page.evaluate(() => { window.sttResponse = "unauthorized"; window.mossResponse = "quota" })
      await recordAndSend()
      await page.locator(".ichat-dictation-error").waitFor()
      assert.equal(await input.inputValue(), "失败不发送")
      assert.equal(await page.evaluate(() => window.providerCalls), 1)
      await page.evaluate(() => { window.sttResponse = window.mossResponse = "hold" })
      await recordAndSend()
      await page.waitForFunction(() => typeof window.resolveStt === "function" || typeof window.resolveMoss === "function")
      await page.getByRole("button", { name: "取消转写" }).evaluate((el) => el.click())
      await fill("取消后修改")
      await page.evaluate(() => (window.resolveMoss || window.resolveStt)(new Response(JSON.stringify({ text: "过期", output: { text: "过期" } }))))
      await page.waitForTimeout(100)
      assert.equal(await input.inputValue(), "取消后修改")
      assert.equal(await page.evaluate(() => window.providerCalls), 1, "cancelled transcription must never trigger queued send")
    }
    assert.deepEqual(errors, [], "no browser runtime errors")
    console.log("PASS: production composer, dictation lifecycle, permission page, IME, stop/send, and 320/390/960px layout. Speech and provider APIs were mocked.")
  } finally {
    await browser.close()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => server.close())
