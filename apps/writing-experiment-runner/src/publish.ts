/**
 * 目录级原子发布（发布单元 = 整个实验输出目录）。
 *
 * 流程：
 * 1. 调用方只向唯一 staging 目录写文件；
 * 2. 预检 staging / backup 路径不存在；final 不存在或无 --force 时前置拒绝；
 * 3. --force 时 final rename 到唯一 backup；
 * 4. staging rename 为 final；
 * 5. 成功后删除 backup；失败则 best-effort 恢复 backup、清理残留 staging；
 * 6. 错误不泄漏绝对路径（由 safe-error 统一包装）。
 *
 * 不复制 PR #18 的逐文件多角色发布逻辑。
 */

import { safeDisplayPath } from './safe-error.js';
import { CliUsageError } from './safe-error.js';

export interface PublishDeps {
  readonly exists: (p: string) => boolean;
  readonly renameDir: (from: string, to: string) => void;
  readonly removeDir: (p: string) => void;
  readonly idGenerator: () => string;
}

export function stagingPathFor(finalDir: string, runId: string): string {
  return `${finalDir}.gq2-tmp-${runId}`;
}

export function backupPathFor(finalDir: string, runId: string): string {
  return `${finalDir}.gq2-bak-${runId}`;
}

export interface PublishOptions {
  readonly finalDir: string;
  readonly stagingDir: string;
  readonly backupDir: string;
  readonly force: boolean;
}

/**
 * 发布前预检：任何写入之前拒绝预存在 staging / backup，以及未授权覆盖 final。
 * 返回后调用方可以安全地 mkdir(staging) 并写入文件。
 */
export function preflightPublish(deps: PublishDeps, options: PublishOptions): void {
  if (deps.exists(options.stagingDir)) {
    throw new CliUsageError(
      `内部暂存目录 "${safeDisplayPath(options.stagingDir)}" 已存在；请先移除或更换输出路径`,
    );
  }
  if (deps.exists(options.backupDir)) {
    throw new CliUsageError(
      `内部备份目录 "${safeDisplayPath(options.backupDir)}" 已存在；请先移除或更换输出路径`,
    );
  }
  if (deps.exists(options.finalDir) && !options.force) {
    throw new CliUsageError(
      `输出目录 "${safeDisplayPath(options.finalDir)}" 已存在；如需覆盖请显式使用 --force`,
    );
  }
}

/**
 * 原子发布：staging → final（--force 走 backup）。
 * 失败时 best-effort 恢复 backup 并清理残留 staging。
 */
export function publishDirectory(deps: PublishDeps, options: PublishOptions): void {
  let backupMoved = false;
  try {
    if (deps.exists(options.finalDir)) {
      deps.renameDir(options.finalDir, options.backupDir);
      backupMoved = true;
    }
    deps.renameDir(options.stagingDir, options.finalDir);
    if (backupMoved) {
      deps.removeDir(options.backupDir);
    }
  } catch (err) {
    // best-effort 恢复：把旧 final 搬回来，清理残留 staging
    if (backupMoved) {
      try {
        if (!deps.exists(options.finalDir)) {
          deps.renameDir(options.backupDir, options.finalDir);
        }
      } catch {
        // best-effort
      }
    }
    try {
      if (deps.exists(options.stagingDir)) {
        deps.removeDir(options.stagingDir);
      }
    } catch {
      // best-effort
    }
    throw err;
  }
}
