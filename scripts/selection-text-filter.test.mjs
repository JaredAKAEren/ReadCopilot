import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import ts from 'typescript';

async function loadWordHeuristicModule() {
  const sourcePath = path.resolve('entrypoints/utils/wordHeuristic.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'selection-text-filter-'));
  const outputPath = path.join(tempDir, 'wordHeuristic.mjs');
  await fs.writeFile(outputPath, compiled.outputText);
  return import(pathToFileURL(outputPath).href);
}

test('allows selected text only when it contains translatable non-Chinese text', async () => {
  const { isAllNonChineseSelectionText } = await loadWordHeuristicModule();

  assert.equal(isAllNonChineseSelectionText('constraint'), true);
  assert.equal(isAllNonChineseSelectionText('GraphQL resolver returns 404.'), true);
  assert.equal(isAllNonChineseSelectionText('OAuth 2.0 / Kubernetes'), true);
  assert.equal(isAllNonChineseSelectionText('C++'), true);
  assert.equal(isAllNonChineseSelectionText('404'), true);
  assert.equal(isAllNonChineseSelectionText('かなカナ'), true);

  assert.equal(isAllNonChineseSelectionText('中文'), false);
  assert.equal(isAllNonChineseSelectionText('hello 世界'), false);
  assert.equal(isAllNonChineseSelectionText('API 接口'), false);
  assert.equal(isAllNonChineseSelectionText('日本語の漢字'), false);
  assert.equal(isAllNonChineseSelectionText('!@#$%^&*()'), false);
  assert.equal(isAllNonChineseSelectionText('---'), false);
  assert.equal(isAllNonChineseSelectionText('……'), false);
  assert.equal(isAllNonChineseSelectionText('，。！？'), false);
  assert.equal(isAllNonChineseSelectionText('🙂'), false);
  assert.equal(isAllNonChineseSelectionText('   '), false);
});
