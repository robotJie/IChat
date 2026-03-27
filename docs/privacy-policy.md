---
title: Privacy Policy
---

# IChat Privacy Policy

Last updated: March 27, 2026

This Privacy Policy explains how IChat handles information when you use the extension.

## Overview

IChat is a Chrome extension that captures context from the current web page only when you explicitly trigger it, then sends the resulting prompt to the AI provider you selected in the extension settings.

IChat is designed as a local-first, bring-your-own-key product:

- Your provider API keys are stored locally in your browser extension storage.
- Captured context and local chat state are stored locally on your device.
- IChat does not use a project-owned backend in the current implementation.
- IChat sends requests directly to the provider you choose.

## Information IChat Handles

Depending on how you use the extension, IChat may handle the following categories of information:

### 1. Provider Configuration

Stored locally in extension storage:

- OpenAI-compatible API key
- Gemini API key
- Anthropic API key
- selected provider and model settings
- optional custom OpenAI-compatible endpoint

### 2. Captured Page Context

When you explicitly trigger capture, IChat may collect:

- current page URL, title, and host
- selected text
- smart DOM target text
- nearby implicit context text
- locator metadata such as XPath or CSS path
- viewport and document metadata

### 3. Captured Media

If the current target includes an image, IChat may process:

- image source URLs when available
- normalized image blobs stored locally
- image metadata such as type, dimensions, alt text, caption text, and nearby text

If direct media resolution is not available, IChat may use screenshot-based fallback for the visible area needed to complete the requested capture.

### 4. Local Chat State

Stored locally:

- chat thread snapshots by provider
- pending prompts
- capture status and dispatch status

## When Data Is Collected

IChat does not continuously monitor all browsing activity for remote processing.

IChat handles page context only when you explicitly trigger extension behavior, for example:

- clicking the extension action
- using the configured capture shortcut
- sending a message with attached captured context

## Where Data Is Stored

In the current implementation, IChat stores data locally in the browser:

- extension local storage for settings, API keys, FlowContext, pending prompts, and chat snapshots
- IndexedDB for locally stored captured image attachments

IChat does not currently provide cloud sync or a project-owned account system.

## Where Data Is Sent

When you send a request, IChat may send relevant content to the provider you selected in settings, such as:

- the composed FlowContext prompt
- recent conversation messages included in the request
- image attachments for vision-capable flows

Depending on your configuration, this may include direct requests to:

- OpenAI
- Google Gemini
- Anthropic
- another OpenAI-compatible provider you configure

Those providers process requests under their own terms and privacy policies.

## What IChat Does Not Currently Do

In the current implementation, IChat does not:

- send your data to a project-owned backend
- require a project-owned user account
- include built-in analytics, advertising, or telemetry services
- sell personal information

## User Control

You control whether to use IChat and what to send.

Current controls include:

- deciding when to trigger capture
- choosing which provider to use
- editing provider model settings
- clearing a provider chat thread locally
- resetting the current captured context locally
- removing attached images before sending

If broader delete or reset controls are added later, this policy should be updated to reflect them.

## Data Retention

Locally stored data remains on your device until you change it, overwrite it, or remove it through extension controls or browser-level extension data removal.

Third-party provider retention is governed by the provider you selected, not by IChat.

## Children

IChat is not intended for children under 13.

## Security

IChat uses local browser extension storage for settings and state. However, no browser extension can guarantee absolute security. You should avoid using IChat with highly sensitive information unless you understand the risks of local storage and third-party AI provider processing.

## Changes To This Policy

This Privacy Policy may be updated when the product behavior changes, especially if storage, permissions, networking, or data flows change.

## Contact

At this stage, the project does not yet publish a dedicated support contact address. When the public repository and project contact channels are finalized, this section should be updated with a stable contact method.

---

## 中文摘要

IChat 当前是一个本地优先的 Chrome 扩展：

- 只有在用户主动触发时才抓取页面上下文
- API Key、聊天记录、FlowContext 和附件主要保存在本地
- 当前没有项目自建后端，也没有内置统计或遥测
- 发送请求时，数据会直接发往用户选择的 AI 提供方

如果未来引入后端、账号系统、遥测或新的数据用途，本页面应同步更新。
