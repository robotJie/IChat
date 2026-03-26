import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { getActiveProvider, getFlowContextMode, getProviderModel, isAutoSendEnabled, providerLabels } from "../lib/prompt-builder"
import { useI18n } from "../lib/i18n"
import type { AppState, FlowContext, IChatSettingsUpdate, ProviderId, UiLanguage } from "../lib/types"

interface SettingsWorkspaceProps {
  appState: AppState
  promptPreview: string
  pendingState: string | null
  viewMode: "sidepanel" | "tab"
  onClose: () => void
  onTriggerCapture: () => void
  onOpenDetachedTab: () => void
  onProviderChange: (provider: ProviderId) => void | Promise<void>
  onModelChange: (provider: ProviderId, model: string) => void | Promise<void>
  onApiKeyChange: (provider: ProviderId, value: string) => void | Promise<void>
  onOpenAIEndpointChange: (value: string) => void | Promise<void>
  onSettingsChange: (partial: IChatSettingsUpdate) => void | Promise<void>
  onCopyPrompt: () => void | Promise<void>
  onCopySystemInstructions: () => void | Promise<void>
  onSendCurrentContext: () => void | Promise<void>
  onClearThread: () => void | Promise<void>
  onResetContext: () => void | Promise<void>
}

type SettingsSectionId = "general" | "providers" | "context" | "shortcuts"

interface CommandBindingSummary {
  name: string
  description: string
  shortcut: string
}

const LANGUAGE_OPTIONS: Array<{ value: UiLanguage; labelKey: "settings.general.language.system" | "settings.general.language.en" | "settings.general.language.zhCN" }> = [
  { value: "system", labelKey: "settings.general.language.system" },
  { value: "en", labelKey: "settings.general.language.en" },
  { value: "zh-CN", labelKey: "settings.general.language.zhCN" }
]

const PROVIDERS: ProviderId[] = ["openai", "gemini", "anthropic"]

function getSettingsSections(t: ReturnType<typeof useI18n>["t"]): Array<{ id: SettingsSectionId; label: string; description: string }> {
  return [
    { id: "general", label: t("settings.sections.general.label"), description: t("settings.sections.general.description") },
    { id: "providers", label: t("settings.sections.providers.label"), description: t("settings.sections.providers.description") },
    { id: "context", label: t("settings.sections.context.label"), description: t("settings.sections.context.description") },
    { id: "shortcuts", label: t("settings.sections.shortcuts.label"), description: t("settings.sections.shortcuts.description") }
  ]
}

function getProviderHelp(t: ReturnType<typeof useI18n>["t"]): Record<
  ProviderId,
  {
    keyLabel: string
    keyPlaceholder: string
    modelLabel: string
    note: string
    endpointLabel?: string
    endpointPlaceholder?: string
    endpointNote?: string
  }
> {
  return {
    openai: {
      keyLabel: t("settings.providers.openai.keyLabel"),
      keyPlaceholder: "sk-...",
      modelLabel: t("settings.providers.openai.modelLabel"),
      note: t("settings.providers.openai.note"),
      endpointLabel: t("settings.providers.openai.endpointLabel"),
      endpointPlaceholder: "https://api.openai.com/v1",
      endpointNote: t("settings.providers.openai.endpointNote")
    },
    gemini: {
      keyLabel: t("settings.providers.gemini.keyLabel"),
      keyPlaceholder: "AIza...",
      modelLabel: t("settings.providers.gemini.modelLabel"),
      note: t("settings.providers.gemini.note")
    },
    anthropic: {
      keyLabel: t("settings.providers.anthropic.keyLabel"),
      keyPlaceholder: "sk-ant-...",
      modelLabel: t("settings.providers.anthropic.modelLabel"),
      note: t("settings.providers.anthropic.note")
    }
  }
}

function snippet(value?: string | null, maxLength = 200, fallback = "Unavailable") {
  if (!value?.trim()) {
    return fallback
  }

  return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}...` : value
}

function clampHistoryMessageLimit(value: number) {
  if (!Number.isFinite(value)) {
    return 6
  }

  return Math.min(100, Math.max(0, Math.trunc(value)))
}

function formatSmartTargetPreview(flowContext: FlowContext, maxLength: number, t: ReturnType<typeof useI18n>["t"]) {
  const target = flowContext.smartTarget
  if (!target) {
    return t("settings.context.noSmartDomTarget")
  }

  if (target.text?.trim()) {
    return snippet(target.text, maxLength, t("settings.context.noSmartDomTarget"))
  }

  if (target.kind === "image") {
    return target.sourceUrl
      ? snippet(target.sourceUrl, maxLength, t("settings.context.capturedImageTarget"))
      : t("settings.context.capturedImageTarget")
  }

  if (target.kind === "video") {
    return target.sourceUrl
      ? snippet(target.sourceUrl, maxLength, t("settings.context.capturedVideoTarget"))
      : t("settings.context.capturedVideoTarget")
  }

  return t("settings.context.noSmartDomTarget")
}

function formatAttachmentPreview(flowContext: FlowContext, maxLength: number, t: ReturnType<typeof useI18n>["t"]) {
  if (!flowContext.attachments.length) {
    return t("settings.context.noAttachments")
  }

  return flowContext.attachments
    .slice(0, 3)
    .map((attachment, index) => {
      const bits = [
        `${index + 1}. ${attachment.kind}`,
        attachment.altText || attachment.captionText || attachment.titleText || null,
        attachment.width && attachment.height ? `${attachment.width}x${attachment.height}` : null
      ].filter(Boolean)

      return snippet(bits.join(" · "), maxLength, attachment.kind)
    })
    .join("\n")
}

function getDisplayedLocator(flowContext: FlowContext | null) {
  if (!flowContext) {
    return ""
  }

  return (
    flowContext.smartTarget?.locator?.xpath ||
    flowContext.smartTarget?.locator?.cssPath ||
    flowContext.selection?.anchorLocator?.xpath ||
    flowContext.selection?.anchorLocator?.cssPath ||
    flowContext.implicitContext?.locator?.xpath ||
    flowContext.implicitContext?.locator?.cssPath ||
    ""
  )
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hasAttribute("aria-hidden"))
}

function formatPendingStateLabel(pendingState: string | null, t: ReturnType<typeof useI18n>["t"]) {
  if (pendingState === "draft") {
    return t("settings.context.summary.state.draft")
  }

  if (pendingState === "pending") {
    return t("settings.context.summary.state.pending")
  }

  if (pendingState === "processing") {
    return t("settings.context.summary.state.processing")
  }

  if (pendingState === "sent") {
    return t("settings.context.summary.state.sent")
  }

  if (pendingState === "error") {
    return t("settings.context.summary.state.error")
  }

  return t("settings.context.summary.draftNotCreated")
}

function SettingsSectionHeader(props: { title: string; description: string }) {
  const { title, description } = props

  return (
    <div className="ichat-settings-section-intro">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  )
}

function SettingsRow(props: {
  label: string
  description: string
  control: ReactNode
  danger?: boolean
}) {
  const { label, description, control, danger = false } = props

  return (
    <div className={`ichat-settings-row ${danger ? "is-danger" : ""}`}>
      <div className="ichat-settings-row-copy">
        <strong>{label}</strong>
        <p>{description}</p>
      </div>
      <div className="ichat-settings-row-control">{control}</div>
    </div>
  )
}

function SectionNavButton(props: {
  id: SettingsSectionId
  label: string
  active: boolean
  onSelect: (id: SettingsSectionId) => void
}) {
  const { id, label, active, onSelect } = props

  return (
    <button
      className={`ichat-settings-nav-button ${active ? "is-active" : ""}`}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(id)}>
      {label}
    </button>
  )
}

function SegmentedControl<T extends string>(props: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  const { value, options, onChange } = props

  return (
    <div className="ichat-settings-segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          className={`ichat-settings-segment ${value === option.value ? "is-active" : ""}`}
          type="button"
          onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

function ProviderCard(props: {
  provider: ProviderId
  activeProvider: ProviderId
  expanded: boolean
  onToggle: () => void
  apiKey: string
  modelId: string
  openaiEndpoint: string
  onProviderChange: (provider: ProviderId) => void | Promise<void>
  onModelChange: (provider: ProviderId, model: string) => void | Promise<void>
  onApiKeyChange: (provider: ProviderId, value: string) => void | Promise<void>
  onOpenAIEndpointChange: (value: string) => void | Promise<void>
}) {
  const { t } = useI18n()
  const { provider, activeProvider, expanded, onToggle, apiKey, modelId, openaiEndpoint, onProviderChange, onModelChange, onApiKeyChange, onOpenAIEndpointChange } = props
  const help = getProviderHelp(t)[provider]
  const isActive = provider === activeProvider

  return (
    <article className={`ichat-settings-provider-card ${isActive ? "is-active" : ""} ${expanded ? "is-expanded" : ""}`}>
      <button className="ichat-settings-provider-toggle" type="button" aria-expanded={expanded} onClick={onToggle}>
        <div className="ichat-settings-provider-title-row">
          <h3>{providerLabels[provider]}</h3>
          <div className="ichat-settings-provider-meta">
            {isActive ? <span className="ichat-settings-provider-badge">{t("settings.providers.active")}</span> : null}
            <svg className="ichat-settings-provider-chevron" aria-hidden="true" viewBox="0 0 20 20" fill="none">
              <path d="M6 8L10 12L14 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </button>

      {expanded ? (
        <div className="ichat-settings-provider-body">
          <div className="ichat-settings-provider-head">
            <p>{help.note}</p>
            <button className={`ichat-secondary-button ${isActive ? "is-selected" : ""}`} type="button" onClick={() => void onProviderChange(provider)}>
              {isActive ? t("settings.providers.active") : t("settings.providers.useProvider")}
            </button>
          </div>

          <div className="ichat-settings-field-grid">
            <label className="ichat-settings-field">
              <span>{help.keyLabel}</span>
              <input
                className="ichat-settings-input"
                type="password"
                value={apiKey}
                placeholder={help.keyPlaceholder}
                onChange={(event) => void onApiKeyChange(provider, event.target.value)}
              />
            </label>
            <label className="ichat-settings-field">
              <span>{help.modelLabel}</span>
              <input
                className="ichat-settings-input"
                type="text"
                value={modelId}
                onChange={(event) => void onModelChange(provider, event.target.value)}
              />
            </label>
            {provider === "openai" ? (
              <label className="ichat-settings-field">
                <span>{help.endpointLabel}</span>
                <input
                  className="ichat-settings-input"
                  type="text"
                  value={openaiEndpoint}
                  placeholder={help.endpointPlaceholder}
                  onChange={(event) => void onOpenAIEndpointChange(event.target.value)}
                />
              </label>
            ) : null}
          </div>
          {provider === "openai" && help.endpointNote ? <p>{help.endpointNote}</p> : null}
        </div>
      ) : null}
    </article>
  )
}

export function SettingsWorkspace(props: SettingsWorkspaceProps) {
  const { locale, t } = useI18n()
  const {
    appState,
    promptPreview,
    pendingState,
    viewMode,
    onClose,
    onTriggerCapture,
    onOpenDetachedTab,
    onProviderChange,
    onModelChange,
    onApiKeyChange,
    onOpenAIEndpointChange,
    onSettingsChange,
    onCopyPrompt,
    onCopySystemInstructions,
    onSendCurrentContext,
    onClearThread,
    onResetContext
  } = props

  const [activeSection, setActiveSection] = useState<SettingsSectionId>("general")
  const [commandBindings, setCommandBindings] = useState<CommandBindingSummary[]>([])
  const [expandedProvider, setExpandedProvider] = useState<ProviderId | null>(null)

  const workspaceRef = useRef<HTMLElement | null>(null)
  const backButtonRef = useRef<HTMLButtonElement | null>(null)

  const settingsSections = useMemo(() => getSettingsSections(t), [t])
  const settings = appState.settings
  const flowContext = appState.flowContext
  const activeProvider = getActiveProvider(settings)
  const autoSendEnabled = isAutoSendEnabled(settings)
  const displayedLocator = getDisplayedLocator(flowContext)
  const previewLength = settings.context.previewDensity === "full" ? 480 : 180
  const primaryBinding = commandBindings.find((binding) => binding.name === "capture-flow-context") ?? null
  const shortcutLabel = primaryBinding?.shortcut || t("settings.shortcuts.notSet")
  const threadCount = appState.chatThreads[activeProvider]?.length ?? 0
  const contextMode = flowContext ? getFlowContextMode(flowContext) : null

  const handleOpenShortcutSettings = async () => {
    await chrome.tabs.create({
      url: "chrome://extensions/shortcuts",
      active: true
    })
  }

  const contextCards = useMemo(() => {
    if (!flowContext) {
      return []
    }

    const cards: Array<{ label: string; value: string }> = []

    if (flowContext.selection?.text?.trim()) {
      cards.push({
        label: t("settings.context.cards.selectedText"),
        value: snippet(flowContext.selection.text, previewLength, t("settings.context.noExplicitSelection"))
      })
    }

    if (flowContext.smartTarget) {
      cards.push({
        label:
          flowContext.smartTarget.kind === "image"
            ? t("settings.context.cards.imageTarget")
            : flowContext.smartTarget.kind === "video"
              ? t("settings.context.cards.videoTarget")
              : t("settings.context.cards.smartTarget"),
        value: formatSmartTargetPreview(flowContext, previewLength, t)
      })
    }

    if (flowContext.implicitContext?.text?.trim()) {
      cards.push({
        label: t("settings.context.cards.implicitContext"),
        value: snippet(flowContext.implicitContext.text, previewLength, t("settings.context.noImplicitContext"))
      })
    }

    if (flowContext.attachments.length) {
      cards.push({
        label: flowContext.attachments.length === 1 ? t("settings.context.cards.attachment") : t("settings.context.cards.attachments"),
        value: formatAttachmentPreview(flowContext, previewLength, t)
      })
    }

    if (displayedLocator) {
      cards.push({
        label: t("settings.context.cards.locator"),
        value: snippet(displayedLocator, previewLength, t("settings.context.noLocator"))
      })
    }

    return cards
  }, [displayedLocator, flowContext, previewLength, t])

  const flowContextParts = useMemo(() => {
    if (!flowContext) {
      return []
    }

    const parts: string[] = []

    if (flowContext.selection?.text?.trim()) {
      parts.push(t("settings.context.parts.selection"))
    }

    if (flowContext.smartTarget) {
      parts.push(
        flowContext.smartTarget.kind === "image"
          ? t("settings.context.parts.imageTarget")
          : flowContext.smartTarget.kind === "video"
            ? t("settings.context.parts.videoTarget")
            : t("settings.context.parts.smartTarget")
      )
    }

    if (flowContext.implicitContext?.text?.trim()) {
      parts.push(t("settings.context.parts.implicitContext"))
    }

    if (flowContext.attachments.length) {
      parts.push(
        flowContext.attachments.length === 1
          ? t("settings.context.parts.attachments.one")
          : t("settings.context.parts.attachments", { count: flowContext.attachments.length })
      )
    }

    if (displayedLocator) {
      parts.push(t("settings.context.parts.locator"))
    }

    return parts
  }, [displayedLocator, flowContext, t])

  useEffect(() => {
    backButtonRef.current?.focus()

    const loadBindings = async () => {
      if (!chrome.commands?.getAll) {
        setCommandBindings([])
        return
      }

      const bindings = await new Promise<chrome.commands.Command[]>((resolve) => {
        chrome.commands.getAll((commands) => {
          resolve(commands ?? [])
        })
      })

      setCommandBindings(
        bindings
          .filter((command) => command.name === "capture-flow-context")
          .map((command) => ({
          name: command.name || "",
          description: command.description || t("settings.shortcuts.noDescriptionAvailable"),
          shortcut: command.shortcut || ""
          }))
      )
    }

    void loadBindings()
  }, [t])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== "Tab") {
        return
      }

      const workspace = workspaceRef.current
      if (!workspace) {
        return
      }

      const focusable = getFocusableElements(workspace)
      if (!focusable.length) {
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = document.activeElement

      if (event.shiftKey && activeElement === first) {
        event.preventDefault()
        last.focus()
      }

      if (!event.shiftKey && activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  const renderActiveSection = () => {
    if (activeSection === "general") {
      return (
        <section className="ichat-settings-page-section">
          <SettingsSectionHeader title={t("settings.general.title")} description={t("settings.general.description")} />

          <div className="ichat-settings-panel">
            <SettingsRow
              label={t("settings.general.language.label")}
              description={t("settings.general.language.description")}
              control={
                <SegmentedControl
                  value={settings.uiLanguage}
                  options={LANGUAGE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey)
                  }))}
                  onChange={(value) => void onSettingsChange({ uiLanguage: value })}
                />
              }
            />
            <SettingsRow
              label={t("settings.general.confirmDestructiveActions.label")}
              description={t("settings.general.confirmDestructiveActions.description")}
              control={
                <button
                  className={`ichat-toggle ${settings.data.confirmDestructiveActions ? "is-on" : ""}`}
                  type="button"
                  onClick={() => void onSettingsChange({ data: { confirmDestructiveActions: !settings.data.confirmDestructiveActions } })}>
                  {settings.data.confirmDestructiveActions ? t("settings.general.confirmDestructiveActions.required") : t("settings.general.confirmDestructiveActions.off")}
                </button>
              }
            />
            <SettingsRow
              label={t("settings.general.historyMessageLimit.label")}
              description={t("settings.general.historyMessageLimit.description")}
              control={
                <input
                  className="ichat-settings-input ichat-settings-input-number"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={settings.data.historyMessageLimit}
                  onChange={(event) =>
                    void onSettingsChange({
                      data: {
                        historyMessageLimit: clampHistoryMessageLimit(Number.parseInt(event.target.value || "0", 10))
                      }
                    })
                  }
                />
              }
            />
            <SettingsRow
              label={t("settings.general.currentProviderThread.label")}
              description={t("settings.general.currentProviderThread.description", { providerLabel: providerLabels[activeProvider] })}
              control={
                <button className="ichat-danger-button" type="button" onClick={onClearThread}>
                  {t("settings.general.currentProviderThread.clearCount", { count: threadCount })}
                </button>
              }
              danger
            />
          </div>
        </section>
      )
    }

    if (activeSection === "providers") {
      return (
        <section className="ichat-settings-page-section">
          <SettingsSectionHeader title={t("settings.providers.title")} description={t("settings.providers.description")} />

          <div className="ichat-settings-provider-grid">
            {PROVIDERS.map((provider) => (
              <ProviderCard
                key={provider}
                provider={provider}
                activeProvider={activeProvider}
                expanded={expandedProvider === provider}
                onToggle={() => setExpandedProvider((current) => (current === provider ? null : provider))}
                apiKey={appState.apiKeys[provider]}
                modelId={getProviderModel(settings, provider)}
                openaiEndpoint={settings.providers.openaiEndpoint}
                onProviderChange={onProviderChange}
                onModelChange={onModelChange}
                onApiKeyChange={onApiKeyChange}
                onOpenAIEndpointChange={onOpenAIEndpointChange}
              />
            ))}
          </div>
        </section>
      )
    }

    if (activeSection === "context") {
      return (
        <section className="ichat-settings-page-section">
          <SettingsSectionHeader title={t("settings.context.title")} description={t("settings.context.description")} />

          <div className="ichat-settings-panel">
            <SettingsRow
              label={t("settings.context.autoSend.label")}
              description={t("settings.context.autoSend.description")}
              control={
                <button
                  className={`ichat-toggle ${autoSendEnabled ? "is-on" : ""}`}
                  type="button"
                  onClick={() => void onSettingsChange({ context: { autoSend: !autoSendEnabled } })}>
                  {autoSendEnabled ? t("settings.context.autoSend.on") : t("settings.context.autoSend.off")}
                </button>
              }
            />
            <SettingsRow
              label={t("settings.context.previewDensity.label")}
              description={t("settings.context.previewDensity.description")}
              control={
                <SegmentedControl
                  value={settings.context.previewDensity}
                  options={[
                    { value: "compact", label: t("settings.context.previewDensity.compact") },
                    { value: "full", label: t("settings.context.previewDensity.full") }
                  ]}
                  onChange={(value) => void onSettingsChange({ context: { previewDensity: value } })}
                />
              }
            />
          </div>

          <article className="ichat-settings-card ichat-settings-system-card">
            <span>{t("settings.context.systemInstructions.label")}</span>
            <p>{t("settings.context.systemInstructions.description")}</p>
            <textarea
              className="ichat-context-editor-textarea"
              rows={8}
              value={settings.context.systemInstructions}
              onChange={(event) =>
                void onSettingsChange({
                  context: {
                    systemInstructions: event.target.value,
                    systemInstructionsCustomized: true
                  }
                })
              }
            />
            <div className="ichat-settings-inline-actions">
              <button className="ichat-secondary-button" type="button" onClick={onCopySystemInstructions}>
                {t("settings.context.systemInstructions.copy")}
              </button>
              <button
                className="ichat-secondary-button"
                type="button"
                onClick={() => void onSettingsChange({ context: { systemInstructionsCustomized: false } })}>
                {t("settings.context.systemInstructions.restoreDefault")}
              </button>
            </div>
          </article>

          <section className="ichat-settings-flow-inspector">
            <div className="ichat-settings-flow-inspector-head">
              <h3>{t("settings.context.inspect.title")}</h3>
              <p>{t("settings.context.inspect.description")}</p>
            </div>

            {flowContext ? (
              <>
              <div className="ichat-settings-summary-grid is-context-grid">
                <article className="ichat-settings-summary-card">
                  <span>{t("settings.context.summary.captureMode")}</span>
                  <strong>{contextMode === "selection" ? t("settings.context.summary.selectionAndImplicit") : t("settings.context.summary.smartDom")}</strong>
                </article>
                <article className="ichat-settings-summary-card">
                  <span>{t("settings.context.summary.contains")}</span>
                  <strong>{flowContextParts.length ? flowContextParts.join(" + ") : t("settings.context.summary.metadataOnly")}</strong>
                </article>
                <article className="ichat-settings-summary-card">
                  <span>{t("settings.context.summary.attachments")}</span>
                  <strong>{flowContext.attachments.length ? t("settings.context.summary.attachedCount", { count: flowContext.attachments.length }) : t("settings.context.summary.noneAttached")}</strong>
                </article>
                <article className="ichat-settings-summary-card">
                  <span>{t("settings.context.summary.promptState")}</span>
                  <strong>{formatPendingStateLabel(pendingState, t)}</strong>
                </article>
              </div>

              <article className="ichat-settings-flow-overview">
                <div className="ichat-settings-flow-overview-main">
                  <span>{t("settings.context.overview.page")}</span>
                  <strong>{flowContext.page.title || flowContext.page.host || t("settings.context.pageUntitled")}</strong>
                  <p>{flowContext.page.url || t("common.unavailable")}</p>
                </div>
                <div className="ichat-settings-flow-overview-side">
                  <span>{t("settings.context.overview.created")}</span>
                  <strong>{new Date(flowContext.createdAt).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US")}</strong>
                </div>
                {flowContextParts.length ? (
                  <div className="ichat-settings-flow-pill-row" aria-label={t("settings.context.title")}>
                    {flowContextParts.map((part) => (
                      <span key={part} className="ichat-settings-flow-pill">
                        {part}
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>

              <div className="ichat-settings-card-grid">
                {contextCards.map((card) => (
                  <article key={card.label} className="ichat-settings-card">
                    <span>{card.label}</span>
                    <p>{card.value}</p>
                  </article>
                ))}
              </div>

              <div className={`ichat-prompt-preview ${settings.context.previewDensity === "full" ? "is-dense-full" : ""}`}>
                <span>{t("settings.context.promptPreview")}</span>
                <pre>{promptPreview || t("settings.context.promptPreviewEmpty")}</pre>
              </div>

              <div className="ichat-settings-actions-row">
                <button className="ichat-secondary-button" type="button" onClick={onCopyPrompt}>
                  {t("settings.context.actions.copyPrompt")}
                </button>
                <button className="ichat-danger-button" type="button" onClick={onResetContext}>
                  {t("settings.context.actions.clearCapturedContext")}
                </button>
                <button className="ichat-primary-button" type="button" onClick={onSendCurrentContext}>
                  {pendingState === "error" ? t("settings.context.actions.retrySend") : t("settings.context.actions.sendCurrentContext")}
                </button>
              </div>
              </>
            ) : (
              <div className="ichat-settings-empty-state">
                <h3>{t("settings.context.empty.title")}</h3>
                <p>
                  {t("settings.context.empty.description", {
                    shortcutSuffix: shortcutLabel && shortcutLabel !== t("settings.shortcuts.notSet")
                      ? t("settings.context.empty.shortcutSuffix", { shortcut: shortcutLabel })
                      : ""
                  })}
                </p>
                <button className="ichat-primary-button" type="button" onClick={onTriggerCapture}>
                  {t("settings.context.empty.startCapture")}
                </button>
              </div>
            )}
          </section>
        </section>
      )
    }

    return (
      <section className="ichat-settings-page-section">
        <SettingsSectionHeader title={t("settings.shortcuts.title")} description={t("settings.shortcuts.description")} />

        <div className="ichat-settings-card-grid is-shortcut-grid">
          {(commandBindings.length ? commandBindings : [{ name: "capture-flow-context", description: t("settings.shortcuts.defaultCaptureDescription"), shortcut: "" }]).map((binding) => (
            <article key={binding.name} className="ichat-settings-card is-shortcut-card">
              <span>{binding.name || t("settings.shortcuts.unnamedCommand")}</span>
              <strong>{binding.shortcut || t("settings.shortcuts.notSet")}</strong>
              <p>{binding.description}</p>
            </article>
          ))}
        </div>

        <div className="ichat-settings-note">
          {t("settings.shortcuts.notePrefix")}
          <button className="ichat-settings-link-button" type="button" onClick={() => void handleOpenShortcutSettings()}>
            {t("settings.shortcuts.openChromeSettings")}
          </button>
          {t("settings.shortcuts.noteSuffix")}
        </div>
      </section>
    )
  }

  const activeSectionMeta = settingsSections.find((section) => section.id === activeSection)

  return (
    <div className="ichat-settings-overlay" role="presentation">
      <section className="ichat-settings-workspace" ref={workspaceRef} role="dialog" aria-modal="true" aria-label={t("settings.title")}>
        <header className="ichat-settings-topbar">
          <div className="ichat-settings-topbar-main">
            <button className="ichat-settings-back" ref={backButtonRef} type="button" onClick={onClose}>
              <svg className="ichat-settings-back-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{t("common.backToApp")}</span>
            </button>
            <div>
              <p className="ichat-eyebrow">{t("settings.title")}</p>
              <h1>{activeSectionMeta?.label || t("settings.title")}</h1>
              <p className="ichat-subtitle">{activeSectionMeta?.description || t("settings.subtitle")}</p>
            </div>
          </div>
        </header>

        <div className="ichat-settings-shell">
          <aside className="ichat-settings-sidebar">
            <nav className="ichat-settings-nav" aria-label={t("settings.title")}>
              {settingsSections.map((section) => (
                <SectionNavButton
                  key={section.id}
                  id={section.id}
                  label={section.label}
                  active={activeSection === section.id}
                  onSelect={setActiveSection}
                />
              ))}
            </nav>
          </aside>

          <div className="ichat-settings-main-scroll">{renderActiveSection()}</div>
        </div>
      </section>
    </div>
  )
}
