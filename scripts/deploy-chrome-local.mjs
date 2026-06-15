#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_EXTENSION_ID = 'dbkfbapmknekjhcipdicjpojlemcgehj';
export const DEFAULT_TARGET_DIR =
  '/Users/shixuran/work_space/google-extensions/readcopilot-0.0.30-chrome';

const DEFAULT_SOURCE_DIR = '.output/chrome-mv3';

export function createDeployOptions(argv = [], env = process.env, cwd = process.cwd()) {
  const options = {
    cwd,
    sourceDir: path.resolve(cwd, env.CHROME_EXTENSION_SOURCE_DIR || DEFAULT_SOURCE_DIR),
    targetDir: path.resolve(env.CHROME_EXTENSION_DIR || DEFAULT_TARGET_DIR),
    extensionId: env.CHROME_EXTENSION_ID || DEFAULT_EXTENSION_ID,
    dryRun: false,
    skipBuild: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--skip-build') {
      options.skipBuild = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--target-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--target-dir requires a directory path');
      }
      options.targetDir = path.resolve(cwd, value);
      index += 1;
      continue;
    }

    if (arg === '--source-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--source-dir requires a directory path');
      }
      options.sourceDir = path.resolve(cwd, value);
      index += 1;
      continue;
    }

    if (arg === '--extension-id') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--extension-id requires an extension id');
      }
      options.extensionId = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

export function getHelpText() {
  return [
    'Usage: pnpm deploy:chrome-local [--dry-run] [--skip-build]',
    '',
    'Builds the WXT Chromium extension and syncs it into the unpacked Chrome',
    'extension directory that Chrome already loads locally.',
    '',
    'Options:',
    '  --dry-run               Print the build and sync steps without running them',
    '  --skip-build            Sync the current .output/chrome-mv3 build as-is',
    '  --source-dir <path>     Override the WXT build directory',
    '  --target-dir <path>     Override the local Chrome unpacked extension directory',
    '  --extension-id <id>     Override the Chrome extension id printed at the end',
    '',
    `Default target: ${DEFAULT_TARGET_DIR}`,
    `Default extension page: chrome://extensions/?id=${DEFAULT_EXTENSION_ID}`,
  ].join('\n');
}

async function readManifest(extensionDir) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const content = await fs.readFile(manifestPath, 'utf8');
  return JSON.parse(content);
}

async function listDirectoryEntries(directory) {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function validateManifestPair(sourceDir, targetDir) {
  let sourceManifest;

  try {
    sourceManifest = await readManifest(sourceDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Source build is missing manifest.json: ${sourceDir}`);
    }
    throw error;
  }

  let targetManifest = null;
  try {
    targetManifest = await readManifest(targetDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  if (targetManifest && targetManifest.name !== sourceManifest.name) {
    throw new Error(
      `Target extension name mismatch: expected "${sourceManifest.name}", found "${targetManifest.name}"`,
    );
  }

  if (!targetManifest) {
    const entries = (await listDirectoryEntries(targetDir)).filter((entry) => entry !== '.DS_Store');
    if (entries.length > 0) {
      throw new Error(`Target directory has files but no manifest.json: ${targetDir}`);
    }
  }

  return { sourceManifest, targetManifest };
}

function appendTrailingSlash(directory) {
  return directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatCommand(command, args) {
  return [command, ...args].map(shellQuote).join(' ');
}

export function runCommand(command, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${formatCommand(command, args)} exited with code ${code}`));
    });
  });
}

export async function deployChromeLocal({
  cwd,
  sourceDir,
  targetDir,
  extensionId,
  dryRun,
  skipBuild,
  runCommand: commandRunner = runCommand,
  log = console.log,
}) {
  const extensionPageUrl = `chrome://extensions/?id=${extensionId}`;
  const rsyncArgs = [
    '-a',
    '--delete',
    appendTrailingSlash(sourceDir),
    appendTrailingSlash(targetDir),
  ];

  log('ReadCopilot local Chrome deploy');
  log(`Source: ${sourceDir}`);
  log(`Target: ${targetDir}`);
  log(`Extension page: ${extensionPageUrl}`);

  if (dryRun) {
    log('');
    log('Dry run only. No files will be changed.');
    if (!skipBuild) {
      log(`Would run: ${formatCommand('pnpm', ['build'])}`);
    }
    log(`Would run: ${formatCommand('rsync', rsyncArgs)}`);
    return { dryRun, extensionPageUrl };
  }

  if (!skipBuild) {
    log('');
    log('Building Chromium extension...');
    await commandRunner('pnpm', ['build'], { cwd });
  }

  await validateManifestPair(sourceDir, targetDir);
  await fs.mkdir(targetDir, { recursive: true });

  log('');
  log('Syncing build output into the local Chrome extension directory...');
  await commandRunner('rsync', rsyncArgs, { cwd });

  log('');
  log('Local extension package has been updated.');
  log(`Open ${extensionPageUrl} and click the reload button for this extension.`);

  return { dryRun, extensionPageUrl };
}

async function main() {
  const options = createDeployOptions(process.argv.slice(2));

  if (options.help) {
    console.log(getHelpText());
    return;
  }

  await deployChromeLocal(options);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
