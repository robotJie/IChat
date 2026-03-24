(function () {
  if (globalThis.__ICHAT_CHAT_ADAPTER_READY__) {
    return;
  }

  globalThis.__ICHAT_CHAT_ADAPTER_READY__ = true;

  const PROVIDERS = {
    chatgpt: {
      matches: ["chatgpt.com", "chat.openai.com"],
      composerSelectors: [
        "#prompt-textarea",
        "div[contenteditable='true'][id='prompt-textarea']",
        "div[contenteditable='true'][data-testid='composer-text-input']",
        "div[contenteditable='true'][data-testid='prompt-textarea']",
        "textarea[placeholder*='Message']",
        "textarea[placeholder*='Ask']"
      ],
      sendButtonSelectors: [
        "button[data-testid='send-button']",
        "button[aria-label*='Send message']",
        "button[aria-label*='Send']"
      ]
    },
    gemini: {
      matches: ["gemini.google.com"],
      composerSelectors: [
        "rich-textarea div[contenteditable='true']",
        ".ql-editor[contenteditable='true']",
        "div.textarea[contenteditable='true']",
        "textarea[aria-label*='Enter a prompt']",
        "textarea[aria-label*='prompt']"
      ],
      sendButtonSelectors: [
        "button[aria-label*='Send message']",
        "button[mattooltip*='Send']",
        "button.send-button"
      ]
    }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "ICHAT_DISPATCH_PROMPT") {
      return false;
    }

    Promise.resolve(dispatchPrompt(message.provider, message.prompt))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  });

  async function dispatchPrompt(providerName, prompt) {
    const resolved = resolveProvider(providerName || detectProviderKey());

    if (!resolved) {
      return { ok: false, error: "This page is not a supported AI chat site." };
    }

    const composer = await waitForElement(resolved.config.composerSelectors, 18000);

    if (!composer) {
      return { ok: false, error: `Could not find the ${resolved.key} composer.` };
    }

    fillComposer(composer, prompt || "");
    await delay(250);

    const sendButton = await waitForElement(
      resolved.config.sendButtonSelectors,
      8000,
      isEnabledButton
    );

    if (sendButton) {
      sendButton.click();
      return { ok: true, submitted: true };
    }

    composer.focus();
    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter"
      })
    );

    return { ok: true, submitted: false };
  }

  function resolveProvider(providerName) {
    if (providerName && PROVIDERS[providerName]) {
      return { key: providerName, config: PROVIDERS[providerName] };
    }

    const detectedKey = detectProviderKey();
    return detectedKey ? { key: detectedKey, config: PROVIDERS[detectedKey] } : null;
  }

  function detectProviderKey() {
    const host = window.location.host;

    return Object.keys(PROVIDERS).find((key) =>
      PROVIDERS[key].matches.some((match) => host.includes(match))
    );
  }

  async function waitForElement(selectors, timeoutMs, predicate) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const element = queryDeep(selectors);

      if (element && isVisible(element) && (!predicate || predicate(element))) {
        return element;
      }

      await delay(300);
    }

    return null;
  }

  function queryDeep(selectors) {
    const queue = [document];

    while (queue.length) {
      const root = queue.shift();

      for (const selector of selectors) {
        const found = root.querySelector(selector);

        if (found) {
          return found;
        }
      }

      const elements = root.querySelectorAll("*");
      for (const element of elements) {
        if (element.shadowRoot) {
          queue.push(element.shadowRoot);
        }
      }
    }

    return null;
  }

  function fillComposer(element, prompt) {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      if (setter) {
        setter.call(element, prompt);
      } else {
        element.value = prompt;
      }

      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: prompt
        })
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.focus();
      return;
    }

    element.focus();

    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.addRange(range);
    }

    let inserted = false;
    if (typeof document.execCommand === "function") {
      try {
        document.execCommand("selectAll", false);
        inserted = document.execCommand("insertText", false, prompt);
      } catch (error) {
        inserted = false;
      }
    }

    if (!inserted) {
      element.textContent = prompt;
    }

    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: prompt
      })
    );
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isEnabledButton(element) {
    if (!(element instanceof HTMLButtonElement)) {
      return false;
    }

    if (element.disabled || element.getAttribute("aria-disabled") === "true") {
      return false;
    }

    return isVisible(element);
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
