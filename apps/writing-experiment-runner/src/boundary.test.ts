/**
 * Runner 边界测试。
 *
 * 库源码（排除 cli-run.ts / 测试 / test-util）不得：
 * - import 产品数据库 / worker / electron / react / node:sqlite / 网络模块 / fetch；
 * - 直接使用 node:child_process（Keychain 只经 @ai-novel/secret-store；
 *   cli-run.ts 是进程边界，仅用它做 git rev-parse 注入 repository.commit）。
 *
 * 同时锁定：writing-evaluation 依赖保持不变（仅 @ai-novel/domain），证明 Runner 未反向污染评测包。
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(SRC_ROOT, '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === 'dist') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function librarySources(): string[] {
  return walk(SRC_ROOT)
    .filter((p) => !p.endsWith('.test.ts'))
    .filter((p) => !p.endsWith('test-util.ts'))
    .filter((p) => !p.endsWith('cli-run.ts'));
}

describe('Runner 依赖方向', () => {
  it('库源码不含 fetch / 产品 DB / worker / electron / react / node:sqlite / 网络模块', () => {
    const sources = librarySources();
    expect(sources.length).toBeGreaterThan(0);
    const forbidden = [
      /fetch\s*\(/,
      /@ai-novel\/database/,
      /@ai-novel\/worker/,
      /electron/,
      /react/,
      /node:sqlite/,
      /node:net/,
      /node:http/,
      /node:https/,
    ];
    for (const p of sources) {
      const source = readFileSync(p, 'utf8');
      for (const re of forbidden) {
        expect(source, `${p} 不得匹配 ${re}`).not.toMatch(re);
      }
    }
  });

  it('库源码不含 node:child_process（Keychain 只经 secret-store；spawn 语义不用）', () => {
    for (const p of librarySources()) {
      const source = readFileSync(p, 'utf8');
      // 只匹配 import / require 语句，不误伤注释里提到该词
      expect(source, `${p} 不得 import node:child_process`).not.toMatch(
        /(?:from\s+['"]node:child_process|import\s+['"]node:child_process|require\(\s*['"]node:child_process)/,
      );
      expect(source, `${p} 不得 spawn/execSync`).not.toMatch(
        /\bspawn\(|\bexecSync\b|\bspawnSync\b/,
      );
    }
  });

  it('@ai-novel/writing-evaluation 依赖保持不变（仅 @ai-novel/domain）', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/writing-evaluation/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies).toEqual({ '@ai-novel/domain': 'workspace:*' });
  });

  it('runner 依赖不包含 product DB / worker / desktop / electron', () => {
    const pkg = JSON.parse(readFileSync(resolve(SRC_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).toContain('@ai-novel/writing-evaluation');
    expect(deps).toContain('@ai-novel/model-gateway');
    expect(deps).toContain('@ai-novel/secret-store');
    for (const forbidden of ['@ai-novel/database', '@ai-novel/worker', '@ai-novel/desktop']) {
      expect(deps).not.toContain(forbidden);
    }
  });

  it('@ai-novel/secret-store 依赖仅 @ai-novel/application（type-only）', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/secret-store/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies).toEqual({ '@ai-novel/application': 'workspace:*' });
  });
});
