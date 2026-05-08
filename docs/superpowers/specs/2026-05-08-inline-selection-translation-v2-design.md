# 内联划词翻译 v2 设计：词典 popover、术语兜底、重叠选区

## 目标

在 [2026-05-06 内联划词翻译 MVP](./2026-05-06-inline-selection-translation-design.md) 的基础上修复三个用户报告的问题：

1. **重叠选区不触发**：单词翻译完成后，再次划包含该单词的句子不会触发"译"按钮。需要允许触发，并保留原单词的翻译结果。
2. **单词翻译缺语境且信息单薄**：单词翻译没有把句子语境传给模型；译文只是单一中文释义，缺音标、多义、发音指导。
3. **术语返回原文**：部分术语（如 OAuth、Kubernetes）翻译后被模型当作 "no translation needed" 直接返回原文，没有解释。

## 范围

### 包含

- 改造单词模式翻译协议：传句子作 context、要求模型返回 JSON 结构化词典数据。
- 新增右上角 hover icon + floating popover 展示词典数据（IPA、发音指导、多义释义、当前语境含义）。
- 术语场景由单词模式承担：prompt 强制要求中文释义；译文等于原文时不重复渲染译文，仅留 icon。
- 重叠选区基于 source tier 数据模型：word 与 outer 二级，最多两层；新选区按规则覆盖 / 绕开 / 拒绝。
- popup 设置页将 `内联翻译` 选项门控到 LLM 服务。

### 不包含

- 句子 / 段落模式不变（无 popover、不传 context、不改 prompt）。
- 非 LLM 服务的词典支持。
- 例句、同义词、反义词、词根等扩展字段。
- 多目标语种的词典支持（仅 `config.to === 'zh-Hans'` 启用）。
- 自动化测试（仓库无测试框架）。

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  popup UI (Main.vue)                                        │
│   · 内联翻译选项 :disabled = !isLLMService(config.service)   │
│   · 服务切换若为 inline+非 LLM → 回退 bilingual + toast       │
└──────────────┬──────────────────────────────────────────────┘
               │ config.selectionTranslatorMode / config.service
               ▼
┌─────────────────────────────────────────────────────────────┐
│  Vue 内容脚本 (SelectionTranslator.vue + WordExplainPopover) │
│   · handleInlineTranslate 调用 looksLikeWord                 │
│   · word: 抽取 sentence context, 调 translateText(mode='word')│
│   · 收到 WordPayload → 渲染 inline 译文 + 右上角 icon         │
│   · icon hover (200/150ms 防抖) → 浮 WordExplainPopover       │
└──────────────┬──────────────────────────────────────────────┘
               │ translateText(origin, ctx?, { mode, sentence? })
               ▼
┌─────────────────────────────────────────────────────────────┐
│  utils 层 (translateApi.ts + cache.ts + inlineSelection.ts)  │
│   · translateText 返回 string | WordPayload                  │
│   · word cache namespace: `inline-word:${djb2(origin|sent)}` │
│   · inlineSelection: tier 标记 + 覆盖/绕开/拒绝 三类规则      │
└──────────────┬──────────────────────────────────────────────┘
               │ runtime.sendMessage({ context, origin, mode, sentence })
               ▼
┌─────────────────────────────────────────────────────────────┐
│  background.ts + service/* + template.ts                    │
│   · 透传 mode/sentence 到 _service[config.service](message)  │
│   · LLM 模板按 mode 切 prompt（word 走 JSON schema 指令）     │
│   · 响应处理：word 模式 JSON.parse + schema 校验，失败软降级   │
└─────────────────────────────────────────────────────────────┘
```

### 修改的文件

- `entrypoints/utils/option.ts` — 新增 `isLLMService`，复用现有 `servicesType.AI` 集合。
- `components/Main.vue` — inline 选项 disabled 逻辑 + 服务切换 watch。
- `entrypoints/utils/translateApi.ts` — 增加 `mode` / `sentence` options，返回类型 `string | WordPayload`，cache key 按 mode 拼前缀。
- `entrypoints/background.ts` — 透传 `mode` / `sentence` 字段到 service handler。
- `entrypoints/service/common.ts` 等 LLM 服务 — word 模式响应解析分支。
- `entrypoints/utils/template.ts` — 4 个 LLM 模板按 mode 切 prompt。
- `entrypoints/utils/inlineSelectionTranslation.ts` — tier 标记 + 三类规则；扩展 `InlineSelectionSession`。
- `entrypoints/utils/wordHeuristic.ts` (新建) — `looksLikeWord` + `extractSentence`。
- `entrypoints/utils/wordPrompt.ts` (新建) — word 模式 system / user prompt + JSON parser。
- `components/WordExplainPopover.vue` (新建) — hover 浮窗组件。
- `entrypoints/style.css` — icon、popover 全局样式。

### 不修改

- 现有 `cache.ts` 模块对外接口
- 全文翻译 (`trans.ts`)
- 双语 / 仅译文 tooltip 行为
- 输入框翻译
- 非 LLM 服务模板

## 详细设计

### 1. Word 判定与句子抽取（`wordHeuristic.ts`）

仅在 `config.to === 'zh-Hans'` 启用 word 词典模式；其他目标语种自动退化为 sentence 模式。

```ts
export function looksLikeWord(raw: string, targetLang: string): boolean {
  if (targetLang !== 'zh-Hans') return false;
  const text = raw.trim();
  if (!text || text.length > 30) return false;
  if (/[.!?。！？\n\r]/.test(text)) return false;
  if (!/^[A-Za-z][A-Za-z'\-\s]*$/.test(text)) return false;  // 字母 + 撇号 + 连字符 + 空格
  if (text.split(/\s+/).length > 4) return false;            // ≤4 token，覆盖 phrasal verb
  return true;
}

export function extractSentence(range: Range, block: HTMLElement): string {
  // block.textContent 作字符串轨道，定位 range 起止字符 offset。
  // 向左/向右各扫到最近的 [.!?。！？\n] 或 block 边界，截取 trim 后返回。
  // 长度兜底：> 600 字符截断到 600。
}
```

### 2. Source tier 数据模型（`inlineSelectionTranslation.ts`）

每条 source span 多一个 `data-fr-inline-selection-tier` 属性：

```html
<span class="fr-inline-selection-source"
      data-fr-inline-selection-source="fr-inline-1234"
      data-fr-inline-selection-tier="word">important</span>
```

`InlineSelectionSession` 扩展：

```ts
export interface InlineSelectionSession {
  sourceId: string;
  tier: 'word' | 'outer';
  mode: 'word' | 'sentence';        // word↔word, outer↔sentence
  sentence?: string;                 // 仅 word 模式有值
  sourceElements: HTMLElement[];
  resultAnchor: HTMLElement;         // 挂 loading/result/icon 的锚点
  payload?: WordPayload;             // word 模式翻译完后回填，icon hover 用
}
```

### 3. 重叠选区规则（重写 `getSourceReuseDecision`）

按顺序判定：

1. **越界检查**：block 内任何 source 与 new range 部分重叠且延伸到 range 外 → 拒绝（按钮不出）。
2. **完全等同**：new range 边界 = 某个 source 边界 → 走重译路径，复用 sourceId，替换 result/payload。
3. **覆盖/绕开决策**：
   - `containedSources` = 完全落在 range 内的所有 source。
   - `newTier = looksLikeWord(rangeText, config.to) ? 'word' : 'outer'`。
   - newTier === `outer`：移除 containedSources 中 tier === `outer` 的（unwrap span + 清掉 result/status/icon），保留 tier === `word`。
   - newTier === `word`：range 太短理论不会含其它 source；万一含，拒绝（防御性）。

`collectTextFragments` 的 `acceptNode` 增加 reject：text node 的祖先链里有 `[data-fr-inline-selection-source]` → `FILTER_REJECT`。新建 outer source 自动绕开保留的 word source。

`computeResultAnchor(range, block)` = 新选区内所有 source（任 tier）按文档序最末的一个，替代 MVP 的"sourceElements 最末"。

### 4. 翻译协议（`translateApi.ts` + `template.ts` + `wordPrompt.ts`）

#### 消息契约

`runtime.sendMessage` body 扩展：

```ts
{ context, origin, mode?: 'word' | 'sentence', sentence?: string }
```

`background.ts` 的 `runtime.onMessage` 透传 `mode` / `sentence` 到 `_service[config.service](message)`，不做新分支。

#### `translateText` 签名

```ts
interface TranslateOptions {
  maxRetries?: number; retryDelay?: number; timeout?: number; useCache?: boolean;
  mode?: 'word' | 'sentence';        // 默认 sentence
  sentence?: string;                  // 仅 mode='word' 时填
}

export async function translateText(
  origin: string,
  context: string = document.title,
  options: TranslateOptions = {},
): Promise<string | WordPayload>;
```

非 word callers 永远拿 string，无需类型守卫。

#### LLM 模板分流

`template.ts` 的 4 个 LLM 模板（commonMsgTemplate / claudeMsgTemplate / geminiMsgTemplate / deepseekMsgTemplate）签名从 `(origin: string)` 改为 `(message: TranslateMessage)`：

```ts
export function commonMsgTemplate(message: TranslateMessage) {
  if (message.mode === 'word') return wordPromptTemplate(message);
  return sentencePromptTemplate(message);  // 现状代码原样
}
```

调用点（`common.ts:25` 等）顺带改一下。

#### Word prompt（英文 system，不强制 response_format）

```ts
// wordPrompt.ts
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
```

`wordPromptTemplate` 用 `temperature: 0.3`（更稳定），不传 `response_format`（豆包/通义/文心等支持度差异大，靠 prompt 强约束 + parser fence 剥离）。

各家 LLM JSON 输出处理差异由各自 template 内消化，例如 Claude 的 user prompt 末尾追加 `Respond with JSON only.`，Gemini 的 `generationConfig.responseMimeType: 'application/json'`。

#### `WordPayload` 与解析

```ts
export interface WordPayload {
  translation: string;
  ipa?: string;
  pronunciation?: string;
  definitions?: Array<{ pos: string; meaning: string }>;
  contextualMeaning?: string;
}

export function parseWordResponse(raw: string): WordPayload | null {
  try {
    const cleaned = raw.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const obj = JSON.parse(cleaned);
    if (typeof obj?.translation !== 'string' || !obj.translation.trim()) return null;
    return {
      translation: obj.translation.trim(),
      ipa: typeof obj.ipa === 'string' ? obj.ipa : undefined,
      pronunciation: typeof obj.pronunciation === 'string' ? obj.pronunciation : undefined,
      definitions: Array.isArray(obj.definitions)
        ? obj.definitions.filter((d: any) => d?.pos && d?.meaning)
            .map((d: any) => ({ pos: String(d.pos), meaning: String(d.meaning) }))
        : undefined,
      contextualMeaning: typeof obj.contextualMeaning === 'string' ? obj.contextualMeaning : undefined,
    };
  } catch {
    return null;
  }
}
```

#### LLM 服务响应分支

`common.ts` 等 handler 在拿到 content 后：

```ts
if (message.mode === 'word') {
  const payload = parseWordResponse(content);
  return payload ?? { translation: contentPostHandler(content) };  // 软降级
}
return contentPostHandler(content);
```

返回类型从 `string` 变为 `string | WordPayload`，可跨 message 透传。

### 5. Cache 策略（`translateApi.ts`）

不改 `cache.ts` 对外接口。在 translateApi 层按 mode 拼 key，word 值用 `JSON.stringify` 序列化：

```ts
function makeCacheKey(origin: string, mode: 'word' | 'sentence', sentence?: string): string {
  if (mode === 'word') return `inline-word:${djb2(origin + '|' + (sentence ?? ''))}`;
  return origin;  // sentence 模式 key 保持现状，老缓存继续命中
}
```

读：

```ts
if (useCache) {
  const key = makeCacheKey(origin, mode, sentence);
  const raw = cache.localGet(key);
  if (raw) return mode === 'word' ? JSON.parse(raw) as WordPayload : raw;
}
```

写：

```ts
if (mode === 'word') {
  // word 模式允许 translation === origin 的结果入 cache（术语场景）
  if (useCache && isValidWordPayload(result)) cache.localSet(key, JSON.stringify(result));
  return result;
}
if (!result || result === origin) return origin;  // sentence 模式保持现行
if (useCache) cache.localSet(key, result);
return result;
```

不引入新失效机制。

### 6. UI 实现

#### 6.1 Inline 译文 + icon 渲染（修改 `inlineSelectionTranslation.ts`）

`completeInlineSelectionTranslation` 签名扩展：

```ts
export function completeInlineSelectionTranslation(
  session: InlineSelectionSession,
  translatedText: string,
  payload?: WordPayload,
): void;
```

result span 渲染规则：

- 始终渲染 `<span class="fr-inline-selection-result">`，作为 icon 容器。
- `translation === origin` 时（术语 + 译文 = 原文），span 内不渲染中文文本，加 `is-empty` class（去掉左 margin）；icon 紧贴原文。
- `payload && session.mode === 'word'` 时，span 内 append icon SVG。
- 否则（sentence 模式或软降级）不 append icon。

icon SVG（11×11 书形）样式（写入 `style.css`）：

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
.fr-inline-selection-result:hover .fr-inline-selection-icon { color: #4f8cff; }
.fr-inline-selection-result.is-empty { margin-left: 4px; }
```

icon 的 hover 监听由 `inlineSelectionTranslation.ts` 直接挂在 SVG 上：mouseenter 200ms 后挂载 popover 组件，mouseleave 150ms 后卸载（鼠标移到 popover 上时取消卸载）。

#### 6.2 `WordExplainPopover.vue`（新建）

布局：B 版（contextual 高亮置顶）。

```vue
<template>
  <div class="fr-word-popover" :class="{ 'fr-dark-theme': isDarkTheme }">
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
</template>
```

宽度 280px，圆角 10px，阴影 `0 8px 24px rgba(0,0,0,0.10)`，dark mode 适配。

挂载用 `@floating-ui/dom` 的 `computePosition` + `autoPlacement` + `offset(8)` + `shift({ padding: 8 })`，referenceElement 是 icon SVG，container 是 `document.body`。`autoUpdate` 监听滚动 / resize。

popover 打开时给 source span 加 `.fr-source-active`：

```css
.fr-inline-selection-source.fr-source-active {
  background: rgba(79,140,255,0.20);
}
```

popover 关闭时移除该 class。

#### 6.3 popup 设置页门控（`Main.vue` + `option.ts`）

`option.ts`：

```ts
import { servicesType } from './option';
export const isLLMService = (s: string) => servicesType.AI.has(s);
```

`Main.vue` el-option：

```vue
<el-option
  label="内联翻译"
  value="inline"
  :disabled="!isLLMService(config.service)" />
```

并在 `<el-tooltip>` 文案里说明：`内联翻译需要 LLM 服务（OpenAI / Claude / Gemini / DeepSeek 等）才能启用词典浮窗`。

服务切换 watch（如不存在则新增）：

```ts
watch(() => config.value.service, (newService) => {
  if (config.value.selectionTranslatorMode === 'inline' && !isLLMService(newService)) {
    config.value.selectionTranslatorMode = 'bilingual';
    ElMessage.info('当前服务不支持内联翻译，已自动切换为双语弹窗');
  }
});
```

### 7. 错误处理与降级

| 场景 | 行为 |
|------|------|
| word 模式 LLM 返回非合法 JSON | `parseWordResponse` 返回 null → handler 回填 `{translation: rawText}` 当字符串；result span 不渲染 icon |
| word 模式 LLM 返回 JSON 缺 translation 字段 | 同上 |
| word 模式 LLM 返回 JSON 但 ipa/definitions 等缺 | 渲染译文 + icon；popover 各 section v-if，缺啥不渲染啥 |
| 网络错误 / 超时 | 沿用 MVP 红字"翻译失败" |
| 非中文目标语种 + word 选区 | `looksLikeWord` 返回 false → tier=outer → sentence 模式，无 icon |
| 同句重复划同词 | cache 命中，0 延迟 |
| 用户切到非 LLM 服务后又切回 | 自动回退 bilingual + toast；用户须手动改回 inline |
| popover 加载完前用户关闭 | Vue v-if 控制，组件卸载无副作用 |
| source DOM 被站点脚本删除 | cleanup 时 querySelectorAll 自然找不到，无报错 |

#### Vue 层错误边界

```ts
const result = await translateText(inlineText, undefined, {
  mode: session.mode,
  sentence: session.sentence,
});

if (typeof result === 'string') {
  completeInlineSelectionTranslation(session, result);  // 软降级，无 icon
} else {
  session.payload = result;
  completeInlineSelectionTranslation(session, result.translation, result);
}
```

#### 日志原则

按 CLAUDE.md，翻译服务实现中**不打印请求体**。失败时只打印 error.message，不打印 origin / sentence / response body。

## 验收

仓库无测试框架，全程 `pnpm compile` + 浏览器手动验证。

### 编译检查

```bash
pnpm compile
```

类型变化集中在：
- `translateText` 返回 `string | WordPayload`
- 4 个 LLM 模板签名 `(message: TranslateMessage)`
- `InlineSelectionSession` 增加 `tier` / `mode` / `sentence` / `resultAnchor` / `payload`
- `completeInlineSelectionTranslation` 增加第三参数 payload

### popup 设置页

1. 服务设为 OpenAI → 内联翻译可选。
2. 服务设为 Microsoft → 内联翻译选项 disabled，tooltip 解释原因。
3. 当前 inline，服务从 OpenAI 切到 Microsoft → 自动回退双语 + toast。

### 单词翻译 + popover

测试页：英文文章，目标语 = 简体中文，服务 = OpenAI。

1. 划 "constraint" → 译按钮 → 点击：原文蓝下划线，译文 "约束" 紧跟，11px 书形 icon `transform: translateY(-0.45em)`。
2. hover icon 200ms → popover：标题 + IPA + pronunciation；蓝条高亮 contextualMeaning；下方完整释义。
3. 离开 icon 150ms → popover 收起；进 popover 不收起。
4. 同句重划同词 → cache 命中，loading 一闪而过。
5. 切到含相同词的不同句子 → cache miss，contextualMeaning 应针对新句子。

### 术语翻译

1. 划 "OAuth" → 点译。
2. 译文区段不渲染中文（translation === origin），仅留 icon。
3. popover：contextual 是术语解释，definitions 可能仅 1 条。
4. 划 "Kubernetes"、"embedding" 类似行为。

### 重叠选区 / source tier

1. 先翻 "important"（tier=word）。
2. 再划包含 important 的句子 → 触发；新 outer source 包 "This is " + " text"；下划线在 important 处断开；句子译文落在 "text" 之后；句子 icon 不出。
3. 再划整段（含已有句子 + 别的句子）→ 句子级老 outer 被覆盖；word source 保留。
4. 划切到 source 中间的范围 → 拒绝。
5. 划恰好等于已有 outer source 的范围 → 重译并替换。

### 软降级 / 异常

1. 故意构造 prompt 让模型不返回 JSON → 译文照常显示，无 icon。
2. 断网划单词 → 红字"翻译失败"。
3. 极快连续划不同词 → queue 串行无错乱。
4. 翻译进行中切换 popup 模式 → 老 inline 翻译完成后被 cleanup，无残留 DOM。

### 跨浏览器

按 CLAUDE.md 要求，至少 Chromium 全验。Firefox 跑 popover + 重叠选区核心场景，确认 floating-ui 与 transform 视觉一致。

### 无回归

- 全文翻译开/关
- 双语 / 仅译文 tooltip hover
- 输入框 Ctrl+Enter 翻译

## 决策记录

| # | 决策 | 关键理由 |
|---|------|----------|
| Q1 | 仅 LLM 服务支持词典 | 改造面最小，user 主要使用 LLM 服务 |
| Q2 | word 模式传"句子"作 context；句/段不传 | 单句够消歧义，token 成本可控 |
| Q3 | 客户端启发式判 word | sentence 路径稳定，错判降级即可理解 |
| Q4 | 美音 only / 去顶层 pos / contextualMeaning 单行 / 不要例句、同义反义、词根 / 英文常见词类比发音 | 精简 popover，专注核心信息 |
| Q5 | 术语复用 word prompt；译文 = 原文不重复渲染 | 减少分支；视觉去噪 |
| Q6 | source tier=word/outer 二元；最多 2 层 | 数据模型简单；规则可枚举 |
| Q7 | icon 嵌 result span；仅词典数据存在时渲染；200/150ms 防抖；floating popover；纯 hover | 视觉与功能解耦；与 Element Plus tooltip 默认一致 |
| Q8a | word cache 独立 namespace + sentence-hash key | 同句复用，跨句不误命中 |
| Q8b | JSON 解析失败软降级到纯文本 | 用户感知最低，无重试浪费 |
| Q8c | popup UI 把 inline 选项 LLM-only disabled | 明确约束，避免用户切非 LLM 后困惑 |

## 视觉决策

| # | 决策 | 关键理由 |
|---|------|----------|
| icon 风格 | 11×11 书形 SVG，`transform: translateY(-0.45em)` | 视觉辨识度好；transform 而非 absolute，与 result span 是否有文本解耦 |
| popover 布局 | Variant B (contextual 置顶) | 用户优先关心当前语境含义，词典释义降为辅助 |
| popover 宽度 | 280px | 足以容纳 IPA 与定义，又不过宽 |
| source 高亮 | popover 打开时加 `.fr-source-active` 加深背景 | 提示 popover 与原文的对应关系 |

## 参考

- 上一版 MVP：[2026-05-06 内联划词翻译 MVP 设计](./2026-05-06-inline-selection-translation-design.md)
- MVP 实现计划：[`docs/superpowers/plans/2026-05-06-inline-selection-translation.md`](../plans/2026-05-06-inline-selection-translation.md)
- CLAUDE.md：项目编码与协作约定
