
# IChat 扩展使用文档


语言：
[English](./extension-guide.md) | [简体中文](./extension-guide.zh-CN.md)

## IChat 是做什么的

IChat 是一个面向网页场景的 Chrome 侧边栏 AI 对话扩展。创新点在于：上下文的智能获取+无缝流转。并且完全的本地化，无需担心隐私和api key泄露。

具体来说: 根据你鼠标hover的区域或者选定的文字，智能组建一个Context(在IChat，我称之为FlowContext)，并通过唤起侧边栏，让整个Q&A chat的过程无比丝滑顺畅。

场景示例:

![](./assets/sample.png)

## 当前能力

- 选中文本优先抓取
- 未选中文本时的智能 DOM 抓取
- 面向图片目标的附件处理能力
- 原生 side panel 聊天界面
- 可分离出的独立聊天标签页
- 支持 OpenAI-compatible、Gemini 和 Anthropic 的 BYOK 配置


## 如何使用 IChat

### 1. 加载/安装扩展

本地开发时：

1. 运行 `npm install`
2. 运行 `npm run build`
3. 打开 `chrome://extensions/`
4. 打开开发者模式
5. 点击 **Load unpacked**
6. 选择 `build/chrome-mv3-prod`

### 2. 打开侧边栏

你可以通过以下方式打开 IChat：

- 点击扩展 action
- 使用当前配置的抓取快捷键(默认 ctrl+shift+y)

### 3. 设置

#### 通用

![](./assets/General.png)

* 支持英语、简体中文，默认跟随系统
* 请求附带的消息数: 决定历史消息中的前多少条会被附带。默认值为6，一定程度支持多轮上下文关联的对话，又节省token降低时延
* 清除本地的历史消息

#### LLM 提供商

![](./assets/LLM-provider.png)

打开 **Settings**，填入下列任意一种：

- OpenAI-compatible API Key (比如豆包)
- 来自 Google AI Studio 的 Gemini API Key
- Anthropic API Key


#### FlowContext
![](./assets/FlowContext.png)

- auto-send 行为
	- 开启 auto-send，让抓取到的上下文立即进入发送流程(无须手动发送)
	- 关闭 auto-send，可在输入框输入想要的prompt再发送

* FlowContext 系统提示词：作为system prompt，可自定义
* 检查FlowContext:  可用于查看当前FlowContext字段内容


## 本地存储和数据流

在当前实现中：

- 设置和 API Key 保存在扩展本地存储
- FlowContext 和聊天快照保存在本地
- 图片附件保存在 IndexedDB
- 请求会直接发往用户选择的模型提供方

更详细的说明请查看 [隐私政策](./privacy-policy.zh-CN.md)。

## 权限概述

IChat 当前需要的 Chrome 扩展能力主要与以下场景相关：

- 本地存储
- 与当前页面交互以完成抓取
- side panel 展示
- 为抓取而进行的 content script 注入与页面脚本执行


## 抓取是如何工作的

当你在普通 `http` 或 `https` 页面上触发 IChat 时，扩展会尝试从当前页面收集与请求相关的上下文。

抓取内容可能包括：

- 选中的文本
- 智能 DOM 目标文本
- 周边隐式上下文
- 页面元数据
- 图片附件元数据

如果无法直接解析图片目标，IChat 可能使用截图回退，对当前可见区域中的目标部分进行截图处理。