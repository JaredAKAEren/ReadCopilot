# 内联划词翻译 v2 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 [v2 设计](../specs/2026-05-08-inline-selection-translation-v2-design.md) 给现有 inline 划词翻译加三项能力：① 重叠选区可触发并保留内层翻译；② 单词翻译携带句子语境，返回结构化词典数据并以 hover popover 展示；③ 术语兜底，prompt 强制要求中文释义，译文等于原文时不重复渲染、仅留 icon。

**Architecture:** 单路径 mode-aware 协议 —— `translateText` 增加 `mode='word'` / `sentence` 两参数；4 个 LLM 模板（commonMsgTemplate / claudeMsgTemplate / geminiMsgTemplate / deepseekMsgTemplate）与 10 个 service handler 按 mode 切 prompt 与响应解析。Source 数据模型升级为 `tier='word'|'outer'` 二级，最多两层嵌套。新建 `WordExplainPopover.vue` 用 `@floating-ui/dom` 浮在 icon 右上方。

**Tech Stack:** WXT + Vue 3 `<script setup>` + TypeScript；@floating-ui/dom（已装）；Element Plus（已装，用 ElMessage）；现有 `translateText` / cache / queue / 翻译服务链路；content script 全局 CSS。

---

## 文件结构

新建：

- `entrypoints/utils/messageTypes.ts` — `TranslateMessage` 接口（消息契约）。
- `entrypoints/utils/wordHeuristic.ts` — `looksLikeWord(raw, targetLang)`、`extractSentence(range, block)`（纯函数）。
- `entrypoints/utils/wordPrompt.ts` — `WordPayload` / `WORD_SYSTEM_PROMPT` / `buildWordUserPrompt` / `parseWordResponse` / `isValidWordPayload` / `interpretLLMContent`。
- `components/WordExplainPopover.vue` — hover 词典浮窗组件（contextual 置顶布局）。

修改：

- `entrypoints/utils/template.ts` — 4 个 LLM 模板签名 `(origin: string)` → `(message: TranslateMessage)`，并在 word 模式下分流到 word prompt。
- `entrypoints/service/{common, claude, gemini, deepseek, azure-openai, custom, grok, infini, newapi, zhipu}.ts` — 10 个 LLM 服务文件：调用站点 `(message.origin)` → `(message)`；响应处理 `contentPostHandler` → `interpretLLMContent`。
- `entrypoints/utils/translateApi.ts` — 新增 `mode` / `sentence` 选项，TypeScript 函数重载，cache key 按 mode 拼前缀，word 值 JSON 序列化。
- `entrypoints/utils/inlineSelectionTranslation.ts` — `InlineSelectionSession` 增 `tier` / `mode` / `sentence` / `resultAnchor` / `payload` 字段；`getSourceReuseDecision` 重写；新增 `computeResultAnchor` / `mountWordPopover` / `unmountWordPopover`；hover 监听挂在 icon SVG。
- `components/SelectionTranslator.vue` — `handleInlineTranslate` 调 `looksLikeWord` 决定 tier、抽取 sentence、传 mode 给 `translateText`、按返回类型决定是否传 payload。
- `components/Main.vue` — 内联翻译选项 `:disabled` 接 `servicesType.isAI(config.service)`；服务切换 watch 在 inline + 非 LLM 时回退 bilingual + ElMessage。
- `entrypoints/style.css` — `.fr-inline-selection-icon`、`.fr-inline-selection-result.is-empty`、`.fr-inline-selection-source.fr-source-active` 等全局样式。

不修改：`entrypoints/background.ts`（`_service[config.service](message)` 已经透传整 message）；`entrypoints/utils/cache.ts`；全文翻译 `entrypoints/main/trans.ts`；非 LLM 服务模板与 handler。

## 测试与验证约定

仓库无测试框架（CLAUDE.md 已声明）。每个 task 的验证方式为：

- **`pnpm compile`** — `vue-tsc --noEmit`，类型必须通过。
- **`pnpm dev`** — Chromium 开发模式下手动验证（最后一个 task 集中跑）。

每个 task 的 commit 都使用中文 Conventional Commits（`feat:` / `refactor:` / `docs:` / `style:`），祈使句，**不带 `Co-Authored-By` 标签**（按 CLAUDE.md 与 commit message 约定）。

---

### Task 1: 消息类型契约

**Files:**
- Create: `entrypoints/utils/messageTypes.ts`

- [ ] **Step 1: 创建消息类型文件**

写入 `entrypoints/utils/messageTypes.ts`：

```ts
// background <-> content script 间的翻译请求消息契约。
// sentence 模式（默认）行为与现状一致；word 模式新增 sentence 字段作 prompt context。
export interface TranslateMessage {
  context: string;
  origin: string;
  mode?: 'word' | 'sentence';
  sentence?: string;
}
```

- [ ] **Step 2: 编译检查**

```bash
pnpm compile
```

预期：通过。

- [ ] **Step 3: 提交**

```bash
git add entrypoints/utils/messageTypes.ts
git commit -m "feat: 新增翻译请求消息类型 TranslateMessage"
```

---

### Task 2: word 启发式判定 helper

**Files:**
- Create: `entrypoints/utils/wordHeuristic.ts`

- [ ] **Step 1: 创建 helper 文件**

写入 `entrypoints/utils/wordHeuristic.ts`：

```ts
// 仅在目标语为中文时启用单词词典模式；其他目标语种走 sentence 模式。
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
```

- [ ] **Step 2: 编译检查**

```bash
pnpm compile
```

预期：通过。

- [ ] **Step 3: 提交**

```bash
git add entrypoints/utils/wordHeuristic.ts
git commit -m "feat: 新增单词判定与句子抽取启发式 helper"
```

---

### Task 3: word prompt + 响应解析 helper

**Files:**
- Create: `entrypoints/utils/wordPrompt.ts`

- [ ] **Step 1: 创建 helper 文件**

写入 `entrypoints/utils/wordPrompt.ts`：

```ts
import { contentPostHandler } from './check';

// 词典浮窗渲染所需的结构化数据。translation 必填；其余字段缺失则对应区段 v-if 隐藏。
export interface WordPayload {
  translation: string;
  ipa?: string;
  pronunciation?: string;
  definitions?: Array<{ pos: string; meaning: string }>;
  contextualMeaning?: string;
}

export const WORD_SYSTEM_PROMPT = `You are a bilingual dictionary assistant for English→Chinese learners.
For the given English word/phrase/term plus its sentence context, return ONLY a JSON object matching the schema below. No prose, no markdown fences.

Schema:
{
  "translation": string,        // 中文主译；专有名词/术语保留原名或音译
  "ipa": string,                // 美式音标，例 "/kənˈstreɪnt/"
  "pronunciation": string,      // 英文常见词类比的发音指导，例 "kuhn-STRAYNT (like 'plain')"
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
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    const obj = JSON.parse(cleaned);
    if (typeof obj?.translation !== 'string' || !obj.translation.trim()) return null;
    return {
      translation: obj.translation.trim(),
      ipa: typeof obj.ipa === 'string' ? obj.ipa : undefined,
      pronunciation: typeof obj.pronunciation === 'string' ? obj.pronunciation : undefined,
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
```

- [ ] **Step 2: 编译检查**

```bash
pnpm compile
```

预期：通过。

- [ ] **Step 3: 提交**

```bash
git add entrypoints/utils/wordPrompt.ts
git commit -m "feat: 新增 word prompt 与 LLM 响应解析 helper"
```

---

### Task 4: LLM 模板签名改造 + 调用站点更新

把 4 个 LLM 模板的入参从 `origin: string` 改为 `message: TranslateMessage`，并把 10 个 service caller 从 `xxxMsgTemplate(message.origin)` 改为 `xxxMsgTemplate(message)`。本 task 不引入 word 模式；仅改签名，sentence 模式行为完全保持。

**Files:**
- Modify: `entrypoints/utils/template.ts`
- Modify: `entrypoints/service/common.ts`
- Modify: `entrypoints/service/claude.ts`
- Modify: `entrypoints/service/gemini.ts`
- Modify: `entrypoints/service/deepseek.ts`
- Modify: `entrypoints/service/azure-openai.ts`
- Modify: `entrypoints/service/custom.ts`
- Modify: `entrypoints/service/grok.ts`
- Modify: `entrypoints/service/infini.ts`
- Modify: `entrypoints/service/newapi.ts`
- Modify: `entrypoints/service/zhipu.ts`

- [ ] **Step 1: 改造 commonMsgTemplate**

`entrypoints/utils/template.ts` 顶部增加 import：

```ts
import { TranslateMessage } from "./messageTypes";
```

把 `commonMsgTemplate(origin: string)` 改为 `commonMsgTemplate(message: TranslateMessage)`，函数体里 `origin` 替换成 `message.origin`：

```ts
// openai 格式的消息模板（通用模板）
export function commonMsgTemplate(message: TranslateMessage) {
    // 检测是否使用自定义模型
    let model = config.model[config.service] === customModelString ? config.customModel[config.service] : config.model[config.service]

    // 删除模型名称中的中文括号及其内容，如"gpt-4（推荐）" -> "gpt-4"
    model = model.replace(/（.*）/g, "");

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    return JSON.stringify({
        'model': model,
        "temperature": 1.0,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ]
    })
}
```

- [ ] **Step 2: 改造 deepseekMsgTemplate**

同样把 `(origin: string)` 改成 `(message: TranslateMessage)`，函数体内 `origin` 替换为 `message.origin`：

```ts
export function deepseekMsgTemplate(message: TranslateMessage) {
    let model = config.model[config.service] === customModelString ? config.customModel[config.service] : config.model[config.service]
    model = model.replace(/（.*）/g, "");

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    const payload: any = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ]
    };

    if (model !== 'deepseek-reasoner') {
        payload.temperature = 0.7;
    }

    return JSON.stringify(payload);
}
```

- [ ] **Step 3: 改造 geminiMsgTemplate**

```ts
export function geminiMsgTemplate(message: TranslateMessage) {
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    return JSON.stringify({
        "contents": [
            {"role": "user", "parts": [{"text": user}]},
        ]
    })
}
```

- [ ] **Step 4: 改造 claudeMsgTemplate**

```ts
export function claudeMsgTemplate(message: TranslateMessage) {
    let model = config.model[services.claude];
    if (model === "claude-3-5-haiku") model = "claude-3-5-haiku-20241022";
    else if (model === "claude-3-5-sonnet") model = "claude-3-5-sonnet-20241022";
    else if (model === "claude-3-opus") model = "claude-3-opus-20240229";

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    return JSON.stringify({
        model: model,
        max_tokens: 4096,
        stream: false,
        system: system,
        messages: [
            {role: "user", content: user},
        ]
    })
}
```

- [ ] **Step 5: 更新所有调用站点**

依次把下列 10 个文件中 `xxxMsgTemplate(message.origin)` 改成 `xxxMsgTemplate(message)`。每处只改 body 行，不动其它内容。

`entrypoints/service/common.ts:25` —— `body: commonMsgTemplate(message)`

`entrypoints/service/claude.ts:20` —— `body: claudeMsgTemplate(message)`

`entrypoints/service/gemini.ts:18` —— `body: geminiMsgTemplate(message)`

`entrypoints/service/deepseek.ts:18` —— `body: deepseekMsgTemplate(message)`

`entrypoints/service/azure-openai.ts:32` —— `body: commonMsgTemplate(message)`

`entrypoints/service/custom.ts:16` —— `body: commonMsgTemplate(message)`

`entrypoints/service/grok.ts:23` —— `body: commonMsgTemplate(message)`

`entrypoints/service/infini.ts:19` —— `body: commonMsgTemplate(message)`

`entrypoints/service/newapi.ts:33` —— `body: commonMsgTemplate(message)`（同文件可能还有 deepseekMsgTemplate 调用，一并改成 `(message)`）

`entrypoints/service/zhipu.ts:31` —— `body: commonMsgTemplate(message)`

- [ ] **Step 6: 编译检查**

```bash
pnpm compile
```

预期：通过。如有 caller 漏改，编译会报 `Argument of type 'string' is not assignable to parameter of type 'TranslateMessage'`。

- [ ] **Step 7: 提交**

```bash
git add entrypoints/utils/template.ts entrypoints/service/
git commit -m "refactor: LLM 模板签名改为接收 TranslateMessage 整体"
```

---

### Task 5: word 模式 prompt 分流 + 服务响应解析

在 4 个 LLM 模板里检测 `message.mode === 'word'` 并切到 word prompt；10 个 service handler 把 `contentPostHandler(content)` 替换成 `interpretLLMContent(content, message.mode)`。

**Files:**
- Modify: `entrypoints/utils/template.ts`
- Modify: `entrypoints/service/common.ts`
- Modify: `entrypoints/service/claude.ts`
- Modify: `entrypoints/service/gemini.ts`
- Modify: `entrypoints/service/deepseek.ts`
- Modify: `entrypoints/service/azure-openai.ts`
- Modify: `entrypoints/service/custom.ts`
- Modify: `entrypoints/service/grok.ts`
- Modify: `entrypoints/service/infini.ts`
- Modify: `entrypoints/service/newapi.ts`
- Modify: `entrypoints/service/zhipu.ts`

- [ ] **Step 1: 在 template.ts 顶部 import word prompt helper**

```ts
import { WORD_SYSTEM_PROMPT, buildWordUserPrompt } from "./wordPrompt";
```

- [ ] **Step 2: commonMsgTemplate 增加 word 分流**

替换 commonMsgTemplate 函数体为：

```ts
export function commonMsgTemplate(message: TranslateMessage) {
    let model = config.model[config.service] === customModelString ? config.customModel[config.service] : config.model[config.service]
    model = model.replace(/（.*）/g, "");

    if (message.mode === 'word') {
        return JSON.stringify({
            'model': model,
            'temperature': 0.3,
            'messages': [
                {'role': 'system', 'content': WORD_SYSTEM_PROMPT},
                {'role': 'user', 'content': buildWordUserPrompt(message.origin, message.sentence ?? '')},
            ]
        })
    }

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    return JSON.stringify({
        'model': model,
        "temperature": 1.0,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ]
    })
}
```

- [ ] **Step 3: deepseekMsgTemplate 增加 word 分流**

```ts
export function deepseekMsgTemplate(message: TranslateMessage) {
    let model = config.model[config.service] === customModelString ? config.customModel[config.service] : config.model[config.service]
    model = model.replace(/（.*）/g, "");

    if (message.mode === 'word') {
        const payload: any = {
            'model': model,
            'messages': [
                {'role': 'system', 'content': WORD_SYSTEM_PROMPT},
                {'role': 'user', 'content': buildWordUserPrompt(message.origin, message.sentence ?? '')},
            ]
        };
        if (model !== 'deepseek-reasoner') payload.temperature = 0.3;
        return JSON.stringify(payload);
    }

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    const payload: any = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ]
    };

    if (model !== 'deepseek-reasoner') {
        payload.temperature = 0.7;
    }

    return JSON.stringify(payload);
}
```

- [ ] **Step 4: geminiMsgTemplate 增加 word 分流（开启 JSON 模式）**

```ts
export function geminiMsgTemplate(message: TranslateMessage) {
    if (message.mode === 'word') {
        const userPrompt = `${WORD_SYSTEM_PROMPT}\n\n${buildWordUserPrompt(message.origin, message.sentence ?? '')}`;
        return JSON.stringify({
            "contents": [
                {"role": "user", "parts": [{"text": userPrompt}]},
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": 0.3,
            }
        })
    }

    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    return JSON.stringify({
        "contents": [
            {"role": "user", "parts": [{"text": user}]},
        ]
    })
}
```

- [ ] **Step 5: claudeMsgTemplate 增加 word 分流（user prompt 末尾追加 JSON 强约束）**

```ts
export function claudeMsgTemplate(message: TranslateMessage) {
    let model = config.model[services.claude];
    if (model === "claude-3-5-haiku") model = "claude-3-5-haiku-20241022";
    else if (model === "claude-3-5-sonnet") model = "claude-3-5-sonnet-20241022";
    else if (model === "claude-3-opus") model = "claude-3-opus-20240229";

    if (message.mode === 'word') {
        return JSON.stringify({
            model: model,
            max_tokens: 4096,
            stream: false,
            temperature: 0.3,
            system: WORD_SYSTEM_PROMPT,
            messages: [
                {role: "user", content: `${buildWordUserPrompt(message.origin, message.sentence ?? '')}\n\nRespond with JSON only.`},
            ]
        })
    }

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    return JSON.stringify({
        model: model,
        max_tokens: 4096,
        stream: false,
        system: system,
        messages: [
            {role: "user", content: user},
        ]
    })
}
```

- [ ] **Step 6: 把 10 个 service handler 的 `contentPostHandler(...)` 调用换成 `interpretLLMContent(..., message.mode)`**

每个文件加 import：

```ts
import { interpretLLMContent } from "@/entrypoints/utils/wordPrompt";
```

并删除原来的 `import { contentPostHandler } from "..."`（如果存在）。`return contentPostHandler(...)` 形式替换为 `return interpretLLMContent(..., message.mode)`。

10 个文件 + 各自的响应行：

`entrypoints/service/common.ts:33` —— `return interpretLLMContent(result.choices[0].message.content, message.mode);`

`entrypoints/service/azure-openai.ts` —— 同 common 形态，找到返回 `contentPostHandler(...)` 的行替换。

`entrypoints/service/custom.ts` —— 同上。

`entrypoints/service/grok.ts` —— 同上。

`entrypoints/service/infini.ts` —— 同上。

`entrypoints/service/newapi.ts` —— 同上。

`entrypoints/service/zhipu.ts` —— 同上。

`entrypoints/service/deepseek.ts` —— 同上。

`entrypoints/service/claude.ts` —— claude 响应字段是 `result.content[0].text`：`return interpretLLMContent(result.content[0].text, message.mode);`

`entrypoints/service/gemini.ts` —— gemini 响应字段是 `result.candidates[0].content.parts[0].text`：`return interpretLLMContent(result.candidates[0].content.parts[0].text, message.mode);`

> 提示：若某 service 文件原本不调 `contentPostHandler`，跳过；只在调过的位置替换。可用 `grep -rn "contentPostHandler" entrypoints/service/` 列出全部。

- [ ] **Step 7: 编译检查**

```bash
pnpm compile
```

预期：通过。返回类型从 `string` 变为 `string | WordPayload`，`_service` 的 `ServiceFunction` 类型签名 `(message: any) => Promise<any>` 已是 any，向下兼容。

- [ ] **Step 8: 提交**

```bash
git add entrypoints/utils/template.ts entrypoints/service/
git commit -m "feat: LLM 模板与服务 handler 支持 word 模式 prompt 与解析"
```

---

### Task 6: translateApi.ts 增加 mode/sentence + cache namespace + 函数重载

**Files:**
- Modify: `entrypoints/utils/translateApi.ts`

- [ ] **Step 1: 顶部 import + djb2 哈希**

文件顶部 import 区追加：

```ts
import { TranslateMessage } from './messageTypes';
import { WordPayload, isValidWordPayload } from './wordPrompt';
```

文件末尾（`TranslateOptions` 接口下方）追加：

```ts
function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function makeCacheKey(origin: string, mode: 'word' | 'sentence', sentence?: string): string {
  if (mode === 'word') return `inline-word:${djb2Hex(origin + '|' + (sentence ?? ''))}`;
  return origin;
}
```

- [ ] **Step 2: 扩展 TranslateOptions 接口**

把现有的 `TranslateOptions` interface 改成：

```ts
export interface TranslateOptions {
  /** 最大重试次数 */
  maxRetries?: number;
  /** 重试间隔(毫秒) */
  retryDelay?: number;
  /** 超时时间(毫秒) */
  timeout?: number;
  /** 是否使用缓存 */
  useCache?: boolean;
  /** 翻译模式，默认 sentence；word 模式要求 LLM 返回结构化词典 JSON */
  mode?: 'word' | 'sentence';
  /** word 模式的句子语境，作 prompt context */
  sentence?: string;
}
```

- [ ] **Step 3: translateText 增加函数重载**

把现有的 `translateText` 函数签名替换为带重载的版本：

```ts
// 重载 1：默认 / sentence 模式 → 始终返回 string
export async function translateText(
  origin: string,
  context?: string,
  options?: Omit<TranslateOptions, 'mode'> & { mode?: 'sentence' },
): Promise<string>;
// 重载 2：word 模式 → 返回 string | WordPayload（软降级时为 string）
export async function translateText(
  origin: string,
  context: string | undefined,
  options: Omit<TranslateOptions, 'mode'> & { mode: 'word' },
): Promise<string | WordPayload>;
// 实现
export async function translateText(
  origin: string,
  context: string = document.title,
  options: TranslateOptions = {},
): Promise<string | WordPayload> {
  const {
    maxRetries = 3,
    retryDelay = 1000,
    timeout = 45000,
    useCache = config.useCache,
    mode = 'sentence',
    sentence,
  } = options;

  // 如果目标语言与当前文本语言相同，直接返回原文
  if (detectlang(origin.replace(/[\s　]/g, '')) === config.to) {
    return origin;
  }

  const cacheKey = makeCacheKey(origin, mode, sentence);

  // 检查缓存
  if (useCache) {
    const cachedRaw = cache.localGet(cacheKey);
    if (cachedRaw) {
      if (isDev) console.log('[翻译API] 命中缓存，直接返回缓存结果');
      if (mode === 'word') {
        try {
          const parsed = JSON.parse(cachedRaw);
          if (isValidWordPayload(parsed)) return parsed;
        } catch { /* fall through，丢弃损坏的缓存项 */ }
      } else {
        return cachedRaw;
      }
    }
  }

  // 增加翻译计数
  config.count++;
  storage.setItem('local:config', JSON.stringify(config));

  // 使用队列处理翻译请求
  return enqueueTranslation(async () => {
    const translationTask = async (retryCount: number = 0): Promise<string | WordPayload> => {
      try {
        const message: TranslateMessage = { context, origin, mode, sentence };
        const result = await Promise.race([
          browser.runtime.sendMessage(message),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('翻译请求超时')), timeout)
          )
        ]) as string | WordPayload;

        if (mode === 'word') {
          // word 模式：只要 payload 合法就缓存（即使 translation === origin，术语场景）
          if (useCache && isValidWordPayload(result)) {
            cache.localSet(cacheKey, JSON.stringify(result));
          }
          return result;
        }

        // sentence 模式：保持现行 "结果为空 / 与原文相同 → 返回原文不缓存" 行为
        if (!result || result === origin) return origin;
        if (useCache) cache.localSet(cacheKey, result as string);
        return result;
      } catch (error) {
        if (retryCount < maxRetries) {
          if (isDev) console.log(`[翻译API] 翻译失败，${retryCount + 1}/${maxRetries} 次重试，原因:`, (error as Error).message);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          return translationTask(retryCount + 1);
        }
        throw error;
      }
    };

    return translationTask();
  });
}
```

> 注意：不打印请求体（CLAUDE.md 规则）。失败日志只打印 `error.message`。

- [ ] **Step 4: 编译检查**

```bash
pnpm compile
```

预期：通过。现有 sentence 模式 callers（`Promise<string>`）签名匹配重载 1，类型不变；word callers 走重载 2。

- [ ] **Step 5: 提交**

```bash
git add entrypoints/utils/translateApi.ts
git commit -m "feat: translateText 支持 word 模式与独立 cache namespace"
```

---

### Task 7: source tier 数据扩展 + collectTextFragments 跳过已标记节点

本 task 不重写规则，仅给 session 加 tier 字段并让新建 source 跳过已标记 source 内部的文本（为 Task 8 的覆盖/绕开规则铺垫）。MVP 现行行为继续保持（旧 `getSourceReuseDecision` 仍然在跑）。

**Files:**
- Modify: `entrypoints/utils/inlineSelectionTranslation.ts`

- [ ] **Step 1: 顶部 import wordHeuristic、wordPrompt**

```ts
import { looksLikeWord, extractSentence } from './wordHeuristic';
import type { WordPayload } from './wordPrompt';
import { config } from './config';
```

(若 config 已经 import 过，跳过。)

- [ ] **Step 2: 扩展 InlineSelectionSession**

替换现有 `InlineSelectionSession` 定义为：

```ts
export interface InlineSelectionSession {
  sourceId: string;
  tier: 'word' | 'outer';
  mode: 'word' | 'sentence';
  sentence?: string;
  sourceElements: HTMLElement[];
  resultAnchor: HTMLElement;
  payload?: WordPayload;
}
```

- [ ] **Step 3: 新增 TIER_ATTR 常量**

文件常量区追加：

```ts
const TIER_ATTR = 'data-fr-inline-selection-tier';
```

- [ ] **Step 4: createSourceWrapper 接受 tier 参数**

替换为：

```ts
function createSourceWrapper(sourceId: string, tier: 'word' | 'outer'): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'fr-inline-selection-source';
  wrapper.setAttribute(SOURCE_ATTR, sourceId);
  wrapper.setAttribute(TIER_ATTR, tier);
  return wrapper;
}
```

`markRange` / `wrapTextFragment` 的调用点同步增加 `tier` 参数：

```ts
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
```

- [ ] **Step 5: collectTextFragments 跳过已有 source 内部的文本**

替换 `collectTextFragments` 的 `acceptNode` 函数：

```ts
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
```

- [ ] **Step 6: beginInlineSelectionTranslation 内决定 tier 并填充 session**

修改 `beginInlineSelectionTranslation` 函数（沿用其现有结构，但创建 session 时多带几个字段。本 task 暂不改 `getSourceReuseDecision`，所以混合选区还是会被拒绝；新增 tier 仅在合法 session 中生效）：

替换函数体内 `markRange(...)` 调用前的 tier 计算与 markRange 参数：

```ts
const text = workingRange.toString();
const tier: 'word' | 'outer' = looksLikeWord(text, config.to) ? 'word' : 'outer';
const mode: 'word' | 'sentence' = tier === 'word' ? 'word' : 'sentence';
const sentence = mode === 'word' ? extractSentence(workingRange, block) : undefined;

const sourceId = existingSourceId ?? `fr-inline-${Date.now()}-${sourceCounter++}`;
const sourceElements = existingSourceId
  ? getSourceElements(sourceId)
  : markRange(workingRange, block, sourceId, tier);

if (!sourceElements.length) return null;
```

并在函数返回的 session 字面量里填齐字段：

```ts
return {
  sourceId,
  tier,
  mode,
  sentence,
  sourceElements,
  resultAnchor: sourceElements[sourceElements.length - 1], // 临时 anchor，Task 8 用 computeResultAnchor 改写
};
```

> Task 7 不改 `completeInlineSelectionTranslation` / `failInlineSelectionTranslation`；它们仍然用 `getSessionAnchor(session)` 取最末 source span。等 Task 8 切到 `session.resultAnchor`。

- [ ] **Step 7: 编译检查**

```bash
pnpm compile
```

预期：通过。

- [ ] **Step 8: 提交**

```bash
git add entrypoints/utils/inlineSelectionTranslation.ts
git commit -m "refactor: source 引入 tier 与 collectTextFragments 跳过已标记节点"
```

---

### Task 8: 重写 source 规则 + computeResultAnchor + completeXXX 接受 payload

启用新的覆盖/绕开/拒绝规则；result anchor 改用文档序最末 source；`completeInlineSelectionTranslation` 增加 `payload` 参数并据此渲染 icon。

**Files:**
- Modify: `entrypoints/utils/inlineSelectionTranslation.ts`

- [ ] **Step 1: 新增 isFullyInsideRange / computeResultAnchor 工具函数**

文件中部追加：

```ts
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
  // 与 range 相交但跨出 range 边界
  return intersects && (startsBefore || endsAfter) && !isFullyInsideRange(el, range);
}

function computeResultAnchor(range: Range, block: HTMLElement): HTMLElement | null {
  const all = Array.from(block.querySelectorAll<HTMLElement>(`[${SOURCE_ATTR}]`));
  const inside = all.filter((el) => isFullyInsideRange(el, range));
  return inside[inside.length - 1] ?? null;
}
```

- [ ] **Step 2: 重写 getSourceReuseDecision**

替换现有 `getSourceReuseDecision` 为新的三步规则：

```ts
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

  // 2. 完全等同：range 边界正好等于某个 source 边界（同一 sourceId 的所有 span 集合等于 range）→ 重译
  const sourceIdGroups = new Map<string, HTMLElement[]>();
  for (const src of allSources) {
    const id = src.getAttribute(SOURCE_ATTR) ?? '';
    if (!sourceIdGroups.has(id)) sourceIdGroups.set(id, []);
    sourceIdGroups.get(id)!.push(src);
  }
  for (const [id, group] of sourceIdGroups) {
    const allInside = group.every((el) => isFullyInsideRange(el, range));
    if (!allInside) continue;
    // 检查 range 内是否 *只有* 这组 source 的文字（无其它字符）
    const rangeText = range.toString().trim();
    const groupText = group.map((el) => el.textContent ?? '').join('').trim();
    if (rangeText === groupText) return { kind: 'reuse', sourceId: id };
  }

  // 3. 覆盖/绕开：完全落在 range 内的 source
  const containedSources = allSources.filter((el) => isFullyInsideRange(el, range));
  if (newTier === 'word') {
    // word 选区理论上不会包含其它 source（太短），防御性拒绝
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
```

- [ ] **Step 3: 新增 removeSource（unwrap 老 outer source）**

```ts
function removeSource(sourceId: string): void {
  const sources = getSourceElements(sourceId);
  for (const src of sources) {
    // unwrap：把 children 移出去，删 wrapper
    const parent = src.parentNode;
    if (!parent) continue;
    while (src.firstChild) parent.insertBefore(src.firstChild, src);
    parent.removeChild(src);
  }
  removeStatus(sourceId);
  removeResult(sourceId);
}
```

- [ ] **Step 4: canUseInlineSelection 重写为对接新规则**

```ts
export function canUseInlineSelection(range: Range | null): boolean {
  if (!range || range.collapsed || !range.toString().trim()) return false;
  const block = getSharedBlockContainer(range);
  if (!block) return false;
  if (hasSelectedDescendantBlock(range, block)) return false;
  const newTier: 'word' | 'outer' = looksLikeWord(range.toString(), config.to) ? 'word' : 'outer';
  const decision = getSourceReuseDecision(range, block, newTier);
  return decision.kind !== 'reject';
}
```

> 旧的 `getInlineSelectionBlockContainer` 可以删（其能力已分散到 `getSharedBlockContainer` + `hasSelectedDescendantBlock` + `getSourceReuseDecision`）。

- [ ] **Step 5: beginInlineSelectionTranslation 切换到新决策**

完整替换函数体为：

```ts
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
```

- [ ] **Step 6: completeInlineSelectionTranslation / failInlineSelectionTranslation 接受 payload + 用 session.resultAnchor**

替换两个函数为：

```ts
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

  const showText = !(payload && payload.translation === session.sourceElements.map((el) => el.textContent ?? '').join(''));
  if (showText) {
    result.textContent = translatedText;
  } else {
    result.classList.add('is-empty');
  }

  // word 模式且有 payload 时，append icon SVG
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
```

> `createIconElement` 与 `attachIconHover` 在 Task 10 实现真版。本 task 先放占位，避免编译错误：

```ts
function createIconElement(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'fr-inline-selection-icon';
  // SVG 内容在 Task 10 step 5 填入；此处先空壳。
  return span;
}

function attachIconHover(_icon: HTMLElement, _session: InlineSelectionSession, _payload: WordPayload): void {
  // 在 Task 10 step 4 实现 hover → mountWordPopover；此处占位。
}
```

- [ ] **Step 7: cleanupInlineSelectionTranslations 兜底卸载 popover**

为 Task 10 预留接口，先增加空函数：

```ts
function unmountWordPopover(): void {
  // Task 10 实现。
}
```

修改 `cleanupInlineSelectionTranslations`：

```ts
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
```

- [ ] **Step 8: 编译检查**

```bash
pnpm compile
```

预期：通过。

- [ ] **Step 9: 提交**

```bash
git add entrypoints/utils/inlineSelectionTranslation.ts
git commit -m "feat: 重写 source 规则支持 tier 覆盖/绕开/拒绝与重译"
```

---

### Task 9: WordExplainPopover.vue 词典浮窗组件

**Files:**
- Create: `components/WordExplainPopover.vue`

- [ ] **Step 1: 创建组件文件**

写入 `components/WordExplainPopover.vue`：

```vue
<template>
  <teleport to="body">
    <div
      ref="popoverRef"
      class="fr-word-popover"
      :class="{ 'fr-dark-theme': isDarkTheme }"
      @mouseenter="emit('hoverEnter')"
      @mouseleave="emit('hoverLeave')"
    >
      <div class="fr-word-popover-header">
        <span class="fr-word-popover-word">{{ word }}</span>
        <span v-if="payload.ipa" class="fr-word-popover-ipa">{{ payload.ipa }}</span>
        <div v-if="payload.pronunciation" class="fr-word-popover-pronunciation">
          {{ payload.pronunciation }}
        </div>
      </div>

      <div v-if="payload.contextualMeaning" class="fr-word-popover-context">
        <div class="fr-word-popover-context-label">在该语境下</div>
        <div class="fr-word-popover-context-text">{{ payload.contextualMeaning }}</div>
      </div>

      <div v-if="payload.definitions?.length" class="fr-word-popover-section">
        <div class="fr-word-popover-defs-label">完整释义</div>
        <ul class="fr-word-popover-defs">
          <li v-for="(def, i) in payload.definitions" :key="i">
            <span class="fr-word-popover-pos">{{ def.pos }}</span>
            <span class="fr-word-popover-meaning">{{ def.meaning }}</span>
          </li>
        </ul>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, useTemplateRef } from 'vue';
import { autoUpdate, computePosition, flip, offset, shift, autoPlacement } from '@floating-ui/dom';
import { config } from '@/entrypoints/utils/config';
import type { WordPayload } from '@/entrypoints/utils/wordPrompt';

const props = defineProps<{
  word: string;
  payload: WordPayload;
  referenceEl: HTMLElement;
}>();

const emit = defineEmits<{
  (e: 'hoverEnter'): void;
  (e: 'hoverLeave'): void;
}>();

const popoverRef = useTemplateRef<HTMLElement>('popoverRef');
const isDarkTheme = ref(false);

let cleanupAutoUpdate: (() => void) | null = null;

function updateTheme() {
  const t = config.theme || 'auto';
  if (t === 'auto') {
    isDarkTheme.value = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } else {
    isDarkTheme.value = t === 'dark';
  }
}

onMounted(() => {
  updateTheme();
  watch(() => config.theme, updateTheme);

  const popover = popoverRef.value;
  if (!popover) return;

  cleanupAutoUpdate = autoUpdate(props.referenceEl, popover, () => {
    computePosition(props.referenceEl, popover, {
      placement: 'top',
      middleware: [
        offset(8),
        flip({ fallbackPlacements: ['bottom', 'right', 'left'] }),
        shift({ padding: 8 }),
      ],
    }).then(({ x, y }) => {
      Object.assign(popover.style, { left: `${x}px`, top: `${y}px`, position: 'absolute' });
    });
  });
});

onBeforeUnmount(() => {
  cleanupAutoUpdate?.();
});
</script>

<style scoped>
.fr-word-popover {
  width: 280px;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.10);
  font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.55;
  color: #1f2937;
  z-index: 10001;
}

.fr-word-popover-header {
  padding: 10px 14px 8px;
  border-bottom: 1px solid #f3f4f6;
}

.fr-word-popover-word {
  font-size: 15px;
  font-weight: 600;
  color: #111827;
  margin-right: 6px;
}

.fr-word-popover-ipa {
  display: inline-block;
  font-family: "Fira Mono", "SF Mono", monospace;
  font-size: 12px;
  color: #4f8cff;
}

.fr-word-popover-pronunciation {
  margin-top: 4px;
  font-size: 12px;
  color: #6b7280;
}

.fr-word-popover-context {
  background: linear-gradient(180deg, rgba(79,140,255,0.08), rgba(79,140,255,0.03));
  border-left: 3px solid #4f8cff;
  padding: 8px 14px;
}

.fr-word-popover-context-label {
  font-size: 11px;
  color: #4f8cff;
  font-weight: 600;
  margin-bottom: 2px;
}

.fr-word-popover-context-text {
  font-size: 13px;
  color: #1f2937;
  font-weight: 500;
}

.fr-word-popover-section {
  padding: 8px 14px;
  border-top: 1px solid #f3f4f6;
}

.fr-word-popover-defs-label {
  font-size: 11px;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}

.fr-word-popover-defs {
  margin: 0;
  padding: 0;
  list-style: none;
}

.fr-word-popover-defs li {
  margin-bottom: 4px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.fr-word-popover-defs li:last-child { margin-bottom: 0; }

.fr-word-popover-pos {
  flex-shrink: 0;
  font-size: 11px;
  color: #6b7280;
  font-style: italic;
  min-width: 28px;
}

.fr-word-popover-meaning {
  color: #1f2937;
}

/* dark mode */
.fr-word-popover.fr-dark-theme {
  background: #1f1f1f;
  border-color: #333;
  color: #ffffff;
}
.fr-word-popover.fr-dark-theme .fr-word-popover-word { color: #ffffff; }
.fr-word-popover.fr-dark-theme .fr-word-popover-header { border-color: #333; }
.fr-word-popover.fr-dark-theme .fr-word-popover-section { border-color: #333; }
.fr-word-popover.fr-dark-theme .fr-word-popover-context-text { color: #ffffff; }
.fr-word-popover.fr-dark-theme .fr-word-popover-meaning { color: #ffffff; }
.fr-word-popover.fr-dark-theme .fr-word-popover-pronunciation { color: #aaa; }
</style>
```

- [ ] **Step 2: 编译检查**

```bash
pnpm compile
```

预期：通过。

- [ ] **Step 3: 提交**

```bash
git add components/WordExplainPopover.vue
git commit -m "feat: 新增词典浮窗组件 WordExplainPopover"
```

---

### Task 10: icon hover 监听 + popover 命令式挂载

把 Task 8 占位的 `attachIconHover` / `unmountWordPopover` 实现为真正的 mountWordPopover + show/hide debounce timers。

**Files:**
- Modify: `entrypoints/utils/inlineSelectionTranslation.ts`

- [ ] **Step 1: 顶部 import 命令式挂载工具**

```ts
import { createApp, type App } from 'vue';
import WordExplainPopover from '@/components/WordExplainPopover.vue';
```

- [ ] **Step 2: 添加 popover 状态变量**

文件常量区追加：

```ts
const HOVER_SHOW_DELAY = 200;
const HOVER_HIDE_DELAY = 150;

interface ActivePopover {
  app: App;
  container: HTMLElement;
  sourceElements: HTMLElement[];
  iconEl: HTMLElement;
}

let activePopover: ActivePopover | null = null;
let showTimer: number | null = null;
let hideTimer: number | null = null;
```

- [ ] **Step 3: 实现 mountWordPopover / unmountWordPopover**

替换 Task 8 的 `unmountWordPopover` 占位，并新增 `mountWordPopover`：

```ts
function mountWordPopover(icon: HTMLElement, session: InlineSelectionSession, payload: WordPayload): void {
  unmountWordPopover();

  const container = document.createElement('div');
  container.className = 'fr-word-popover-host';
  document.body.appendChild(container);

  const word = session.sourceElements.map((el) => el.textContent ?? '').join('');

  const app = createApp(WordExplainPopover, {
    word,
    payload,
    referenceEl: icon,
    onHoverEnter: () => {
      if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    },
    onHoverLeave: () => {
      scheduleHidePopover();
    },
  });
  app.mount(container);

  for (const el of session.sourceElements) el.classList.add('fr-source-active');

  activePopover = { app, container, sourceElements: session.sourceElements, iconEl: icon };
}

function unmountWordPopover(): void {
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (!activePopover) return;
  for (const el of activePopover.sourceElements) el.classList.remove('fr-source-active');
  activePopover.app.unmount();
  activePopover.container.remove();
  activePopover = null;
}

function scheduleHidePopover(): void {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    unmountWordPopover();
  }, HOVER_HIDE_DELAY);
}
```

- [ ] **Step 4: 实现 attachIconHover**

替换 Task 8 占位实现：

```ts
function attachIconHover(icon: HTMLElement, session: InlineSelectionSession, payload: WordPayload): void {
  icon.addEventListener('mouseenter', () => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (activePopover && activePopover.iconEl === icon) return; // 已经显示这个 icon 的 popover

    if (showTimer !== null) clearTimeout(showTimer);
    showTimer = window.setTimeout(() => {
      mountWordPopover(icon, session, payload);
      showTimer = null;
    }, HOVER_SHOW_DELAY);
  });

  icon.addEventListener('mouseleave', () => {
    if (showTimer !== null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    scheduleHidePopover();
  });
}
```

- [ ] **Step 5: createIconElement 渲染 SVG**

替换 Task 8 占位为 11×11 书形 SVG：

```ts
function createIconElement(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'fr-inline-selection-icon';
  // 11×11 书形 SVG，stroke 跟随 currentColor
  span.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
  return span;
}
```

- [ ] **Step 6: 编译检查**

```bash
pnpm compile
```

预期：通过。

- [ ] **Step 7: 提交**

```bash
git add entrypoints/utils/inlineSelectionTranslation.ts
git commit -m "feat: 词典 icon 与 hover 浮窗命令式挂载"
```

---

### Task 11: inline 与 popover 全局样式

**Files:**
- Modify: `entrypoints/style.css`

- [ ] **Step 1: 在文件末尾追加新样式**

打开 `entrypoints/style.css`，文件末尾追加：

```css
.fr-inline-selection-icon {
    display: inline-block;
    width: 11px;
    height: 11px;
    margin-left: 3px;
    color: #9ca3af;
    cursor: help;
    transform: translateY(-0.45em);
    transition: color 0.15s;
}

.fr-inline-selection-icon svg {
    display: block;
    width: 11px;
    height: 11px;
}

.fr-inline-selection-result:hover .fr-inline-selection-icon {
    color: #4f8cff;
}

.fr-inline-selection-result.is-empty {
    margin-left: 4px;
}

.fr-inline-selection-source.fr-source-active {
    background: rgba(79, 140, 255, 0.20);
}

@media (prefers-color-scheme: dark) {
    .fr-inline-selection-icon { color: #6b7280; }
    .fr-inline-selection-result:hover .fr-inline-selection-icon { color: #69c0ff; }
    .fr-inline-selection-source.fr-source-active { background: rgba(105, 192, 255, 0.25); }
}
```

- [ ] **Step 2: 编译检查**

```bash
pnpm compile
```

预期：通过（CSS 不参与 vue-tsc，但 dev server 启动时会校验语法）。

- [ ] **Step 3: 提交**

```bash
git add entrypoints/style.css
git commit -m "style: 新增 inline 词典 icon 与高亮态全局样式"
```

---

### Task 12: SelectionTranslator.vue word 模式接入

把 `handleInlineTranslate` 拉通：从 session 取 mode/sentence，传给 `translateText`，按返回类型决定是否带 payload 调 `completeInlineSelectionTranslation`。

**Files:**
- Modify: `components/SelectionTranslator.vue`

- [ ] **Step 1: 替换 handleInlineTranslate 函数体**

定位现有 `const handleInlineTranslate = async () => { ... }`（约第 332-368 行），整体替换为：

```ts
const handleInlineTranslate = async () => {
  if (isUnmounted || !selectedText.value || !selectRange.value || isInlineTranslating.value) return;

  const range = selectRange.value.cloneRange();
  const inlineText = range.toString().trim();
  if (!inlineText || !canUseInlineSelection(range)) {
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
  selectedText.value = inlineText;
  isInlineTranslating.value = true;

  try {
    if (session.mode === 'word') {
      const result = await translateText(inlineText, undefined, {
        mode: 'word',
        sentence: session.sentence,
      });
      if (isUnmounted) return;
      if (typeof result === 'string') {
        // 软降级：纯文本译文，无词典数据
        completeInlineSelectionTranslation(session, result);
      } else {
        completeInlineSelectionTranslation(session, result.translation, result);
      }
    } else {
      const result = await translateText(inlineText);
      if (isUnmounted) return;
      completeInlineSelectionTranslation(session, result);
    }
  } catch (err) {
    if (!isUnmounted) {
      failInlineSelectionTranslation(session);
      console.error('Inline translation error:', (err as Error).message);
    }
  } finally {
    if (!isUnmounted) {
      isInlineTranslating.value = false;
    }
  }
};
```

> 注意：`InlineSelectionSession` 已在 Task 8 增加 `mode` / `sentence` / `payload` 字段；`translateText` 重载在 Task 6 已就绪。

- [ ] **Step 2: 编译检查**

```bash
pnpm compile
```

预期：通过。

- [ ] **Step 3: 提交**

```bash
git add components/SelectionTranslator.vue
git commit -m "feat: SelectionTranslator 接入 word 模式翻译与 payload 渲染"
```

---

### Task 13: Main.vue 内联翻译选项门控 + 服务切换回退

**Files:**
- Modify: `components/Main.vue`

- [ ] **Step 1: 在 `<script setup>` 顶部 import**

定位 `<script setup>` 的 imports（搜索 `import { config }`），追加：

```ts
import { servicesType } from '@/entrypoints/utils/option';
import { ElMessage } from 'element-plus';
```

> 如果 `ElMessage` 已被 import 跳过；如果使用全局 `Element Plus` 注册可直接 `ElMessage.info(...)`，无需 import。

- [ ] **Step 2: el-option `:disabled` 接 servicesType.isAI**

定位 `<el-option label="内联翻译" value="inline" />`（约第 187 行），替换为：

```vue
<el-option
  label="内联翻译"
  value="inline"
  :disabled="!servicesType.isAI(config.service)" />
```

- [ ] **Step 3: 更新对应 tooltip 提示**

定位上方那个 `<el-tooltip ... content="...">`（约第 174 行 `选中文本后触发划词翻译。可选择关闭、双语弹窗、仅译文弹窗或内联翻译`），替换 content：

```vue
<el-tooltip class="box-item" effect="dark" content="选中文本后触发划词翻译。可选择关闭、双语弹窗、仅译文弹窗或内联翻译。内联翻译需要 LLM 服务（OpenAI / Claude / Gemini / DeepSeek 等）才能启用词典浮窗" placement="top-start" :show-after="500">
```

- [ ] **Step 4: 服务切换 watch 增加 inline → bilingual 回退**

定位 `<script setup>` 中现有的 watcher 区域，追加：

```ts
watch(() => config.value.service, (newService) => {
  if (config.value.selectionTranslatorMode === 'inline' && !servicesType.isAI(newService)) {
    config.value.selectionTranslatorMode = 'bilingual';
    ElMessage.info('当前服务不支持内联翻译，已自动切换为双语弹窗');
  }
});
```

> 现有的 `watch(() => config.value.selectionTranslatorMode, ...)`（约第 836 行）会自动把新模式广播到 content scripts，无需重复广播。

- [ ] **Step 5: 编译检查**

```bash
pnpm compile
```

预期：通过。

- [ ] **Step 6: 提交**

```bash
git add components/Main.vue
git commit -m "feat: 内联翻译选项仅在 LLM 服务下启用，切非 LLM 自动回退"
```

---

### Task 14: 浏览器手动验收

**Files:**
- 仅手动验证；无文件改动。

- [ ] **Step 1: 编译再过一遍**

```bash
pnpm compile
```

预期：通过。

- [ ] **Step 2: 启动 Chromium 开发模式**

```bash
pnpm dev
```

加载扩展到一个英文文章页面（推荐：MDN、Wikipedia 英文版、Hacker News 任一篇）。把 `config.to` 设为 `zh-Hans`，`config.service` 设为已配 token 的 LLM（OpenAI / Claude / Gemini / DeepSeek 任一）。

- [ ] **Step 3: 验证 popup 设置**

- 服务设为 OpenAI → 划词翻译下拉的「内联翻译」可选。
- 服务设为 Microsoft → 「内联翻译」选项灰色 disabled，hover tooltip 提示需要 LLM 服务。
- 当前 mode = inline，把服务从 OpenAI 切到 Microsoft → 自动回退到「双语显示」，弹 ElMessage info「当前服务不支持内联翻译，已自动切换为双语弹窗」。

- [ ] **Step 4: 验证单词翻译 + 词典 popover**

设置 mode = inline。在文章里：

- 划单个英文词如 "constraint"（需在某句子里）→ 出「译」按钮。
- 点击 → loading spinner 紧跟原文，翻译完成后显示译文 "约束" + 11×11 书形 icon（位置在原文右上方，靠 `transform: translateY(-0.45em)`）。
- hover icon ~200ms 后弹 popover：
  - 标题：constraint /kənˈstreɪnt/（美音）
  - 副标题：英文常见词类比的发音指导
  - 蓝条高亮区：「在该语境下：…」
  - 完整释义列表：n. 约束/限制；v. 强迫…
  - source span 加 `.fr-source-active` 加深背景。
- 鼠标移出 icon → ~150ms 后 popover 收起。
- 鼠标从 icon → popover 内部时不收起。
- 同句重划同词 → cache 命中，loading 一闪即过。
- 切到不同句子里的同一个词 → cache miss，contextualMeaning 应针对新句子。

- [ ] **Step 5: 验证术语翻译**

- 划 "OAuth" → 点译。
- inline 译文区段不渲染中文文字（translation === origin），仅紧贴原文挂出 icon（`.is-empty` 去掉左 margin）。
- hover popover：contextual 区是 OAuth 的解释（"开放授权…"），definitions 可能仅 1 条。
- 同样划 "Kubernetes"、"embedding" 验证类似行为。

- [ ] **Step 6: 验证重叠选区 / source tier**

- 先划 "important" 翻译完成（tier=word）。
- 再划包含 important 的句子 "This is important text." → 出按钮 → 点译。预期：
  - 内层 [important] 的下划线 + 中文译文 + icon 保留
  - 句子层蓝下划线在 important 处断开（B 方案：跳过已标记内部）
  - 句子的小灰译文落在 "text" 之后（result anchor = 文档序最末 source）
  - 句子级 icon **不出**（sentence 模式无 popover）
- 再划包含上面整个句子 + 后续别的句子的更大范围 → 触发；句子级老 outer source 被覆盖（unwrap），新 outer 包整段；word source [important] 保留。
- 划"切到一个 source 中间"的范围（比如从 important 字母 m 开始）→ 按钮不出。
- 划恰好等于已有 outer source 的范围 → 重译并替换原结果。

- [ ] **Step 7: 验证软降级 / 异常**

- 故意制造 JSON 解析失败：临时把 wordPrompt.ts 的 system prompt 改成 "Return plain text"，重启 dev → 划单词 → 译文照常出现，不出 icon。验证完后**回滚**修改并保持原 prompt。
- 断网划单词 → 红字"翻译失败"。
- 极快连续划不同词 → queue 串行执行，无错乱。
- 翻译进行中切换 popup 模式（inline → bilingual）→ 老 inline 翻译完成后 cleanup，无残留 DOM。

- [ ] **Step 8: Firefox 冒烟**

```bash
pnpm dev:firefox
```

跑 Step 4 + Step 6 的核心场景。确认 floating-ui popover 与 transform 视觉一致。如有差异，PR 中说明。

- [ ] **Step 9: 无回归冒烟**

- 切到「双语显示」/「只显示译文」模式：选中文本，hover 小红点弹 tooltip，确认翻译正常。
- 触发全文翻译（右键菜单 / 快捷键）：确认整页翻译正常，撤销翻译正常。
- 输入框翻译（Ctrl+Enter / 三连空格）：确认正常。

- [ ] **Step 10: 总结**

如所有验收均通过且没有发现需要代码改动的 bug，本计划完成。无需新增 commit。

如果暴露 bug：回到对应 Task 做聚焦修复，重新 `pnpm compile`，重跑相关浏览器检查，并使用该 Task 的提交命令。
