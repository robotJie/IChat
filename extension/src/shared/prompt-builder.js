(function () {
  const STORAGE_KEYS = {
    flowContext: "ichat.flowContext",
    promptDraft: "ichat.promptDraft",
    settings: "ichat.settings",
    captureStatus: "ichat.captureStatus",
    dispatchStatus: "ichat.dispatchStatus"
  };

  const DEFAULT_SETTINGS = {
    provider: "chatgpt",
    autoSend: true
  };

  function composePrompt(flowContext) {
    if (!flowContext) {
      return "";
    }

    const selectionText = flowContext.selection && flowContext.selection.text;
    const smartText = flowContext.smartTarget && flowContext.smartTarget.text;
    const contextText = flowContext.implicitContext && flowContext.implicitContext.text;
    const mode = flowContext.trigger ? flowContext.trigger.mode : "smart-dom";
    const modeLabel = mode === "selection" ? "划词 + 隐式上下文" : "智能 DOM 选区";
    const sections = [
      "你是用户的网页上下文助手。",
      "请严格基于下面捕获到的页面语境理解用户意图，并使用中文回答。",
      "如果上下文不足，请明确说出，不要假设页面中不存在的信息。",
      "",
      "页面信息：",
      `- 标题：${flowContext.page.title || "未知标题"}`,
      `- URL：${flowContext.page.url || "未知 URL"}`,
      `- 捕获方式：${modeLabel}`
    ];

    if (selectionText) {
      sections.push("");
      sections.push("用户显式划选的内容：");
      sections.push('"""');
      sections.push(selectionText);
      sections.push('"""');
    }

    if (smartText) {
      sections.push("");
      sections.push("插件智能识别到的主要上下文片段：");
      sections.push('"""');
      sections.push(smartText);
      sections.push('"""');
    }

    if (contextText && contextText !== smartText) {
      sections.push("");
      sections.push("补充上下文：");
      sections.push('"""');
      sections.push(contextText);
      sections.push('"""');
    }

    sections.push("");
    sections.push("输出要求：");
    sections.push("1. 先用一句话概括你理解到的当前页面语境。");
    sections.push("2. 如果用户有划词，优先解释划选内容在当前语境里的具体含义。");
    sections.push("3. 给出 3 到 5 条关键信息或下一步建议。");

    return sections.join("\n");
  }

  function providerLabel(provider) {
    return provider === "gemini" ? "Gemini" : "ChatGPT";
  }

  globalThis.IChatShared = globalThis.IChatShared || {};
  globalThis.IChatShared.prompt = {
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    composePrompt,
    providerLabel
  };
})();
