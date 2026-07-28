/**
 * Grill 问题规划后台 runner。
 *
 * 职责：
 * - 异步执行规划任务（独立 DB 连接）；
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

// ── Settlement ────────────────────────────────────────────────────

const SETTLE_ERROR_CODE = 'TASK_EXECUTION_FAILED';
const SETTLE_ERROR_MESSAGE = '问题规划任务执行失败';
const SETTLE_INVOCATION_ERROR = '模型调用因任务异常而未完成';

/**
 * 安全终结失败的 runner。
 *
 * - 已终态（SUCCEEDED/FAILED/STALE/CANCELLED）：no-op，不覆盖。
 * - PENDING：failPending（attemptCount 保持 0）。
 * - RUNNING：事务内将非终态 invocation 标记 FAILED + failRunning task。
 * - CAS 失败时重新读取：若已终态则视为并发正常完成。
 * - 自身被 try/catch 包裹，不产生 unhandled rejection。
 */
export function settleGrillPlanRunnerFailure(
  taskRepo: TaskRepositoryPort,
  invocationRepo: ModelInvocationRepositoryPort,
  transaction: <T>(fn: () => T) => T,
  taskId: string,
): void {
  try {
    const task = taskRepo.getById(taskId);
    if (!task) return;

    if (
      task.status === 'SUCCEEDED' ||
      task.status === 'FAILED' ||
      task.status === 'STALE' ||
      task.status === 'CANCELLED'
    ) {
      return;
    }

    if (task.status === 'PENDING') {
      const ok = taskRepo.failPending(taskId, SETTLE_ERROR_CODE, SETTLE_ERROR_MESSAGE);
      if (!ok) {
        const reread = taskRepo.getById(taskId);
        if (
          reread &&
          reread.status !== 'SUCCEEDED' &&
          reread.status !== 'FAILED' &&
          reread.status !== 'STALE' &&
          reread.status !== 'CANCELLED'
        ) {
          // 仍非终态但 CAS 失败：无法安全处理，不再重试
        }
      }
      return;
    }

    // RUNNING
    transaction(() => {
      const invocations = invocationRepo.listByTask(taskId);
      for (const inv of invocations) {
        if (inv.status === 'PENDING' || inv.status === 'RUNNING') {
          invocationRepo.markFailed(
            inv.id,
            [inv.status],
            SETTLE_ERROR_CODE,
            SETTLE_INVOCATION_ERROR,
            null,
          );
        }
      }
      taskRepo.failRunning(taskId, SETTLE_ERROR_CODE, SETTLE_ERROR_MESSAGE);
    });
  } catch {
    // settlement 自身失败：不产生 unhandled rejection，不泄露信息
  }
}

// ── Runner ────────────────────────────────────────────────────────

/**
 * 调度后台 Grill 规划任务执行。
 *
 * 打开独立 DB → 执行 → settlement on error → 关闭 DB（只一次）。
 * 若 DB 打开失败，使用 fallback 将任务标记 FAILED（如果可能）。
 */
export function scheduleGrillPlanRun(
  deps: GrillPlanRunnerDeps,
  projectId: string,
  taskId: string,
): void {
  let projDb: ProjectDatabase;
  try {
    projDb = deps.openDb(projectId);
  } catch {
    // DB 无法打开：无法安全终结任务（无可用连接）
    // 留待下次 startup recovery 处理
    return;
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

  const engineDeps = deps.buildEngineDeps(projDb);

  void executeGrillQuestionPlan(engineDeps, taskId)
    .catch(() => {
      settleGrillPlanRunnerFailure(
        deps.getTaskRepo(projDb),
        deps.getInvocationRepo(projDb),
        <T>(fn: () => T) => projDb.transaction(fn),
        taskId,
      );
    })
    .finally(() => {
      closeDb();
    });
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
