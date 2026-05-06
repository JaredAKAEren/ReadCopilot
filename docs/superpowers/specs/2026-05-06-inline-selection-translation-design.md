# Inline Selection Translation MVP Design

## Goal

Add a new selection translation mode that translates selected text inline, without replacing the existing tooltip-based selection translator. Users select a word or sentence, click a small `译` button near the selection, and see a muted translated phrase directly after the selected text.

## Scope

This MVP adds `inline` as a new `selectionTranslatorMode` option alongside `disabled`, `bilingual`, and `translation-only`.

In scope:

- Show a `译` action button at the selected text's upper-right edge.
- Translate only after the user clicks the button.
- Reuse the existing `translateText()` pipeline, including provider configuration, queueing, cache, retries, and target language.
- Insert an inline loading indicator immediately after the selected text while translation is pending.
- Replace loading with a smaller, lower-contrast inline translation on success.
- Add a plugin-owned underline or subtle marker to the selected source text.
- Support selections within one block container, including inline children such as `span`, `strong`, and `a`.

Out of scope:

- Cross-paragraph or cross-block selection insertion.
- New translation provider behavior.
- A separate history panel, copy controls, audio controls, or cleanup UI.
- Automated tests, because the project does not currently configure a test runner.

## Architecture

`SelectionTranslator.vue` remains the mounted component for all selection translation modes. It continues to own selection event handling, selected text state, current `Range`, and Floating UI positioning.

When `config.selectionTranslatorMode === 'inline'`, the component renders the compact `译` button instead of the current red dot and tooltip. On click, it calls a new helper in `entrypoints/utils/inlineSelectionTranslation.ts`.

The helper owns DOM mutation:

- Validate whether the selected `Range` is inside one block container.
- Insert loading markup after the selected range.
- Mark selected source text with `data-fr-inline-selection-source`.
- Replace loading with translated text or a compact error message.
- Reuse or replace an existing inline translation for the same source marker.
- Expose cleanup helpers for component unmount and page unload.

Existing `bilingual` and `translation-only` modes keep the current tooltip behavior.

## Interaction Flow

1. User selects text.
2. If the selection is non-empty, under the existing length limit, and valid for inline mode, show `译` near the upper-right of the range.
3. User clicks `译`.
4. Preserve the browser's natural selection behavior; do not force-clear it.
5. Insert an inline loading icon immediately after the selected text.
6. Call `translateText(selectedText)`.
7. On success, replace loading with muted inline translation text.
8. On failure, replace loading with a compact retryable error label such as `翻译失败`.

Selecting other text only moves the button. Existing inline translations remain in the page.

## DOM Rules

Inline mode supports selections that share one nearest block container, such as one `p`, `li`, or heading. It can cross inline descendants within that block. Cross-block selections must hide the action button; the click handler must also revalidate the range and return without DOM mutation if the range is invalid.

Source marking should prefer `Range.surroundContents()` when possible. If it fails because the selection crosses inline boundaries, the helper should split text nodes and wrap selected text fragments. All inserted or wrapped nodes must use FluentRead-specific classes and `data-fr-*` attributes so cleanup and duplicate detection are reliable.

The translated text should be inline, visually secondary, and layout-light: smaller font size, muted color, and a small left margin. It should not create a new line by default.

## Validation

Required checks:

- `pnpm compile` passes.
- Popup setting includes `内联翻译` and sends `updateSelectionTranslatorMode`.
- `disabled`, `bilingual`, and `translation-only` behavior still works.
- Inline mode works for plain text and same-block selections across `span`, `strong`, and `a`.
- Cross-paragraph selection does not mutate the page.
- Loading is removed after success or failure.
- Repeated translation of the same marked source replaces the existing translation instead of appending duplicates.
