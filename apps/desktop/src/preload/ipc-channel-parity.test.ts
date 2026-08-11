/**
 * Preload 与 contracts 的 IPC 通道一致性守卫（B8 复查随行补齐）。
 *
 * 背景：preload 编译为自包含 CJS，**不得运行时导入 workspace ESM 包**（见
 * preload/index.ts 顶部说明），因此 `IPC_CHANNELS` 在 preload 里是一份手抄字面量。
 * `const desktopAPI: DesktopAPI = {...}` 的类型标注能挡住"少实现一个方法"，但
 * **挡不住通道字符串本身抄错或漏抄**——那种情况下 typecheck 全过、全部单测全绿，
 * 功能却在真机上直接死掉（`ipcRenderer.invoke` 打到一个没人注册的通道）。
 * 这正是 B6 REWORK 的同一类失败："分层测试全绿掩盖功能不可达"。
 *
 * 本测试读两处源码做键与值的双向比对。不导入 preload 模块本身——它在加载时就会调用
 * `contextBridge.exposeInMainWorld`，需要真实 electron 运行时。
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 路径自仓库根解析（vitest.config.ts 在根，故 cwd 即仓库根）。不用 import.meta：
// preload 的 tsconfig 编译目标是 CommonJS，import.meta 在那里非法（TS1343），
// 而本文件位于 src/preload 之下会被那份 tsconfig 一并类型检查。
const REPO_ROOT = process.cwd();
const PRELOAD_SRC = resolve(REPO_ROOT, 'apps/desktop/src/preload/index.ts');
const CONTRACTS_SRC = resolve(REPO_ROOT, 'packages/contracts/src/index.ts');

/** 从源码里抽出 IPC_CHANNELS 对象字面量的 键→值 映射 */
function parseChannels(source: string, startMarker: string): Record<string, string> {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`未找到 ${startMarker}`);
  const end = source.indexOf('} as const;', start);
  if (end === -1) throw new Error(`${startMarker} 缺少 '} as const;' 结尾`);
  const body = source.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

const preloadChannels = parseChannels(readFileSync(PRELOAD_SRC, 'utf8'), 'const IPC_CHANNELS = {');
const contractsChannels = parseChannels(
  readFileSync(CONTRACTS_SRC, 'utf8'),
  'export const IPC_CHANNELS = {',
);

describe('preload ↔ contracts IPC 通道一致性', () => {
  it('两份源码都能定位到（cwd 变了要响亮失败，不能静默变成空比对）', () => {
    expect(existsSync(PRELOAD_SRC)).toBe(true);
    expect(existsSync(CONTRACTS_SRC)).toBe(true);
  });

  it('解析器本身有效（两侧都抽到了通道，不是空对象假绿）', () => {
    expect(Object.keys(contractsChannels).length).toBeGreaterThan(50);
    expect(Object.keys(preloadChannels).length).toBeGreaterThan(50);
    // 控制项：一个已知通道必须被抽到，防止正则改坏后静默退化为空比对
    expect(contractsChannels.HEALTH_CHECK).toBe('ipc:health-check');
    expect(preloadChannels.HEALTH_CHECK).toBe('ipc:health-check');
  });

  it('键集合完全一致（preload 不漏抄、不多抄）', () => {
    expect(Object.keys(preloadChannels).sort()).toEqual(Object.keys(contractsChannels).sort());
  });

  it('每个通道的字符串值完全一致（抄错一个字符就是运行时死链）', () => {
    expect(preloadChannels).toEqual(contractsChannels);
  });

  it('B8 新增的蓝图通道两侧都在（本批次的具体回归点）', () => {
    expect(contractsChannels.BLUEPRINT_GET_BLUEPRINT).toBe('ipc:blueprint-get-blueprint');
    expect(preloadChannels.BLUEPRINT_GET_BLUEPRINT).toBe('ipc:blueprint-get-blueprint');
  });
});
