importScripts("../shared/prompt-builder.js");

const { STORAGE_KEYS, DEFAULT_SETTINGS, providerLabel } = IChatShared.prompt;

const PROVIDER_CONFIG = {
  chatgpt: {
    homeUrl: "https://chatgpt.com/",
    urlPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
  },
  gemini: {
    homeUrl: "https://gemini.google.com/app",
    urlPatterns: ["https://gemini.google.com/*"]
  }
};

let lastWindowId = chrome.windows.WINDOW_ID_CURRENT;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
});

chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (typeof windowId === "number" && windowId !== chrome.windows.WINDOW_ID_NONE) {
    lastWindowId = windowId;
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (typeof windowId === "number" && windowId !== chrome.windows.WINDOW_ID_NONE) {
    lastWindowId = windowId;
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "capture-flow-context") {
    return;
  }

  openSidePanelForGesture();
  handleCaptureCommand().catch((error) => {
    console.error("IChat capture failed", error);
  });
});

chrome.action.onClicked.addListener(() => {
  openSidePanelForGesture();
  handleCaptureCommand().catch((error) => {
    console.error("IChat capture failed", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "ICHAT_GET_PANEL_STATE") {
    getPanelState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ICHAT_UPDATE_SETTINGS") {
    updateSettings(message.settings || {})
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ICHAT_TRIGGER_CAPTURE") {
    handleCaptureCommand()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ICHAT_SAVE_PROMPT_DRAFT") {
    chrome.storage.local
      .set({ [STORAGE_KEYS.promptDraft]: message.prompt || "" })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ICHAT_FLOW_CONTEXT_CAPTURED") {
    handleCapturedFlowContext(message.flowContext)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ICHAT_CAPTURE_ERROR" || message.type === "ICHAT_CAPTURE_CANCELLED") {
    handleCaptureFailure(message.error || message.reason || "Capture cancelled")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ICHAT_DISPATCH_PROMPT") {
    dispatchPrompt(message.provider, message.prompt, message.flowContextId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

function openSidePanelForGesture() {
  const windowId = typeof lastWindowId === "number" ? lastWindowId : chrome.windows.WINDOW_ID_CURRENT;

  chrome.sidePanel.open({ windowId }).catch((error) => {
    console.debug("IChat side panel open skipped", error);
  });
}

async function ensureDefaults() {
  const existing = await chrome.storage.local.get([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.captureStatus,
    STORAGE_KEYS.dispatchStatus
  ]);
  const updates = {};

  if (!existing[STORAGE_KEYS.settings]) {
    updates[STORAGE_KEYS.settings] = DEFAULT_SETTINGS;
  }

  if (!existing[STORAGE_KEYS.captureStatus]) {
    updates[STORAGE_KEYS.captureStatus] = statusPayload("idle", "Waiting for capture");
  }

  if (!existing[STORAGE_KEYS.dispatchStatus]) {
    updates[STORAGE_KEYS.dispatchStatus] = dispatchStatusPayload("idle", null, "Waiting to send");
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }
}

async function handleCaptureCommand() {
  await ensureDefaults();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.id || !isNormalWebPage(tab.url)) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.captureStatus]: statusPayload(
        "error",
        "This page does not support capture. Switch to a normal webpage and try again."
      )
    });
    return;
  }

  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.captureStatus]: statusPayload("capturing", "Capturing page context"),
      [STORAGE_KEYS.dispatchStatus]: dispatchStatusPayload("idle", null, "Waiting to send")
    });

    await pingPage(tab.id);
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
    });
  } catch (error) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.captureStatus]: statusPayload(
        "error",
        error && error.message ? error.message : "Failed to start capture"
      )
    });
    throw error;
  }
}

async function pingPage(tabId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "ICHAT_PING" });

      if (response && response.ok) {
        return true;
      }
    } catch (error) {
      await delay(250);
    }
  }

  throw new Error("Content script is not ready yet");
}

async function handleCapturedFlowContext(flowContext) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.flowContext]: flowContext,
    [STORAGE_KEYS.captureStatus]: statusPayload(
      "captured",
      flowContext && flowContext.trigger && flowContext.trigger.mode === "selection"
        ? "Selection with implicit context captured"
        : "Smart DOM context captured"
    ),
    [STORAGE_KEYS.dispatchStatus]: dispatchStatusPayload("idle", null, "Waiting to send")
  });
}

async function handleCaptureFailure(message) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.captureStatus]: statusPayload("error", message),
    [STORAGE_KEYS.dispatchStatus]: dispatchStatusPayload("idle", null, "Waiting to send")
  });
}

async function getPanelState() {
  await ensureDefaults();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.flowContext,
    STORAGE_KEYS.promptDraft,
    STORAGE_KEYS.settings,
    STORAGE_KEYS.captureStatus,
    STORAGE_KEYS.dispatchStatus
  ]);

  return {
    flowContext: stored[STORAGE_KEYS.flowContext] || null,
    promptDraft: stored[STORAGE_KEYS.promptDraft] || "",
    settings: { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) },
    captureStatus: stored[STORAGE_KEYS.captureStatus] || statusPayload("idle", "Waiting for capture"),
    dispatchStatus:
      stored[STORAGE_KEYS.dispatchStatus] || dispatchStatusPayload("idle", null, "Waiting to send")
  };
}

async function updateSettings(partialSettings) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const nextSettings = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.settings] || {}),
    ...partialSettings
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: nextSettings
  });

  return nextSettings;
}

async function dispatchPrompt(provider, prompt, flowContextId) {
  const normalizedProvider = PROVIDER_CONFIG[provider] ? provider : DEFAULT_SETTINGS.provider;

  await chrome.storage.local.set({
    [STORAGE_KEYS.dispatchStatus]: dispatchStatusPayload(
      "sending",
      flowContextId,
      `Sending to ${providerLabel(normalizedProvider)}`
    )
  });

  try {
    const targetTab = await ensureProviderTab(normalizedProvider);
    const response = await sendPromptToProviderTab(targetTab.id, normalizedProvider, prompt);

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Send failed");
    }

    const successMessage = response.submitted
      ? `Sent to ${providerLabel(normalizedProvider)}`
      : `Filled ${providerLabel(normalizedProvider)}. Please submit manually.`;

    await chrome.storage.local.set({
      [STORAGE_KEYS.dispatchStatus]: dispatchStatusPayload(
        response.submitted ? "sent" : "filled",
        flowContextId,
        successMessage,
        targetTab.id
      )
    });

    return {
      provider: normalizedProvider,
      targetTabId: targetTab.id,
      submitted: response.submitted
    };
  } catch (error) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.dispatchStatus]: dispatchStatusPayload(
        "error",
        flowContextId,
        error && error.message ? error.message : "Send failed"
      )
    });
    throw error;
  }
}

async function ensureProviderTab(provider) {
  const config = PROVIDER_CONFIG[provider];
  const tabs = await chrome.tabs.query({});
  let targetTab = tabs.find((tab) => matchesProvider(tab.url, config.urlPatterns));

  if (!targetTab) {
    targetTab = await chrome.tabs.create({
      url: config.homeUrl,
      active: false
    });
  }

  await waitForTabReady(targetTab.id);
  targetTab = await chrome.tabs.get(targetTab.id);

  if (!matchesProvider(targetTab.url, config.urlPatterns)) {
    throw new Error(
      `${providerLabel(provider)} redirected away from the app page. Please sign in first.`
    );
  }

  await ensureProviderAdapterInjected(targetTab.id);
  return targetTab;
}

async function ensureProviderAdapterInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/chat-adapter.js"]
    });
  } catch (error) {
    throw new Error(
      error && error.message ? `Could not inject AI adapter: ${error.message}` : "Could not inject AI adapter"
    );
  }
}

async function sendPromptToProviderTab(tabId, provider, prompt) {
  let lastErrorMessage = "Target AI page is not ready yet";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await ensureProviderAdapterInjected(tabId);

      const response = await chrome.tabs.sendMessage(tabId, {
        type: "ICHAT_DISPATCH_PROMPT",
        provider,
        prompt
      });

      if (response && response.ok) {
        return response;
      }

      if (response && response.error) {
        lastErrorMessage = response.error;
      } else {
        lastErrorMessage = "Target AI page did not respond";
      }
    } catch (error) {
      lastErrorMessage = error && error.message ? error.message : lastErrorMessage;
    }

    await delay(700);
  }

  throw new Error(lastErrorMessage);
}

function waitForTabReady(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Target tab load timed out"));
    }, 20000);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          clearTimeout(timeout);
          resolve();
          return;
        }

        chrome.tabs.onUpdated.addListener(onUpdated);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function isNormalWebPage(url) {
  return Boolean(url && /^https?:/i.test(url));
}

function matchesProvider(url, urlPatterns) {
  if (!url) {
    return false;
  }

  return urlPatterns.some((pattern) => {
    const prefix = pattern.replace("*", "");
    return url.startsWith(prefix);
  });
}

function statusPayload(state, message) {
  return {
    state,
    message,
    updatedAt: new Date().toISOString()
  };
}

function dispatchStatusPayload(state, flowContextId, message, targetTabId) {
  return {
    state,
    flowContextId: flowContextId || null,
    message,
    targetTabId: targetTabId || null,
    updatedAt: new Date().toISOString()
  };
}

function delay(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}
