import { resolveLocale, type SupportedLocale } from "./i18n-core"
import type { IChatSettings, UiLanguage } from "./types"

const EN_FLOWCONTEXT_SYSTEM_INSTRUCTIONS = `You are IChat, a context-native browser assistant.
Use the captured FlowContext as the primary source of truth.
Answer based on the captured context first, and clearly say when you are inferring.
Start with the most relevant answer to the user's likely intent.
Cite exact details from the captured context when available.
Keep the response concise unless the user asks for depth.
If image attachments are present, reason over the image and the surrounding DOM context together.
If the context is insufficient, say what is missing and ask a focused follow-up question.`

const ZH_CN_FLOWCONTEXT_SYSTEM_INSTRUCTIONS = `你是 IChat，一名上下文原生的浏览器助手。
把捕获到的 FlowContext 作为首要事实来源。
优先依据捕获到的上下文回答，并在你是在推断时明确说明。
先给出最贴近用户当前意图的答案。
在有依据时引用捕获上下文里的具体细节。
除非用户要求展开，否则保持回答简洁。
如果存在图片附件，要结合图片内容和周围 DOM 上下文一起推理。
如果上下文不足，明确缺少什么，并提出一个聚焦的后续问题。`

export const DEFAULT_FLOWCONTEXT_SYSTEM_INSTRUCTIONS_BY_LOCALE: Record<SupportedLocale, string> = {
  en: EN_FLOWCONTEXT_SYSTEM_INSTRUCTIONS,
  "zh-CN": ZH_CN_FLOWCONTEXT_SYSTEM_INSTRUCTIONS
}

export const DEFAULT_FLOWCONTEXT_SYSTEM_INSTRUCTIONS = EN_FLOWCONTEXT_SYSTEM_INSTRUCTIONS

function normalizeMultilineText(value: string) {
  return value.replace(/\r\n?/g, "\n")
}

export function getDefaultFlowContextSystemInstructions(locale: SupportedLocale) {
  return DEFAULT_FLOWCONTEXT_SYSTEM_INSTRUCTIONS_BY_LOCALE[locale]
}

export function getDefaultFlowContextSystemInstructionsForSettings(
  settings: Pick<IChatSettings, "uiLanguage"> | { uiLanguage?: UiLanguage }
) {
  return getDefaultFlowContextSystemInstructions(resolveLocale(settings))
}

export function isDefaultFlowContextSystemInstructions(value: string | null | undefined) {
  if (typeof value !== "string") {
    return false
  }

  const normalized = normalizeMultilineText(value)

  return Object.values(DEFAULT_FLOWCONTEXT_SYSTEM_INSTRUCTIONS_BY_LOCALE)
    .some((candidate) => normalizeMultilineText(candidate) === normalized)
}
