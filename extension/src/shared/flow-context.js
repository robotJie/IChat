(function () {
  const MAX_TEXT_LENGTH = 6000;
  const MIN_CANDIDATE_TEXT_LENGTH = 24;
  const NOISE_TAGS = new Set([
    "A",
    "BUTTON",
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "OPTION",
    "LABEL",
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "SVG",
    "PATH",
    "IFRAME"
  ]);
  const SEMANTIC_TAGS = new Set([
    "P",
    "ARTICLE",
    "SECTION",
    "MAIN",
    "ASIDE",
    "BLOCKQUOTE",
    "FIGCAPTION",
    "LI",
    "TD",
    "DD"
  ]);
  const BLOCK_TAGS = new Set([
    "P",
    "ARTICLE",
    "SECTION",
    "MAIN",
    "DIV",
    "LI",
    "UL",
    "OL",
    "TABLE",
    "TR",
    "TD",
    "BLOCKQUOTE",
    "ASIDE"
  ]);

  function sanitizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function truncateText(value, maxLength) {
    const text = sanitizeText(value);

    if (text.length <= maxLength) {
      return text;
    }

    return text.slice(0, maxLength - 1).trimEnd() + "...";
  }

  function rectToObject(rect) {
    if (!rect) {
      return null;
    }

    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function unionRects(rects) {
    if (!Array.isArray(rects) || rects.length === 0) {
      return null;
    }

    const bounds = rects.reduce(
      (acc, rect) => ({
        top: Math.min(acc.top, rect.top),
        left: Math.min(acc.left, rect.left),
        right: Math.max(acc.right, rect.right),
        bottom: Math.max(acc.bottom, rect.bottom)
      }),
      {
        top: rects[0].top,
        left: rects[0].left,
        right: rects[0].right,
        bottom: rects[0].bottom
      }
    );

    return {
      x: bounds.left,
      y: bounds.top,
      top: bounds.top,
      left: bounds.left,
      right: bounds.right,
      bottom: bounds.bottom,
      width: Math.max(0, bounds.right - bounds.left),
      height: Math.max(0, bounds.bottom - bounds.top)
    };
  }

  function isElement(node) {
    return Boolean(node && node.nodeType === Node.ELEMENT_NODE);
  }

  function getElementFromNode(node) {
    if (!node) {
      return null;
    }

    if (isElement(node)) {
      return node;
    }

    return node.parentElement || null;
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity || 1) < 0.05
    ) {
      return false;
    }

    return rect.width > 4 && rect.height > 4;
  }

  function getVisibleText(element) {
    if (!element || !(element instanceof Element)) {
      return "";
    }

    const raw = element.innerText || element.textContent || "";
    return truncateText(raw, MAX_TEXT_LENGTH);
  }

  function hasMeaningfulText(element) {
    return getVisibleText(element).length >= MIN_CANDIDATE_TEXT_LENGTH;
  }

  function safeEscapeCss(segment) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(segment);
    }

    return String(segment).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function buildCssPath(element) {
    if (!element || !(element instanceof Element)) {
      return null;
    }

    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      let part = current.localName;

      if (!part) {
        break;
      }

      if (current.id) {
        part += "#" + safeEscapeCss(current.id);
        parts.unshift(part);
        break;
      }

      const classNames = Array.from(current.classList || [])
        .filter((className) => className && !className.startsWith("ng-"))
        .slice(0, 2);

      if (classNames.length) {
        part += "." + classNames.map(safeEscapeCss).join(".");
      } else if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter(
          (sibling) => sibling.localName === current.localName
        );

        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }

      parts.unshift(part);
      current = current.parentElement;

      if (parts.length >= 6) {
        break;
      }
    }

    return parts.join(" > ");
  }

  function buildXPath(element) {
    if (!element || !(element instanceof Element)) {
      return null;
    }

    if (element.id) {
      return `//*[@id="${element.id}"]`;
    }

    const segments = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let index = 1;
      let sibling = current.previousElementSibling;

      while (sibling) {
        if (sibling.localName === current.localName) {
          index += 1;
        }

        sibling = sibling.previousElementSibling;
      }

      segments.unshift(`${current.localName}[${index}]`);
      current = current.parentElement;

      if (current === document.documentElement) {
        segments.unshift("html[1]");
        break;
      }
    }

    return "/" + segments.join("/");
  }

  function locatorFromElement(element) {
    if (!element || !(element instanceof Element)) {
      return null;
    }

    return {
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      xpath: buildXPath(element),
      cssPath: buildCssPath(element),
      rect: rectToObject(element.getBoundingClientRect()),
      textSample: truncateText(getVisibleText(element), 180)
    };
  }

  function scoreCandidate(candidate) {
    const tagName = candidate.element.tagName;
    const rect = candidate.rect;
    const viewportArea = window.innerWidth * window.innerHeight;
    const elementArea = Math.max(1, rect.width * rect.height);
    const textLength = candidate.text.length;
    const areaRatio = elementArea / Math.max(1, viewportArea);

    let score = 0;

    if (SEMANTIC_TAGS.has(tagName)) {
      score += 18;
    }

    if (BLOCK_TAGS.has(tagName)) {
      score += 12;
    }

    if (candidate.element.closest("article, main, section")) {
      score += 8;
    }

    score += Math.min(45, textLength / 18);

    if (textLength > 2400) {
      score -= 16;
    } else if (textLength > 1400) {
      score -= 8;
    }

    if (areaRatio > 0.82) {
      score -= 40;
    } else if (areaRatio > 0.55) {
      score -= 18;
    }

    if (candidate.depth > 8) {
      score -= Math.min(12, candidate.depth);
    }

    return score;
  }

  function collectSmartTrail(startElement) {
    const trail = [];
    let current = getElementFromNode(startElement);
    let previousText = "";
    let depth = 0;

    while (current && current !== document.body && current !== document.documentElement) {
      if (
        current instanceof Element &&
        !NOISE_TAGS.has(current.tagName) &&
        isVisible(current) &&
        hasMeaningfulText(current)
      ) {
        const text = getVisibleText(current);

        if (text !== previousText) {
          const candidate = {
            element: current,
            depth,
            tagName: current.tagName.toLowerCase(),
            text,
            textLength: text.length,
            rect: rectToObject(current.getBoundingClientRect()),
            locator: locatorFromElement(current)
          };

          candidate.score = scoreCandidate(candidate);
          trail.push(candidate);
          previousText = text;
        }
      }

      current = current.parentElement;
      depth += 1;

      if (depth > 14) {
        break;
      }
    }

    return trail;
  }

  function pickBestCandidateIndex(trail) {
    if (!Array.isArray(trail) || trail.length === 0) {
      return -1;
    }

    let bestIndex = 0;
    let bestScore = trail[0].score;

    trail.forEach((candidate, index) => {
      if (candidate.score > bestScore) {
        bestIndex = index;
        bestScore = candidate.score;
      }
    });

    return bestIndex;
  }

  function serializeCandidate(candidate, trail, activeIndex) {
    if (!candidate) {
      return null;
    }

    return {
      text: candidate.text,
      textLength: candidate.textLength,
      tagName: candidate.tagName,
      score: candidate.score,
      locator: candidate.locator,
      rect: candidate.rect,
      activeCandidateIndex: activeIndex,
      candidateTrail: Array.isArray(trail)
        ? trail.map((item, index) => ({
            index,
            tagName: item.tagName,
            text: truncateText(item.text, 260),
            textLength: item.textLength,
            score: item.score,
            locator: item.locator,
            rect: item.rect
          }))
        : []
    };
  }

  function safeHost(url) {
    try {
      return new URL(url).host;
    } catch (error) {
      return null;
    }
  }

  function createBaseFlowContext(tabMeta, mode) {
    const pageUrl = tabMeta && tabMeta.url ? tabMeta.url : window.location.href;
    const title = tabMeta && tabMeta.title ? tabMeta.title : document.title;

    return {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      page: {
        tabId: tabMeta ? tabMeta.id : null,
        windowId: tabMeta ? tabMeta.windowId : null,
        title,
        url: pageUrl,
        host: safeHost(pageUrl)
      },
      trigger: {
        command: "capture-flow-context",
        source: "keyboard-shortcut",
        mode
      },
      selection: null,
      smartTarget: null,
      implicitContext: null,
      metadata: {
        documentLang: document.documentElement.lang || null,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      }
    };
  }

  function buildSelectionFlowContext(tabMeta) {
    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const selectedText = sanitizeText(selection.toString());

    if (!selectedText) {
      return null;
    }

    const anchorElement = getElementFromNode(selection.anchorNode);
    const focusElement = getElementFromNode(selection.focusNode);
    const trail = collectSmartTrail(anchorElement || focusElement);
    const activeIndex = pickBestCandidateIndex(trail);
    const smartCandidate = activeIndex >= 0 ? trail[activeIndex] : null;
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects())
      .map(rectToObject)
      .filter(Boolean)
      .slice(0, 8);
    const flowContext = createBaseFlowContext(tabMeta, "selection");

    flowContext.selection = {
      text: truncateText(selectedText, 1200),
      textLength: selectedText.length,
      anchorLocator: locatorFromElement(anchorElement),
      focusLocator: locatorFromElement(focusElement),
      rects,
      unionRect: unionRects(rects)
    };

    if (smartCandidate) {
      flowContext.smartTarget = serializeCandidate(smartCandidate, trail, activeIndex);
      flowContext.implicitContext = {
        text: smartCandidate.text,
        textLength: smartCandidate.textLength,
        locator: smartCandidate.locator
      };
    }

    return flowContext;
  }

  function buildSmartFlowContext(tabMeta, trail, activeIndex) {
    if (!Array.isArray(trail) || trail.length === 0 || activeIndex < 0) {
      return null;
    }

    const smartCandidate = trail[activeIndex];

    if (!smartCandidate) {
      return null;
    }

    const flowContext = createBaseFlowContext(tabMeta, "smart-dom");

    flowContext.smartTarget = serializeCandidate(smartCandidate, trail, activeIndex);
    flowContext.implicitContext = {
      text: smartCandidate.text,
      textLength: smartCandidate.textLength,
      locator: smartCandidate.locator
    };

    return flowContext;
  }

  globalThis.IChatShared = globalThis.IChatShared || {};
  globalThis.IChatShared.flow = {
    sanitizeText,
    truncateText,
    rectToObject,
    unionRects,
    getElementFromNode,
    collectSmartTrail,
    pickBestCandidateIndex,
    buildSelectionFlowContext,
    buildSmartFlowContext
  };
})();
