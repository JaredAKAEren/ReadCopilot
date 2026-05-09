import { looksLikeWord, extractSentence } from './wordHeuristic';
import type { WordPayload } from './wordPrompt';
import { config } from './config';

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
  'PRE', 'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL',
]);

const SOURCE_ATTR = 'data-fr-inline-selection-source';
const STATUS_ATTR = 'data-fr-inline-selection-status';
const RESULT_ATTR = 'data-fr-inline-selection-result';
const TIER_ATTR = 'data-fr-inline-selection-tier';

let sourceCounter = 0;

export interface InlineSelectionSession {
  sourceId: string;
  tier: 'word' | 'outer';
  mode: 'word' | 'sentence';
  sentence?: string;
  sourceElements: HTMLElement[];
  resultAnchor: HTMLElement;
  payload?: WordPayload;
}

interface TextFragment {
  node: Text;
  start: number;
  end: number;
}

// ─── Overlap / anchor utilities ───────────────────────────────────────────────

function isFullyInsideRange(el: HTMLElement, range: Range): boolean {
  const elRange = document.createRange();
  elRange.selectNodeContents(el);
  const startsAfter = range.compareBoundaryPoints(Range.START_TO_START, elRange) <= 0;
  const endsBefore = range.compareBoundaryPoints(Range.END_TO_END, elRange) >= 0;
  elRange.detach();
  return startsAfter && endsBefore;
}

function partiallyOverlapsRange(el: HTMLElement, range: Range): boolean {
  const elRange = document.createRange();
  elRange.selectNodeContents(el);
  const startsBefore = range.compareBoundaryPoints(Range.START_TO_START, elRange) < 0;
  const endsAfter = range.compareBoundaryPoints(Range.END_TO_END, elRange) > 0;
  const intersects = range.intersectsNode(el);
  elRange.detach();
  return intersects && (startsBefore || endsAfter) && !isFullyInsideRange(el, range);
}

function isRangeFullyInsideElement(range: Range, el: HTMLElement): boolean {
  const elRange = document.createRange();
  elRange.selectNodeContents(el);
  const startsAfter = range.compareBoundaryPoints(Range.START_TO_START, elRange) >= 0;
  const endsBefore = range.compareBoundaryPoints(Range.END_TO_END, elRange) <= 0;
  elRange.detach();
  return startsAfter && endsBefore;
}

function computeResultAnchor(range: Range, block: HTMLElement): HTMLElement | null {
  const all = Array.from(block.querySelectorAll<HTMLElement>(`[${SOURCE_ATTR}]`));
  const inside = all.filter((el) => isFullyInsideRange(el, range));
  return inside[inside.length - 1] ?? null;
}

// ─── Reuse decision ───────────────────────────────────────────────────────────

type ReuseDecision =
  | { kind: 'fresh' }                           // 新建 session
  | { kind: 'reuse'; sourceId: string }         // 完全等同：重译并替换
  | { kind: 'cover'; idsToRemove: string[] }    // 覆盖：移除指定 outer source 后新建
  | { kind: 'reject' };                         // 拒绝

function getSourceReuseDecision(range: Range, block: HTMLElement, newTier: 'word' | 'outer'): ReuseDecision {
  const allSources = Array.from(block.querySelectorAll<HTMLElement>(`[${SOURCE_ATTR}]`));

  // 1. 越界检查：任何 source 与 range 部分重叠且越界 → 拒绝
  for (const src of allSources) {
    if (partiallyOverlapsRange(src, range)) return { kind: 'reject' };
  }

  // 2. 完全等同：range 边界正好等于某个 source 边界 → 重译
  const sourceIdGroups = new Map<string, HTMLElement[]>();
  for (const src of allSources) {
    const id = src.getAttribute(SOURCE_ATTR) ?? '';
    if (!sourceIdGroups.has(id)) sourceIdGroups.set(id, []);
    sourceIdGroups.get(id)!.push(src);
  }
  for (const [id, group] of sourceIdGroups) {
    const allInside = group.every((el) => isFullyInsideRange(el, range));
    if (!allInside) continue;
    const rangeText = range.toString().trim();
    const groupText = group.map((el) => el.textContent ?? '').join('').trim();
    if (rangeText === groupText) return { kind: 'reuse', sourceId: id };
  }

  // 2.5. 防御：range 完全落在某个已有 source 内部（且不等于它，因为相等已在 step 2 处理）→ 拒绝
  for (const src of allSources) {
    if (isRangeFullyInsideElement(range, src)) return { kind: 'reject' };
  }

  // 3. 覆盖/绕开：完全落在 range 内的 source
  const containedSources = allSources.filter((el) => isFullyInsideRange(el, range));
  if (newTier === 'word') {
    if (containedSources.length > 0) return { kind: 'reject' };
    return { kind: 'fresh' };
  }
  // newTier === 'outer'：移除其中 tier === 'outer' 的，保留 word
  const idsToRemove = Array.from(new Set(
    containedSources
      .filter((el) => el.getAttribute(TIER_ATTR) === 'outer')
      .map((el) => el.getAttribute(SOURCE_ATTR) ?? '')
      .filter(Boolean)
  ));
  return { kind: 'cover', idsToRemove };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function canUseInlineSelection(range: Range | null): boolean {
  if (!range || range.collapsed || !range.toString().trim()) return false;
  const block = getSharedBlockContainer(range);
  if (!block) return false;
  if (hasSelectedDescendantBlock(range, block)) return false;
  const newTier: 'word' | 'outer' = looksLikeWord(range.toString(), config.to) ? 'word' : 'outer';
  const decision = getSourceReuseDecision(range, block, newTier);
  return decision.kind !== 'reject';
}

export function beginInlineSelectionTranslation(range: Range): InlineSelectionSession | null {
  if (range.collapsed || !range.toString().trim()) return null;

  const workingRange = range.cloneRange();
  const block = getSharedBlockContainer(workingRange);
  if (!block) return null;
  if (hasSelectedDescendantBlock(workingRange, block)) return null;

  const text = workingRange.toString();
  const tier: 'word' | 'outer' = looksLikeWord(text, config.to) ? 'word' : 'outer';
  const mode: 'word' | 'sentence' = tier === 'word' ? 'word' : 'sentence';
  const sentence = mode === 'word' ? extractSentence(workingRange, block) : undefined;

  const decision = getSourceReuseDecision(workingRange, block, tier);
  if (decision.kind === 'reject') return null;

  let sourceId: string;
  let sourceElements: HTMLElement[];

  if (decision.kind === 'reuse') {
    sourceId = decision.sourceId;
    sourceElements = getSourceElements(sourceId);
  } else {
    if (decision.kind === 'cover') {
      for (const id of decision.idsToRemove) removeSource(id);
    }
    sourceId = `fr-inline-${Date.now()}-${sourceCounter++}`;
    sourceElements = markRange(workingRange, block, sourceId, tier);
  }

  if (!sourceElements.length) return null;

  removeStatus(sourceId);
  removeResult(sourceId);

  // result anchor：新选区内所有 source（任 tier）按文档序最末
  const anchor = computeResultAnchor(workingRange, block) ?? sourceElements[sourceElements.length - 1];

  // loading span 紧跟 anchor
  const loading = document.createElement('span');
  loading.className = 'fr-inline-selection-loading';
  loading.setAttribute(STATUS_ATTR, sourceId);
  loading.setAttribute('aria-label', '翻译中');
  const spinner = document.createElement('span');
  spinner.className = 'fr-inline-selection-spinner';
  loading.appendChild(spinner);
  anchor.insertAdjacentElement('afterend', loading);

  return { sourceId, tier, mode, sentence, sourceElements, resultAnchor: anchor };
}

export function completeInlineSelectionTranslation(
  session: InlineSelectionSession,
  translatedText: string,
  payload?: WordPayload,
): void {
  removeStatus(session.sourceId);
  removeResult(session.sourceId);

  const result = document.createElement('span');
  result.className = 'fr-inline-selection-result';
  result.setAttribute(RESULT_ATTR, session.sourceId);

  const sourceText = session.sourceElements.map((el) => el.textContent ?? '').join('').trim();
  const showText = !(payload && payload.translation === sourceText);
  if (showText) {
    result.textContent = translatedText;
  } else {
    result.classList.add('is-empty');
  }

  // word 模式且有 payload 时，append icon SVG（hover 浮 popover）
  if (session.mode === 'word' && payload) {
    session.payload = payload;
    const icon = createIconElement();
    result.appendChild(icon);
    attachIconHover(icon, session, payload);
  }

  session.resultAnchor.insertAdjacentElement('afterend', result);
}

export function failInlineSelectionTranslation(
  session: InlineSelectionSession,
  message = '翻译失败',
): void {
  removeStatus(session.sourceId);
  removeResult(session.sourceId);

  const error = document.createElement('span');
  error.className = 'fr-inline-selection-error';
  error.setAttribute(RESULT_ATTR, session.sourceId);
  error.textContent = message;

  session.resultAnchor.insertAdjacentElement('afterend', error);
}

export function cleanupInlineSelectionTranslations(): void {
  unmountWordPopover();
  document.querySelectorAll(`[${STATUS_ATTR}], [${RESULT_ATTR}]`).forEach((node) => node.remove());
  document.querySelectorAll<HTMLElement>(`[${SOURCE_ATTR}]`).forEach((node) => {
    node.removeAttribute(SOURCE_ATTR);
    node.removeAttribute(TIER_ATTR);
    node.classList.remove('fr-inline-selection-source');
    node.classList.remove('fr-source-active');
  });
}

// ─── Placeholders (Task 9-10 will implement) ──────────────────────────────────

function createIconElement(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'fr-inline-selection-icon';
  // Task 10 step 5 填入 SVG 内容；此处先空壳。
  return span;
}

function attachIconHover(_icon: HTMLElement, _session: InlineSelectionSession, _payload: WordPayload): void {
  // Task 10 step 4 实现 hover → mountWordPopover；此处占位。
}

function unmountWordPopover(): void {
  // Task 10 实现。
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function removeSource(sourceId: string): void {
  const sources = getSourceElements(sourceId);
  for (const src of sources) {
    const parent = src.parentNode;
    if (!parent) continue;
    while (src.firstChild) parent.insertBefore(src.firstChild, src);
    parent.removeChild(src);
  }
  removeStatus(sourceId);
  removeResult(sourceId);
}

function markRange(range: Range, block: HTMLElement, sourceId: string, tier: 'word' | 'outer'): HTMLElement[] {
  const wrapper = createSourceWrapper(sourceId, tier);

  try {
    range.surroundContents(wrapper);
    return [wrapper];
  } catch {
    const fragments = collectTextFragments(range, block);
    return fragments
      .map((fragment) => wrapTextFragment(fragment, sourceId, tier))
      .filter((element): element is HTMLElement => element !== null);
  }
}

function createSourceWrapper(sourceId: string, tier: 'word' | 'outer'): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'fr-inline-selection-source';
  wrapper.setAttribute(SOURCE_ATTR, sourceId);
  wrapper.setAttribute(TIER_ATTR, tier);
  return wrapper;
}

function wrapTextFragment(fragment: TextFragment, sourceId: string, tier: 'word' | 'outer'): HTMLElement | null {
  if (fragment.start >= fragment.end) return null;

  let selectedNode = fragment.node;
  if (fragment.end < selectedNode.length) {
    selectedNode.splitText(fragment.end);
  }
  if (fragment.start > 0) {
    selectedNode = selectedNode.splitText(fragment.start);
  }

  const wrapper = createSourceWrapper(sourceId, tier);
  selectedNode.parentNode?.insertBefore(wrapper, selectedNode);
  wrapper.appendChild(selectedNode);
  return wrapper;
}

function collectTextFragments(range: Range, root: HTMLElement): TextFragment[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      // 已被标记为某个 source 内部的文本节点 → 跳过，新建 source 自动绕开
      const parentEl = node.parentElement;
      if (parentEl?.closest(`[${SOURCE_ATTR}]`)) return NodeFilter.FILTER_REJECT;
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const fragments: TextFragment[] = [];
  let current = walker.nextNode() as Text | null;

  while (current) {
    const start = current === range.startContainer ? range.startOffset : 0;
    const end = current === range.endContainer ? range.endOffset : current.length;

    if (start < end) {
      fragments.push({ node: current, start, end });
    }

    current = walker.nextNode() as Text | null;
  }

  return fragments;
}

function getSourceElements(sourceId: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${SOURCE_ATTR}]`))
    .filter((node) => node.getAttribute(SOURCE_ATTR) === sourceId);
}

function removeStatus(sourceId: string): void {
  document.querySelectorAll(`[${STATUS_ATTR}]`).forEach((node) => {
    if (node instanceof Element && node.getAttribute(STATUS_ATTR) === sourceId) {
      node.remove();
    }
  });
}

function removeResult(sourceId: string): void {
  document.querySelectorAll(`[${RESULT_ATTR}]`).forEach((node) => {
    if (node instanceof Element && node.getAttribute(RESULT_ATTR) === sourceId) {
      node.remove();
    }
  });
}

function getSharedBlockContainer(range: Range): HTMLElement | null {
  const startBlock = getNearestBlockContainer(range.startContainer);
  const endBlock = getNearestBlockContainer(range.endContainer);
  return startBlock && startBlock === endBlock ? startBlock : null;
}

function hasSelectedDescendantBlock(range: Range, root: HTMLElement): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (!(node instanceof Element) || !isBlockContainer(node)) {
        return NodeFilter.FILTER_SKIP;
      }

      if (!range.intersectsNode(node)) {
        return NodeFilter.FILTER_SKIP;
      }

      return hasMeaningfulSelectedText(range, node)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  return walker.nextNode() !== null;
}

function hasMeaningfulSelectedText(range: Range, root: Element): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let current = walker.nextNode() as Text | null;
  while (current) {
    const start = current === range.startContainer ? range.startOffset : 0;
    const end = current === range.endContainer ? range.endOffset : current.length;

    if (start < end && current.data.slice(start, end).trim()) {
      return true;
    }

    current = walker.nextNode() as Text | null;
  }

  return false;
}

function getNearestBlockContainer(node: Node): HTMLElement | null {
  let element = node.nodeType === Node.TEXT_NODE
    ? node.parentElement
    : node instanceof Element
      ? node
      : null;

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
