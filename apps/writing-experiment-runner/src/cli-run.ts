#!/usr/bin/env node
/**
 * CLI 入口（进程边界）。
 *
 * 这里做两件 runner 库代码不允许做的事：
 * 1. git rev-parse HEAD（best-effort，非 git 环境为 null）→ 注入 manifest repository.commit；
 * 2. 安装 SIGINT 处理器 → 标 ABORTED（best-effort）。
 *
 * 库代码（runner.ts / publish.ts / generator/…）不 import node:child_process；
 * Keychain 只经 @ai-novel/secret-store。
 */

import { execFileSync } from 'node:child_process';
import { runCli } from './cli.js';
import { systemClock } from '@ai-novel/writing-evaluation';
import type { AbortState } from './runner.js';

// 管道关闭（如 | head）时优雅退出，避免未处理 EPIPE 崩溃
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const abort: AbortState = { aborted: false };
process.on('SIGINT', () => {
  abort.aborted = true;
  // 当前 case 结束后走 ABORTED 发布；兜底 3 秒强制退出保证响应性
  setTimeout(() => process.exit(130), 3000);
});

function readGitCommit(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

const exitCode = await runCli(process.argv.slice(2), {
  defaultClock: systemClock,
  abort,
  gitCommit: readGitCommit(),
});
process.exitCode = exitCode;
