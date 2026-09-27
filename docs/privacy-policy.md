---
title: Privacy Policy
---

# IChat Privacy Policy

Last updated: September 27, 2026

This Privacy Policy explains how IChat handles information when you use the extension.

Language:
[English](./privacy-policy.md) | [简体中文](./privacy-policy.zh-CN.md)

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
- optional Alibaba Cloud Fun-ASR and MOSS API keys and selected speech recognition provider
- selected provider and model settings
- optional custom OpenAI-compatible endpoint

### 2. Captured Page Context

Auto-send is off by default for new installs or when no value is saved. Captured context waits for you to send it manually unless you enable auto-send. Existing saved preferences are preserved.

When you explicitly trigger capture, IChat may collect:

- current page URL, title, and host
- selected text
- smart DOM target text
- nearby implicit context text
- locator metadata such as XPath or CSS path
- viewport and document metadata

When you click **Capture selected text with IChat** in the selection context menu, Chrome supplies the selected text and available page/frame metadata directly to IChat. This also supports text selections supplied by Chrome's PDF viewer. This path does not read or write the clipboard, take screenshots, or extract surrounding text. It stores the selection locally as FlowContext and follows the existing auto-send setting when sending to the selected provider. The `contextMenus` permission is used to provide this explicit capture action.

### 3. Captured Media

If the current target includes an image, IChat may process:

- image source URLs when available
- normalized image blobs stored locally
- image metadata such as type, dimensions, alt text, caption text, and nearby text

If direct media resolution is not available, IChat may use screenshot-based fallback for the visible area needed to complete the requested capture.

For online PDFs opened in Chrome's native PDF viewer, triggering capture with the extension action or keyboard shortcut takes an image of the currently visible tab area, including visible PDF viewer controls. It does not extract the full PDF or the exact text selection. This image follows the same local IndexedDB storage and selected-provider image sending flow, including your auto-send setting. The screenshot fallback uses existing permissions and no remote PDF processing service.

### 4. Local Chat State

Stored locally:

- chat thread snapshots by provider
- pending prompts
- capture status and dispatch status

### 5. Optional Voice Dictation

With MOSS selected, the same in-memory recording flow sends a 16 kHz mono WAV directly to `https://api.mosi.cn/v1/audio/transcriptions` as a multipart file, using model `moss-transcribe-1.0`. Only the recording and transcription options are sent, without page context or chat history. The MOSS key stays in local extension storage and is sent only to MOSS for authentication. Recording limits, cancellation, and local cleanup match the Fun-ASR flow below. IChat does not create a separate hosted file through the MOSS files API.

Clicking the microphone starts the selected speech input flow after microphone access is allowed. Chrome built-in recognition is the default and may send audio to the browser's speech service (for example, Google's service in Chrome). Alternatively, you can choose Alibaba Cloud Fun-ASR-Flash or MOSS and supply its separate API key locally in Settings → STT Provider.

With Fun-ASR-Flash, IChat records up to three minutes of microphone audio into memory. Clicking Send or the microphone again, pressing Escape in the input, or reaching the recording limit stops recording and submits the audio as a 16 kHz mono WAV to Alibaba Cloud's Beijing DashScope HTTPS endpoint for transcription. The request contains this recording and a language hint, not page context or chat history. Recordings are not saved to extension storage or IndexedDB and are released after processing or cancellation. Transcription can be cancelled; cancellation cannot undo audio already transmitted. Leaving the chat, hiding the document, switching providers, or closing the page cancels capture and outstanding requests. Listening never restarts automatically.

Recognized text is inserted into the unsent draft. If you click Send during recording, IChat first stops dictation and completes transcription, then sends the merged draft to the selected chat provider. Stopping with the microphone button alone does not send the draft; recognition failure or cancellation prevents the pending send. Sending the draft follows the same chat provider request and local chat storage flow as typed messages. Speech and chat providers are configured independently; this implementation uses no project-owned relay.

If the side panel cannot obtain microphone permission, an optional extension tab lets you grant access. The permission button briefly opens the microphone and immediately stops all audio tracks. A separate, user-triggered microphone test measures sound levels locally for up to ten seconds and displays the input device name. The test does not record, persist, or upload audio or device information; stopping it or leaving the tab releases the microphone. No additional manifest or host permissions are added for dictation. You can revoke microphone access in Chrome or system settings.

The browser's speech service, Alibaba Cloud, or MOSS handles audio under its own terms, privacy policy, and retention rules. All modes depend on their respective service availability; offline recognition is not guaranteed.

## When Data Is Collected

IChat does not continuously monitor all browsing activity for remote processing.

IChat handles page context only when you explicitly trigger extension behavior, for example:

- clicking the extension action
- using the configured capture shortcut
- clicking IChat's selected-text context menu item
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
