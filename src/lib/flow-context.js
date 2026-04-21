const MAX_TEXT_LENGTH = 6000;
const MIN_CANDIDATE_TEXT_LENGTH = 24;
const MAX_NEARBY_TEXT_LENGTH = 1200;
const MAX_SMART_CAPTURE_DEPTH = 9;
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
const MEDIA_SELECTOR = "img, picture, figure, canvas, video";
const DEBUG_MEDIA_CAPTURE = true;

import { createRandomId } from "./random-id";

function shouldDebugMediaElement(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  const tagName = element.tagName.toLowerCase();
  return tagName === "img" || tagName === "picture" || tagName === "figure" || tagName === "canvas" || tagName === "video";
}

function debugMedia(stage, payload) {
  if (!DEBUG_MEDIA_CAPTURE) {
    return;
  }

  console.debug(`[IChat media] ${stage}`, payload);
}

function describeMediaElement(element, extra = {}) {
  if (!(element instanceof Element)) {
    return { element: null, ...extra };
  }

  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    className: element.className || null,
    alt: element.getAttribute?.("alt") || null,
    src: element.getAttribute?.("src") || null,
    currentSrc: typeof element.currentSrc === "string" ? element.currentSrc : null,
    naturalWidth: typeof element.naturalWidth === "number" ? element.naturalWidth : null,
    naturalHeight: typeof element.naturalHeight === "number" ? element.naturalHeight : null,
    rect: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    ...extra
  };
}

function summarizeHitTestStack(stack) {
  return Array.isArray(stack)
    ? stack.map((element, index) => {
        if (!(element instanceof Element)) {
          return { index, element: null };
        }

        const rect = element.getBoundingClientRect();
        return {
          index,
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          className: element.className || null,
          dataImageUrl: element.getAttribute?.("data-image-url") || null,
          alt: element.getAttribute?.("alt") || null,
          src: element.getAttribute?.("src") || null,
          currentSrc: typeof element.currentSrc === "string" ? element.currentSrc : null,
          pointerEvents: window.getComputedStyle(element).pointerEvents,
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      })
    : [];
}

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
  const tagName = element.tagName.toLowerCase();
  const hasRenderableRect = rect.width > 4 && rect.height > 4;
  const isTransparent = Number(style.opacity || 1) < 0.05;
  const isTransparentLoadedImage =
    tagName === "img" &&
    isTransparent &&
    hasRenderableRect &&
    Boolean(element.currentSrc || element.getAttribute?.("src")) &&
    typeof element.naturalWidth === "number" &&
    typeof element.naturalHeight === "number" &&
    element.naturalWidth > 1 &&
    element.naturalHeight > 1;
  const visibleByStyle = !(
    style.display === "none" ||
    style.visibility === "hidden" ||
    (isTransparent && !isTransparentLoadedImage)
  );
  const visibleByRect = hasRenderableRect;
  const result = visibleByStyle && visibleByRect;

  if (shouldDebugMediaElement(element)) {
    debugMedia("isVisible", describeMediaElement(element, {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      isTransparentLoadedImage,
      visibleByStyle,
      visibleByRect,
      result
    }));
  }

  if (!visibleByStyle) {
    return false;
  }

  return visibleByRect;
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
    tag: element.tagName.toLowerCase(),
    xpath: buildXPath(element),
    cssPath: buildCssPath(element),
    textPreview: truncateText(getVisibleText(element), 180)
  };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch (error) {
    return null;
  }
}

function parseBackgroundImageUrl(element) {
  if (!element || !(element instanceof Element)) {
    return null;
  }

  const backgroundImage = window.getComputedStyle(element).backgroundImage || "";
  if (!backgroundImage || backgroundImage === "none") {
    return null;
  }

  const match = backgroundImage.match(/url\((['"]?)(.*?)\1\)/i);
  return match?.[2] || null;
}

function getContextRoot(element) {
  return element?.closest?.("figure, article, section, main, aside, li, div") || element?.parentElement || element;
}

function collectNearbyText(element) {
  if (!element || !(element instanceof Element)) {
    return "";
  }

  const root = getContextRoot(element);
  if (!root) {
    return "";
  }

  const figcaption = root.querySelector?.("figcaption");
  const captionText = figcaption ? getVisibleText(figcaption) : "";
  const rootText = truncateText(getVisibleText(root), MAX_NEARBY_TEXT_LENGTH);

  if (captionText && rootText && rootText !== captionText) {
    return truncateText(`${captionText}\n\n${rootText}`, MAX_NEARBY_TEXT_LENGTH);
  }

  return captionText || rootText;
}

function summarizeMediaText(meta) {
  return truncateText([
    meta.captionText,
    meta.altText,
    meta.ariaLabel,
    meta.nearbyText
  ].filter(Boolean).join("\n\n"), MAX_NEARBY_TEXT_LENGTH);
}

function createBaseAttachment(element, kind) {
  const rect = rectToObject(element.getBoundingClientRect());
  return {
    id: createRandomId(),
    kind,
    blobStoreKey: null,
    mimeType: null,
    normalizedMimeType: null,
    filename: null,
    bytes: null,
    width: null,
    height: null,
    naturalWidth: null,
    naturalHeight: null,
    sourceUrl: null,
    altText: null,
    titleText: element.getAttribute("title") || null,
    ariaLabel: element.getAttribute("aria-label") || null,
    captionText: null,
    nearbyText: collectNearbyText(element),
    locator: locatorFromElement(element),
    rect,
    origin: "pending",
    captureIntegrity: "unknown",
    unsupportedReason: null,
    resolutionHint: null
  };
}

function buildImageAttachment(element, options = {}) {
  const attachment = createBaseAttachment(element, "image");
  const tagName = element.tagName.toLowerCase();
  const sourceUrl = options.sourceUrl || element.currentSrc || element.getAttribute("src") || null;
  const backgroundUrl = options.backgroundUrl || null;
  const effectiveUrl = sourceUrl || backgroundUrl;
  const figcaption = element.closest?.("figure")?.querySelector?.("figcaption");

  attachment.sourceUrl = effectiveUrl;
  attachment.altText = element.getAttribute?.("alt") || null;
  attachment.captionText = figcaption ? getVisibleText(figcaption) : null;
  attachment.width = Math.round(element.getBoundingClientRect().width) || null;
  attachment.height = Math.round(element.getBoundingClientRect().height) || null;
  attachment.naturalWidth = typeof element.naturalWidth === "number" ? element.naturalWidth : attachment.width;
  attachment.naturalHeight = typeof element.naturalHeight === "number" ? element.naturalHeight : attachment.height;

  if (effectiveUrl && effectiveUrl.startsWith("data:")) {
    attachment.mimeType = effectiveUrl.slice(5, effectiveUrl.indexOf(";")) || "image/png";
    attachment.resolutionHint = {
      strategy: "data-url",
      sourceUrl: effectiveUrl,
      inlineDataUrl: effectiveUrl,
      mediaType: attachment.mimeType,
      cropRect: attachment.rect
    };
  } else if (effectiveUrl && effectiveUrl.startsWith("blob:")) {
    attachment.mimeType = tagName === "img" ? element.currentSrc?.startsWith("blob:") ? null : null : null;
    attachment.resolutionHint = {
      strategy: "blob-url",
      sourceUrl: effectiveUrl,
      pageFetchUrl: effectiveUrl,
      cropRect: attachment.rect
    };
  } else if (effectiveUrl) {
    const strategy = backgroundUrl ? "background-image-url" : options.fromVideoPoster ? "video-poster-url" : "network-url";
    attachment.resolutionHint = {
      strategy,
      sourceUrl: effectiveUrl,
      pageFetchUrl: effectiveUrl,
      cropRect: attachment.rect
    };
  } else if (tagName === "canvas") {
    attachment.resolutionHint = {
      strategy: "canvas-data-url",
      cropRect: attachment.rect
    };
    attachment.mimeType = "image/png";
  } else {
    attachment.resolutionHint = {
      strategy: "capture-visible-tab",
      cropRect: attachment.rect
    };
  }

  debugMedia("buildImageAttachment", describeMediaElement(element, {
    sourceUrl,
    backgroundUrl,
    effectiveUrl,
    strategy: attachment.resolutionHint?.strategy || null,
    mimeType: attachment.mimeType || null,
    attachment
  }));

  return attachment;
}

function buildVideoAttachment(element) {
  const attachment = createBaseAttachment(element, "video");
  const poster = element.getAttribute?.("poster") || null;
  attachment.sourceUrl = poster;
  attachment.mimeType = poster ? null : "video/*";
  attachment.unsupportedReason = "Video capture is not sent yet.";
  attachment.resolutionHint = poster
    ? {
        strategy: "video-poster-url",
        sourceUrl: poster,
        pageFetchUrl: poster,
        cropRect: attachment.rect
      }
    : {
        strategy: "unsupported-video",
        cropRect: attachment.rect
      };
  return attachment;
}

function createMediaCandidate(element, depth, attachment) {
  const text = summarizeMediaText(attachment);
  const rect = attachment.rect;
  const candidate = {
    kind: attachment.kind,
    element,
    depth,
    tagName: element.tagName.toLowerCase(),
    text,
    textLength: text.length,
    rect,
    locator: attachment.locator,
    sourceUrl: attachment.sourceUrl,
    mediaType: attachment.mimeType,
    attachmentId: attachment.id
  };

  candidate.score = attachment.kind === "image" ? scoreImageCandidate(candidate, attachment) : scoreVideoCandidateStub(candidate, attachment);
  return candidate;
}

function depthPenalty(depth, kind) {
  if (depth <= 2) {
    return 0;
  }

  const adjustedDepth = depth - 2;
  if (kind === "text") {
    return Math.round(adjustedDepth * adjustedDepth * 1.4 + adjustedDepth * 1.5);
  }

  return Math.round(adjustedDepth * adjustedDepth * 0.65 + adjustedDepth);
}

function textContainerPenalty(areaRatio) {
  if (areaRatio > 0.88) {
    return 52;
  }

  if (areaRatio > 0.72) {
    return 34;
  }

  if (areaRatio > 0.55) {
    return 18;
  }

  return 0;
}

function scoreTextCandidate(candidate) {
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

  score -= textContainerPenalty(areaRatio);
  score -= depthPenalty(candidate.depth, "text");

  return score;
}

function scoreImageCandidate(candidate, attachment) {
  const rect = candidate.rect || { width: 0, height: 0 };
  const viewportArea = window.innerWidth * window.innerHeight;
  const elementArea = Math.max(1, rect.width * rect.height);
  const areaRatio = elementArea / Math.max(1, viewportArea);

  let score = 26;

  if (candidate.element.closest("figure, picture")) {
    score += 14;
  }

  if (attachment.captionText) {
    score += 10;
  }

  if (attachment.altText) {
    score += 8;
  }

  if (attachment.nearbyText) {
    score += Math.min(18, attachment.nearbyText.length / 40);
  }

  score += Math.min(32, areaRatio * 140);

  if (areaRatio > 0.90) {
    score -= 18;
  } else if (areaRatio > 0.78) {
    score -= 10;
  }

  score -= depthPenalty(candidate.depth, "image");

  return score;
}

function scoreVideoCandidateStub(candidate, attachment) {
  const rect = candidate.rect || { width: 0, height: 0 };
  const viewportArea = window.innerWidth * window.innerHeight;
  const elementArea = Math.max(1, rect.width * rect.height);
  const areaRatio = elementArea / Math.max(1, viewportArea);

  let score = 12 + Math.min(18, areaRatio * 90);
  if (attachment.sourceUrl) {
    score += 8;
  }
  if (attachment.nearbyText) {
    score += 6;
  }
  return score;
}

function getMediaAttachmentForElement(element) {
  if (!element || !(element instanceof Element)) {
    return null;
  }

  const visible = isVisible(element);
  if (!visible) {
    if (shouldDebugMediaElement(element)) {
      debugMedia("getMediaAttachmentForElement:not-visible", describeMediaElement(element));
    }
    return null;
  }

  const tagName = element.tagName.toLowerCase();

  if (tagName === "img") {
    const attachment = buildImageAttachment(element);
    debugMedia("getMediaAttachmentForElement:img", describeMediaElement(element, {
      attachmentId: attachment?.id || null,
      strategy: attachment?.resolutionHint?.strategy || null,
      sourceUrl: attachment?.sourceUrl || null
    }));
    return attachment;
  }

  if (tagName === "picture") {
    const img = element.querySelector("img");
    if (!img) {
      debugMedia("getMediaAttachmentForElement:picture-no-img", describeMediaElement(element));
      return null;
    }

    return buildImageAttachment(img);
  }

  if (tagName === "figure") {
    const media = element.querySelector("img, canvas, video, picture");
    if (media?.tagName?.toLowerCase() === "video") {
      return buildVideoAttachment(media);
    }

    if (media?.tagName?.toLowerCase() === "canvas") {
      return buildImageAttachment(media);
    }

    if (media) {
      return buildImageAttachment(media);
    }
  }

  if (tagName === "canvas") {
    return buildImageAttachment(element);
  }

  if (tagName === "video") {
    return buildVideoAttachment(element);
  }

  const backgroundUrl = parseBackgroundImageUrl(element);
  if (backgroundUrl) {
    return buildImageAttachment(element, { backgroundUrl });
  }

  if (shouldDebugMediaElement(element)) {
    debugMedia("getMediaAttachmentForElement:none", describeMediaElement(element));
  }

  return null;
}

function getAttachmentSignature(attachment) {
  return [
    attachment.kind,
    attachment.sourceUrl || "",
    attachment.locator?.cssPath || attachment.locator?.xpath || "",
    attachment.rect ? `${attachment.rect.left}:${attachment.rect.top}:${attachment.rect.width}:${attachment.rect.height}` : ""
  ].join("|");
}

function collectMediaAttachmentsInSubtree(rootElement) {
  if (!rootElement || !(rootElement instanceof Element)) {
    return [];
  }

  const attachments = [];
  const seen = new Set();
  const elements = [rootElement, ...Array.from(rootElement.querySelectorAll(MEDIA_SELECTOR))];

  for (const element of elements) {
    if (!(element instanceof Element)) {
      continue;
    }

    const attachment = getMediaAttachmentForElement(element);
    if (!attachment) {
      continue;
    }

    const signature = getAttachmentSignature(attachment);
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    attachments.push(attachment);
  }

  return attachments;
}

function findBestAttachmentInSubtree(rootElement) {
  const attachments = collectMediaAttachmentsInSubtree(rootElement);
  if (!attachments.length) {
    return null;
  }

  let bestAttachment = attachments[0];
  let bestScore = createMediaCandidate(rootElement, 0, attachments[0]).score;

  for (const attachment of attachments.slice(1)) {
    const score = createMediaCandidate(rootElement, 0, attachment).score;
    if (score > bestScore) {
      bestAttachment = attachment;
      bestScore = score;
    }
  }

  return bestAttachment;
}

function collectSmartTrail(startElement) {
  const trail = [];
  let current = getElementFromNode(startElement);
  let previousText = "";
  const mediaSignatures = new Set();
  let depth = 0;

  while (current && current !== document.body && current !== document.documentElement) {
    if (current instanceof Element && isVisible(current)) {
      const mediaAttachment = getMediaAttachmentForElement(current);
      if (mediaAttachment) {
        const signature = getAttachmentSignature(mediaAttachment);
        if (!mediaSignatures.has(signature)) {
          const candidate = createMediaCandidate(current, depth, mediaAttachment);
          candidate.attachment = mediaAttachment;
          trail.push(candidate);
          mediaSignatures.add(signature);
        }
      }

      if (!NOISE_TAGS.has(current.tagName) && hasMeaningfulText(current)) {
        const text = getVisibleText(current);

        if (text !== previousText) {
          const candidate = {
            kind: "text",
            element: current,
            depth,
            tagName: current.tagName.toLowerCase(),
            text,
            textLength: text.length,
            rect: rectToObject(current.getBoundingClientRect()),
            locator: locatorFromElement(current),
            attachmentId: null,
            sourceUrl: null,
            mediaType: null
          };

          candidate.score = scoreTextCandidate(candidate);
          trail.push(candidate);
          previousText = text;
        }
      }
    }

    current = current.parentElement;
    depth += 1;

    if (depth > MAX_SMART_CAPTURE_DEPTH) {
      break;
    }
  }

  return trail;
}

function findDirectImageCandidateIndex(trail, startElement) {
  const seedElement = getElementFromNode(startElement);
  if (!seedElement || seedElement.tagName?.toLowerCase() !== "img") {
    return -1;
  }

  return trail.findIndex((candidate) =>
    candidate.kind === "image" &&
    candidate.depth === 0 &&
    candidate.element === seedElement
  );
}

function findPreferredSmartCaptureSeed(target, pointX, pointY) {
  const fallbackElement = getElementFromNode(target);
  const stack = typeof document.elementsFromPoint === "function"
    ? document.elementsFromPoint(pointX, pointY)
    : [];

  debugMedia("findPreferredSmartCaptureSeed:stack", {
    point: {
      x: Math.round(pointX),
      y: Math.round(pointY)
    },
    fallback: describeMediaElement(fallbackElement),
    stack: summarizeHitTestStack(stack)
  });

  for (const element of stack) {
    if (!(element instanceof Element)) {
      continue;
    }

    if (getMediaAttachmentForElement(element)) {
      return element;
    }
  }

  return fallbackElement || document.elementFromPoint(pointX, pointY);
}

function findBestTextCandidate(trail, minimumDepth = 0) {
  let bestCandidate = null;

  trail.forEach((candidate) => {
    if (candidate.kind !== "text" || candidate.depth < minimumDepth) {
      return;
    }

    if (!bestCandidate || candidate.score > bestCandidate.score) {
      bestCandidate = candidate;
    }
  });

  return bestCandidate;
}

function resolveImplicitContextCandidate(trail, activeIndex) {
  const activeCandidate = trail[activeIndex];
  if (!activeCandidate) {
    return null;
  }

  if (activeCandidate.kind !== "image") {
    return activeCandidate;
  }

  return findBestTextCandidate(trail, activeCandidate.depth) || findBestTextCandidate(trail, 0) || activeCandidate;
}

function pickBestCandidateIndex(trail, startElement) {
  if (!Array.isArray(trail) || trail.length === 0) {
    return -1;
  }

  const directImageIndex = findDirectImageCandidateIndex(trail, startElement);
  if (directImageIndex >= 0) {
    return directImageIndex;
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
    kind: candidate.kind || "text",
    text: candidate.text,
    textLength: candidate.textLength,
    tag: candidate.tagName,
    score: candidate.score,
    locator: candidate.locator,
    rect: candidate.rect,
    attachmentId: candidate.attachmentId || null,
    sourceUrl: candidate.sourceUrl || null,
    mediaType: candidate.mediaType || null,
    activeCandidateIndex: activeIndex,
    candidates: Array.isArray(trail)
      ? trail.map((item) => ({
          kind: item.kind || "text",
          tag: item.tagName,
          text: truncateText(item.text, 260),
          textLength: item.textLength,
          score: item.score,
          locator: item.locator,
          rect: item.rect,
          attachmentId: item.attachmentId || null,
          sourceUrl: item.sourceUrl || null,
          mediaType: item.mediaType || null,
          depth: item.depth
        }))
      : []
  };
}

function createBaseFlowContext(tabMeta, mode) {
  const pageUrl = tabMeta && tabMeta.url ? tabMeta.url : window.location.href;
  const title = tabMeta && tabMeta.title ? tabMeta.title : document.title;

  return {
    schemaVersion: 2,
    id: createRandomId(),
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
    primaryCaptureKind: "text",
    primaryAttachmentId: null,
    attachments: [],
    selection: null,
    smartTarget: null,
    implicitContext: null,
    metadata: {
      documentLang: document.documentElement.lang || null,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      }
    }
  };
}

function collectRangeMediaTargets(range) {
  if (!range) {
    return [];
  }

  const commonRoot = getElementFromNode(range.commonAncestorContainer);
  if (!commonRoot) {
    return [];
  }

  const candidates = [];
  const seen = new Set();
  const elements = [commonRoot, ...Array.from(commonRoot.querySelectorAll(MEDIA_SELECTOR))];

  for (const element of elements) {
    if (!(element instanceof Element)) {
      continue;
    }

    try {
      if (!range.intersectsNode(element)) {
        continue;
      }
    } catch {
      continue;
    }

    const attachment = getMediaAttachmentForElement(element);
    if (!attachment) {
      continue;
    }

    const signature = getAttachmentSignature(attachment);
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    candidates.push(attachment);
  }

  return candidates;
}

function dedupeAttachments(attachments) {
  const seen = new Set();
  return attachments.filter((attachment) => {
    const signature = getAttachmentSignature(attachment);
    if (seen.has(signature)) {
      return false;
    }

    seen.add(signature);
    return true;
  });
}

function buildSelectionFlowContext(tabMeta) {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const selectedText = sanitizeText(selection.toString());
  const selectedAttachments = collectRangeMediaTargets(range);

  if (!selectedText && selectedAttachments.length === 0) {
    return null;
  }

  const anchorElement = getElementFromNode(selection.anchorNode);
  const focusElement = getElementFromNode(selection.focusNode);
  const trail = collectSmartTrail(anchorElement || focusElement);
  const activeIndex = pickBestCandidateIndex(trail, anchorElement || focusElement);
  const smartCandidate = activeIndex >= 0 ? trail[activeIndex] : null;
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

  flowContext.attachments = dedupeAttachments(selectedAttachments);
  if (flowContext.attachments.length > 0) {
    flowContext.primaryCaptureKind = "image";
    flowContext.primaryAttachmentId = flowContext.attachments[0].id;
  }

  if (smartCandidate) {
    flowContext.smartTarget = serializeCandidate(smartCandidate, trail, activeIndex);
    flowContext.implicitContext = {
      text: smartCandidate.text,
      textLength: smartCandidate.textLength,
      locator: smartCandidate.locator
    };

    if (flowContext.primaryCaptureKind !== "image") {
      flowContext.primaryCaptureKind = smartCandidate.kind || (selectedText ? "text" : "image");
      flowContext.primaryAttachmentId = smartCandidate.attachmentId || null;
    }

    if (smartCandidate.attachment && !flowContext.attachments.find((attachment) => attachment.id === smartCandidate.attachment.id)) {
      flowContext.attachments = dedupeAttachments([...flowContext.attachments, smartCandidate.attachment]);
    }
  } else if (selectedText) {
    flowContext.primaryCaptureKind = "text";
  }

  return flowContext;
}

function buildSmartFlowContext(tabMeta, trail, activeIndex) {
  if (!Array.isArray(trail) || trail.length === 0 || activeIndex < 0) {
    return null;
  }

  const smartCandidate = trail[activeIndex];
  const implicitCandidate = resolveImplicitContextCandidate(trail, activeIndex);

  if (!smartCandidate) {
    return null;
  }

  const flowContext = createBaseFlowContext(tabMeta, "smart-dom");
  const bestAttachment = smartCandidate.attachment || findBestAttachmentInSubtree(smartCandidate.element);

  flowContext.smartTarget = serializeCandidate(smartCandidate, trail, activeIndex);
  flowContext.implicitContext = implicitCandidate
    ? {
        text: implicitCandidate.text,
        textLength: implicitCandidate.textLength,
        locator: implicitCandidate.locator
      }
    : null;
  flowContext.primaryCaptureKind = smartCandidate.kind || "text";
  flowContext.primaryAttachmentId = bestAttachment?.id || smartCandidate.attachmentId || null;
  flowContext.attachments = bestAttachment ? [bestAttachment] : [];

  if (bestAttachment && flowContext.primaryCaptureKind !== "image" && bestAttachment.kind === "image") {
    flowContext.primaryCaptureKind = "image";
  }

  return flowContext;
}

export {
  sanitizeText,
  truncateText,
  rectToObject,
  unionRects,
  getElementFromNode,
  findPreferredSmartCaptureSeed,
  collectSmartTrail,
  pickBestCandidateIndex,
  buildSelectionFlowContext,
  buildSmartFlowContext
}
