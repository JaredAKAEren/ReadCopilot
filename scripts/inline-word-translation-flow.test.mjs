import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import ts from 'typescript';

async function loadFlowModule() {
  const sourcePath = path.resolve('entrypoints/utils/inlineWordTranslationFlow.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-word-flow-'));
  const outputPath = path.join(tempDir, 'inlineWordTranslationFlow.mjs');
  await fs.writeFile(outputPath, compiled.outputText);
  return import(pathToFileURL(outputPath).href);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test('renders fast translation first and replaces it with rich payload later', async () => {
  const { runInlineWordTranslationFlow } = await loadFlowModule();
  const fast = deferred();
  const rich = deferred();
  const events = [];
  const timings = [];

  const flow = runInlineWordTranslationFlow({
    fastRequest: () => fast.promise,
    richRequest: () => rich.promise,
    onFastResult: (text) => events.push(`fast:${text}`),
    onRichResult: (text, payload) => events.push(`rich:${text}:${payload?.ipa ?? 'no-ipa'}`),
    onTiming: (stage, elapsedMs) => timings.push(`${stage}:${elapsedMs}`),
    now: (() => {
      let value = 0;
      return () => value += 5;
    })(),
  });

  fast.resolve('约束');
  await flushMicrotasks();
  assert.deepEqual(events, ['fast:约束']);

  rich.resolve({ translation: '约束', ipa: '/kənˈstreɪnt/' });
  await flow;

  assert.deepEqual(events, ['fast:约束', 'rich:约束:/kənˈstreɪnt/']);
  assert.deepEqual(timings.map((item) => item.split(':')[0]), ['fast', 'rich', 'total']);
});

test('ignores a late fast translation when rich payload already rendered', async () => {
  const { runInlineWordTranslationFlow } = await loadFlowModule();
  const fast = deferred();
  const rich = deferred();
  const events = [];

  const flow = runInlineWordTranslationFlow({
    fastRequest: () => fast.promise,
    richRequest: () => rich.promise,
    onFastResult: (text) => events.push(`fast:${text}`),
    onRichResult: (text, payload) => events.push(`rich:${text}:${payload?.contextualMeaning ?? 'none'}`),
  });

  rich.resolve({ translation: '骨干网络', contextualMeaning: '网络主干' });
  await flushMicrotasks();
  assert.deepEqual(events, ['rich:骨干网络:网络主干']);

  fast.resolve('主干');
  await flow;

  assert.deepEqual(events, ['rich:骨干网络:网络主干']);
});

test('keeps fast translation when rich payload fails', async () => {
  const { runInlineWordTranslationFlow } = await loadFlowModule();
  const fast = deferred();
  const rich = deferred();
  const events = [];

  const flow = runInlineWordTranslationFlow({
    fastRequest: () => fast.promise,
    richRequest: () => rich.promise,
    onFastResult: (text) => events.push(`fast:${text}`),
    onRichResult: (text) => events.push(`rich:${text}`),
  });

  fast.resolve('限制');
  await flushMicrotasks();
  rich.reject(new Error('rich failed'));
  await flow;

  assert.deepEqual(events, ['fast:限制']);
});

test('throws only when both fast and rich requests fail', async () => {
  const { runInlineWordTranslationFlow } = await loadFlowModule();
  const fast = deferred();
  const rich = deferred();
  const events = [];

  const flow = runInlineWordTranslationFlow({
    fastRequest: () => fast.promise,
    richRequest: () => rich.promise,
    onFastResult: (text) => events.push(`fast:${text}`),
    onRichResult: (text) => events.push(`rich:${text}`),
  });

  fast.reject(new Error('fast failed'));
  rich.reject(new Error('rich failed'));

  await assert.rejects(flow, /fast failed|rich failed/);
  assert.deepEqual(events, []);
});

test('word mode cache accepts any valid word payload, including soft fallback payloads', async () => {
  const source = await fs.readFile(path.resolve('entrypoints/utils/translateApi.ts'), 'utf8');

  assert.match(source, /if \(useCache && isValidWordPayload\(result\)\) \{/);
  assert.doesNotMatch(source, /hasRichWordPayload\(result\)/);
});
