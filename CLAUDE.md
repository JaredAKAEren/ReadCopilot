# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

流畅阅读（FluentRead）是一款基于 WXT 的浏览器翻译扩展，提供全文翻译、划词翻译、输入框翻译三大入口，集成 20+ 家传统机器翻译与 LLM 翻译服务。技术栈为 Vue 3 + TypeScript，包管理器使用 pnpm，从同一份源码同时构建 Chromium 与 Firefox 版本。

## 常用命令

```bash
pnpm install            # 安装依赖；postinstall 会自动执行 wxt prepare
pnpm dev                # Chromium 开发模式（HMR）
pnpm dev:firefox        # Firefox 开发模式
pnpm build              # 生产构建（Chromium）
pnpm build:firefox      # 生产构建（Firefox）
pnpm zip / pnpm zip:firefox   # 打包成应用商店上传所需的 zip
pnpm compile            # vue-tsc --noEmit；提交前必须执行的基础检查
pnpm docs:dev           # 在 ./docs 启动 VitePress 文档站点
```

仓库未配置测试框架。修改后请在对应浏览器目标下用 `pnpm dev` 手动验证 popup 设置、全文翻译、划词翻译、输入框翻译以及涉及到的翻译服务。若 Chrome / Edge / Firefox 之间存在差异，需在 PR 中明确说明。

## 架构

### 入口与消息流

WXT 会自动注入 `defineBackground`、`defineContentScript`、`browser`、`storage` 等全局符号（参见 `wxt.config.ts` 中的 polyfill 模块和 Vue 自动导入插件）。Manifest 权限在 `wxt.config.ts` 中声明：`storage`、`contextMenus`、`offscreen`。

- `entrypoints/background.ts`：注册 FluentRead 右键菜单，跟踪每个 tab 的翻译状态，并作为消息总线。`runtime.onMessage` 监听器对普通翻译请求分发到 `_service[config.service](message)`；输入框翻译走独立分支 `inputBoxTranslation`，由 background 直接调用微软翻译 API，以规避 Firefox 内容脚本的 CORS 限制。
- `entrypoints/content.ts`：在 `<all_urls>` 上以 `document_end` 注入。先 `await configReady`，再装配：悬浮快捷键触发的取词翻译（`setupManualTranslationTriggers`）、全文翻译快捷键（`setupFloatingBallHotkey`，通过派发 `fluentread-toggle-translation` CustomEvent 解耦）、输入框翻译触发器（`Ctrl+Enter` 或连按三次空格 / `=` / `-`），以及来自右键菜单和 popup 的运行时消息处理；同时挂载悬浮球、划词翻译、翻译状态等 Vue 组件。
- `entrypoints/popup/`：Vue 3 设置面板，使用 Element Plus，组件在 `popup/main.ts` 中按需注册。
- `entrypoints/offscreen/`：当某些功能需要稳定的 DOM 上下文时使用的 offscreen 文档。

### 全文翻译流水线

`entrypoints/main/`：
- `dom.ts`：节点筛选规则。`grabAllNode` 用 `TreeWalker` 遍历 DOM，根据 `directSet`（块级标签作为整体翻译）、`skipSet`（永不翻译）、`inlineSet`（可作为可翻译父级的内联子元素）进行裁剪。`LLMStandardHTML`、`beautyHTML` 用于为 LLM 类提供商整理 HTML。
- `trans.ts`：编排 `autoTranslateEnglishPage`、悬停触发的 `handleTranslation`，以及 `restoreOriginalContent`。已翻译节点会被打上 `data-fr-translated="true"` 和 `data-fr-node-id="<n>"`，原始 innerHTML 保存在模块级 `originalContents` Map 中（按 node-id 索引）。一次翻译过程会启用两个观察器：`IntersectionObserver` 用于按可见性懒翻译、`MutationObserver` 用于捕获新插入的节点。还原时遍历所有 `[data-fr-translated]`，按 node-id 取回原始内容并断开两个观察器。
- `compat.ts`：站点适配（`getMainDomain`、`replaceCompatFn`、`selectCompatFn`），用于覆盖默认的节点选择或文本替换逻辑。

CSS 约定：翻译内容使用 `fluent-read-bilingual`、`fluent-read-bilingual-content`、`fluent-read-loading`、`fluent-read-failure`、`fluent-read-retry-wrapper` 等类名。`restoreOriginalContent` / `clearAllTranslations` 依赖这些类名做查询，请保持稳定。

### 翻译服务

`entrypoints/service/`：
- `_service.ts` 是服务注册表，将 `services.<name>` 映射到 `(message) => Promise<string>` 的处理函数。新增服务的步骤：在此目录下实现处理函数模块、在 `_service` 中注册、在 `entrypoints/utils/option.ts` 中加上 `services` 键、再在 popup UI 中暴露。
- `common.ts` 是通用的 OpenAI Schema 实现，被 openai、moonshot、baichuan、lingyi、jieyue、groq、doubao、siliconCloud、openrouter、grok 等共用。各家厂商专属的鉴权、请求体、流式细节放在独立文件，如 `claude.ts`、`gemini.ts`、`deepl.ts`、`microsoft.ts`、`tencent.ts`。按 AGENTS 指南要求，共享契约放在 `_service.ts` 与 `common.ts`，单个引擎要保持隔离。

### 客户端翻译入口

`entrypoints/utils/`：
- `translateApi.ts`：`translateText(origin, context, options)` 是所有 UI 入口（全文 / 划词 / 输入框）共用的统一函数。当 `detectlang(origin) === config.to` 时直接返回原文；如启用 `config.useCache` 会先查 `cache`；之后通过 `enqueueTranslation` 包成任务，再以 `{ context, origin }` 经 `browser.runtime.sendMessage` 转发到 background。重试、超时、取消逻辑都集中在这里。
- `translateQueue.ts`：全局并发闸（默认值 `config.maxConcurrentTranslations = 6`），全文、划词、内联划词翻译共用同一队列。
- `config.ts` / `model.ts`：`config` 是带默认值的可变单例，启动时通过 `storage.getItem('local:config')` 注水（`configReady` Promise 暴露），并经 `storage.watch` 与存储保持同步。异步启动路径中读取 config 之前必须 `await configReady`。修改时直接写字段，再把整个 JSON 写回 `local:config` 即可持久化。
- `cache.ts`：以原文为键的翻译缓存，附带定期清理。
- `selectionTranslator.ts` / `floatingBall.ts` / `newApi.ts`：命令式 `mount` / `unmount` 帮助函数；在 `document.body` 下创建容器并 `createApp(Component)`，根据来自 popup 的运行时消息切换显示。
- `inlineSelectionTranslation.ts`：内联划词翻译 MVP，用 `data-fr-inline-selection-source` / `-status` / `-result` 三个属性管理每个翻译源的状态。
- `constant.ts`：快捷键标识（`DoubleClick`、`LongPress`、`MiddleClick`、`TwoFinger` / `ThreeFinger` / `FourFinger`、`DoubleClickScreen` / `TripleClickScreen`）和 `CONTEXT_MENU_IDS`。

### 组件

`components/` 同时承载内容脚本挂载的 SFC（`FloatingBall.vue`、`SelectionTranslator.vue`、`TranslationStatus.vue`）和 popup 内的 SFC（`Header.vue`、`Main.vue`、`Footer.vue`、`CustomHotkeyInput.vue`）。组件文件名使用 PascalCase，对应的工具文件使用 camelCase（例如 `selectionTranslator.ts`）。

## 编码与协作约定

- Vue / TS / CSS / JSON 一律两个空格缩进；新代码使用 Vue 3 Composition API。
- 提交信息使用 Conventional Commits 风格（`feat:` / `fix:` / `build:` / `chore:` / `docs:`），主语简洁、祈使句。
- 翻译服务实现中不要打印请求体，避免泄露用户页面文本或选区。
- 不要把 API key、厂商 token 或本地浏览器配置提交进仓库；密钥放在扩展存储里。

## 参考文档

- `AGENTS.md`：贡献者指南（目录结构、命令、规范、安全提示）。修改时请保持与本文件同步。
- `README.md`：面向用户的中文介绍与各浏览器商店安装入口。
- `docs/`：发布到官方文档站点的 VitePress 源。
