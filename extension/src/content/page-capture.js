(function () {
  const flow = globalThis.IChatShared && globalThis.IChatShared.flow;

  if (!flow) {
    return;
  }

  const state = {
    overlay: null,
    style: null,
    lastPointer: {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
      target: null
    },
    captureSession: null,
    flashTimer: null,
    suppressPrimaryActivationUntil: 0
  };

  const CAPTURE_UI_ID = "ichat-flow-capture-ui";
  const CAPTURE_STYLE_ID = "ichat-flow-capture-style";

  window.addEventListener("pointermove", handlePointerMove, true);
  window.addEventListener("mousemove", handlePointerMove, true);
  window.addEventListener("keydown", handleKeydown, true);
  window.addEventListener("mousedown", handleMouseDown, true);
  window.addEventListener("mouseup", handleSuppressedPrimaryActivation, true);
  window.addEventListener("click", handleSuppressedPrimaryActivation, true);
  window.addEventListener("wheel", handleWheel, { capture: true, passive: false });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === "ICHAT_PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "ICHAT_START_CAPTURE") {
      Promise.resolve(startCapture(message.payload && message.payload.tabMeta))
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    return false;
  });

  function handlePointerMove(event) {
    if (isCaptureUiElement(event.target)) {
      return;
    }

    state.lastPointer = {
      x: event.clientX,
      y: event.clientY,
      target: event.target instanceof Element ? event.target : null
    };

    if (!state.captureSession) {
      return;
    }

    if (state.captureSession.pointerTarget === event.target) {
      scheduleAutoCommit(state.captureSession.manualOverride ? 2600 : 1800);
      return;
    }

    refreshCaptureSession(event.target);
  }

  function handleKeydown(event) {
    if (!state.captureSession) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelCaptureSession(true);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      confirmSmartCapture();
    }
  }

  function handleMouseDown(event) {
    if (!state.captureSession || event.button !== 0) {
      return;
    }

    suppressPrimaryActivation();
    event.preventDefault();
    event.stopPropagation();

    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }

    confirmSmartCapture();
  }

  function handleSuppressedPrimaryActivation(event) {
    if (performance.now() > state.suppressPrimaryActivationUntil) {
      return;
    }

    if ("button" in event && event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }

    if (event.type === "click") {
      state.suppressPrimaryActivationUntil = 0;
    }
  }

  function handleWheel(event) {
    if (!state.captureSession) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const session = state.captureSession;
    const delta = Math.sign(event.deltaY);

    if (delta === 0) {
      return;
    }

    if (delta < 0) {
      session.activeIndex = Math.min(session.trail.length - 1, session.activeIndex + 1);
    } else {
      session.activeIndex = Math.max(0, session.activeIndex - 1);
    }

    session.manualOverride = true;
    renderSessionHighlight();
    scheduleAutoCommit(2600);
  }

  async function startCapture(tabMeta) {
    clearFlashTimer();
    cancelCaptureSession(false);

    const selectionContext = flow.buildSelectionFlowContext(tabMeta);

    if (selectionContext) {
      flashSelection(selectionContext);
      emitMessage("ICHAT_FLOW_CONTEXT_CAPTURED", { flowContext: selectionContext });
      return { ok: true, mode: "selection", immediate: true };
    }

    const seed = getSeedElement();

    if (!seed) {
      emitMessage("ICHAT_CAPTURE_ERROR", {
        error: "No capture seed found. Move the pointer over the target area and try again."
      });
      return { ok: false, error: "No capture seed" };
    }

    armSmartCapture(tabMeta, seed);
    return { ok: true, mode: "smart-dom", immediate: false };
  }

  function getSeedElement() {
    if (state.lastPointer.target && document.contains(state.lastPointer.target)) {
      return state.lastPointer.target;
    }

    return document.elementFromPoint(state.lastPointer.x, state.lastPointer.y);
  }

  function armSmartCapture(tabMeta, seedElement) {
    const trail = flow.collectSmartTrail(seedElement);

    if (!trail.length) {
      emitMessage("ICHAT_CAPTURE_ERROR", {
        error: "The hovered area does not contain enough readable DOM text. Move the pointer and try again."
      });
      return;
    }

    state.captureSession = {
      tabMeta,
      trail,
      activeIndex: flow.pickBestCandidateIndex(trail),
      pointerTarget: seedElement,
      manualOverride: false,
      timer: null
    };

    renderSessionHighlight();
    scheduleAutoCommit(1800);
  }

  function refreshCaptureSession(seedElement) {
    if (!state.captureSession || !seedElement || !(seedElement instanceof Element)) {
      return;
    }

    const trail = flow.collectSmartTrail(seedElement);

    if (!trail.length) {
      return;
    }

    state.captureSession.trail = trail;
    state.captureSession.pointerTarget = seedElement;
    state.captureSession.manualOverride = false;
    state.captureSession.activeIndex = flow.pickBestCandidateIndex(trail);
    renderSessionHighlight();
    scheduleAutoCommit(1800);
  }

  function renderSessionHighlight() {
    const session = state.captureSession;

    if (!session) {
      return;
    }

    const candidate = session.trail[session.activeIndex];

    if (!candidate || !candidate.rect) {
      return;
    }

    showHighlight(
      candidate.rect,
      "IChat Smart Capture",
      "Scroll to resize | Left click confirm | Esc cancel"
    );
  }

  function confirmSmartCapture() {
    const session = state.captureSession;

    if (!session) {
      return;
    }

    const capturedCandidate = session.trail[session.activeIndex];
    const flowContext = flow.buildSmartFlowContext(session.tabMeta, session.trail, session.activeIndex);

    cancelCaptureSession(false);

    if (!flowContext) {
      emitMessage("ICHAT_CAPTURE_ERROR", { error: "Failed to build FlowContext" });
      return;
    }

    if (capturedCandidate && capturedCandidate.rect) {
      flashRect(capturedCandidate.rect, "IChat Captured", "Smart DOM context");
    }

    emitMessage("ICHAT_FLOW_CONTEXT_CAPTURED", { flowContext });
  }

  function cancelCaptureSession(announce) {
    if (!state.captureSession) {
      hideHighlight();
      return;
    }

    if (state.captureSession.timer) {
      clearTimeout(state.captureSession.timer);
    }

    state.captureSession = null;
    hideHighlight();

    if (announce) {
      emitMessage("ICHAT_CAPTURE_CANCELLED", { reason: "Capture cancelled" });
    }
  }

  function scheduleAutoCommit(delayMs) {
    if (!state.captureSession) {
      return;
    }

    if (state.captureSession.timer) {
      clearTimeout(state.captureSession.timer);
    }

    state.captureSession.timer = setTimeout(() => {
      confirmSmartCapture();
    }, delayMs);
  }

  function flashSelection(flowContext) {
    const rect =
      (flowContext.selection && flowContext.selection.unionRect) ||
      (flowContext.smartTarget && flowContext.smartTarget.rect);

    if (!rect) {
      return;
    }

    flashRect(rect, "IChat Captured", "Selection + implicit context");
  }

  function flashRect(rect, title, subtitle) {
    showHighlight(rect, title, subtitle);
    clearFlashTimer();
    state.flashTimer = setTimeout(() => {
      hideHighlight();
    }, 1100);
  }

  function clearFlashTimer() {
    if (state.flashTimer) {
      clearTimeout(state.flashTimer);
      state.flashTimer = null;
    }
  }

  function suppressPrimaryActivation(durationMs = 420) {
    state.suppressPrimaryActivationUntil = performance.now() + durationMs;
  }

  function ensureCaptureUi() {
    if (state.overlay && document.contains(state.overlay.root)) {
      return state.overlay;
    }

    if (!state.style) {
      const style = document.createElement("style");
      style.id = CAPTURE_STYLE_ID;
      style.textContent = `
        #${CAPTURE_UI_ID} {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 2147483647;
          font-family: "Segoe UI Variable", "Aptos", sans-serif;
        }

        #${CAPTURE_UI_ID}[data-visible="false"] {
          opacity: 0;
        }

        #${CAPTURE_UI_ID}[data-visible="true"] {
          opacity: 1;
        }

        #${CAPTURE_UI_ID} .ichat-box,
        #${CAPTURE_UI_ID} .ichat-halo,
        #${CAPTURE_UI_ID} .ichat-sheen,
        #${CAPTURE_UI_ID} .ichat-label {
          position: fixed;
          transition: all 200ms cubic-bezier(0.22, 1, 0.36, 1);
        }

        #${CAPTURE_UI_ID} .ichat-halo {
          background:
            radial-gradient(circle at top left, rgba(169, 242, 255, 0.48), transparent 48%),
            radial-gradient(circle at bottom right, rgba(255, 226, 157, 0.32), transparent 44%),
            linear-gradient(135deg, rgba(108, 225, 255, 0.28), rgba(140, 255, 223, 0.22));
          filter: blur(22px);
          border-radius: 26px;
          opacity: 0.9;
          animation: ichatHaloPulse 2.2s ease-in-out infinite;
        }

        #${CAPTURE_UI_ID} .ichat-box {
          border-radius: 22px;
          border: 1px solid rgba(244, 251, 255, 0.82);
          box-shadow:
            0 0 0 1px rgba(134, 237, 255, 0.26),
            0 0 24px rgba(104, 205, 255, 0.22),
            0 0 60px rgba(118, 255, 220, 0.16),
            inset 0 0 0 1px rgba(255, 255, 255, 0.28);
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02));
          backdrop-filter: blur(3px);
        }

        #${CAPTURE_UI_ID} .ichat-sheen {
          border-radius: 22px;
          background:
            linear-gradient(110deg, rgba(255, 255, 255, 0) 30%, rgba(255, 255, 255, 0.24) 50%, rgba(255, 255, 255, 0) 70%);
          mix-blend-mode: screen;
          opacity: 0.65;
          animation: ichatSweep 2.8s linear infinite;
        }

        #${CAPTURE_UI_ID} .ichat-label {
          min-width: 220px;
          max-width: min(360px, calc(100vw - 24px));
          padding: 10px 14px;
          border-radius: 16px;
          color: #f5fbff;
          background: rgba(10, 17, 31, 0.72);
          border: 1px solid rgba(170, 238, 255, 0.2);
          box-shadow: 0 18px 40px rgba(5, 12, 24, 0.24);
          backdrop-filter: blur(18px);
        }

        #${CAPTURE_UI_ID} .ichat-title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(196, 247, 255, 0.92);
        }

        #${CAPTURE_UI_ID} .ichat-subtitle {
          margin-top: 4px;
          font-size: 12px;
          line-height: 1.45;
          color: rgba(234, 244, 255, 0.84);
        }

        @keyframes ichatHaloPulse {
          0%,
          100% {
            transform: scale(0.985);
            opacity: 0.82;
          }

          50% {
            transform: scale(1.015);
            opacity: 1;
          }
        }

        @keyframes ichatSweep {
          0% {
            transform: translateX(-12%) skewX(-12deg);
            opacity: 0;
          }

          18% {
            opacity: 0.66;
          }

          60% {
            opacity: 0.52;
          }

          100% {
            transform: translateX(12%) skewX(-12deg);
            opacity: 0;
          }
        }
      `;
      document.documentElement.appendChild(style);
      state.style = style;
    }

    const root = document.createElement("div");
    root.id = CAPTURE_UI_ID;
    root.dataset.visible = "false";
    root.innerHTML = `
      <div class="ichat-halo"></div>
      <div class="ichat-box"></div>
      <div class="ichat-sheen"></div>
      <div class="ichat-label">
        <div class="ichat-title"></div>
        <div class="ichat-subtitle"></div>
      </div>
    `;

    document.documentElement.appendChild(root);

    state.overlay = {
      root,
      halo: root.querySelector(".ichat-halo"),
      box: root.querySelector(".ichat-box"),
      sheen: root.querySelector(".ichat-sheen"),
      label: root.querySelector(".ichat-label"),
      title: root.querySelector(".ichat-title"),
      subtitle: root.querySelector(".ichat-subtitle")
    };

    return state.overlay;
  }

  function showHighlight(rect, title, subtitle) {
    const ui = ensureCaptureUi();
    const padding = 8;
    const x = Math.max(6, rect.left - padding);
    const y = Math.max(6, rect.top - padding);
    const width = Math.max(40, rect.width + padding * 2);
    const height = Math.max(24, rect.height + padding * 2);
    const labelHeight = 54;
    const labelTop = y > 84 ? y - 64 : y + height + 10;
    const labelLeft = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 372));

    applyBox(ui.halo, x - 8, y - 8, width + 16, height + 16);
    applyBox(ui.box, x, y, width, height);
    applyBox(ui.sheen, x, y, width, height);
    applyBox(ui.label, labelLeft, labelTop, Math.min(360, window.innerWidth - 16), labelHeight);

    ui.title.textContent = title;
    ui.subtitle.textContent = subtitle;
    ui.root.dataset.visible = "true";
  }

  function hideHighlight() {
    const ui = state.overlay;

    if (!ui) {
      return;
    }

    ui.root.dataset.visible = "false";
  }

  function applyBox(element, left, top, width, height) {
    if (!element) {
      return;
    }

    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
  }

  function isCaptureUiElement(target) {
    return Boolean(target && target instanceof Element && target.closest(`#${CAPTURE_UI_ID}`));
  }

  function emitMessage(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, ...payload });
    } catch (error) {
      console.debug("IChat message failed", error);
    }
  }
})();
