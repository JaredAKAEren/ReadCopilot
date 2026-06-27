// 仅在目标语为中文时启用单词词典模式；其他目标语种走 sentence 模式。
const CHINESE_HAN_RE = /\p{Script=Han}/u;
const TRANSLATABLE_TEXT_RE = /[\p{L}\p{N}]/u;

export function isAllNonChineseSelectionText(raw: string): boolean {
  const text = raw.trim();
  return !!text && !CHINESE_HAN_RE.test(text) && TRANSLATABLE_TEXT_RE.test(text);
}

export function looksLikeWord(raw: string, targetLang: string): boolean {
  if (targetLang !== 'zh-Hans') return false;
  const text = raw.trim();
  if (!text || text.length > 30) return false;
  if (/[.!?。！？\n\r]/.test(text)) return false;
  if (!/^[A-Za-z][A-Za-z'\-\s]*$/.test(text)) return false; // 字母 + 撇号 + 连字符 + 空格
  if (text.split(/\s+/).length > 4) return false;            // ≤4 token，覆盖 phrasal verb
  return true;
}

interface RangeOffsets {
  startIdx: number;
  endIdx: number;
}

// 用 TreeWalker 遍历 block 文本节点，累计字符 offset，定位 range 起止在 block.textContent 中的位置。
function computeRangeOffsetsInText(range: Range, block: HTMLElement): RangeOffsets {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let startIdx = 0;
  let endIdx = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (node === range.startContainer) startIdx = cursor + range.startOffset;
    if (node === range.endContainer) endIdx = cursor + range.endOffset;
    cursor += len;
    node = walker.nextNode() as Text | null;
  }
  return { startIdx, endIdx };
}

// 从 range 起止向左右各扫到最近的句末标点或 block 边界，截取 trim 后返回。
// 长度兜底：> 600 字符截断到 600。
export function extractSentence(range: Range, block: HTMLElement): string {
  const fullText = block.textContent ?? '';
  if (!fullText) return '';

  const { startIdx, endIdx } = computeRangeOffsetsInText(range, block);
  const SENT_END = /[.!?。！？\n]/;

  let left = startIdx;
  while (left > 0 && !SENT_END.test(fullText[left - 1])) left--;
  let right = endIdx;
  while (right < fullText.length && !SENT_END.test(fullText[right])) right++;

  let sentence = fullText.slice(left, Math.min(right + 1, fullText.length)).trim();
  if (sentence.length > 600) sentence = sentence.slice(0, 600);
  return sentence;
}
