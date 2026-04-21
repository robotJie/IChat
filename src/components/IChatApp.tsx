import { startTransition, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from "react"
import {
  createPendingPrompt,
  DEFAULT_SETTINGS,
  dispatchStatusPayload,
  EMPTY_API_KEYS,
  getActiveProvider,
  getProviderModel,
  providerLabels,
  STORAGE_KEYS
} from "../lib/prompt-builder"
import {
  clearChatThread,
  getAppState,
  normalizeApiKeys,
  normalizeFlowContext,
  normalizeSettings,
  setDispatchStatus,
  setFlowContext,
  setPendingPrompt,
  updateApiKeys,
  updateSettings
} from "../lib/storage"
import { createI18n, I18nProvider, resolveLocale } from "../lib/i18n"
import type { AppState, IChatSettingsUpdate, ProviderId } from "../lib/types"
import { getVisionBlockedMessage, supportsVisionInput } from "../lib/vision-capabilities"
import { ProviderConversation } from "./ProviderConversation"
import { SettingsWorkspace } from "./SettingsWorkspace"
import { IChatLogotype } from "./IChatLogotype"
import "./ichat.css"

const INITIAL_STATE: AppState = {
  flowContext: null,
  settings: DEFAULT_SETTINGS,
  apiKeys: EMPTY_API_KEYS,
  captureStatus: {
    state: "idle",
    message: "Ready to capture context",
    updatedAt: new Date(0).toISOString()
  },
  dispatchStatus: {
    state: "idle",
    flowContextId: null,
    provider: null,
    message: "Prompt is waiting",
    updatedAt: new Date(0).toISOString()
  },
  pendingPrompt: null,
  chatThreads: {
    openai: [],
    gemini: [],
    anthropic: []
  }
}

interface IChatAppProps {
  viewMode: "sidepanel" | "tab"
}

function didOnlyProviderDraftSettingsChange(current: AppState["settings"], next: AppState["settings"]) {
  return (
    current.schemaVersion === next.schemaVersion &&
    current.uiLanguage === next.uiLanguage &&
    current.providers.active === next.providers.active &&
    JSON.stringify(current.context) === JSON.stringify(next.context) &&
    JSON.stringify(current.shortcuts) === JSON.stringify(next.shortcuts) &&
    JSON.stringify(current.data) === JSON.stringify(next.data) &&
    (
      current.providers.openaiEndpoint !== next.providers.openaiEndpoint ||
      current.providers.models.openai !== next.providers.models.openai ||
      current.providers.models.gemini !== next.providers.models.gemini ||
      current.providers.models.anthropic !== next.providers.models.anthropic ||
      current.providers.searchEnabled.openai !== next.providers.searchEnabled.openai ||
      current.providers.searchEnabled.gemini !== next.providers.searchEnabled.gemini ||
      current.providers.searchEnabled.anthropic !== next.providers.searchEnabled.anthropic
    )
  )
}

export function IChatApp({ viewMode }: IChatAppProps) {
  const [appState, setAppState] = useState<AppState>(INITIAL_STATE)
  const [threadClearSignals, setThreadClearSignals] = useState<Record<ProviderId, number>>({
    openai: 0,
    gemini: 0,
    anthropic: 0
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const deferredFlowContext = useDeferredValue(appState.flowContext)
  const gearButtonRef = useRef<HTMLButtonElement | null>(null)
  const wasSettingsOpenRef = useRef(false)
  const appStateRef = useRef(appState)
  const settingsOpenRef = useRef(settingsOpen)
  const suppressedStorageEchoRef = useRef({
    settings: 0,
    apiKeys: 0
  })
  const locale = resolveLocale(appState.settings)
  const i18n = useMemo(() => createI18n(locale), [locale])
  const { t } = i18n

  useEffect(() => {
    appStateRef.current = appState
  }, [appState])

  useEffect(() => {
    settingsOpenRef.current = settingsOpen
  }, [settingsOpen])

  const promptPreview = useMemo(() => {
    if (!deferredFlowContext) {
      return ""
    }

    return createPendingPrompt(deferredFlowContext, appState.settings).prompt
  }, [appState.settings, deferredFlowContext])

  const applyStoragePatch = useEffectEvent((patch: Partial<AppState>) => {
    startTransition(() => {
      setAppState((current) => ({
        ...current,
        ...patch,
        settings: patch.settings ?? current.settings,
        apiKeys: patch.apiKeys ?? current.apiKeys,
        chatThreads: patch.chatThreads ?? current.chatThreads
      }))
    })
  })

  const consumeSuppressedStorageEcho = useEffectEvent((key: "settings" | "apiKeys") => {
    if (suppressedStorageEchoRef.current[key] <= 0) {
      return false
    }

    suppressedStorageEchoRef.current[key] -= 1
    return true
  })

  const shouldMuteProviderDraftEcho = useEffectEvent((changes: Record<string, chrome.storage.StorageChange>) => {
    if (!settingsOpenRef.current) {
      return {
        settings: false,
        apiKeys: false
      }
    }

    const currentState = appStateRef.current
    const nextSettings = changes[STORAGE_KEYS.settings]
      ? normalizeSettings(changes[STORAGE_KEYS.settings].newValue)
      : null
    const nextApiKeys = changes[STORAGE_KEYS.apiKeys]
      ? normalizeApiKeys(changes[STORAGE_KEYS.apiKeys].newValue)
      : null

    return {
      settings: nextSettings ? didOnlyProviderDraftSettingsChange(currentState.settings, nextSettings) : false,
      apiKeys: nextApiKeys ? JSON.stringify(currentState.apiKeys) !== JSON.stringify(nextApiKeys) : false
    }
  })

  useEffect(() => {
    let mounted = true

    void getAppState().then((state) => {
      if (!mounted) {
        return
      }

      setAppState(state)
    })

    const handleStorageChange: typeof chrome.storage.onChanged.addListener extends (callback: infer T) => void ? T : never = (changes, areaName) => {
      if (areaName !== "local") {
        return
      }

      const patch: Partial<AppState> = {}
      const mutedEcho = shouldMuteProviderDraftEcho(changes)

      if (changes[STORAGE_KEYS.flowContext]) {
        patch.flowContext = normalizeFlowContext(changes[STORAGE_KEYS.flowContext].newValue)
      }

      if (changes[STORAGE_KEYS.settings] && !mutedEcho.settings && !consumeSuppressedStorageEcho("settings")) {
        patch.settings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue)
      }

      if (changes[STORAGE_KEYS.apiKeys] && !mutedEcho.apiKeys && !consumeSuppressedStorageEcho("apiKeys")) {
        patch.apiKeys = normalizeApiKeys(changes[STORAGE_KEYS.apiKeys].newValue)
      }

      if (changes[STORAGE_KEYS.captureStatus]) {
        patch.captureStatus = changes[STORAGE_KEYS.captureStatus].newValue as AppState["captureStatus"]
      }

      if (changes[STORAGE_KEYS.dispatchStatus]) {
        patch.dispatchStatus = changes[STORAGE_KEYS.dispatchStatus].newValue as AppState["dispatchStatus"]
      }

      if (changes[STORAGE_KEYS.pendingPrompt]) {
        patch.pendingPrompt = (changes[STORAGE_KEYS.pendingPrompt].newValue as AppState["pendingPrompt"]) ?? null
      }

      if (changes[STORAGE_KEYS.chatThreads]) {
        patch.chatThreads = changes[STORAGE_KEYS.chatThreads].newValue as AppState["chatThreads"]
      }

      if (Object.keys(patch).length > 0) {
        applyStoragePatch(patch)
      }
    }

    chrome.storage.onChanged.addListener(handleStorageChange)

    return () => {
      mounted = false
      chrome.storage.onChanged.removeListener(handleStorageChange)
    }
  }, [applyStoragePatch, consumeSuppressedStorageEcho, shouldMuteProviderDraftEcho])

  useEffect(() => {
    if (!settingsOpen && wasSettingsOpenRef.current) {
      gearButtonRef.current?.focus()
      void getAppState().then((state) => {
        setAppState(state)
      })
    }

    wasSettingsOpenRef.current = settingsOpen
  }, [settingsOpen])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || appState.captureStatus.state !== "capturing") {
        return
      }

      void chrome.runtime.sendMessage({ type: "ICHAT_CANCEL_CAPTURE" }).catch(() => {})
    }

    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [appState.captureStatus.state])

  const activeProvider = getActiveProvider(appState.settings)
  const currentPendingPrompt = appState.pendingPrompt
  const pendingState = currentPendingPrompt && currentPendingPrompt.flowContextId === appState.flowContext?.id ? currentPendingPrompt.status : null
  const captureErrorBanner = appState.captureStatus.state === "error" ? appState.captureStatus.message : null

  const triggerCapture = async () => {
    await chrome.runtime.sendMessage({ type: "ICHAT_TRIGGER_CAPTURE" })
  }

  const openDetachedTab = async () => {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("tabs/chat.html"),
      active: true
    })
  }

  const handleProviderChange = async (provider: ProviderId) => {
    await updateSettings({
      providers: {
        active: provider
      }
    })
  }

  const runSuppressedSettingsUpdate = async (updateAction: () => Promise<void>) => {
    suppressedStorageEchoRef.current.settings += 1
    try {
      await updateAction()
    } catch (error) {
      suppressedStorageEchoRef.current.settings = Math.max(0, suppressedStorageEchoRef.current.settings - 1)
      throw error
    }
  }

  const handleModelChange = async (provider: ProviderId, model: string) => {
    await runSuppressedSettingsUpdate(async () => {
      const models: Partial<Record<ProviderId, string>> = { [provider]: model }
      await updateSettings({
        providers: {
          models
        }
      })
    })
  }

  const handleOpenAIEndpointChange = async (value: string) => {
    await runSuppressedSettingsUpdate(async () => {
      await updateSettings({
        providers: {
          openaiEndpoint: value
        }
      })
    })
  }

  const handleProviderSearchChange = async (provider: ProviderId, enabled: boolean) => {
    await runSuppressedSettingsUpdate(async () => {
      await updateSettings({
        providers: {
          searchEnabled: {
            [provider]: enabled
          }
        }
      })
    })
  }

  const handleApiKeyChange = async (provider: ProviderId, value: string) => {
    suppressedStorageEchoRef.current.apiKeys += 1
    try {
      await updateApiKeys({ [provider]: value })
    } catch (error) {
      suppressedStorageEchoRef.current.apiKeys = Math.max(0, suppressedStorageEchoRef.current.apiKeys - 1)
      throw error
    }
  }

  const handleHistoryMessageLimitChange = async (value: number) => {
    await runSuppressedSettingsUpdate(async () => {
      await updateSettings({
        data: {
          historyMessageLimit: value
        }
      })
    })
  }

  const handleSystemInstructionsChange = async (value: string) => {
    await runSuppressedSettingsUpdate(async () => {
      await updateSettings({
        context: {
          systemInstructions: value,
          systemInstructionsCustomized: true
        }
      })
    })
  }

  const handleSettingsChange = async (partial: IChatSettingsUpdate) => {
    await updateSettings(partial)
  }

  const handleCopyPrompt = async () => {
    if (!promptPreview) {
      return
    }

    await navigator.clipboard.writeText(promptPreview)
  }

  const handleSendCurrentContext = async () => {
    if (!appState.flowContext) {
      return
    }

    const manualSendSettings = {
      ...appState.settings,
      providers: {
        ...appState.settings.providers,
        active: activeProvider
      },
      context: {
        ...appState.settings.context,
        autoSend: true
      }
    }

    const pendingPrompt = {
      ...createPendingPrompt(appState.flowContext, manualSendSettings),
      status: "pending" as const,
      provider: activeProvider
    }

    const currentModel = getProviderModel(appState.settings, activeProvider)
    if (pendingPrompt.requiresVision && !supportsVisionInput(activeProvider, currentModel)) {
      const blockedMessage = getVisionBlockedMessage(activeProvider, currentModel, t)
      await setPendingPrompt({
        ...pendingPrompt,
        status: "draft",
        error: blockedMessage
      })
      await setDispatchStatus(dispatchStatusPayload("error", blockedMessage, activeProvider, appState.flowContext.id))
      return
    }

    await setPendingPrompt(pendingPrompt)
    await setDispatchStatus(
      dispatchStatusPayload("sending", t("state.sendingContext", { providerLabel: providerLabels[activeProvider] }), activeProvider, appState.flowContext.id)
    )
  }

  const confirmDangerousAction = async (message: string) => {
    return window.confirm(message)
  }

  const handleClearThread = async () => {
    const confirmed = await confirmDangerousAction(t("confirm.clearThread", { providerLabel: providerLabels[activeProvider] }))
    if (!confirmed) {
      return
    }

    await clearChatThread(activeProvider)
    setThreadClearSignals((current) => ({
      ...current,
      [activeProvider]: current[activeProvider] + 1
    }))
    await setDispatchStatus(dispatchStatusPayload("idle", t("state.clearedConversation", { providerLabel: providerLabels[activeProvider] }), activeProvider, null))
  }

  const handleResetContext = async () => {
    const confirmed = await confirmDangerousAction(t("confirm.resetContext"))
    if (!confirmed) {
      return
    }

    await Promise.all([
      setFlowContext(null),
      setPendingPrompt(null),
      setDispatchStatus(dispatchStatusPayload("idle", t("state.clearedContext"), activeProvider, null))
    ])
  }

  return (
    <I18nProvider value={i18n}>
      <div className={`ichat-app view-${viewMode}`}>
        <div className="ichat-shell">
          <header className="ichat-header is-minimal">
            <div className="ichat-brand" aria-hidden="true">
              <IChatLogotype className="ichat-brand-mark" title="IChat" variant="wordmark" />
            </div>
            <button className="ichat-icon-button is-gear" ref={gearButtonRef} type="button" aria-label={t("common.settings")} onClick={() => setSettingsOpen(true)}>
              <svg className="ichat-gear-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <path d="M12 8.75A3.25 3.25 0 1 0 12 15.25A3.25 3.25 0 1 0 12 8.75Z" stroke="currentColor" strokeWidth="1.7" />
                <path d="M19.4 13.5V10.5L17.36 9.82C17.19 9.25 16.96 8.71 16.66 8.2L17.62 6.25L15.5 4.13L13.55 5.09C13.04 4.79 12.5 4.56 11.93 4.39L11.25 2.35H8.25L7.57 4.39C7 4.56 6.46 4.79 5.95 5.09L4 4.13L1.88 6.25L2.84 8.2C2.54 8.71 2.31 9.25 2.14 9.82L0.1 10.5V13.5L2.14 14.18C2.31 14.75 2.54 15.29 2.84 15.8L1.88 17.75L4 19.87L5.95 18.91C6.46 19.21 7 19.44 7.57 19.61L8.25 21.65H11.25L11.93 19.61C12.5 19.44 13.04 19.21 13.55 18.91L15.5 19.87L17.62 17.75L16.66 15.8C16.96 15.29 17.19 14.75 17.36 14.18L19.4 13.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              </svg>
            </button>
          </header>

          {captureErrorBanner ? (
            <div className="ichat-banner is-warning">{captureErrorBanner}</div>
          ) : null}

          <ProviderConversation
            key={activeProvider}
            provider={activeProvider}
            settings={appState.settings}
            apiKeys={appState.apiKeys}
            pendingPrompt={appState.pendingPrompt}
            flowContext={appState.flowContext}
            threadClearSignal={threadClearSignals[activeProvider]}
          />
        </div>

        {settingsOpen ? (
          <SettingsWorkspace
            appState={appState}
            promptPreview={promptPreview}
            pendingState={pendingState}
            viewMode={viewMode}
            onClose={() => setSettingsOpen(false)}
            onTriggerCapture={() => void triggerCapture()}
            onOpenDetachedTab={() => void openDetachedTab()}
            onProviderChange={(provider) => void handleProviderChange(provider)}
            onModelChange={(provider, model) => void handleModelChange(provider, model)}
            onApiKeyChange={(provider, value) => void handleApiKeyChange(provider, value)}
            onProviderSearchChange={(provider, enabled) => void handleProviderSearchChange(provider, enabled)}
            onOpenAIEndpointChange={(value) => void handleOpenAIEndpointChange(value)}
            onHistoryMessageLimitChange={(value) => void handleHistoryMessageLimitChange(value)}
            onSystemInstructionsChange={(value) => void handleSystemInstructionsChange(value)}
            onSettingsChange={(partial) => void handleSettingsChange(partial)}
            onCopyPrompt={() => void handleCopyPrompt()}
            onSendCurrentContext={() => void handleSendCurrentContext()}
            onClearThread={() => void handleClearThread()}
            onResetContext={() => void handleResetContext()}
          />
        ) : null}
      </div>
    </I18nProvider>
  )
}


