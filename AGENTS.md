# Repository Guidelines

## Project Structure & Module Organization
This is a WXT browser extension built with Vue 3 and TypeScript. Runtime entry points live in `entrypoints/`: `background.ts` handles extension background work, `content.ts` loads content behavior, `main/` contains page translation DOM logic, `popup/` contains the extension popup, `offscreen/` contains offscreen worker UI, `service/` contains translation providers, and `utils/` contains shared helpers. Reusable Vue components are in `components/`. Shared styles live in `styles/` and entry-specific CSS files. Static icons are in `public/icon/`. VitePress documentation is under `docs/`, with extra images and English README assets in `misc/`.

## Build, Test, and Development Commands
Use `pnpm install` to install dependencies and run WXT preparation. Start Chromium extension development with `pnpm dev`; use `pnpm dev:firefox` for Firefox. Build production artifacts with `pnpm build` or `pnpm build:firefox`. Package zips with `pnpm zip` and `pnpm zip:firefox`. Run `pnpm compile` before submitting changes to type-check Vue and TypeScript. Documentation commands are `pnpm docs:dev`, `pnpm docs:build`, and `pnpm docs:preview`.

## Coding Style & Naming Conventions
Write TypeScript and Vue single-file components using the existing composition-style patterns. Use two-space indentation in Vue, TypeScript, CSS, and JSON. Prefer descriptive camelCase names for variables, functions, and matching utility files, such as `selectionTranslator.ts`. Vue components use PascalCase filenames, for example `FloatingBall.vue`. Keep translation engines isolated in `entrypoints/service/`; shared provider contracts belong in `_service.ts` and `common.ts`.

## Testing Guidelines
No dedicated test framework is currently configured. Treat `pnpm compile` as the required baseline check. For extension behavior, manually verify the affected browser target with `pnpm dev` or `pnpm dev:firefox`, including popup settings, content-script translation, selection translation, and any touched provider configuration. If tests are added later, place them near the changed module and use clear `*.test.ts` or `*.spec.ts` names.

## Commit & Pull Request Guidelines
Recent history uses short imperative commits, often with Conventional Commit prefixes such as `fix:`, `feat:`, and `build:`; follow that style where practical, for example `fix: correct selection popup positioning`. Pull requests should describe the user-facing change, list verification steps, link related issues, and include screenshots or GIFs for popup, styling, or content-script UI changes. Call out browser coverage when behavior differs between Chrome, Edge, and Firefox.

## Security & Configuration Tips
Do not commit API keys, provider tokens, or local browser profiles. Keep provider-specific secrets in extension storage or local development configuration. When changing translation providers, avoid logging request payloads that may contain page text or user selections.
