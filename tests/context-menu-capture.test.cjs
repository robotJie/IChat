const assert = require("node:assert/strict")
const { test } = require("node:test")
const { loadModule } = require("./helpers/load-module.cjs")

const { buildContextMenuSelection, CAPTURE_SELECTION_MENU_ID } = loadModule("context-menu-capture.ts")
const tab = { id: 42, windowId: 7, url: "https://arxiv.org/pdf/2210.03629", title: "ReAct" }
const info = {
  menuItemId: CAPTURE_SELECTION_MENU_ID, editable: false,
  selectionText: "Reasoning and acting\n模型推理与行动",
  frameUrl: "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html"
}

function workerHarness(autoSend = false, panelError = null) {
  const listeners = {}
  const log = []
  const menus = new Map()
  const state = { settings: structuredClone(loadModule("prompt-builder.ts").DEFAULT_SETTINGS) }
  state.settings.context.autoSend = autoSend
  state.settings.uiLanguage = "zh-CN"
  const event = (name) => ({ addListener: (listener) => { listeners[name] = listener } })
  const chrome = {
    runtime: { onInstalled: event("installed"), onStartup: event("startup"), onMessage: event("message") },
    storage: { onChanged: event("storage") },
    windows: { WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1, onFocusChanged: event("focus") },
    tabs: { onActivated: event("activated") },
    commands: { onCommand: event("command") },
    action: { onClicked: event("action") },
    sidePanel: {
      setPanelBehavior: async () => {},
      open: (options) => {
        log.push({ kind: "open", windowId: options.windowId })
        return panelError ? Promise.reject(new Error(panelError)) : Promise.resolve()
      }
    },
    contextMenus: {
      onClicked: event("menu"),
      update: (id, props, callback) => {
        if (menus.has(id)) Object.assign(menus.get(id), props)
        else chrome.runtime.lastError = { message: "Menu not found" }
        callback()
        delete chrome.runtime.lastError
      },
      create: (props, callback) => {
        delete chrome.runtime.lastError
        assert.equal(menus.has(props.id), false, "must not create duplicate menus")
        menus.set(props.id, props)
        callback()
      }
    }
  }
  const storage = {
    ensureDefaults: async () => { log.push({ kind: "defaults" }) },
    getAppState: async () => state,
    setFlowContext: async (flow) => { state.flow = flow },
    setPendingPrompt: async (prompt) => { state.pending = prompt },
    setCaptureStatus: async (status) => { state.capture = status },
    setDispatchStatus: async (status) => { state.dispatch = status }
  }
  loadModule("../background.ts", { chrome, console: { debug() {} } }, {
    "./lib/storage": storage,
    "./lib/flow-context-media": {
      resolveFlowContextAttachments: async (flow) => {
        assert.equal(flow.attachments.length, 0, "selection must never request screenshots")
        return flow
      }
    },
    "./lib/vision-capabilities": {
      supportsVisionInput: () => false,
      getVisionBlockedMessage: () => { throw new Error("Text capture must work with text-only models") }
    }
  })
  return { listeners, state, log, menus }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("PDF menu selections preserve text and original URL without invented DOM context", () => {
  const flow = buildContextMenuSelection(info, tab)
  assert.equal(flow.selection.text, info.selectionText)
  assert.equal(flow.page.url, tab.url)
  assert.equal(flow.trigger.source, "context-menu")
  assert.equal(flow.trigger.mode, "selection")
  assert.equal(flow.primaryCaptureKind, "text")
  assert.equal(flow.attachments.length, 0)
  assert.equal(flow.implicitContext, null)
  assert.equal(flow.selection.anchorLocator, null)
  assert.equal(buildContextMenuSelection({ ...info, selectionText: "  " }, tab), null)
})

test("web iframe, local PDF and missing URL selections retain usable source metadata", () => {
  const frame = buildContextMenuSelection({ ...info, frameUrl: "https://example.org/article" }, tab)
  assert.equal(frame.page.url, "https://example.org/article")
  const local = buildContextMenuSelection(info, { ...tab, url: "file:///C:/paper.pdf" })
  assert.equal(local.page.url, "file:///C:/paper.pdf")
  assert.equal(local.page.host, null)
  const unknown = buildContextMenuSelection({ ...info, frameUrl: undefined }, { ...tab, url: undefined })
  assert.equal(unknown.selection.text, info.selectionText)
})

for (const autoSend of [false, true]) {
  test(`menu click opens the clicked window immediately and honors auto-send=${autoSend}`, async () => {
    const { listeners, state, log } = workerHarness(autoSend)
    listeners.focus(99) // A different window was last focused.
    listeners.menu(info, tab)
    assert.equal(log.length, 1, "panel open must happen before any async storage work")
    assert.deepEqual(log[0], { kind: "open", windowId: 7 })
    await settle()
    assert.equal(state.flow.selection.text, info.selectionText)
    assert.equal(state.pending.flowContextId, state.flow.id)
    assert.equal(state.pending.requiresVision, false)
    assert.equal(state.pending.attachmentIds.length, 0)
    assert.ok(state.pending.prompt.includes(info.selectionText))
    assert.equal(state.pending.status, autoSend ? "pending" : "draft")
    assert.equal(state.dispatch.state, autoSend ? "sending" : "draft")
    assert.equal(state.capture.message, "已通过右键菜单捕获选中文字。")
  })
}

test("empty selections, unrelated menus and absent tabs do not start capture", async () => {
  const { listeners, state, log } = workerHarness()
  listeners.menu({ ...info, selectionText: " " }, tab)
  listeners.menu({ ...info, menuItemId: "another-menu" }, tab)
  listeners.menu(info, undefined)
  await settle()
  assert.equal(log.length, 0)
  assert.equal(state.pending, undefined)
})

test("panel-opening failures produce an error and do not auto-send", async () => {
  const { listeners, state } = workerHarness(true, "Panel open denied")
  listeners.menu(info, tab)
  await settle()
  assert.equal(state.capture.state, "error")
  assert.equal(state.pending, null)
  assert.equal(state.flow, undefined)
})

test("install, startup and language changes keep one selection-only localized menu", async () => {
  const { listeners, state, menus } = workerHarness()
  await listeners.installed()
  await listeners.startup()
  assert.equal(menus.size, 1)
  assert.equal(menus.get(CAPTURE_SELECTION_MENU_ID).title, "用 IChat 捕获选中文字")
  assert.equal(menus.get(CAPTURE_SELECTION_MENU_ID).contexts.join(), "selection")
  state.settings.uiLanguage = "en"
  listeners.storage({ "ichat.settings": {} }, "local")
  await settle()
  assert.equal(menus.size, 1)
  assert.equal(menus.get(CAPTURE_SELECTION_MENU_ID).title, "Capture selected text with IChat")
})
