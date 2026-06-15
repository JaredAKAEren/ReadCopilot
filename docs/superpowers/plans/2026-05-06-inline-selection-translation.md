# 新版内联划词翻译实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `内联翻译` 划词模式：选中文本后显示 `译` 按钮，点击后翻译，并把弱化的小号译文插入到选中文本后。

**Architecture:** 继续使用 `SelectionTranslator.vue` 作为划词翻译挂载组件，在其中增加 `inline` 分支。把 Range 校验、原文标记、loading 插入、结果替换等 DOM 操作放进 `entrypoints/utils/inlineSelectionTranslation.ts`。把插入到网页 DOM 的样式放进 `entrypoints/style.css`，因为 Vue scoped 样式不会作用到组件模板外创建的节点。

**Tech Stack:** WXT、Vue 3 `<script setup>`、TypeScript、Floating UI、现有 `translateText()` 队列/缓存/翻译服务链路、content script 全局 CSS。

---

## 文件结构

- 修改 `entrypoints/utils/model.ts`：补充 `selectionTranslatorMode` 的 `inline` 取值说明。
- 修改 `components/Main.vue`：新增 `内联翻译` 设置选项，并更新提示文案。
- 新建 `entrypoints/utils/inlineSelectionTranslation.ts`：校验同块选区、标记原文、插入 loading、替换译文或错误，并处理重复翻译。
- 修改 `entrypoints/style.css`：添加原文标记、inline loading、inline 译文和错误状态的全局样式。
- 修改 `components/SelectionTranslator.vue`：inline 模式下渲染 `译` 按钮，显示前校验选区，点击后调用 helper。

## 范围说明

- 仓库当前没有配置测试框架。本 MVP 使用 `pnpm compile` 加浏览器手动验证。
- 不重写 `bilingual` 或 `translation-only` 的现有 tooltip 行为。
- 用户选择其他文本时，不清理页面上已有的 inline 译文。
- 跨块级容器选区不能修改页面 DOM。

---

### Task 1: 添加内联模式配置入口

**Files:**
- Modify: `entrypoints/utils/model.ts`
- Modify: `components/Main.vue`

- [ ] **Step 1: 更新配置模型注释**

在 `entrypoints/utils/model.ts` 中，把 `selectionTranslatorMode` 注释改为包含 `inline`：

```ts
selectionTranslatorMode: string; // 划词翻译显示模式: 'disabled' | 'bilingual' | 'translation-only' | 'inline'
```

- [ ] **Step 2: 更新 popup 提示文案和选项**

在 `components/Main.vue` 中，把划词翻译 tooltip 内容和 select 选项替换为：

```vue
<el-tooltip class="box-item" effect="dark" content="选中文本后触发划词翻译。可选择关闭、双语弹窗、仅译文弹窗或内联翻译" placement="top-start" :show-after="500">
  <span class="popup-text popup-vertical-left">
    划词翻译
    <el-icon class="icon-margin">
      <ChatDotRound />
    </el-icon>
  </span>
</el-tooltip>
```

```vue
<el-select v-model="config.selectionTranslatorMode" placeholder="选择模式" size="small" style="width: 100%">
  <el-option label="关闭" value="disabled" />
  <el-option label="双语显示" value="bilingual" />
  <el-option label="只显示译文" value="translation-only" />
  <el-option label="内联翻译" value="inline" />
</el-select>
```

- [ ] **Step 3: 编译检查**

运行：

```bash
pnpm compile
```

预期：命令成功退出。

- [ ] **Step 4: 提交**

```bash
git add entrypoints/utils/model.ts components/Main.vue
git commit -m "feat: add inline selection mode option"
```

---

### Task 2: 创建内联选区 DOM helper

**Files:**
- Create: `entrypoints/utils/inlineSelectionTranslation.ts`

- [ ] **Step 1: 创建 helper 文件**

创建 `entrypoints/utils/inlineSelectionTranslation.ts`，内容如下：

```ts
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
  'PRE', 'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL',
]);

const SOURCE_ATTR = 'data-fr-inline-selection-source';
const STATUS_ATTR = 'data-fr-inline-selection-status';
const RESULT_ATTR = 'data-fr-inline-selection-result';

let sourceCounter = 0;

export interface InlineSelectionSession {
  sourceId: string;
  sourceElements: HTMLElement[];
}

interface TextFragment {
  node: Text;
  start: number;
  end: number;
}

export function canUseInlineSelection(range: Range | null): boolean {
  if (!range || range.collapsed || !range.toString().trim()) return false;
  return getSharedBlockContainer(range) !== null;
}

export function beginInlineSelectionTranslation(range: Range): InlineSelectionSession | null {
  const workingRange = range.cloneRange();
  const block = getSharedBlockContainer(workingRange);
  if (!block) return null;

  const existingSourceId = findExistingSourceId(workingRange);
  const sourceId = existingSourceId ?? `fr-inline-${Date.now()}-${sourceCounter++}`;
  const sourceElements = existingSourceId
    ? getSourceElements(sourceId)
    : markRange(workingRange, block, sourceId);

  if (!sourceElements.length) return null;

  removeStatus(sourceId);
  removeResult(sourceId);

  const loading = document.createElement('span');
  loading.className = 'fr-inline-selection-loading';
  loading.setAttribute(STATUS_ATTR, sourceId);
  loading.setAttribute('aria-label', '翻译中');
  loading.innerHTML = '<span class="fr-inline-selection-spinner"></span>';
  sourceElements[sourceElements.length - 1].insertAdjacentElement('afterend', loading);

  return { sourceId, sourceElements };
}

export function completeInlineSelectionTranslation(session: InlineSelectionSession, translatedText: string) {
  removeStatus(session.sourceId);
  removeResult(session.sourceId);

  const result = document.createElement('span');
  result.className = 'fr-inline-selection-result';
  result.setAttribute(RESULT_ATTR, session.sourceId);
  result.textContent = translatedText;

  const sourceElements = getSourceElements(session.sourceId);
  const anchor = sourceElements[sourceElements.length - 1] ?? session.sourceElements[session.sourceElements.length - 1];
  anchor?.insertAdjacentElement('afterend', result);
}

export function failInlineSelectionTranslation(session: InlineSelectionSession, message = '翻译失败') {
  removeStatus(session.sourceId);
  removeResult(session.sourceId);

  const error = document.createElement('span');
  error.className = 'fr-inline-selection-error';
  error.setAttribute(RESULT_ATTR, session.sourceId);
  error.textContent = message;

  const sourceElements = getSourceElements(session.sourceId);
  const anchor = sourceElements[sourceElements.length - 1] ?? session.sourceElements[session.sourceElements.length - 1];
  anchor?.insertAdjacentElement('afterend', error);
}

export function cleanupInlineSelectionTranslations() {
  document.querySelectorAll(`[${STATUS_ATTR}], [${RESULT_ATTR}]`).forEach((node) => node.remove());
  document.querySelectorAll<HTMLElement>(`[${SOURCE_ATTR}]`).forEach((node) => {
    node.removeAttribute(SOURCE_ATTR);
    node.classList.remove('fr-inline-selection-source');
  });
}

function markRange(range: Range, block: HTMLElement, sourceId: string): HTMLElement[] {
  const wrapper = createSourceWrapper(sourceId);

  try {
    range.surroundContents(wrapper);
    return [wrapper];
  } catch {
    const fragments = collectTextFragments(range, block);
    return fragments.map((fragment) => wrapTextFragment(fragment, sourceId)).filter(Boolean) as HTMLElement[];
  }
}

function createSourceWrapper(sourceId: string): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'fr-inline-selection-source';
  wrapper.setAttribute(SOURCE_ATTR, sourceId);
  return wrapper;
}

function wrapTextFragment(fragment: TextFragment, sourceId: string): HTMLElement | null {
  if (fragment.start >= fragment.end) return null;

  let selectedNode = fragment.node;
  if (fragment.end < selectedNode.length) {
    selectedNode.splitText(fragment.end);
  }
  if (fragment.start > 0) {
    selectedNode = selectedNode.splitText(fragment.start);
  }

  const wrapper = createSourceWrapper(sourceId);
  selectedNode.parentNode?.insertBefore(wrapper, selectedNode);
  wrapper.appendChild(selectedNode);
  return wrapper;
}

function collectTextFragments(range: Range, root: HTMLElement): TextFragment[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const fragments: TextFragment[] = [];
  let current = walker.nextNode() as Text | null;

  while (current) {
    const start = current === range.startContainer ? range.startOffset : 0;
    const end = current === range.endContainer ? range.endOffset : current.length;
    if (start < end) fragments.push({ node: current, start, end });
    current = walker.nextNode() as Text | null;
  }

  return fragments;
}

function findExistingSourceId(range: Range): string | null {
  const startSource = closestSourceElement(range.startContainer);
  const endSource = closestSourceElement(range.endContainer);
  const startId = startSource?.getAttribute(SOURCE_ATTR);
  const endId = endSource?.getAttribute(SOURCE_ATTR);
  return startId && startId === endId ? startId : null;
}

function closestSourceElement(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
  return element?.closest?.(`[${SOURCE_ATTR}]`) as HTMLElement | null;
}

function getSourceElements(sourceId: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${SOURCE_ATTR}="${sourceId}"]`));
}

function removeStatus(sourceId: string) {
  document.querySelectorAll(`[${STATUS_ATTR}="${sourceId}"]`).forEach((node) => node.remove());
}

function removeResult(sourceId: string) {
  document.querySelectorAll(`[${RESULT_ATTR}="${sourceId}"]`).forEach((node) => node.remove());
}

function getSharedBlockContainer(range: Range): HTMLElement | null {
  const startBlock = getNearestBlockContainer(range.startContainer);
  const endBlock = getNearestBlockContainer(range.endContainer);
  return startBlock && startBlock === endBlock ? startBlock : null;
}

function getNearestBlockContainer(node: Node): HTMLElement | null {
  let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element | null;

  while (element && element !== document.body && element !== document.documentElement) {
    if (isBlockContainer(element)) return element as HTMLElement;
    element = element.parentElement;
  }

  return null;
}

function isBlockContainer(element: Element): boolean {
  if (BLOCK_TAGS.has(element.tagName)) return true;

  const display = window.getComputedStyle(element).display;
  return display === 'block'
    || display === 'list-item'
    || display === 'table-cell'
    || display === 'flex'
    || display === 'grid';
}
```

- [ ] **Step 2: 编译检查**

运行：

```bash
pnpm compile
```

预期：命令成功退出。

- [ ] **Step 3: 提交**

```bash
git add entrypoints/utils/inlineSelectionTranslation.ts
git commit -m "feat: add inline selection translation helper"
```

---

### Task 3: 添加内联翻译全局样式

**Files:**
- Modify: `entrypoints/style.css`

- [ ] **Step 1: 添加原文、loading、译文和错误样式**

在 `entrypoints/style.css` 末尾追加：

```css
.fr-inline-selection-source {
    border-bottom: 2px solid #4f8cff;
    background: rgba(79, 140, 255, 0.10);
    border-radius: 2px;
}

.fr-inline-selection-loading,
.fr-inline-selection-result,
.fr-inline-selection-error {
    display: inline-flex;
    align-items: center;
    margin-left: 0.35em;
    vertical-align: baseline;
    font-size: 0.78em;
    line-height: 1.4;
}

.fr-inline-selection-loading {
    color: #667085;
}

.fr-inline-selection-spinner {
    width: 0.78em;
    height: 0.78em;
    border: 2px solid rgba(102, 112, 133, 0.35);
    border-top-color: #4f8cff;
    border-radius: 50%;
    animation: frInlineSelectionSpin 0.85s linear infinite;
}

.fr-inline-selection-result {
    color: #667085;
}

.fr-inline-selection-error {
    color: #d92d20;
}

@keyframes frInlineSelectionSpin {
    from {
        transform: rotate(0deg);
    }
    to {
        transform: rotate(360deg);
    }
}
```

- [ ] **Step 2: 编译检查**

运行：

```bash
pnpm compile
```

预期：命令成功退出。

- [ ] **Step 3: 提交**

```bash
git add entrypoints/style.css
git commit -m "style: add inline selection translation styles"
```

---

### Task 4: 在 SelectionTranslator 中接入内联模式

**Files:**
- Modify: `components/SelectionTranslator.vue`

- [ ] **Step 1: 添加 helper import**

更新 `<script setup>` 的 imports：

```ts
import {
  beginInlineSelectionTranslation,
  canUseInlineSelection,
  cleanupInlineSelectionTranslations,
  completeInlineSelectionTranslation,
  failInlineSelectionTranslation,
  type InlineSelectionSession,
} from '@/entrypoints/utils/inlineSelectionTranslation';
```

- [ ] **Step 2: 添加内联翻译状态**

在现有 refs 附近添加：

```ts
const isInlineTranslating = ref(false);
```

- [ ] **Step 3: 在 inline 模式渲染按钮**

把当前 indicator 模板块替换为：

```vue
<button
  v-if="showIndicator && config.selectionTranslatorMode === 'inline'"
  class="fr-inline-translate-button"
  :disabled="isInlineTranslating"
  title="翻译选中文本"
  @click.stop.prevent="handleInlineTranslate">
  译
</button>

<div
  v-else-if="showIndicator"
  class="fr-selection-indicator"
  @mouseenter="handleMouseEnter"
  @mouseleave="handleMouseLeave">
</div>
```

- [ ] **Step 4: 显示按钮前校验 inline 选区**

在 `handleTextSelection` 中，拿到 `const range = selection.getRangeAt(0);` 后、赋值 `selectedText`、`lastSelectedText`、`selectRange` 和 `showIndicator` 前，添加：

```ts
if (config.selectionTranslatorMode === 'inline' && !canUseInlineSelection(range)) {
  hideIndicator();
  return;
}
```

在处理 `selectedTextContent === lastSelectedText.value` 的分支中，也在 `const range = selection.getRangeAt(0);` 后添加同样校验。

- [ ] **Step 5: 添加 inline 点击处理**

在 `getTranslation` 附近添加：

```ts
const handleInlineTranslate = async () => {
  if (!selectedText.value || !selectRange.value || isInlineTranslating.value) return;

  const range = selectRange.value.cloneRange();
  if (!canUseInlineSelection(range)) {
    hideIndicator();
    return;
  }

  const session: InlineSelectionSession | null = beginInlineSelectionTranslation(range);
  if (!session) {
    hideIndicator();
    return;
  }

  showIndicator.value = false;
  showTooltip.value = false;
  isInlineTranslating.value = true;

  try {
    const result = await translateText(selectedText.value);
    completeInlineSelectionTranslation(session, result);
  } catch (err) {
    failInlineSelectionTranslation(session);
    console.error('Inline translation error:', err);
  } finally {
    isInlineTranslating.value = false;
  }
};
```

- [ ] **Step 6: 避免 inline 模式触发 tooltip 翻译**

更新 `watch(showTooltip, ...)` 分支：

```ts
watch(showTooltip, async (newValue: boolean) => {
  if (newValue && config.selectionTranslatorMode !== 'inline') {
    await getTranslation();
  } else if (!newValue && isPlaying.value) {
    stopAudio();
  }
});
```

- [ ] **Step 7: 避免页面点击错误关闭 inline 按钮**

更新点击目标判断：

```ts
const isOutsideIndicator = !target.closest('.fr-selection-indicator') && !target.closest('.fr-inline-translate-button');
const isOutsideTooltip = !target.closest('.fr-translation-tooltip');
```

- [ ] **Step 8: 添加 scoped 按钮样式**

在组件 style block 中添加：

```css
.fr-inline-translate-button {
  position: absolute;
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 14px;
  background: #1677ff;
  color: #fff;
  font-size: 14px;
  line-height: 28px;
  cursor: pointer;
  z-index: 9999;
  box-shadow: 0 4px 12px rgba(22, 119, 255, 0.28);
}

.fr-inline-translate-button:hover {
  background: #0958d9;
}

.fr-inline-translate-button:disabled {
  cursor: default;
  opacity: 0.65;
}

[data-placement="left"] .fr-inline-translate-button {
  bottom: 0;
  right: 4px;
}
[data-placement="right"] .fr-inline-translate-button {
  bottom: 0;
  left: 4px;
}
[data-placement="top-start"] .fr-inline-translate-button {
  left: 0;
  bottom: 4px;
}
[data-placement="top-end"] .fr-inline-translate-button {
  right: 0;
  bottom: 4px;
}
[data-placement="bottom-start"] .fr-inline-translate-button {
  left: 0;
  top: 4px;
}
[data-placement="bottom-end"] .fr-inline-translate-button {
  right: 0;
  top: 4px;
}
```

- [ ] **Step 9: 组件卸载时清理 helper 状态**

在 `onBeforeUnmount` 中，定时器清理之后、音频清理之前，添加：

```ts
cleanupInlineSelectionTranslations();
```

- [ ] **Step 10: 编译检查**

运行：

```bash
pnpm compile
```

预期：命令成功退出。

- [ ] **Step 11: 提交**

```bash
git add components/SelectionTranslator.vue
git commit -m "feat: integrate inline selection translation mode"
```

---

### Task 5: 浏览器手动验收

**Files:**
- 只验证；预期不修改文件。

- [ ] **Step 1: 再运行一次编译检查**

```bash
pnpm compile
```

预期：命令成功退出。

- [ ] **Step 2: 启动 WXT 开发服务器**

```bash
pnpm dev
```

预期：WXT 启动，并输出 Chromium 扩展构建信息。

- [ ] **Step 3: 验证 popup 设置**

打开扩展 popup，确认 `划词翻译` 下拉框包含：

```text
关闭
双语显示
只显示译文
内联翻译
```

- [ ] **Step 4: 验证旧模式不回归**

设置为 `双语显示`，在普通页面选择文本，hover 小红点，确认旧 tooltip 仍能翻译。

设置为 `只显示译文`，在普通页面选择文本，hover 小红点，确认旧 tooltip 只显示译文。

- [ ] **Step 5: 验证普通文本 inline 模式**

设置为 `内联翻译`，在段落中选择一个词或一句话，点击 `译`，确认：

```text
loading 立即出现在选中文本后
选中原文带有插件下划线/轻背景
译文在原位替换 loading
译文字号更小、对比度更低
```

- [ ] **Step 6: 验证跨 inline 元素选区**

使用包含以下结构的页面或本地验证页面：

```html
<p>This is <strong>important text</strong> with <a href="#">a link</a> inside one paragraph.</p>
```

从 `important` 选到 `a link`，点击 `译`，确认页面在选中文本后得到一条 inline 译文，并且链接没有被破坏。

- [ ] **Step 7: 验证跨块选区不修改 DOM**

从一个段落选到下一个段落。确认 `译` 按钮不出现。如果浏览器选区边界导致按钮出现，点击后也不能插入 loading 或译文 DOM。

- [ ] **Step 8: 验证重复翻译行为**

对同一个已标记原文翻译两次。确认第二次结果替换第一次结果，不追加重复译文。

- [ ] **Step 9: 结束验收**

如果所有检查通过，并且验收过程中没有代码改动，不需要再创建提交。如果验收暴露 bug，回到负责对应文件的任务中做聚焦修复，重新运行 `pnpm compile`，重复相关浏览器检查，并使用该任务中的提交命令。
