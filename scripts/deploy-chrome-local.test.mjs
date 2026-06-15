import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_EXTENSION_ID,
  DEFAULT_TARGET_DIR,
  createDeployOptions,
  deployChromeLocal,
  validateManifestPair,
} from './deploy-chrome-local.mjs';

test('createDeployOptions points at the WXT chrome build and fixed local Chrome directory by default', () => {
  const cwd = '/repo/readcopilot';
  const options = createDeployOptions([], {}, cwd);

  assert.equal(options.cwd, cwd);
  assert.equal(options.sourceDir, path.resolve(cwd, '.output/chrome-mv3'));
  assert.equal(options.targetDir, DEFAULT_TARGET_DIR);
  assert.equal(options.extensionId, DEFAULT_EXTENSION_ID);
  assert.equal(options.dryRun, false);
  assert.equal(options.skipBuild, false);
});

test('createDeployOptions supports dry-run and target directory override', () => {
  const cwd = '/repo/readcopilot';
  const options = createDeployOptions(
    ['--dry-run', '--skip-build', '--target-dir', '../google-extensions/readcopilot'],
    {},
    cwd,
  );

  assert.equal(options.dryRun, true);
  assert.equal(options.skipBuild, true);
  assert.equal(options.targetDir, path.resolve(cwd, '../google-extensions/readcopilot'));
});

test('validateManifestPair refuses to deploy over another extension directory', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readcopilot-deploy-'));
  const sourceDir = path.join(tempDir, 'source');
  const targetDir = path.join(tempDir, 'target');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: '流畅阅读', version: '1.0.0' }),
  );
  await fs.writeFile(
    path.join(targetDir, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 'Other Extension', version: '1.0.0' }),
  );

  await assert.rejects(
    () => validateManifestPair(sourceDir, targetDir),
    /Target extension name mismatch/,
  );
});

test('deployChromeLocal dry-run prints intended build and sync without running commands', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readcopilot-deploy-'));
  const sourceDir = path.join(tempDir, 'source');
  const targetDir = path.join(tempDir, 'target');
  const calls = [];
  const logs = [];

  const result = await deployChromeLocal({
    cwd: tempDir,
    sourceDir,
    targetDir,
    extensionId: 'abc123',
    dryRun: true,
    skipBuild: false,
    runCommand: async (...args) => calls.push(args),
    log: (message = '') => logs.push(message),
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual(calls, []);
  assert.equal(result.extensionPageUrl, 'chrome://extensions/?id=abc123');
  assert.match(logs.join('\n'), /pnpm build/);
  assert.match(logs.join('\n'), /rsync -a --delete/);
});
