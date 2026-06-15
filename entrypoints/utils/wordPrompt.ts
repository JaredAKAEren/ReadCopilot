import { contentPostHandler } from './check';

// 词典浮窗渲染所需的结构化数据。translation 必填；其余字段缺失则对应区段 v-if 隐藏。
export interface WordPayload {
  translation: string;
  ipa?: string;
  definitions?: Array<{ pos: string; meaning: string }>;
  contextualMeaning?: string;
}

export const WORD_SYSTEM_PROMPT = `You are a bilingual dictionary assistant for English→Chinese learners.
For the given English word/phrase/term plus its sentence context, return ONLY a JSON object matching the schema below. No prose, no markdown fences.

Schema:
{
  "translation": string,        // 中文主译；专有名词/术语保留原名或音译
  "ipa": string,                // 美式音标，例 "/kənˈstreɪnt/"
  "definitions": [              // 多义释义（中文），按常见度排序
    { "pos": string, "meaning": string }
  ],
  "contextualMeaning": string   // 在给定语境下的含义（中文）
}

Rules:
- Always return Chinese explanations even for proper nouns, acronyms, or technical terms (NEVER refuse with "no translation needed").
- For terms (e.g. "OAuth", "Kubernetes"): keep original in "translation" if no common Chinese name; explain in "definitions" and "contextualMeaning".
- Output strictly valid JSON; do not wrap in code fences.`;

export function buildWordUserPrompt(word: string, sentence: string): string {
  return `Word: ${word}\nSentence: ${sentence || '(no context provided)'}\nReturn JSON only.`;
}

// 解析模型响应。剥离 markdown fence；校验 translation 非空；其余字段类型容错。
export function parseWordResponse(raw: string): WordPayload | null {
  try {
    const cleaned = contentPostHandler(raw).trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    const obj = JSON.parse(cleaned);
    if (typeof obj?.translation !== 'string' || !obj.translation.trim()) return null;
    return {
      translation: obj.translation.trim(),
      ipa: typeof obj.ipa === 'string' ? obj.ipa : undefined,
      definitions: Array.isArray(obj.definitions)
        ? obj.definitions
            .filter((d: any) => d && typeof d === 'object' && d.pos && d.meaning)
            .map((d: any) => ({ pos: String(d.pos), meaning: String(d.meaning) }))
        : undefined,
      contextualMeaning: typeof obj.contextualMeaning === 'string' ? obj.contextualMeaning : undefined,
    };
  } catch {
    return null;
  }
}

export function isValidWordPayload(v: unknown): v is WordPayload {
  return typeof v === 'object' && v !== null
    && typeof (v as WordPayload).translation === 'string'
    && (v as WordPayload).translation.trim() !== '';
}

export function hasRichWordPayload(payload: WordPayload): boolean {
  return !!(
    payload.ipa
    || payload.contextualMeaning
    || (payload.definitions?.length ?? 0) > 0
  );
}

// 集中 LLM 服务的响应分流。word 模式：parse JSON，失败软降级为纯文本译文（无词典数据）。
// sentence 模式：保持原 contentPostHandler 行为。
export function interpretLLMContent(content: string, mode?: 'word' | 'sentence'): string | WordPayload {
  if (mode === 'word') {
    const payload = parseWordResponse(content);
    if (payload) return payload;
    return { translation: contentPostHandler(content) };
  }
  return contentPostHandler(content);
}
