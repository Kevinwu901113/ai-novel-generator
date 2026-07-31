#!/usr/bin/env node
/**
 * Smoke test for the packaged Electron app.
 *
 * Launches the app with --smoke-test, which triggers a minimal path:
 *   main process → create window → load renderer → preload healthCheck → exit 0
 *
 * Exits 0 on success, 1 on failure.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'out');

/** Check asar contents for forbidden files and verify grill API presence. */
function checkAsarContents(appPath) {
  const require = createRequire(import.meta.url);
  let asar;
  try {
    asar = require('@electron/asar');
  } catch {
    // Try the legacy package name
    try {
      asar = require('asar');
    } catch {
      console.warn('[smoke-test] asar package not found, skipping content check');
      return true;
    }
  }

  // Find asar file
  let asarPath;
  if (process.platform === 'darwin') {
    asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  } else {
    asarPath = path.join(appPath, 'resources', 'app.asar');
  }

  if (!existsSync(asarPath)) {
    console.warn('[smoke-test] asar not found at', asarPath);
    return true;
  }

  const files = asar.listPackage(asarPath);
  const violations = [];

  for (const file of files) {
    if (file.endsWith('.test.js') || file.endsWith('.test.ts') || file.endsWith('.test.d.ts')) {
      violations.push(`test file: ${file}`);
    }
    if (file.endsWith('.map')) {
      violations.push(`source map: ${file}`);
    }
  }

  if (violations.length > 0) {
    console.error('[smoke-test] asar contains forbidden files:');
    for (const v of violations) {
      console.error(`  - ${v}`);
    }
    return false;
  }

  // Verify grill API channels are present in preload
  const preloadFile = files.find((f) => f.includes('preload') && f.endsWith('index.js'));
  if (preloadFile) {
    // asar paths may have leading slash; extractFile expects no leading slash
    const extractPath = preloadFile.startsWith('/') ? preloadFile.slice(1) : preloadFile;
    const preloadContent = asar.extractFile(asarPath, extractPath).toString();
    const grillChannels = [
      'ipc:grill-create-session',
      'ipc:grill-get-session',
      'ipc:grill-list-sessions',
      'ipc:grill-answer-question',
      'ipc:grill-create-proposal',
    ];
    const missingChannels = grillChannels.filter((ch) => !preloadContent.includes(ch));
    if (missingChannels.length > 0) {
      console.error('[smoke-test] preload missing grill channels:', missingChannels);
      return false;
    }
    // Verify grill API object is exposed
    if (!preloadContent.includes('grill:')) {
      console.error('[smoke-test] preload does not expose grill API');
      return false;
    }
    console.log('[smoke-test] grill API presence check passed');

    // Verify contract API channels and object are present in preload
    // （只验证 surface，不执行真实模型调用）
    const contractChannels = [
      'ipc:contract-get-current',
      'ipc:contract-list-versions',
      'ipc:contract-request-draft',
      'ipc:contract-accept-proposal',
      'ipc:contract-lock-field',
    ];
    const missingContractChannels = contractChannels.filter((ch) => !preloadContent.includes(ch));
    if (missingContractChannels.length > 0) {
      console.error('[smoke-test] preload missing contract channels:', missingContractChannels);
      return false;
    }
    if (!preloadContent.includes('contract:')) {
      console.error('[smoke-test] preload does not expose contract API');
      return false;
    }
    console.log('[smoke-test] contract API presence check passed');
  }

  // Verify no workspace runtime packages in preload
  if (preloadFile) {
    const extractPath2 = preloadFile.startsWith('/') ? preloadFile.slice(1) : preloadFile;
    const preloadContent = asar.extractFile(asarPath, extractPath2).toString();
    const forbiddenImports = ['require("@ai-novel/', "require('@ai-novel/"];
    const hasForbidden = forbiddenImports.some((imp) => preloadContent.includes(imp));
    if (hasForbidden) {
      console.error('[smoke-test] preload references workspace runtime packages');
      return false;
    }
  }

  console.log('[smoke-test] asar content check passed');
  return true;
}

/** Find the packaged Electron binary. */
function findElectronBinary() {
  if (!existsSync(outDir)) return null;

  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS: find .app bundle inside out/<arch>/
    for (const entry of readdirSync(outDir)) {
      const entryDir = path.join(outDir, entry);
      if (!existsSync(entryDir) || !statSync(entryDir).isDirectory()) continue;
      // Look for any .app bundle
      for (const appEntry of readdirSync(entryDir)) {
        if (appEntry.endsWith('.app')) {
          const binary = path.join(entryDir, appEntry, 'Contents', 'MacOS', 'ai-novel-generator');
          if (existsSync(binary)) return binary;
        }
      }
    }
  } else if (platform === 'linux') {
    for (const entry of readdirSync(outDir)) {
      const binary = path.join(outDir, entry, 'ai-novel-generator');
      if (existsSync(binary)) return binary;
    }
  } else if (platform === 'win32') {
    for (const entry of readdirSync(outDir)) {
      const binary = path.join(outDir, entry, 'ai-novel-generator.exe');
      if (existsSync(binary)) return binary;
    }
  }

  return null;
}

const binary = findElectronBinary();
if (!binary) {
  console.error('[smoke-test] Could not find packaged Electron binary in', outDir);
  console.error('  Run "pnpm package" first.');
  process.exit(1);
}

// Check asar contents before launching
const appDir = path.dirname(path.dirname(path.dirname(binary)));
if (!checkAsarContents(appDir)) {
  console.error('[smoke-test] asar content check FAILED');
  process.exit(1);
}

console.log('[smoke-test] Launching:', binary);

const child = execFile(binary, ['--smoke-test'], {
  timeout: 45_000,
  env: { ...process.env, ELECTRON_NO_ATTACH_CONSOLE: '1' },
});

let stdout = '';
let stderr = '';

child.stdout?.on('data', (chunk) => {
  const text = String(chunk);
  stdout += text;
  process.stdout.write(text);
});

child.stderr?.on('data', (chunk) => {
  const text = String(chunk);
  stderr += text;
  process.stderr.write(text);
});

child.on('error', (err) => {
  console.error('[smoke-test] Failed to launch:', err.message);
  process.exit(1);
});

child.on('close', (code) => {
  const allOutput = stdout + stderr;
  const hasPass = allOutput.includes('[smoke-test] All checks passed');
  const hasFail = allOutput.includes('[smoke-test] FAIL');
  const hasTypeStripErr = allOutput.includes('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');
  const hasModuleNotFound = allOutput.includes('MODULE_NOT_FOUND');

  console.log('\n--- Smoke Test Results ---');
  console.log('  Exit code        :', code);
  console.log('  Pass marker      :', hasPass);
  console.log('  Fail marker      :', hasFail);
  console.log('  Type strip error :', hasTypeStripErr);
  console.log('  Module not found :', hasModuleNotFound);

  if (hasPass && !hasFail && !hasTypeStripErr && !hasModuleNotFound && code === 0) {
    console.log('\n✅ Smoke test PASSED');
    process.exit(0);
  } else {
    console.error('\n❌ Smoke test FAILED');
    process.exit(1);
  }
});
