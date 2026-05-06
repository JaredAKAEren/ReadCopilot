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

interface SourceReuseDecision {
  valid: boolean;
  sourceId: string | null;
}

interface SelectedSourceUsage {
  sourceIds: string[];
  hasUnmarkedText: boolean;
}

export function canUseInlineSelection(range: Range | null): boolean {
  if (!range || range.collapsed || !range.toString().trim()) return false;

  const block = getInlineSelectionBlockContainer(range);
  return block !== null && getSourceReuseDecision(range, block).valid;
}

export function beginInlineSelectionTranslation(range: Range): InlineSelectionSession | null {
  if (range.collapsed || !range.toString().trim()) return null;

  const workingRange = range.cloneRange();
  const block = getInlineSelectionBlockContainer(workingRange);
  if (!block) return null;

  const reuseDecision = getSourceReuseDecision(workingRange, block);
  if (!reuseDecision.valid) return null;

  const existingSourceId = reuseDecision.sourceId;
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

  const spinner = document.createElement('span');
  spinner.className = 'fr-inline-selection-spinner';
  loading.appendChild(spinner);

  sourceElements[sourceElements.length - 1].insertAdjacentElement('afterend', loading);

  return { sourceId, sourceElements };
}

export function completeInlineSelectionTranslation(
  session: InlineSelectionSession,
  translatedText: string,
): void {
  removeStatus(session.sourceId);
  removeResult(session.sourceId);

  const result = document.createElement('span');
  result.className = 'fr-inline-selection-result';
  result.setAttribute(RESULT_ATTR, session.sourceId);
  result.textContent = translatedText;

  getSessionAnchor(session)?.insertAdjacentElement('afterend', result);
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

  getSessionAnchor(session)?.insertAdjacentElement('afterend', error);
}

export function cleanupInlineSelectionTranslations(): void {
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
    return fragments
      .map((fragment) => wrapTextFragment(fragment, sourceId))
      .filter((element): element is HTMLElement => element !== null);
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

function getSessionAnchor(session: InlineSelectionSession): HTMLElement | undefined {
  const sourceElements = getSourceElements(session.sourceId);
  return sourceElements[sourceElements.length - 1] ?? session.sourceElements[session.sourceElements.length - 1];
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

function getInlineSelectionBlockContainer(range: Range): HTMLElement | null {
  const sharedBlock = getSharedBlockContainer(range);
  if (!sharedBlock || hasSelectedDescendantBlock(range, sharedBlock)) return null;
  return sharedBlock;
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

function getSourceReuseDecision(range: Range, root: HTMLElement): SourceReuseDecision {
  const usage = getSelectedSourceUsage(range, root);

  if (!usage.sourceIds.length) {
    return { valid: true, sourceId: null };
  }

  if (usage.sourceIds.length > 1 || usage.hasUnmarkedText) {
    return { valid: false, sourceId: null };
  }

  const sourceId = usage.sourceIds[0];
  if (!isEntireSourceSelected(range, sourceId)) {
    return { valid: false, sourceId: null };
  }

  return { valid: true, sourceId };
}

function getSelectedSourceUsage(range: Range, root: HTMLElement): SelectedSourceUsage {
  const sourceIds = new Set<string>();
  let hasUnmarkedText = false;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let current = walker.nextNode() as Text | null;
  while (current) {
    const selectedText = getSelectedTextInTextNode(range, current);
    if (selectedText.trim()) {
      const sourceId = getClosestSourceId(current);

      if (sourceId) {
        sourceIds.add(sourceId);
      } else {
        hasUnmarkedText = true;
      }
    }

    current = walker.nextNode() as Text | null;
  }

  return { sourceIds: Array.from(sourceIds), hasUnmarkedText };
}

function isEntireSourceSelected(range: Range, sourceId: string): boolean {
  const sourceElements = getSourceElements(sourceId);
  if (!sourceElements.length) return false;

  return sourceElements.every((source) => {
    const sourceRange = document.createRange();
    sourceRange.selectNodeContents(source);

    const startsBeforeOrAtSource = range.compareBoundaryPoints(Range.START_TO_START, sourceRange) <= 0;
    const endsAfterOrAtSource = range.compareBoundaryPoints(Range.END_TO_END, sourceRange) >= 0;

    sourceRange.detach();
    return startsBeforeOrAtSource && endsAfterOrAtSource;
  });
}

function getClosestSourceId(node: Node): string | null {
  const element = node.nodeType === Node.TEXT_NODE
    ? node.parentElement
    : node instanceof Element
      ? node
      : null;
  const source = element?.closest<HTMLElement>(`[${SOURCE_ATTR}]`);
  return source?.getAttribute(SOURCE_ATTR) ?? null;
}

function getSelectedTextInTextNode(range: Range, textNode: Text): string {
  const start = textNode === range.startContainer ? range.startOffset : 0;
  const end = textNode === range.endContainer ? range.endOffset : textNode.length;
  return start < end ? textNode.data.slice(start, end) : '';
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
