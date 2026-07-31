/**
 * I. 依赖边界测试。
 *
 * 验证本 package：
 * - package.json 依赖仅允许 @ai-novel/domain（Node 内置无依赖条目）；
 * - 源码不 import Electron / React / database / task-engine / model-gateway；
 * - 源码不使用 fetch / HTTP client / SQLite。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(here, '..');
const srcDir = path.join(here);

const FORBIDDEN_DEPENDENCIES = [
  '@ai-novel/database',
  '@ai-novel/task-engine',
  '@ai-novel/model-gateway',
  '@ai-novel/application',
  '@ai-novel/contracts',
  'electron',
  'react',
];

const FORBIDDEN_SOURCE_MARKERS = [
  "from 'electron'",
  'from "electron"',
  "from 'react'",
  'from "react"',
  '@ai-novel/database',
  '@ai-novel/task-engine',
  '@ai-novel/model-gateway',
  'node:sqlite',
  'node:http',
  'node:https',
  'node:net',
  'node:dgram',
  'node:tls',
];

function listSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && entry.name !== 'boundary.test.ts') {
        files.push(full);
      }
    }
  };
  walk(srcDir);
  return files;
}

describe('依赖边界', () => {
  it('package.json 依赖仅允许 @ai-novel/domain', () => {
    const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).toEqual(['@ai-novel/domain']);
  });

  it('devDependencies 不含禁止依赖', () => {
    const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    for (const forbidden of FORBIDDEN_DEPENDENCIES) {
      expect(devDeps).not.toContain(forbidden);
    }
  });

  it('源码不包含禁止 import / 网络客户端 / SQLite', () => {
    const files = listSourceFiles();
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const marker of FORBIDDEN_SOURCE_MARKERS) {
        expect(content, `${path.basename(file)} 包含禁止标记 "${marker}"`).not.toContain(marker);
      }
      // 不允许全局 fetch 调用
      expect(content, `${path.basename(file)} 使用 fetch`).not.toContain('fetch(');
    }
  });

  it('源码不读取 Keychain / 环境敏感存储', () => {
    const files = listSourceFiles();
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toContain('keychain');
      expect(content).not.toContain('Keychain');
    }
  });

  it('源码使用 node: 前缀仅限安全内置模块', () => {
    const allowed = new Set(['node:crypto', 'node:fs', 'node:path', 'node:url', 'node:process']);
    const files = listSourceFiles();
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const matches = content.match(/from 'node:[^']+'/g) ?? [];
      for (const m of matches) {
        const spec = m.slice("from '".length, -1);
        expect(allowed.has(spec), `${path.basename(file)} 使用非白名单内置模块 ${spec}`).toBe(true);
      }
    }
  });

  it('bin 入口存在', () => {
    const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };
    expect(pkg.bin?.['writing-evaluation']).toBe('./dist/cli-run.js');
  });
});
