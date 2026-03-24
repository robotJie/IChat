// @ts-nocheck
import type { PlasmoCSConfig } from "plasmo"
import {
  buildSelectionFlowContext,
  buildSmartFlowContext,
  collectSmartTrail,
  findPreferredSmartCaptureSeed,
  pickBestCandidateIndex
} from "../lib/flow-context"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle",
  all_frames: false
}

const captureScope = globalThis as typeof globalThis & {
  __ICHAT_PAGE_CAPTURE_READY__?: boolean
}

if (!captureScope.__ICHAT_PAGE_CAPTURE_READY__) {
  captureScope.__ICHAT_PAGE_CAPTURE_READY__ = true

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
  const DEBUG_CAPTURE = true;

  function debugCapture(stage, payload) {
    if (!DEBUG_CAPTURE) {
      return;
    }

    console.debug(`[IChat capture] ${stage}`, payload);
  }

  function describeElement(element) {
    if (!(element instanceof Element)) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      className: element.className || null,
      id: element.id || null,
      alt: element.getAttribute?.("alt") || null,
      src: element.getAttribute?.("src") || element.getAttribute?.("currentSrc") || null,
      text: (element.innerText || element.textContent || "").trim().slice(0, 120) || null,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function summarizeTrail(trail) {
    return Array.isArray(trail)
      ? trail.map((candidate, index) => ({
          index,
          kind: candidate.kind,
          tag: candidate.tagName,
          depth: candidate.depth,
          score: Math.round(candidate.score || 0),
          textLength: candidate.textLength || 0,
          attachmentId: candidate.attachmentId || null,
          sourceUrl: candidate.sourceUrl || null,
          rect: candidate.rect
            ? {
                left: candidate.rect.left,
                top: candidate.rect.top,
                width: candidate.rect.width,
                height: candidate.rect.height
              }
            : null,
          textPreview: typeof candidate.text === "string" ? candidate.text.slice(0, 120) : null
        }))
      : [];
  }

  function summarizeFlowContext(flowContext) {
    return flowContext
      ? {
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
          attachments: Array.isArray(flowContext.attachments)
            ? flowContext.attachments.map((attachment) => ({
                id: attachment.id,
                kind: attachment.kind,
                sourceUrl: attachment.sourceUrl || null,
                strategy: attachment.resolutionHint?.strategy || null,
                blobStoreKey: attachment.blobStoreKey || null
              }))
            : []
        }
      : null;
  }

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

    if (message.type === "ICHAT_FETCH_PAGE_ASSET") {
      Promise.resolve(fetchPageAsset(message.payload && message.payload.url))
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type === "ICHAT_READ_ATTACHMENT_DATA") {
      Promise.resolve(readAttachmentData(message.payload || {}))
        .then((result) => sendResponse({ ok: true, ...result }))
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

    const selectionContext = buildSelectionFlowContext(tabMeta);
    debugCapture("start capture", {
      tabUrl: tabMeta?.url || window.location.href,
      lastPointer: {
        x: state.lastPointer.x,
        y: state.lastPointer.y,
        target: describeElement(state.lastPointer.target)
      },
      hasSelectionContext: Boolean(selectionContext)
    });

    if (selectionContext) {
      debugCapture("selection context resolved", summarizeFlowContext(selectionContext));
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
    return findPreferredSmartCaptureSeed(
      state.lastPointer.target,
      state.lastPointer.x,
      state.lastPointer.y
    );
  }

  function armSmartCapture(tabMeta, seedElement) {
    const trail = collectSmartTrail(seedElement);

    if (!trail.length) {
      emitMessage("ICHAT_CAPTURE_ERROR", {
        error: "The hovered area does not contain enough readable text or media. Move the pointer and try again."
      });
      return;
    }

    state.captureSession = {
      tabMeta,
      trail,
      activeIndex: pickBestCandidateIndex(trail, seedElement),
      pointerTarget: seedElement,
      manualOverride: false,
      timer: null
    };

    debugCapture("smart capture armed", {
      seed: describeElement(seedElement),
      activeIndex: state.captureSession.activeIndex,
      activeCandidate: summarizeTrail([trail[state.captureSession.activeIndex]])[0] || null,
      trail: summarizeTrail(trail)
    });

    renderSessionHighlight();
    scheduleAutoCommit(1800);
  }

  function refreshCaptureSession(seedElement) {
    if (!state.captureSession || !seedElement || !(seedElement instanceof Element)) {
      return;
    }

    const trail = collectSmartTrail(seedElement);

    if (!trail.length) {
      return;
    }

    state.captureSession.trail = trail;
    state.captureSession.pointerTarget = seedElement;
    state.captureSession.manualOverride = false;
    state.captureSession.activeIndex = pickBestCandidateIndex(trail, seedElement);
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
    const flowContext = buildSmartFlowContext(session.tabMeta, session.trail, session.activeIndex);

    debugCapture("confirm smart capture", {
      pointerTarget: describeElement(session.pointerTarget),
      activeIndex: session.activeIndex,
      capturedCandidate: summarizeTrail([capturedCandidate])[0] || null,
      trail: summarizeTrail(session.trail),
      flowContext: summarizeFlowContext(flowContext)
    });

    cancelCaptureSession(false);

    if (!flowContext) {
      emitMessage("ICHAT_CAPTURE_ERROR", { error: "Failed to build FlowContext" });
      return;
    }

    if (capturedCandidate && capturedCandidate.rect) {
      const subtitle = capturedCandidate.kind === "image"
        ? "Smart image context"
        : capturedCandidate.kind === "video"
          ? "Smart video context"
          : "Smart DOM context";
      flashRect(capturedCandidate.rect, "IChat Captured", subtitle);
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
  async function fetchPageAsset(url) {
    if (!url || typeof url !== "string") {
      throw new Error("No page asset URL was provided")
    }

    const response = await fetch(url, {
      credentials: "include",
      cache: "force-cache"
    })

    if (!response.ok) {
      throw new Error(`Page asset request failed with ${response.status}`)
    }

    const blob = await response.blob()
    return {
      dataUrl: await blobToDataUrl(blob),
      mediaType: blob.type || response.headers.get("content-type") || null
    }
  }

  async function readAttachmentData(payload) {
    const target = findAttachmentElement(payload)
    if (!target) {
      throw new Error("Attachment target is no longer available in the page")
    }

    if (target instanceof HTMLCanvasElement) {
      return {
        dataUrl: target.toDataURL("image/png"),
        mediaType: "image/png"
      }
    }

    if (target instanceof HTMLImageElement) {
      const sourceUrl = target.currentSrc || target.src || payload.sourceUrl || ""
      if (sourceUrl.startsWith("data:")) {
        return {
          dataUrl: sourceUrl,
          mediaType: target.currentSrc?.slice(5, target.currentSrc.indexOf(";")) || "image/png"
        }
      }

      if (sourceUrl.startsWith("blob:")) {
        const blob = await fetch(sourceUrl).then((response) => response.blob())
        return {
          dataUrl: await blobToDataUrl(blob),
          mediaType: blob.type || null
        }
      }

      const response = await fetch(sourceUrl, {
        credentials: "include",
        cache: "force-cache"
      })
      if (!response.ok) {
        throw new Error(`Attachment request failed with ${response.status}`)
      }
      const blob = await response.blob()
      return {
        dataUrl: await blobToDataUrl(blob),
        mediaType: blob.type || response.headers.get("content-type") || null
      }
    }

    if (target instanceof HTMLVideoElement && target.poster) {
      const response = await fetch(target.poster, {
        credentials: "include",
        cache: "force-cache"
      })
      if (!response.ok) {
        throw new Error(`Video poster request failed with ${response.status}`)
      }
      const blob = await response.blob()
      return {
        dataUrl: await blobToDataUrl(blob),
        mediaType: blob.type || response.headers.get("content-type") || null
      }
    }

    const backgroundUrl = extractBackgroundUrl(target)
    if (backgroundUrl) {
      const response = await fetch(backgroundUrl, {
        credentials: "include",
        cache: "force-cache"
      })
      if (!response.ok) {
        throw new Error(`Background image request failed with ${response.status}`)
      }
      const blob = await response.blob()
      return {
        dataUrl: await blobToDataUrl(blob),
        mediaType: blob.type || response.headers.get("content-type") || null
      }
    }

    throw new Error("The attachment target could not be read from the page context")
  }

  function findAttachmentElement(payload) {
    const locator = payload && payload.locator
    if (locator && typeof locator.cssPath === "string" && locator.cssPath) {
      try {
        const found = document.querySelector(locator.cssPath)
        if (found instanceof Element) {
          return found
        }
      } catch {}
    }

    if (locator && typeof locator.xpath === "string" && locator.xpath) {
      try {
        const result = document.evaluate(locator.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
        if (result.singleNodeValue instanceof Element) {
          return result.singleNodeValue
        }
      } catch {}
    }

    if (payload && typeof payload.sourceUrl === "string" && payload.sourceUrl) {
      const media = Array.from(document.querySelectorAll("img,video")).find((element) => {
        if (element instanceof HTMLImageElement) {
          return element.currentSrc === payload.sourceUrl || element.src === payload.sourceUrl
        }

        if (element instanceof HTMLVideoElement) {
          return element.poster === payload.sourceUrl || element.currentSrc === payload.sourceUrl || element.src === payload.sourceUrl
        }

        return false
      })

      if (media instanceof Element) {
        return media
      }
    }

    return null
  }

  function extractBackgroundUrl(element) {
    if (!(element instanceof Element)) {
      return null
    }

    const backgroundImage = window.getComputedStyle(element).backgroundImage || ""
    const match = backgroundImage.match(/url\((['"]?)(.*?)\1\)/i)
    return match?.[2] || null
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
      reader.onerror = () => reject(reader.error || new Error("Failed to convert blob to data URL"))
      reader.readAsDataURL(blob)
    })
  }

  function emitMessage(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, ...payload });
    } catch (error) {
      console.debug("IChat message failed", error);
    }
  }
}
