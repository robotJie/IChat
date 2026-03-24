import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { DEFAULT_FLOWCONTEXT_SYSTEM_INSTRUCTIONS, getActiveProvider, getFlowContextMode, getProviderModel, isAutoSendEnabled, providerLabels } from "../lib/prompt-builder"
import type { AppState, FlowContext, IChatSettingsUpdate, ProviderId } from "../lib/types"

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
  onSettingsChange: (partial: IChatSettingsUpdate) => void | Promise<void>
  onCopyPrompt: () => void | Promise<void>
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

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string; description: string }> = [
  { id: "general", label: "General", description: "Manage local safety prompts and stored chat data." },
  { id: "providers", label: "LLM Providers", description: "Choose the active model provider and manage BYOK settings." },
  { id: "context", label: "FlowContext", description: "Review FlowContext, prompt preview, and capture behavior." },
  { id: "shortcuts", label: "Shortcuts", description: "See the current capture keybinding and open Chrome shortcut settings." }
]

const PROVIDERS: ProviderId[] = ["openai", "gemini", "anthropic"]

const PROVIDER_HELP: Record<ProviderId, { keyLabel: string; keyPlaceholder: string; modelLabel: string; note: string }> = {
  openai: {
    keyLabel: "API key",
    keyPlaceholder: "sk-...",
    modelLabel: "Model ID",
    note: "Good default for balanced chat. Use any OpenAI-compatible chat model ID supported by your key."
  },
  gemini: {
    keyLabel: "AI Studio key",
    keyPlaceholder: "AIza...",
    modelLabel: "Model ID",
    note: "Uses Google AI Studio keys. If requests fail with identity errors, verify the key really belongs to Gemini."
  },
  anthropic: {
    keyLabel: "API key",
    keyPlaceholder: "sk-ant-...",
    modelLabel: "Model ID",
    note: "Claude models work well for reasoning-heavy follow-ups. Keep the model ID aligned with your account access."
  }
}

function snippet(value?: string | null, maxLength = 200, fallback = "Unavailable") {
  if (!value?.trim()) {
    return fallback
  }

  return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}...` : value
}

function formatSmartTargetPreview(flowContext: FlowContext, maxLength: number) {
  const target = flowContext.smartTarget
  if (!target) {
    return "No smart DOM target"
  }

  if (target.text?.trim()) {
    return snippet(target.text, maxLength, "No smart DOM target")
  }

  if (target.kind === "image") {
    return target.sourceUrl ? snippet(target.sourceUrl, maxLength, "Captured image target") : "Captured image target"
  }

  if (target.kind === "video") {
    return target.sourceUrl ? snippet(target.sourceUrl, maxLength, "Captured video target") : "Captured video target"
  }

  return "No smart DOM target"
}

function formatAttachmentPreview(flowContext: FlowContext, maxLength: number) {
  if (!flowContext.attachments.length) {
    return "No attachments"
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
  onProviderChange: (provider: ProviderId) => void | Promise<void>
  onModelChange: (provider: ProviderId, model: string) => void | Promise<void>
  onApiKeyChange: (provider: ProviderId, value: string) => void | Promise<void>
}) {
  const { provider, activeProvider, expanded, onToggle, apiKey, modelId, onProviderChange, onModelChange, onApiKeyChange } = props
  const help = PROVIDER_HELP[provider]
  const isActive = provider === activeProvider

  return (
    <article className={`ichat-settings-provider-card ${isActive ? "is-active" : ""} ${expanded ? "is-expanded" : ""}`}>
      <button className="ichat-settings-provider-toggle" type="button" aria-expanded={expanded} onClick={onToggle}>
        <div className="ichat-settings-provider-title-row">
          <h3>{providerLabels[provider]}</h3>
          <div className="ichat-settings-provider-meta">
            {isActive ? <span className="ichat-settings-provider-badge">Active</span> : null}
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
              {isActive ? "Active" : "Use provider"}
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
          </div>
        </div>
      ) : null}
    </article>
  )
}

export function SettingsWorkspace(props: SettingsWorkspaceProps) {
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
    onSettingsChange,
    onCopyPrompt,
    onSendCurrentContext,
    onClearThread,
    onResetContext
  } = props

  const [activeSection, setActiveSection] = useState<SettingsSectionId>("general")
  const [commandBindings, setCommandBindings] = useState<CommandBindingSummary[]>([])
  const [expandedProvider, setExpandedProvider] = useState<ProviderId | null>(null)

  const workspaceRef = useRef<HTMLElement | null>(null)
  const backButtonRef = useRef<HTMLButtonElement | null>(null)

  const settings = appState.settings
  const flowContext = appState.flowContext
  const activeProvider = getActiveProvider(settings)
  const autoSendEnabled = isAutoSendEnabled(settings)
  const displayedLocator = getDisplayedLocator(flowContext)
  const previewLength = settings.context.previewDensity === "full" ? 480 : 180
  const primaryBinding = commandBindings.find((binding) => binding.name === "capture-flow-context") ?? null
  const shortcutLabel = primaryBinding?.shortcut || "Not set"
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
        label: "Selected text",
        value: snippet(flowContext.selection.text, previewLength, "No explicit selection")
      })
    }

    if (flowContext.smartTarget) {
      cards.push({
        label: flowContext.smartTarget.kind === "image" ? "Image target" : flowContext.smartTarget.kind === "video" ? "Video target" : "Smart target",
        value: formatSmartTargetPreview(flowContext, previewLength)
      })
    }

    if (settings.context.showImplicitContext) {
      if (flowContext.implicitContext?.text?.trim()) {
        cards.push({
          label: "Implicit context",
          value: snippet(flowContext.implicitContext.text, previewLength, "No implicit context")
        })
      }
    }

    if (flowContext.attachments.length) {
      cards.push({
        label: flowContext.attachments.length === 1 ? "Attachment" : "Attachments",
        value: formatAttachmentPreview(flowContext, previewLength)
      })
    }

    if (settings.context.showLocator) {
      if (displayedLocator) {
        cards.push({
          label: "Locator",
          value: snippet(displayedLocator, previewLength, "No locator")
        })
      }
    }

    return cards
  }, [displayedLocator, flowContext, previewLength, settings.context.showImplicitContext, settings.context.showLocator])

  const flowContextParts = useMemo(() => {
    if (!flowContext) {
      return []
    }

    const parts: string[] = []

    if (flowContext.selection?.text?.trim()) {
      parts.push("Selection")
    }

    if (flowContext.smartTarget) {
      parts.push(flowContext.smartTarget.kind === "image" ? "Image target" : flowContext.smartTarget.kind === "video" ? "Video target" : "Smart target")
    }

    if (settings.context.showImplicitContext) {
      if (flowContext.implicitContext?.text?.trim()) {
        parts.push("Implicit context")
      }
    }

    if (flowContext.attachments.length) {
      parts.push(`${flowContext.attachments.length} attachment${flowContext.attachments.length === 1 ? "" : "s"}`)
    }

    if (settings.context.showLocator) {
      if (displayedLocator) {
        parts.push("Locator")
      }
    }

    return parts
  }, [displayedLocator, flowContext, settings.context.showImplicitContext, settings.context.showLocator])

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
          description: command.description || "No description available.",
          shortcut: command.shortcut || ""
          }))
      )
    }

    void loadBindings()
  }, [])

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
          <SettingsSectionHeader title="General" description="Control confirmation behavior and clear local chat state without touching provider keys." />

          <div className="ichat-settings-panel">
            <SettingsRow
              label="Confirm destructive actions"
              description="Ask before clearing threads or resetting the current FlowContext draft."
              control={
                <button
                  className={`ichat-toggle ${settings.data.confirmDestructiveActions ? "is-on" : ""}`}
                  type="button"
                  onClick={() => void onSettingsChange({ data: { confirmDestructiveActions: !settings.data.confirmDestructiveActions } })}>
                  {settings.data.confirmDestructiveActions ? "Required" : "Off"}
                </button>
              }
            />
            <SettingsRow
              label="Current provider thread"
              description={`Clear the ${providerLabels[activeProvider]} thread snapshot stored locally. Messages in other providers stay untouched.`}
              control={
                <button className="ichat-danger-button" type="button" onClick={onClearThread}>
                  Clear {threadCount} messages
                </button>
              }
              danger
            />
            <SettingsRow
              label="Current FlowContext draft"
              description="Remove the current FlowContext and pending prompt from local storage, without changing your provider settings or API keys."
              control={
                <button className="ichat-danger-button" type="button" onClick={onResetContext}>
                  Reset context draft
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
          <SettingsSectionHeader title="LLM Providers" description="Bring your own keys, set model IDs, and decide which provider is active for chat." />

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
                onProviderChange={onProviderChange}
                onModelChange={onModelChange}
                onApiKeyChange={onApiKeyChange}
              />
            ))}
          </div>
        </section>
      )
    }

    if (activeSection === "context") {
      return (
        <section className="ichat-settings-page-section">
          <SettingsSectionHeader title="FlowContext" description="Inspect the latest FlowContext, review the generated prompt, and control how much detail the UI shows." />

          <div className="ichat-settings-panel">
            <SettingsRow
              label="Auto-send captured context"
              description="When enabled, a new FlowContext becomes a pending prompt immediately instead of waiting as a composer attachment."
              control={
                <button
                  className={`ichat-toggle ${autoSendEnabled ? "is-on" : ""}`}
                  type="button"
                  onClick={() => void onSettingsChange({ context: { autoSend: !autoSendEnabled } })}>
                  {autoSendEnabled ? "On" : "Off"}
                </button>
              }
            />
            <SettingsRow
              label="FlowContext preview density"
              description="Compact keeps summary cards tight. Full shows longer excerpts before you open the raw fields."
              control={
                <SegmentedControl
                  value={settings.context.previewDensity}
                  options={[
                    { value: "compact", label: "Compact" },
                    { value: "full", label: "Full" }
                  ]}
                  onChange={(value) => void onSettingsChange({ context: { previewDensity: value } })}
                />
              }
            />
            <SettingsRow
              label="Show locator details"
              description="Display XPath or CSS path details in the context inspector."
              control={
                <button
                  className={`ichat-toggle ${settings.context.showLocator ? "is-on" : ""}`}
                  type="button"
                  onClick={() => void onSettingsChange({ context: { showLocator: !settings.context.showLocator } })}>
                  {settings.context.showLocator ? "Visible" : "Hidden"}
                </button>
              }
            />
            <SettingsRow
              label="Show implicit context"
              description="Include the implicit context block in the visual inspector for quicker review."
              control={
                <button
                  className={`ichat-toggle ${settings.context.showImplicitContext ? "is-on" : ""}`}
                  type="button"
                  onClick={() => void onSettingsChange({ context: { showImplicitContext: !settings.context.showImplicitContext } })}>
                  {settings.context.showImplicitContext ? "Visible" : "Hidden"}
                </button>
              }
            />
          </div>

          <article className="ichat-settings-card ichat-settings-system-card">
            <span>FlowContext system instructions</span>
            <p>These instructions are sent as the system message for FlowContext-driven chats. Editing them directly changes model behavior.</p>
            <textarea
              className="ichat-context-editor-textarea"
              rows={8}
              value={settings.context.systemInstructions}
              onChange={(event) => void onSettingsChange({ context: { systemInstructions: event.target.value } })}
            />
            <div className="ichat-settings-inline-actions">
              <button
                className="ichat-secondary-button"
                type="button"
                onClick={() => void onSettingsChange({ context: { systemInstructions: DEFAULT_FLOWCONTEXT_SYSTEM_INSTRUCTIONS } })}>
                Restore default
              </button>
            </div>
          </article>

          <section className="ichat-settings-flow-inspector">
            <div className="ichat-settings-flow-inspector-head">
              <h3>Inspect FlowContext</h3>
              <p>Review the captured blocks, page metadata, and the exact user prompt preview before sending.</p>
            </div>

            {flowContext ? (
              <>
              <div className="ichat-settings-summary-grid is-context-grid">
                <article className="ichat-settings-summary-card">
                  <span>Capture mode</span>
                  <strong>{contextMode === "selection" ? "Selection + implicit context" : "Smart DOM target"}</strong>
                </article>
                <article className="ichat-settings-summary-card">
                  <span>Contains</span>
                  <strong>{flowContextParts.length ? flowContextParts.join(" + ") : "Metadata only"}</strong>
                </article>
                <article className="ichat-settings-summary-card">
                  <span>Attachments</span>
                  <strong>{flowContext.attachments.length ? `${flowContext.attachments.length} attached` : "None attached"}</strong>
                </article>
                <article className="ichat-settings-summary-card">
                  <span>Prompt state</span>
                  <strong>{pendingState ? `${pendingState.charAt(0).toUpperCase()}${pendingState.slice(1)}` : "Draft not created"}</strong>
                </article>
              </div>

              <article className="ichat-settings-flow-overview">
                <div className="ichat-settings-flow-overview-main">
                  <span>Page</span>
                  <strong>{flowContext.page.title || flowContext.page.host || "Untitled page"}</strong>
                  <p>{flowContext.page.url || "Unavailable"}</p>
                </div>
                <div className="ichat-settings-flow-overview-side">
                  <span>Created</span>
                  <strong>{new Date(flowContext.createdAt).toLocaleString()}</strong>
                </div>
                {flowContextParts.length ? (
                  <div className="ichat-settings-flow-pill-row" aria-label="FlowContext blocks">
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
                <span>User prompt preview</span>
                <pre>{promptPreview || "Prompt will appear here after capture."}</pre>
              </div>

              <div className="ichat-settings-actions-row">
                <button className="ichat-secondary-button" type="button" onClick={onCopyPrompt}>
                  Copy prompt
                </button>
                <button className="ichat-primary-button" type="button" onClick={onSendCurrentContext}>
                  {pendingState === "error" ? "Retry send" : "Send current context"}
                </button>
              </div>
              </>
            ) : (
              <div className="ichat-settings-empty-state">
                <h3>No FlowContext captured yet</h3>
                <p>
                  Capture a page selection or let IChat smart-pick a DOM target to populate this section.
                  {shortcutLabel ? ` Current shortcut: ${shortcutLabel}.` : ""}
                </p>
                <button className="ichat-primary-button" type="button" onClick={onTriggerCapture}>
                  Start capture
                </button>
              </div>
            )}
          </section>
        </section>
      )
    }

    return (
      <section className="ichat-settings-page-section">
        <SettingsSectionHeader title="Shortcuts" description="Review the current capture binding and jump to Chrome's shortcut settings." />

        <div className="ichat-settings-card-grid is-shortcut-grid">
          {(commandBindings.length ? commandBindings : [{ name: "capture-flow-context", description: "Capture page context into IChat.", shortcut: "" }]).map((binding) => (
            <article key={binding.name} className="ichat-settings-card is-shortcut-card">
              <span>{binding.name || "Unnamed command"}</span>
              <strong>{binding.shortcut || "Not set"}</strong>
              <p>{binding.description}</p>
            </article>
          ))}
        </div>

        <div className="ichat-settings-note">
          Change extension shortcuts in{" "}
          <button className="ichat-settings-link-button" type="button" onClick={() => void handleOpenShortcutSettings()}>
            chrome://extensions/shortcuts
          </button>
          .
        </div>
      </section>
    )
  }

  const activeSectionMeta = SETTINGS_SECTIONS.find((section) => section.id === activeSection)

  return (
    <div className="ichat-settings-overlay" role="presentation">
      <section className="ichat-settings-workspace" ref={workspaceRef} role="dialog" aria-modal="true" aria-label="IChat settings">
        <header className="ichat-settings-topbar">
          <div className="ichat-settings-topbar-main">
            <button className="ichat-settings-back" ref={backButtonRef} type="button" onClick={onClose}>
              <svg className="ichat-settings-back-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Back to app</span>
            </button>
            <div>
              <p className="ichat-eyebrow">Settings</p>
              <h1>{activeSectionMeta?.label || "Settings"}</h1>
              <p className="ichat-subtitle">{activeSectionMeta?.description || "Manage providers, FlowContext presentation, shortcuts, and local chat state."}</p>
            </div>
          </div>
        </header>

        <div className="ichat-settings-shell">
          <aside className="ichat-settings-sidebar">
            <nav className="ichat-settings-nav" aria-label="Settings sections">
              {SETTINGS_SECTIONS.map((section) => (
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
