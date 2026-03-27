# IChat

![IChat logotype](assets/brand/ichat-lockup-horizontal.svg)

IChat is a Chrome side panel extension for context-aware AI chat.
It helps you capture context from the current web page and send it to your selected AI provider without leaving the browser.

## What It Does

- capture selected text or a smart DOM target from the current page
- turn that context into a structured `FlowContext`
- open a native side panel chat for follow-up questions
- support BYOK setup for OpenAI-compatible providers, Gemini, and Anthropic

## Install

### Load unpacked in Chrome

1. Run `npm install`
2. Run `npm run build`
3. Open `chrome://extensions/`
4. Enable `Developer mode`
5. Click `Load unpacked`
6. Select `build/chrome-mv3-prod`

## How To Use

1. Open the IChat side panel
2. In `Settings`, add your API key and choose a provider
3. Open a normal `http` or `https` page
4. Trigger capture from the extension action or shortcut
5. Review or send the captured context in the chat UI

## Documentation

- [Extension Guide](docs/extension-guide.md)
- [Privacy Policy](docs/privacy-policy.md)
- [Documentation Index](docs/index.md)

## Development

```bash
npm install
npm run dev
npm run build
npm run package
npm run typecheck
```

The production extension output is generated under `build/chrome-mv3-prod`.
