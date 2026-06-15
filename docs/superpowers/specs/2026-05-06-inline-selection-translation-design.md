# 新版内联划词翻译 MVP 设计

## 目标

新增一种划词翻译模式：用户选中词或句后，在选区右上角显示一个小的 `译` 按钮；点击后使用现有翻译能力，把译文以弱化的小号文本直接插入到选中文本后面。该模式不替换现有的小红点和 tooltip 划词翻译体验，而是作为一个新选项存在。

## 范围

本次 MVP 新增 `selectionTranslatorMode = 'inline'`，与现有的 `disabled`、`bilingual`、`translation-only` 并列。

包含内容：

- 在选中文本右上角显示 `译` 操作按钮。
- 只在用户点击按钮后发起翻译，不自动翻译。
- 复用现有 `translateText()` 链路，包括翻译服务配置、队列、缓存、重试和目标语言。
- 翻译等待期间，在选中文本后直接插入 inline loading 状态。
- 翻译成功后，把 loading 替换为更小、更弱化的 inline 译文。
- 给选中的原文加插件自己的下划线或轻量标记。
- 支持同一个块级容器内的选区，包括跨 `span`、`strong`、`a` 等 inline 子节点。

不包含内容：

- 跨段落或跨块级容器的选区插入。
- 新增或修改翻译服务行为。
- 历史记录面板、复制按钮、语音播放按钮或专门的清理 UI。
- 自动化测试。本仓库目前没有配置测试框架。

## 架构

`SelectionTranslator.vue` 继续作为所有划词翻译模式的挂载组件。它仍然负责选区事件监听、选中文本状态、当前 `Range` 保存，以及通过 Floating UI 定位按钮。

当 `config.selectionTranslatorMode === 'inline'` 时，组件不再渲染当前的小红点和 tooltip，而是渲染紧凑的 `译` 按钮。用户点击按钮后，组件调用新增的 `entrypoints/utils/inlineSelectionTranslation.ts` helper。

新的 helper 只负责 DOM 修改：

- 校验当前 `Range` 是否位于同一个块级容器内。
- 在选区后插入 loading 节点。
- 用 `data-fr-inline-selection-source` 标记选中的原文。
- 把 loading 替换为译文或简短错误状态。
- 对同一个已标记原文重复翻译时，替换已有译文，避免重复追加。
- 提供清理函数，用于组件卸载和页面卸载。

现有 `bilingual` 和 `translation-only` 模式继续保留当前 tooltip 行为。

## 交互流程

1. 用户选中文本。
2. 如果选区非空、长度在现有限制内，并且适合 inline 模式，则在选区右上角显示 `译`。
3. 用户点击 `译`。
4. 不主动清除浏览器原生选区，保持浏览器自然行为。
5. 在选中文本后立即插入 inline loading 图标。
6. 调用 `translateText(selectedText)`。
7. 翻译成功后，把 loading 替换成弱化的 inline 译文。
8. 翻译失败后，把 loading 替换成简短、可重试的错误文案，例如 `翻译失败`。

用户选择其他文本时，只移动 `译` 按钮。页面上已经插入的 inline 译文会保留。

## DOM 规则

Inline 模式只支持同一个最近块级容器内的选区，例如同一个 `p`、`li` 或标题元素。选区可以跨该块内的 inline 子节点。跨块选区必须隐藏 `译` 按钮；点击处理函数也必须重新校验 range，如果无效就直接返回，不修改页面 DOM。

标记原文时优先使用 `Range.surroundContents()`。如果选区跨 inline 边界导致该方法失败，helper 需要拆分文本节点，并只包裹被选中的文本片段。所有插入或包裹的节点都必须使用 FluentRead 专属 class 和 `data-fr-*` 属性，方便清理和重复检测。

译文保持 inline 形态，视觉上弱于原文：使用更小字号、低对比度颜色和较小左边距。默认不另起一行，尽量减少页面布局扰动。

## 验收方式

必须完成的检查：

- `pnpm compile` 通过。
- 设置页包含 `内联翻译` 选项，并能发送 `updateSelectionTranslatorMode` 消息。
- `disabled`、`bilingual`、`translation-only` 的旧行为不回归。
- Inline 模式支持普通文本选区，以及同一块级容器内跨 `span`、`strong`、`a` 的选区。
- 跨段落选区不会修改页面 DOM。
- 翻译成功或失败后，loading 都会被移除。
- 对同一个已标记原文重复翻译时，替换已有译文，不追加重复译文。
