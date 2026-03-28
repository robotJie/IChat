import { createPendingPrompt, captureStatusPayload, dispatchStatusPayload, getActiveProvider, getProviderModel, isAutoSendEnabled, providerLabels } from "./lib/prompt-builder"
import { resolveFlowContextAttachments } from "./lib/flow-context-media"
import { ensureDefaults, getAppState, setCaptureStatus, setDispatchStatus, setFlowContext, setPendingPrompt, updateSettings } from "./lib/storage"
import { getVisionBlockedMessage, supportsVisionInput } from "./lib/vision-capabilities"
import type { FlowContext } from "./lib/types"

let lastWindowId: number = chrome.windows.WINDOW_ID_CURRENT
const DEBUG_CAPTURE = true
const CAPTURE_PING_ATTEMPTS = 12
const CAPTURE_PING_DELAY_MS = 250

function debugCapture(stage: string, payload?: unknown) {
  if (!DEBUG_CAPTURE) {
    return
  }

  console.debug(`[IChat background] ${stage}`, payload)
}

function summarizeFlowContext(flowContext: FlowContext | null | undefined) {
  return flowContext
    ? {
        id: flowContext.id,
        mode: flowContext.trigger.mode,
        primaryCaptureKind: flowContext.primaryCaptureKind,
        primaryAttachmentId: flowContext.primaryAttachmentId,
        smartTarget: flowContext.smartTarget
          ? {
              kind: flowContext.smartTarget.kind,
              tag: flowContext.smartTarget.tag,
              attachmentId: flowContext.smartTarget.attachmentId || null,
              sourceUrl: flowContext.smartTarget.sourceUrl || null,
              textPreview: typeof flowContext.smartTarget.text === "string" ? flowContext.smartTarget.text.slice(0, 120) : null
            }
          : null,
        implicitContext: flowContext.implicitContext
          ? {
              textLength: flowContext.implicitContext.textLength,
              textPreview: typeof flowContext.implicitContext.text === "string" ? flowContext.implicitContext.text.slice(0, 120) : null
            }
          : null,
        attachments: flowContext.attachments.map((attachment) => ({
          id: attachment.id,
          kind: attachment.kind,
          sourceUrl: attachment.sourceUrl || null,
          strategy: attachment.resolutionHint?.strategy || null,
          blobStoreKey: attachment.blobStoreKey || null,
          normalizedMimeType: attachment.normalizedMimeType || null
        }))
      }
    : null
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults()
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
})

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults()
})

chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (typeof windowId === "number" && windowId !== chrome.windows.WINDOW_ID_NONE) {
    lastWindowId = windowId
  }
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (typeof windowId === "number" && windowId !== chrome.windows.WINDOW_ID_NONE) {
    lastWindowId = windowId
  }
})

chrome.commands.onCommand.addListener((command) => {
  if (command !== "capture-flow-context") {
    return
  }

  openSidePanelForGesture()
  void handleCaptureCommand().catch(handleCaptureCommandError)
})

chrome.action.onClicked.addListener(() => {
  openSidePanelForGesture()
  void handleCaptureCommand().catch(handleCaptureCommandError)
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return false
  }

  if (message.type === "ICHAT_TRIGGER_CAPTURE") {
    handleCaptureCommand()
      .then(() => sendResponse({ ok: true }))
      .catch(async (error: Error) => {
        await handleCaptureCommandError(error)
        sendResponse({ ok: false, error: toUserFacingCaptureError(error).message })
      })
    return true
  }

  if (message.type === "ICHAT_CANCEL_CAPTURE") {
    handleCancelCapture()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }))
    return true
  }

  if (message.type === "ICHAT_GET_APP_STATE") {
    getAppState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }))
    return true
  }

  if (message.type === "ICHAT_UPDATE_SETTINGS") {
    updateSettings(message.settings ?? {})
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }))
    return true
  }

  if (message.type === "ICHAT_FLOW_CONTEXT_CAPTURED") {
    handleCapturedFlowContext(message.flowContext as FlowContext)
      .then(() => sendResponse({ ok: true }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }))
    return true
  }

  if (message.type === "ICHAT_CAPTURE_ERROR" || message.type === "ICHAT_CAPTURE_CANCELLED") {
    const reason = message.error || message.reason || "Capture cancelled"
    handleCaptureFailure(reason)
      .then(() => sendResponse({ ok: true }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }))
    return true
  }

  return false
})

function openSidePanelForGesture() {
  const windowId = typeof lastWindowId === "number" ? lastWindowId : chrome.windows.WINDOW_ID_CURRENT

  chrome.sidePanel.open({ windowId }).catch((error) => {
    console.debug("IChat side panel open skipped", error)
  })
}

async function handleCaptureCommand() {
  await ensureDefaults()
  const tab = await getActiveCaptureTab()

  if (!tab?.id || !isNormalWebPage(tab.url)) {
    await Promise.all([
      setCaptureStatus(captureStatusPayload("error", "This page cannot be captured. Switch to a regular website and try again.")),
      setDispatchStatus(dispatchStatusPayload("idle", "Waiting for new context", null, null))
    ])
    return
  }

  await Promise.all([
    setCaptureStatus(captureStatusPayload("capturing", "Reading the current page context...")),
    setDispatchStatus(dispatchStatusPayload("idle", "Waiting for new context", null, null)),
    setPendingPrompt(null)
  ])

  await ensureContentScriptInjected(tab.id)
  await pingPage(tab.id)
  await chrome.tabs.sendMessage(tab.id, {
    type: "ICHAT_START_CAPTURE",
    payload: {
      tabMeta: {
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url
      }
    }
  })
}

async function handleCaptureCommandError(error: unknown) {
  const normalizedError = toUserFacingCaptureError(error)
  console.debug("IChat capture command failed", normalizedError)
  await handleCaptureFailure(normalizedError.message)
}

async function getActiveCaptureTab() {
  const tabs = await chrome.tabs.query({ active: true, windowId: lastWindowId })
  const [tab] = tabs.length > 0 ? tabs : await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ?? null
}

async function handleCancelCapture() {
  const tab = await getActiveCaptureTab()

  if (!tab?.id || !isNormalWebPage(tab.url)) {
    return { cancelled: false }
  }

  await ensureContentScriptInjected(tab.id)
  await pingPage(tab.id)
  const response = await chrome.tabs.sendMessage(tab.id, { type: "ICHAT_CANCEL_CAPTURE" })
  return { cancelled: Boolean(response?.cancelled) }
}

async function pingPage(tabId: number) {
  let lastErrorMessage: string | null = null

  for (let attempt = 0; attempt < CAPTURE_PING_ATTEMPTS; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "ICHAT_PING" })
      if (response?.ok) {
        return true
      }
      lastErrorMessage = "Content script ping returned no acknowledgement."
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error)
      await delay(CAPTURE_PING_DELAY_MS)
    }
  }

  throw new Error(
    lastErrorMessage
      ? `Content script did not become ready. Native error: ${lastErrorMessage}`
      : "Content script did not become ready after injection."
  )
}

async function ensureContentScriptInjected(tabId: number) {
  const manifest = chrome.runtime.getManifest()
  const files = Array.from(
    new Set(
      (manifest.content_scripts ?? []).flatMap((script) => script.js ?? [])
    )
  )

  if (files.length === 0) {
    throw new Error("No content script files were found in the manifest")
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files
    })
  } catch (error) {
    throw new Error(`Content script injection failed. Native error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function toUserFacingCaptureError(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const normalizedMessage = rawMessage.trim() || "Unknown capture error."
  const loweredMessage = normalizedMessage.toLowerCase()

  if (
    loweredMessage.includes("extensions gallery cannot be scripted") ||
    loweredMessage.includes("cannot access contents of url") ||
    loweredMessage.includes("cannot access a chrome://") ||
    loweredMessage.includes("cannot access this page")
  ) {
    return new Error(`Chrome blocked capture on this protected or restricted page. Native error: ${normalizedMessage}`)
  }

  if (loweredMessage.includes("receiving end does not exist")) {
    return new Error(`The page did not accept the content script after injection. Native error: ${normalizedMessage}`)
  }

  return new Error(normalizedMessage)
}

async function handleCapturedFlowContext(flowContext: FlowContext) {
  debugCapture("received flow context", summarizeFlowContext(flowContext))
  const resolvedFlowContext = await resolveFlowContextAttachments(flowContext)
  debugCapture("resolved flow context attachments", summarizeFlowContext(resolvedFlowContext))
  const { settings } = await getAppState()
  const pendingPrompt = createPendingPrompt(resolvedFlowContext, settings)
  const activeProvider = getActiveProvider(settings)
  const autoSendEnabled = isAutoSendEnabled(settings)
  const modelId = getProviderModel(settings, activeProvider)
  const modelSupportsVision = supportsVisionInput(activeProvider, modelId)
  const captureMessage = resolvedFlowContext.primaryCaptureKind === "image"
    ? "Captured image context and surrounding text"
    : resolvedFlowContext.trigger.mode === "selection"
      ? "Captured selected text and surrounding context"
      : "Captured smart DOM context"

  if (pendingPrompt.requiresVision && !modelSupportsVision) {
    const blockedMessage = getVisionBlockedMessage(activeProvider, modelId)

    await Promise.all([
      setFlowContext(resolvedFlowContext),
      setPendingPrompt({
        ...pendingPrompt,
        status: "draft",
        error: blockedMessage
      }),
      setCaptureStatus(captureStatusPayload("captured", captureMessage)),
      setDispatchStatus(dispatchStatusPayload("error", blockedMessage, activeProvider, resolvedFlowContext.id))
    ])
    return
  }

  const autoSendMessage = autoSendEnabled
    ? `Captured page context and preparing to send it to ${providerLabels[activeProvider]}`
    : "Captured page context and waiting for you to send it manually"

  await Promise.all([
    setFlowContext(resolvedFlowContext),
    setPendingPrompt(pendingPrompt),
    setCaptureStatus(captureStatusPayload("captured", captureMessage)),
    setDispatchStatus(dispatchStatusPayload(autoSendEnabled ? "sending" : "draft", autoSendMessage, activeProvider, resolvedFlowContext.id))
  ])
}

async function handleCaptureFailure(message: string) {
  await Promise.all([
    setCaptureStatus(captureStatusPayload("error", message)),
    setDispatchStatus(dispatchStatusPayload("idle", "Waiting for new context", null, null)),
    setPendingPrompt(null)
  ])
}

function isNormalWebPage(url?: string | null) {
  return Boolean(url && /^https?:/i.test(url))
}

function delay(duration: number) {
  return new Promise((resolve) => setTimeout(resolve, duration))
}
