/**
 * Worker 启动恢复 bootstrap（RW-1-R5, Blocker 2）。
 *
 * 对每个项目的非终态 run **await** NodeRunner；每 project / run 错误隔离；
 * 只有全部项目 DB 恢复结束才返回（readiness 门禁）。ProjectDatabase 构造在
 * 每项目 try 内 —— 单个项目打开失败不阻断其他项目恢复。
 *
 * 与 worker 进程全局解耦，便于集成测试直接驱动真实 temp DB。
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ProjectDatabase } from '@ai-novel/database';
import { driveRun, type NodeRunnerDeps } from '@ai-novel/application';

export interface RecoveryProject {
  readonly projectId: string;
  readonly projectDirectory: string;
}

export interface RecoveryBootstrapDeps {
  listProjects(): ReadonlyArray<RecoveryProject>;
  openProjectDb(dbPath: string): ProjectDatabase;
  buildRunnerDeps(projDb: ProjectDatabase, projectId: string): NodeRunnerDeps;
}

/**
 * Worker 启动引导（Blocker 2 / B10）：
 * **await 全部恢复（含 PENDING Graph task 调度）后才调用 onReady** —— 发布 READY / 接受 RPC
 * 前恢复必须完成。生产 initialize() 复用该顺序（await recoverGraphRuns → sendToParent ready）。
 */
export async function bootWorkerStartup(
  deps: RecoveryBootstrapDeps,
  onReady: () => void,
): Promise<void> {
  await runProjectRecovery(deps);
  onReady();
}

/** 恢复全部项目的非终态 run；单个项目失败不阻断整体 */
export async function runProjectRecovery(deps: RecoveryBootstrapDeps): Promise<void> {
  for (const project of deps.listProjects()) {
    const dbPath = join(project.projectDirectory, 'project.sqlite');
    if (!existsSync(dbPath)) continue;
    let projDb: ProjectDatabase | null = null;
    try {
      // Blocker 2：ProjectDatabase 构造在每项目 try 内 —— 损坏 DB 只影响该项目
      projDb = deps.openProjectDb(dbPath);
      const runnerDeps = deps.buildRunnerDeps(projDb, project.projectId);
      const runs = runnerDeps.tx.runInTransaction((repos) => repos.graphRunRepo.listNonTerminal());
      for (const record of runs) {
        try {
          await driveRun(runnerDeps, record.state.projectId, record.state.workflowRunId);
        } catch (err) {
          // 非致命：单个 run 恢复失败不阻断整体
          console.error(`driveRun ${record.state.workflowRunId} failed`, err);
        }
      }
    } catch (err) {
      // 单个项目打开/恢复失败不阻断其他项目
      console.error(`[worker] 项目恢复失败 ${project.projectId}:`, err);
    } finally {
      if (projDb) {
        try {
          projDb.close();
        } catch {
          // 关闭失败不掩盖原始错误
        }
      }
    }
  }
}
