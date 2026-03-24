(function () {
  const shared = globalThis.IChatShared && globalThis.IChatShared.prompt;

  if (!shared) {
    return;
  }

  const { DEFAULT_SETTINGS, STORAGE_KEYS, composePrompt, providerLabel } = shared;
  const state = {
    flowContext: null,
    promptDraft: "",
    settings: { ...DEFAULT_SETTINGS },
    captureStatus: { state: "idle", message: "等待捕获" },
    dispatchStatus: { state: "idle", message: "等待发送", flowContextId: null },
    sending: false,
    draftTouched: false,
    lastComposedPrompt: ""
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    bindEvents();
    await hydrateState();
    render();
    chrome.storage.onChanged.addListener(handleStorageChange);
  }

  function cacheElements() {
    elements.captureStatus = document.getElementById("captureStatus");
    elements.dispatchStatus = document.getElementById("dispatchStatus");
    elements.triggerMode = document.getElementById("triggerMode");
    elements.pageTitle = document.getElementById("pageTitle");
    elements.pageUrl = document.getElementById("pageUrl");
    elements.locatorValue = document.getElementById("locatorValue");
    elements.capturedAt = document.getElementById("capturedAt");
    elements.selectionCard = document.getElementById("selectionCard");
    elements.selectionText = document.getElementById("selectionText");
    elements.smartText = document.getElementById("smartText");
    elements.providerButtons = Array.from(document.querySelectorAll("[data-provider]"));
    elements.autoSendToggle = document.getElementById("autoSendToggle");
    elements.promptDraft = document.getElementById("promptDraft");
    elements.recaptureButton = document.getElementById("recaptureButton");
    elements.dispatchButton = document.getElementById("dispatchButton");
  }

  function bindEvents() {
    elements.providerButtons.forEach((button) => {
      button.addEventListener("click", async () => {
        if (state.settings.provider === button.dataset.provider) {
          return;
        }

        state.settings.provider = button.dataset.provider;
        await saveSettings();
        render();
      });
    });

    elements.autoSendToggle.addEventListener("click", async () => {
      state.settings.autoSend = !state.settings.autoSend;
      await saveSettings();
      render();

      if (state.settings.autoSend) {
        maybeAutoDispatch(true);
      }
    });

    elements.promptDraft.addEventListener("input", () => {
      state.promptDraft = elements.promptDraft.value;
      state.draftTouched = true;
      persistPromptDraft();
      renderActionButton();
    });

    elements.recaptureButton.addEventListener("click", async () => {
      await sendMessage({ type: "ICHAT_TRIGGER_CAPTURE" });
    });

    elements.dispatchButton.addEventListener("click", async () => {
      await dispatchPrompt(false);
    });
  }

  async function hydrateState() {
    const response = await sendMessage({ type: "ICHAT_GET_PANEL_STATE" });

    if (!response || !response.ok) {
      return;
    }

    applyIncomingState(response.state, true);
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") {
      return;
    }

    const patch = {};

    if (changes[STORAGE_KEYS.flowContext]) {
      patch.flowContext = changes[STORAGE_KEYS.flowContext].newValue || null;
    }

    if (changes[STORAGE_KEYS.promptDraft]) {
      patch.promptDraft = changes[STORAGE_KEYS.promptDraft].newValue || "";
    }

    if (changes[STORAGE_KEYS.settings]) {
      patch.settings = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEYS.settings].newValue || {}) };
    }

    if (changes[STORAGE_KEYS.captureStatus]) {
      patch.captureStatus = changes[STORAGE_KEYS.captureStatus].newValue;
    }

    if (changes[STORAGE_KEYS.dispatchStatus]) {
      patch.dispatchStatus = changes[STORAGE_KEYS.dispatchStatus].newValue;
      state.sending = patch.dispatchStatus && patch.dispatchStatus.state === "sending";
    }

    applyIncomingState(patch, false);
  }

  function applyIncomingState(patch, initialLoad) {
    const flowChanged = Object.prototype.hasOwnProperty.call(patch, "flowContext") &&
      patch.flowContext &&
      (!state.flowContext || patch.flowContext.id !== state.flowContext.id);

    if (Object.prototype.hasOwnProperty.call(patch, "flowContext")) {
      state.flowContext = patch.flowContext;
      state.draftTouched = false;
    }

    if (Object.prototype.hasOwnProperty.call(patch, "settings")) {
      state.settings = { ...state.settings, ...patch.settings };
    }

    if (Object.prototype.hasOwnProperty.call(patch, "captureStatus") && patch.captureStatus) {
      state.captureStatus = patch.captureStatus;
    }

    if (Object.prototype.hasOwnProperty.call(patch, "dispatchStatus") && patch.dispatchStatus) {
      state.dispatchStatus = patch.dispatchStatus;
    }

    if (Object.prototype.hasOwnProperty.call(patch, "promptDraft")) {
      state.promptDraft = patch.promptDraft;
    }

    if ((flowChanged || initialLoad) && state.flowContext) {
      const composed = composePrompt(state.flowContext);
      state.lastComposedPrompt = composed;

      if (!state.draftTouched || !state.promptDraft) {
        state.promptDraft = composed;
        persistPromptDraft();
      }
    }

    render();

    if (flowChanged || initialLoad) {
      maybeAutoDispatch(initialLoad);
    }
  }

  function maybeAutoDispatch() {
    if (
      !state.settings.autoSend ||
      !state.flowContext ||
      !state.promptDraft ||
      state.sending ||
      state.dispatchStatus.flowContextId === state.flowContext.id
    ) {
      return;
    }

    dispatchPrompt(true);
  }

  async function dispatchPrompt(isAuto) {
    if (!state.flowContext || !state.promptDraft.trim() || state.sending) {
      return;
    }

    state.sending = true;
    renderActionButton();

    const response = await sendMessage({
      type: "ICHAT_DISPATCH_PROMPT",
      provider: state.settings.provider,
      prompt: state.promptDraft,
      flowContextId: state.flowContext.id
    });

    state.sending = false;

    if (!response || !response.ok) {
      state.dispatchStatus = {
        state: "error",
        message: isAuto
          ? `自动发送失败：${response && response.error ? response.error : "未知错误"}`
          : `发送失败：${response && response.error ? response.error : "未知错误"}`,
        flowContextId: state.flowContext.id
      };
    }

    render();
  }

  async function saveSettings() {
    await sendMessage({
      type: "ICHAT_UPDATE_SETTINGS",
      settings: state.settings
    });
  }

  function persistPromptDraft() {
    sendMessage({
      type: "ICHAT_SAVE_PROMPT_DRAFT",
      prompt: state.promptDraft
    }).catch(() => {});
  }

  function render() {
    renderStatuses();
    renderContext();
    renderControls();
    renderPrompt();
    renderActionButton();
  }

  function renderStatuses() {
    elements.captureStatus.textContent = state.captureStatus.message || "等待捕获";
    elements.dispatchStatus.textContent = state.dispatchStatus.message || "等待发送";
  }

  function renderContext() {
    const flowContext = state.flowContext;

    if (!flowContext) {
      elements.triggerMode.textContent = "未捕获";
      elements.pageTitle.textContent = "等待捕获网页上下文";
      elements.pageUrl.textContent = "尚未捕获 URL";
      elements.pageUrl.removeAttribute("href");
      elements.selectionText.textContent = "还没有划词内容";
      elements.selectionText.classList.add("empty");
      elements.smartText.textContent = "还没有智能选区内容";
      elements.smartText.classList.add("empty");
      elements.locatorValue.textContent = "-";
      elements.capturedAt.textContent = "-";
      return;
    }

    elements.triggerMode.textContent =
      flowContext.trigger.mode === "selection" ? "方案 1 + Bonus 1" : "方案 2";
    elements.pageTitle.textContent = flowContext.page.title || "未知标题";
    elements.pageUrl.textContent = flowContext.page.url || "未知 URL";
    elements.pageUrl.href = flowContext.page.url || "#";
    elements.locatorValue.textContent = getPrimaryLocator(flowContext) || "-";
    elements.capturedAt.textContent = formatCapturedAt(flowContext.createdAt);

    if (flowContext.selection && flowContext.selection.text) {
      elements.selectionText.textContent = flowContext.selection.text;
      elements.selectionText.classList.remove("empty");
      elements.selectionCard.style.display = "block";
    } else {
      elements.selectionText.textContent = "这次没有检测到用户划词，已直接走智能 DOM 选区。";
      elements.selectionText.classList.add("empty");
    }

    if (flowContext.smartTarget && flowContext.smartTarget.text) {
      elements.smartText.textContent = flowContext.smartTarget.text;
      elements.smartText.classList.remove("empty");
    } else {
      elements.smartText.textContent = "还没有智能选区内容";
      elements.smartText.classList.add("empty");
    }
  }

  function renderControls() {
    elements.providerButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.provider === state.settings.provider);
    });

    elements.autoSendToggle.classList.toggle("on", Boolean(state.settings.autoSend));
    elements.autoSendToggle.textContent = state.settings.autoSend ? "自动发送已开" : "自动发送已关";
  }

  function renderPrompt() {
    if (document.activeElement !== elements.promptDraft) {
      elements.promptDraft.value = state.promptDraft || "";
    }
  }

  function renderActionButton() {
    elements.dispatchButton.textContent = state.sending
      ? `正在发送到 ${providerLabel(state.settings.provider)}`
      : `再次发送到 ${providerLabel(state.settings.provider)}`;
  }

  function getPrimaryLocator(flowContext) {
    if (flowContext.selection && flowContext.selection.anchorLocator && flowContext.selection.anchorLocator.xpath) {
      return flowContext.selection.anchorLocator.xpath;
    }

    if (flowContext.smartTarget && flowContext.smartTarget.locator && flowContext.smartTarget.locator.xpath) {
      return flowContext.smartTarget.locator.xpath;
    }

    return "-";
  }

  function formatCapturedAt(value) {
    if (!value) {
      return "-";
    }

    const date = new Date(value);
    return date.toLocaleString("zh-CN", {
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function sendMessage(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        resolve(response);
      });
    });
  }
})();
