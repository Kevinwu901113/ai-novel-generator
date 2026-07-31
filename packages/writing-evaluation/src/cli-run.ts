#!/usr/bin/env node
/**
 * CLI 入口。Programmatic API 在 index.ts / cli.ts 中，与解析器分离。
 */

import { runCli } from './cli.js';
import { systemClock } from './clock.js';

const exitCode = await runCli(process.argv.slice(2), { defaultClock: systemClock });
process.exitCode = exitCode;
