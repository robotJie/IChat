import { createContext, useContext, type ReactNode } from "react"
import type { IChatSettings, UiLanguage } from "./types"
import { enCatalog, type TranslationCatalog, type TranslationKey } from "./locales/en"
import { zhCNCatalog } from "./locales/zhCN"

export type SupportedLocale = "en" | "zh-CN"
export type TranslationParams = Record<string, string | number | null | undefined>
export type TranslateFn = (key: TranslationKey, params?: TranslationParams) => string

const catalogs: Record<SupportedLocale, TranslationCatalog> = {
  en: enCatalog,
  "zh-CN": zhCNCatalog
}

export interface I18nValue {
  locale: SupportedLocale
  t: TranslateFn
}

function normalizeUiLocale(locale: string | null | undefined): SupportedLocale {
  const normalized = locale?.trim().toLowerCase()
  if (!normalized) {
    return "en"
  }

  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-sg" ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-hans-")
  ) {
    return "zh-CN"
  }

  return "en"
}

export function getSystemLocale(): SupportedLocale {
  if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage) {
    return normalizeUiLocale(chrome.i18n.getUILanguage())
  }

  if (typeof navigator !== "undefined") {
    return normalizeUiLocale(navigator.language)
  }

  return "en"
}

export function resolveLocale(settings: Pick<IChatSettings, "uiLanguage"> | { uiLanguage?: UiLanguage }): SupportedLocale {
  if (settings.uiLanguage === "en" || settings.uiLanguage === "zh-CN") {
    return settings.uiLanguage
  }

  return getSystemLocale()
}

function interpolate(message: string, params?: TranslationParams) {
  if (!params) {
    return message
  }

  return message.replace(/\{(\w+)\}/g, (_, token: string) => {
    const value = params[token]
    return value === null || value === undefined ? "" : String(value)
  })
}

export function translate(locale: SupportedLocale, key: TranslationKey, params?: TranslationParams) {
  const activeCatalog = catalogs[locale]
  const fallback = catalogs.en[key]
  const template = activeCatalog[key] || fallback || key

  if (!activeCatalog[key]) {
    console.warn(`[i18n] Missing translation for '${key}' in locale '${locale}'.`)
  }

  return interpolate(template, params)
}

export function createI18n(locale: SupportedLocale): I18nValue {
  return {
    locale,
    t: (key, params) => translate(locale, key, params)
  }
}

const I18nContext = createContext<I18nValue>(createI18n("en"))

export function I18nProvider(props: { value: I18nValue; children: ReactNode }) {
  const { value, children } = props
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}
