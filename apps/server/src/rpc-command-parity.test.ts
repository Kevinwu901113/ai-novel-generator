/**
 * worker dispatchCommand ↔ contracts RPC 命令面一致性守卫（B11）。
 *
 * 背景：Electron IPC → HTTP RPC 迁移中，apps/desktop/src/main/index.ts 的 82 个
 * ipcMain.handle 承担着 renderer→worker 边界的全部输入校验。HTTP 化后 main 这层
 * 不存在了，校验搬进了 packages/contracts 的 `RPC_COMMAND_VALIDATORS`，供
 * apps/server 在 HTTP 边界复用。这份校验表必须与 worker 真实接受的命令面
 * （apps/worker/src/index.ts 的 dispatchCommand switch）保持一一对应——
 * 少一个命令的校验器就是一个不设防的 HTTP 入口（research 域 handler 内部
 * 零校验，这是安全关键）。
 *
 * 本测试读 worker 源码做正则抽取（同 apps/desktop/src/preload/ipc-channel-parity.test.ts
 * 的手法），不导入 worker 模块本身——它在 import 时会做真实的 Electron Utility
 * Process 判定与生命周期注册（见 worker/src/index.ts 顶部说明），不适合当普通
 * Node/Vitest 模块 import。
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RPC_COMMANDS, RPC_COMMAND_VALIDATORS, SERVER_COMMANDS } from '@ai-novel/contracts';

// 路径自仓库根解析（vitest.config.ts 在根，故 cwd 即仓库根）。
const REPO_ROOT = process.cwd();
const WORKER_SRC = resolve(REPO_ROOT, 'apps/worker/src/index.ts');

const SWITCH_MARKER = 'switch (request.command) {';

/**
 * 从 dispatchCommand 的 switch 语句体中抽取全部 `case 'xxx':` 标签。
 * 合并 case（一个 case 块处理多个命令，如 grill.* 的批量分发）逐行匹配，
 * 一行一个 case，天然覆盖。
 */
function parseDispatchCommandCases(source: string): string[] {
  const start = source.indexOf(SWITCH_MARKER);
  if (start === -1) throw new Error(`未找到 ${SWITCH_MARKER}`);
  const body = source.slice(start);
  const cases: string[] = [];
  for (const m of body.matchAll(/^\s*case '([^']+)':/gm)) {
    cases.push(m[1]);
  }
  return cases;
}

const workerSource = readFileSync(WORKER_SRC, 'utf8');
const workerCases = parseDispatchCommandCases(workerSource);
const rpcCommandValues = Object.values(RPC_COMMANDS);

describe('worker dispatchCommand ↔ contracts RPC 命令面一致性', () => {
  it('worker 源码能定位到（cwd 变了要响亮失败，不能静默变成空比对）', () => {
    expect(existsSync(WORKER_SRC)).toBe(true);
  });

  it('解析器本身有效：82 个 case 是防退化锚点（worker 增删命令时本断言会提醒同步 contracts）', () => {
    expect(workerCases.length).toBe(82);
    // 不重复：合并 case 语法下每个命令只应出现一次
    expect(new Set(workerCases).size).toBe(82);
  });

  it('已知锚点命令都在（防正则改坏后静默退化为部分比对）', () => {
    expect(workerCases).toContain('project.create');
    expect(workerCases).toContain('manuscript.export');
    expect(workerCases).toContain('research.getResearchState');
  });

  it('RPC_COMMANDS 与 worker 命令面双向相等（不多不少）', () => {
    expect([...rpcCommandValues].sort()).toEqual([...workerCases].sort());
  });

  it('RPC_COMMAND_VALIDATORS 为每个 RPC 命令都显式声明了校验器（函数或 null，不能漏声明）', () => {
    const validatorKeys = Object.keys(RPC_COMMAND_VALIDATORS);
    expect(validatorKeys.sort()).toEqual([...rpcCommandValues].sort());

    for (const command of rpcCommandValues) {
      const validator = RPC_COMMAND_VALIDATORS[command as keyof typeof RPC_COMMAND_VALIDATORS];
      expect(validator === null || typeof validator === 'function').toBe(true);
    }
  });

  it('SERVER_COMMANDS 与 RPC_COMMANDS 命令面互不相交（服务端本地命令不进 worker dispatch）', () => {
    const serverValues = new Set<string>(Object.values(SERVER_COMMANDS));
    const rpcValues = new Set<string>(rpcCommandValues);
    for (const value of serverValues) {
      expect(rpcValues.has(value)).toBe(false);
    }
  });
});
