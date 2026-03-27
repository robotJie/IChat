import { createContext, useContext, type ReactNode } from "react"
import type { TranslationKey } from "./locales/en"
import { createI18n, type SupportedLocale, type TranslateFn } from "./i18n-core"

export interface I18nValue {
  locale: SupportedLocale
  t: TranslateFn
}

const I18nContext = createContext<I18nValue>(createI18n("en"))

export function I18nProvider(props: { value: I18nValue; children: ReactNode }) {
  const { value, children } = props
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}

export { createI18n, getSystemLocale, resolveLocale, translate } from "./i18n-core"
export type { SupportedLocale, TranslateFn } from "./i18n-core"
export type { TranslationKey }
