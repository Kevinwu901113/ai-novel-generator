/**
 * 数据根目录解析（B11）。
 *
 * 解析顺序（D11）：
 * 1. `AI_NOVEL_DATA_ROOT` 环境变量（测试/部署显式指定，最高优先）；
 * 2. 既有 Electron 桌面版 userData 目录探测（按 `app.sqlite` 存在性判定）：
 *    - dev 运行形态：`~/Library/Application Support/@ai-novel/desktop`
 *    - 打包形态：`~/Library/Application Support/AI 小说创作代理`
 *    两者都存在时取 `app.sqlite` mtime 较新者，并输出警告；
 * 3. 都没有则使用全新目录（macOS：`~/Library/Application Support/ai-novel`，
 *    其它平台：`~/.ai-novel`）。
 *
 * 硬约束：只在原位读取老数据，绝不自动搬迁/移动目录——数据根错配的表现是
 * "项目全丢"，宁可要求用户显式设置环境变量。
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DataRootSource = 'env' | 'electron-userdata' | 'fresh';

export interface DataRootResolution {
  readonly dataRoot: string;
  readonly source: DataRootSource;
  /** 面向启动日志的说明（候选探测结果、多候选取舍警告等） */
  readonly notes: ReadonlyArray<string>;
}

interface ElectronCandidate {
  readonly label: string;
  readonly path: string;
}

function electronCandidates(home: string): ReadonlyArray<ElectronCandidate> {
  if (process.platform !== 'darwin') {
    return [];
  }
  const appSupport = join(home, 'Library', 'Application Support');
  return [
    { label: 'Electron dev 形态', path: join(appSupport, '@ai-novel', 'desktop') },
    { label: 'Electron 打包形态', path: join(appSupport, 'AI 小说创作代理') },
  ];
}

function freshDataRoot(home: string): string {
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'ai-novel');
  }
  return join(home, '.ai-novel');
}

export function resolveDataRoot(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): DataRootResolution {
  const override = env.AI_NOVEL_DATA_ROOT;
  if (override) {
    return { dataRoot: override, source: 'env', notes: ['来源：AI_NOVEL_DATA_ROOT 环境变量'] };
  }

  const withAppDb = electronCandidates(home)
    .map((candidate) => {
      const appDbPath = join(candidate.path, 'app.sqlite');
      if (!existsSync(appDbPath)) return null;
      return { ...candidate, mtimeMs: statSync(appDbPath).mtimeMs };
    })
    .filter(
      (candidate): candidate is ElectronCandidate & { mtimeMs: number } => candidate !== null,
    );

  if (withAppDb.length > 0) {
    const chosen = [...withAppDb].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    const notes = [`来源：既有桌面版数据（${chosen.label}）`];
    if (withAppDb.length > 1) {
      notes.push(
        `⚠️ 检测到多个桌面版数据目录，已按 app.sqlite 修改时间取较新者；` +
          `如不符合预期请用 AI_NOVEL_DATA_ROOT 显式指定。候选：` +
          withAppDb.map((c) => c.path).join('、'),
      );
    }
    return { dataRoot: chosen.path, source: 'electron-userdata', notes };
  }

  return {
    dataRoot: freshDataRoot(home),
    source: 'fresh',
    notes: ['来源：全新数据目录（未检测到既有桌面版数据）'],
  };
}
