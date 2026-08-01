#!/usr/bin/env node
/**
 * CLI 入口。Programmatic API 在 index.ts / cli.ts 中，与解析器分离。
 */

import { runCli } from './cli.js';
import { systemClock } from './clock.js';

// 管道关闭（如 | head）时优雅退出，避免未处理 EPIPE 崩溃
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const exitCode = await runCli(process.argv.slice(2), { defaultClock: systemClock });
process.exitCode = exitCode;
