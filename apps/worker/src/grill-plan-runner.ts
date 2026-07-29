/**
 * Grill 问题规划后台 runner。
 *
 * 职责：
 * - 异步执行规划任务（独立 DB 连接）；
 * - 单一异常边界：所有同步初始化 + 异步执行 + settlement + close 均不抛给调用方；
 * - 任何异常都通过 settlement 收口，不留永久 PENDING/RUNNING；
 * - DB 始终关闭且只关闭一次；
 * - 不产生 unhandled rejection；
 * - 不泄露路径、SQL、stack、API Key 或原始异常消息。
 */

import type { ProjectDatabase } from '@ai-novel/database';
import type { TaskRepositoryPort, ModelInvocationRepositoryPort } from '@ai-novel/application';
import { executeGrillQuestionPlan, type GrillQuestionPlanEngineDeps } from '@ai-novel/task-engine';

// ── 依赖接口（可注入，便于测试）────────────────────────────────────

export interface GrillPlanRunnerDeps {
  openDb(projectId: string): ProjectDatabase;
  buildEngineDeps(projDb: ProjectDatabase): GrillQuestionPlanEngineDeps;
  getTaskRepo(projDb: ProjectDatabase): TaskRepositoryPort;
  getInvocationRepo(projDb: ProjectDatabase): ModelInvocationRepositoryPort;
}

// ── 调度结果 ──────────────────────────────────────────────────────

export type GrillPlanScheduleResult =
  | { readonly scheduled: true }
  | { readonly scheduled: false; readonly reason: 'OPEN_FAILED' | 'SETUP_FAILED' };

// ── Settlement ────────────────────────────────────────────────────

const SETTLE_ERROR_CODE = 'TASK_EXECUTION_FAILED';
const SETTLE_ERROR_MESSAGE = '问题规划任务执行失败';
const SETTLE_INVOCATION_ERROR = '模型调用因任务异常而未完成';

function isTerminalStatus(status: string): boolean {
  return (
    status === 'SUCCEEDED' || status === 'FAILED' || status === 'STALE' || status === 'CANCELLED'
  );
}

/**
 * 安全终结失败的 runner（严格 CAS 版本）。
 *
 * - 已终态：no-op，不覆盖。
 * - PENDING：failPending（attemptCount 保持 0）。
 * - RUNNING：事务内严格 CAS 将非终态 invocation 标记 FAILED + failRunning task。
 *   - markFailed 返回 false 时重新读取：已终态接受，仍非终态则回滚事务。
 *   - failRunning 返回 false 时重新读取：已终态接受，仍非终态则回滚事务。
 * - 所有依赖 getter 在自身 try/catch 内求值。
 * - 不产生 FAILED task + RUNNING/PENDING invocation 的半成品。
 */
export function settleGrillPlanRunnerFailure(
  deps: GrillPlanRunnerDeps,
  projDb: ProjectDatabase,
  taskId: string,
): void {
  try {
    let taskRepo: TaskRepositoryPort;
    let invocationRepo: ModelInvocationRepositoryPort;
    try {
      taskRepo = deps.getTaskRepo(projDb);
      invocationRepo = deps.getInvocationRepo(projDb);
    } catch {
      return;
    }

    const task = taskRepo.getById(taskId);
    if (!task) return;
    if (isTerminalStatus(task.status)) return;

    if (task.status === 'PENDING') {
      const ok = taskRepo.failPending(taskId, SETTLE_ERROR_CODE, SETTLE_ERROR_MESSAGE);
      if (!ok) {
        const reread = taskRepo.getById(taskId);
        if (reread && !isTerminalStatus(reread.status)) {
          // 仍非终态但 CAS 失败：无法安全处理
        }
      }
      return;
    }

    // RUNNING：严格 CAS 事务
    projDb.transaction(() => {
      const invocations = invocationRepo.listByTask(taskId);
      for (const inv of invocations) {
        if (inv.status === 'PENDING' || inv.status === 'RUNNING') {
          const ok = invocationRepo.markFailed(
            inv.id,
            [inv.status],
            SETTLE_ERROR_CODE,
            SETTLE_INVOCATION_ERROR,
            null,
          );
          if (!ok) {
            const reread = invocationRepo.getById(inv.id);
            if (reread && !isTerminalStatus(reread.status)) {
              throw new Error('settlement CAS conflict');
            }
          }
        }
      }
      const taskOk = taskRepo.failRunning(taskId, SETTLE_ERROR_CODE, SETTLE_ERROR_MESSAGE);
      if (!taskOk) {
        const reread = taskRepo.getById(taskId);
        if (reread && !isTerminalStatus(reread.status)) {
          throw new Error('settlement CAS conflict');
        }
      }
    });
  } catch {
    // settlement 自身失败：不产生 unhandled rejection，不泄露信息
  }
}

// ── Runner ────────────────────────────────────────────────────────

/**
 * 调度后台 Grill 规划任务执行。
 *
 * 单一异常边界：所有同步初始化在 try/catch 内，异步执行在 async IIFE 内，
 * 最终 .catch() 保险禁止 unhandled rejection。
 *
 * 返回 GrillPlanScheduleResult 供调用方判断是否需要 fallback。
 */
export function scheduleGrillPlanRun(
  deps: GrillPlanRunnerDeps,
  projectId: string,
  taskId: string,
): GrillPlanScheduleResult {
  let projDb: ProjectDatabase;
  try {
    projDb = deps.openDb(projectId);
  } catch {
    return { scheduled: false, reason: 'OPEN_FAILED' };
  }

  let closed = false;
  const closeDb = (): void => {
    if (!closed) {
      closed = true;
      try {
        projDb.close();
      } catch {
        // 关闭失败不产生 unhandled rejection
      }
    }
  };

  let engineDeps: GrillQuestionPlanEngineDeps;
  try {
    engineDeps = deps.buildEngineDeps(projDb);
  } catch {
    // 同步初始化失败：尝试 settlement 后关闭
    settleGrillPlanRunnerFailure(deps, projDb, taskId);
    closeDb();
    return { scheduled: false, reason: 'SETUP_FAILED' };
  }

  void (async () => {
    try {
      await executeGrillQuestionPlan(engineDeps, taskId);
    } catch {
      settleGrillPlanRunnerFailure(deps, projDb, taskId);
    } finally {
      closeDb();
    }
  })().catch(() => {
    // 最终保险：禁止 unhandled rejection
  });

  return { scheduled: true };
}

// ── Startup Recovery ──────────────────────────────────────────────

export interface GrillPlanRecoveryDeps {
  listProjectDbs(): Array<{ projectId: string; projDb: ProjectDatabase }>;
  getTaskRepo(projDb: ProjectDatabase): TaskRepositoryPort;
  schedule(projectId: string, taskId: string): void;
}

/**
 * 启动时扫描 PENDING GRILL_QUESTION_PLAN 任务并调度。
 *
 * 无法打开的数据库留待下一次恢复，不声称已成功调度。
 */
export function recoverPendingGrillPlans(deps: GrillPlanRecoveryDeps): void {
  let entries: Array<{ projectId: string; projDb: ProjectDatabase }>;
  try {
    entries = deps.listProjectDbs();
  } catch {
    return;
  }

  for (const { projectId, projDb } of entries) {
    try {
      const taskRepo = deps.getTaskRepo(projDb);
      const pendingTasks = taskRepo
        .listByStatus('PENDING')
        .filter((t) => t.taskType === 'GRILL_QUESTION_PLAN');
      for (const task of pendingTasks) {
        deps.schedule(projectId, task.id);
      }
    } catch {
      // 无法读取此项目数据库，留待下次恢复
    } finally {
      try {
        projDb.close();
      } catch {
        // ignore
      }
    }
  }
}
