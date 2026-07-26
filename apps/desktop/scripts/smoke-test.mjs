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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'out');

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
