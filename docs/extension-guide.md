---
title: Extension Guide
---

# IChat Extension Guide

Last updated: March 27, 2026

## What IChat Does

IChat is a Chrome side panel extension for context-aware AI chat.

Its single purpose is to help you:

1. capture context from the current web page
2. turn that context into a structured prompt
3. send the prompt to your selected AI provider from a native side panel

## Current Capabilities

- selection-first capture
- smart DOM capture when no text is selected
- image-aware capture with local attachment processing
- side panel chat UI
- detached chat tab
- BYOK support for OpenAI-compatible providers, Gemini, and Anthropic

## How Capture Works

When you trigger IChat on a normal `http` or `https` page, the extension tries to gather relevant context from the current page.

Capture may include:

- selected text
- smart DOM target text
- surrounding implicit context
- page metadata
- image attachment metadata

If an image target cannot be resolved directly, IChat may use a screenshot-based fallback for the visible target area.

## How To Use IChat

### 1. Load The Extension

For local development:

1. run `npm install`
2. run `npm run build`
3. open `chrome://extensions/`
4. enable Developer mode
5. choose **Load unpacked**
6. select `build/chrome-mv3-prod`

### 2. Open The Side Panel

You can open IChat by:

- clicking the extension action
- triggering the configured capture shortcut

### 3. Configure A Provider

Open **Settings** and add one of the following:

- an OpenAI-compatible API key
- a Gemini API key from Google AI Studio
- an Anthropic API key

You can also configure:

- active provider
- model ID
- optional OpenAI-compatible base endpoint
- language
- FlowContext preview density
- auto-send behavior

### 4. Capture Context

On a standard website:

- if text is selected, IChat uses the selection first
- if no text is selected, IChat enters smart DOM capture

Once captured, the latest FlowContext can be reviewed in Settings.

### 5. Send A Prompt

You can:

- let auto-send dispatch the captured context immediately
- keep auto-send off and manually send the context after review
- attach images and ask a follow-up question when supported by the active model

## Supported Page Types

IChat is intended for normal `http` and `https` pages.

Some pages cannot be scripted due to Chrome restrictions, including examples such as:

- `chrome://` pages
- Chrome Web Store pages
- some internal browser surfaces and protected viewers

## Local Storage And Data Flow

In the current implementation:

- settings and keys are stored in extension local storage
- FlowContext and chat snapshots are stored locally
- image attachments are stored locally in IndexedDB
- requests are sent directly to the selected provider

For more detail, see the [Privacy Policy](./privacy-policy.md).

## Permissions Summary

IChat currently needs Chrome extension capabilities related to:

- local storage
- interacting with the active page for capture
- side panel presentation
- content script injection and page scripting needed for capture

The exact manifest should remain aligned with the current implementation and minimum necessary permission scope.

## Notes For GitHub Pages

This file is written in Markdown so it can be published directly from the repository `docs/` folder using GitHub Pages.

Recommended public pages:

- `docs/index.md`
- `docs/privacy-policy.md`
- `docs/extension-guide.md`

## 中文摘要

IChat 的核心用途是：

- 用户主动触发抓取当前网页上下文
- 将上下文整理为适合 AI 的提示
- 在 Chrome 侧边栏中完成对话

当前版本强调本地优先、BYOK 和直接连到用户选择的模型提供方。
