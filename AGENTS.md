# AGENTS.md

## Project Summary

IChat is a Chrome MV3 extension built with `Plasmo`, `React`, and the `Vercel AI SDK`.
Its single product purpose is:

- Capture context from the current web page when the user explicitly triggers IChat.
- Turn that context into a structured `FlowContext`.
- Send the resulting prompt to the user-selected AI provider inside a native Chrome side panel chat UI.

This is a local-first, BYOK extension:

- Users bring their own API keys.
- Keys are stored locally in extension storage.
- The extension sends prompts directly to the configured model provider.
- There is no project-owned backend in the current architecture.

## Product Principles

- Keep capture explicit. IChat should only capture page context in response to clear user action such as clicking the extension action or using the capture shortcut.
- Preserve the single-purpose scope. Avoid turning IChat into a general browser utility or unrelated productivity suite.
- Stay local-first. Do not introduce a remote relay, telemetry pipeline, or account system unless the product direction explicitly changes.
- Minimize permissions. Any new Chrome permission or host permission must be justified by a real user-facing need.
- Keep docs truthful. Privacy, README, and Chrome Web Store copy must describe the code as it actually behaves today.
- Respect existing UX. The app is chat-first, with non-chat controls grouped into Settings.

## Architecture Map

Key paths:

- `src/background.ts`: command handling, side panel opening, capture orchestration, message routing
- `src/contents/page-capture.ts`: in-page capture UX and smart DOM/media capture
- `src/lib/flow-context.js`: FlowContext construction and DOM heuristics
- `src/lib/flow-context-media.ts`: attachment resolution, including screenshot fallback
- `src/lib/storage.ts`: local persistence, normalization, migrations
- `src/lib/chat-agent.ts`: provider client creation and request execution
- `src/components/IChatApp.tsx`: app shell shared by side panel and detached tab
- `src/components/ProviderConversation.tsx`: conversation state, sending pipeline, attachment handling
- `src/components/SettingsWorkspace.tsx`: settings UI, prompt review, provider configuration
- `src/lib/locales/en.ts` and `src/lib/locales/zhCN.ts`: UI strings

## Working Rules For Agents

- Read the current implementation before changing behavior, especially around capture, storage, and provider requests.
- Keep `FlowContext` as the source of truth for captured page context.
- Prefer extending existing modules over creating duplicate abstractions.
- When changing user-facing text, update both English and Simplified Chinese catalogs.
- When changing storage shape, normalize old data instead of breaking existing installs.
- When changing capture behavior or permissions, review the privacy docs under `docs/` in the same change.
- Do not commit generated output such as `.plasmo/`, `build/`, or packaged zip files.

## Data And Compliance Notes

The current implementation stores or handles these categories locally:

- provider API keys in extension local storage
- FlowContext snapshots in extension local storage
- pending prompts and chat thread snapshots in extension local storage
- captured image attachments in IndexedDB

The current implementation may send these categories to the selected provider:

- the composed FlowContext prompt
- recent thread messages included in the request
- image attachments when the active model flow supports vision input

If you change any of the above, also update:

- `docs/privacy-policy.md`
- `docs/extension-guide.md`
- any Chrome Web Store submission copy derived from those docs

## Development Commands

```bash
npm install
npm run dev
npm run build
npm run package
npm run typecheck
```

Production extension output is generated under `build/chrome-mv3-prod`.

## Preferred Change Style

- Make small, reviewable changes.
- Preserve the existing side panel and settings information architecture unless there is a strong reason to change it.
- Favor explicit names and direct data flow over clever abstractions.
- Add brief comments only when code would otherwise be hard to follow.

## Before Finishing A Change

- Run `npm run typecheck` when TypeScript or React code changes.
- Run `npm run build` when manifest, packaging, or extension wiring changes.
- Re-check any docs affected by changes to permissions, storage, provider routing, or capture behavior.
