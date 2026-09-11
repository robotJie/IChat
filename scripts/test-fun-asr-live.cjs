// Optional live smoke test. Reads the key from stdin without terminal echo;
// never stores credentials. Sends only Alibaba Cloud's public sample audio.
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")

function readKey() {
  return new Promise((resolve) => {
    let input = ""
    const tty = process.stdin.isTTY
    if (tty) process.stdin.setRawMode(true)
    process.stdin.setEncoding("utf8")
    const done = () => {
      process.stdin.removeListener("data", onData)
      if (tty) process.stdin.setRawMode(false)
      process.stdin.pause()
      resolve(input.trim())
    }
    const onData = (part) => {
      if (part.includes("\u0003")) process.exit(130)
      input += part
      if (/[\r\n]/.test(input)) done()
    }
    process.stdin.on("data", onData)
    process.stdin.once("end", done)
    process.stdin.resume()
    console.log("Ready for API key on stdin (hidden input).")
  })
}

async function main() {
  const key = await readKey()
  if (!key) throw new Error("missing-key")
  const source = path.resolve(__dirname, "../src/lib/fun-asr.ts")
  const compiled = ts.transpileModule(fs.readFileSync(source, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const mod = new Module(source, module)
  mod._compile(compiled, source)
  let transcribe = mod.exports.transcribeFunAsr
  let model = mod.exports.FUN_ASR_MODEL
  if (process.argv.includes("--moss")) {
    const mossSource = path.resolve(__dirname, "../src/lib/moss-stt.ts")
    const mossModule = new Module(mossSource, module)
    mossModule.require = (id) => id === "./fun-asr" ? mod.exports : module.require(id)
    mossModule._compile(ts.transpileModule(fs.readFileSync(mossSource, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, mossSource)
    transcribe = (audio, key, _language, signal) => mossModule.exports.transcribeMoss(audio, key, signal)
    model = mossModule.exports.MOSS_STT_MODEL
  }
  const sample = await fetch("https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/paraformer/hello_world_female2.wav", { signal: AbortSignal.timeout(20000) })
  if (!sample.ok) throw new Error("sample-download-failed")
  const audio = new Blob([await sample.arrayBuffer()], { type: "audio/wav" })
  if (process.argv.includes("--silence")) {
    const originalFetch = global.fetch
    global.fetch = async (...args) => {
      const response = await originalFetch(...args)
      const body = await response.clone().json().catch(() => null)
      const message = typeof body?.message === "string" ? body.message.replaceAll(key, "[redacted]").replace(/sk-[\w.-]+/g, "[redacted]").replace(/data:[^\s"]+/g, "[audio]").slice(0, 400) : undefined
      console.log(JSON.stringify({ status: response.status, message }))
      return response
    }
    const bytes = new Uint8Array(44 + 16000 * 2 * 3)
    const view = new DataView(bytes.buffer)
    const write = (offset, text) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i) }
    write(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); write(8, "WAVEfmt ")
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    write(36, "data"); view.setUint32(40, bytes.length - 44, true)
    try {
      const text = await transcribe(new Blob([bytes], { type: "audio/wav" }), key, "zh-CN", AbortSignal.timeout(45000))
      console.log(JSON.stringify({ sample: "silence", text }))
    } catch (error) {
      console.log(JSON.stringify({ sample: "silence", code: error.code || error.name, details: error.details }))
    }
    return
  }
  if (process.argv.includes("--diagnose")) {
    const originalFetch = global.fetch
    global.fetch = async (...args) => {
      const response = await originalFetch(...args)
      const body = await response.clone().json().catch(() => null)
      const safe = (value) => typeof value === "string" ? value.replaceAll(key, "[redacted]").replace(/sk-[\w.-]+/g, "[redacted]").replace(/data:[^\s"]+/g, "[audio]").slice(0, 400) : undefined
      console.log(JSON.stringify({ status: response.status, code: safe(body?.error?.code ?? body?.code), message: safe(body?.error?.message ?? body?.message), requestId: safe(body?.request_id ?? response.headers.get("x-request-id")), outputKeys: body?.output ? Object.keys(body.output) : [] }))
      return response
    }
    for (const language of process.argv.includes("--moss") ? ["auto"] : ["zh-CN", "en-US"]) {
      try {
        const text = await transcribe(audio, key, language, AbortSignal.timeout(45000))
        console.log(JSON.stringify({ sample: "official", language, text }))
      } catch (error) {
        console.log(JSON.stringify({ sample: "official", language, error: error.code || error.name }))
      }
    }
    const { chromium } = require("playwright")
    const http = require("node:http")
    const server = http.createServer((_req, res) => res.end("<!doctype html><title>STT recording probe</title>"))
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu", "--autoplay-policy=no-user-gesture-required"] })
    try {
      const page = await browser.newPage()
      await page.goto(`http://127.0.0.1:${server.address().port}`)
      const recorderSource = fs.readFileSync(path.resolve(__dirname, "../src/lib/audio-recording.ts"), "utf8")
      const recorderCode = ts.transpileModule(recorderSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
      await page.addScriptTag({ content: `{ const exports = {}; ${recorderCode}; window.recordingApi = exports; }` })
      const originalAudio = Buffer.from(await audio.arrayBuffer()).toString("base64")
      const captured = await page.evaluate(async (base64) => {
        const context = new AudioContext()
        await context.resume()
        const buffer = await context.decodeAudioData(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer)
        const source = context.createBufferSource()
        source.buffer = buffer
        const destination = context.createMediaStreamDestination()
        source.connect(destination)
        navigator.mediaDevices.getUserMedia = async () => destination.stream
        const recording = await window.recordingApi.startAudioRecording(new AbortController().signal, () => {})
        source.start()
        await new Promise((resolve) => { source.onended = resolve })
        const wav = await recording.stop()
        await context.close()
        const bytes = new Uint8Array(await wav.arrayBuffer())
        const view = new DataView(bytes.buffer)
        let binary = ""
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
        return { base64: btoa(binary), bytes: bytes.length, rate: view.getUint32(24, true), bits: view.getUint16(34, true), duration: (bytes.length - 44) / 32000 }
      }, originalAudio)
      console.log(JSON.stringify({ sample: "browser-recorded", bytes: captured.bytes, rate: captured.rate, bits: captured.bits, duration: captured.duration }))
      const recordedAudio = new Blob([Buffer.from(captured.base64, "base64")], { type: "audio/wav" })
      try {
        const text = await transcribe(recordedAudio, key, "en-US", AbortSignal.timeout(45000))
        console.log(JSON.stringify({ sample: "browser-recorded", text }))
      } catch (error) {
        console.log(JSON.stringify({ sample: "browser-recorded", error: error.code || error.name }))
      }
    } finally {
      await browser.close()
      await new Promise((resolve) => server.close(resolve))
    }
    return
  }
  const start = performance.now()
  const text = await transcribe(audio, key, "zh-CN", AbortSignal.timeout(45000))
  console.log(JSON.stringify({ ok: true, model, elapsedMs: Math.round(performance.now() - start), transcript: text }))
}
main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.code || error.name || "failed" }))
  process.exitCode = 1
})
