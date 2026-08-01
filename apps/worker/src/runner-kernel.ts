/**
 * 共享安全 runner kernel。
 *
 * Grill 问题规划 runner 与创作契约草案 runner 共用的调度 / settlement / 恢复逻辑：
 * - 打开独立 ProjectDatabase；
 * - 单一异常边界：所有同步初始化 + 异步执行 + settlement + close 均不抛给调用方；
 * - 任何异常都通过 settlement 收口，不留永久 PENDING/RUNNING；
 * - DB 始终关闭且只关闭一次；
 * - 不产生 unhandled rejection；
 * - 不泄露路径、SQL、stack、API Key 或原始异常消息。
 *
 * 抽取不改变既有 Grill runner 行为：grill-plan-runner.ts 仅委托本 kernel 并
 * 传入自己的固定安全消息。
 */

import type { ProjectDatabase } from '@ai-novel/database';
import type { TaskRepositoryPort, ModelInvocationRepositoryPort } from '@ai-novel/application';

// ── 依赖接口 ─────────────────────────────────────────────────────

export interface RunnerKernelDeps<TDeps> {
  openDb(projectId: string): ProjectDatabase;
  buildEngineDeps(projDb: ProjectDatabase): TDeps;
  getTaskRepo(projDb: ProjectDatabase): TaskRepositoryPort;
  getInvocationRepo(projDb: ProjectDatabase): ModelInvocationRepositoryPort;
}

export type RunnerScheduleResult =
  | { readonly scheduled: true }
  | { readonly scheduled: false; readonly reason: 'OPEN_FAILED' | 'SETUP_FAILED' };

/** 各 runner 的固定安全消息（不包含内部诊断）。 */
export interface SettleMessages {
  readonly settleErrorCode: string;
  readonly settleErrorMessage: string;
  readonly settleInvocationError: string;
}

// ── Settlement ────────────────────────────────────────────────────

export function isTerminalStatus(status: string): boolean {
  return (
    status === 'SUCCEEDED' || status === 'FAILED' || status === 'STALE' || status === 'CANCELLED'
  );
}

/**
 * settlement 结果。UNRESOLVED 不得被调用方静默忽略。
 *
 * - TERMINAL：任务已是（或已接受为）终态，无需/已无法覆盖。
 * - RUNNING_ELSEWHERE：任务已被其他 runner 领取并 RUNNING，不得覆盖。
 * - FAILED：本 settlement 成功将任务终结为 FAILED。
 * - UNRESOLVED：CAS 冲突后仍非终态 / 仍 PENDING，无法安全终结。
 */
export type SettlementOutcome = 'TERMINAL' | 'RUNNING_ELSEWHERE' | 'FAILED' | 'UNRESOLVED';

/**
 * 安全终结失败的 runner（严格 CAS 版本）。
 *
 * - 已终态：no-op，不覆盖 → TERMINAL。
 * - PENDING：failPending（attemptCount 保持 0）。
 *   - 成功 → FAILED；失败后重新读取：已终态 → TERMINAL；
 *     RUNNING → RUNNING_ELSEWHERE；仍 PENDING → UNRESOLVED。
 * - RUNNING：事务内严格 CAS 将非终态 invocation 标记 FAILED + failRunning task。
 *   - markFailed/failRunning 返回 false 时重新读取：已终态接受，仍非终态则回滚事务。
 *   - 事务失败后按最终 task 状态分类返回。
 * - 所有依赖 getter 在自身 try/catch 内求值。
 * - 不产生 FAILED task + RUNNING/PENDING invocation 的半成品。
 */
export function settleRunnerFailure<TDeps>(
  deps: RunnerKernelDeps<TDeps>,
  projDb: ProjectDatabase,
  taskId: string,
  messages: SettleMessages,
): SettlementOutcome {
  try {
    let taskRepo: TaskRepositoryPort;
    let invocationRepo: ModelInvocationRepositoryPort;
    try {
      taskRepo = deps.getTaskRepo(projDb);
      invocationRepo = deps.getInvocationRepo(projDb);
    } catch {
      return 'UNRESOLVED';
    }

    const task = taskRepo.getById(taskId);
    if (!task) return 'UNRESOLVED';
    if (isTerminalStatus(task.status)) return 'TERMINAL';

    if (task.status === 'PENDING') {
      const ok = taskRepo.failPending(
        taskId,
        messages.settleErrorCode,
        messages.settleErrorMessage,
      );
      if (ok) return 'FAILED';
      const reread = taskRepo.getById(taskId);
      if (reread && isTerminalStatus(reread.status)) return 'TERMINAL';
      if (reread && reread.status === 'RUNNING') return 'RUNNING_ELSEWHERE';
      return 'UNRESOLVED';
    }

    // RUNNING：严格 CAS 事务
    try {
      projDb.transaction(() => {
        const invocations = invocationRepo.listByTask(taskId);
        for (const inv of invocations) {
          if (inv.status === 'PENDING' || inv.status === 'RUNNING') {
            const ok = invocationRepo.markFailed(
              inv.id,
              [inv.status],
              messages.settleErrorCode,
              messages.settleInvocationError,
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
        const taskOk = taskRepo.failRunning(
          taskId,
          messages.settleErrorCode,
          messages.settleErrorMessage,
        );
        if (!taskOk) {
          const reread = taskRepo.getById(taskId);
          if (reread && !isTerminalStatus(reread.status)) {
            throw new Error('settlement CAS conflict');
          }
        }
      });
    } catch {
      // 事务回滚后按最终 task 状态分类
      const reread = taskRepo.getById(taskId);
      if (reread && isTerminalStatus(reread.status)) return 'TERMINAL';
      if (reread && reread.status === 'RUNNING') return 'RUNNING_ELSEWHERE';
      return 'UNRESOLVED';
    }
    return 'FAILED';
  } catch {
    // settlement 自身失败：不产生 unhandled rejection，不泄露信息
    return 'UNRESOLVED';
  }
}

// ── Runner ────────────────────────────────────────────────────────

/**
 * 调度后台任务执行。
 *
 * 单一异常边界：所有同步初始化在 try/catch 内，异步执行在 async IIFE 内，
 * 最终 .catch() 保险禁止 unhandled rejection。
 *
 * 返回 RunnerScheduleResult 供调用方判断是否需要 fallback。
 */
export function scheduleRunnerRun<TDeps>(
  deps: RunnerKernelDeps<TDeps>,
  projectId: string,
  taskId: string,
  execute: (engineDeps: TDeps, taskId: string) => Promise<unknown>,
  messages: SettleMessages,
): RunnerScheduleResult {
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

  let engineDeps: TDeps;
  try {
    engineDeps = deps.buildEngineDeps(projDb);
  } catch {
    // 同步初始化失败：尝试 settlement 后关闭
    settleRunnerFailure(deps, projDb, taskId, messages);
    closeDb();
    return { scheduled: false, reason: 'SETUP_FAILED' };
  }

  void (async () => {
    try {
      await execute(engineDeps, taskId);
    } catch {
      settleRunnerFailure(deps, projDb, taskId, messages);
    } finally {
      closeDb();
    }
  })().catch(() => {
    // 最终保险：禁止 unhandled rejection
  });

  return { scheduled: true };
}

// ── Startup Recovery ──────────────────────────────────────────────

export interface RunnerRecoveryDeps {
  listProjectDbs(): Array<{ projectId: string; projDb: ProjectDatabase }>;
  getTaskRepo(projDb: ProjectDatabase): TaskRepositoryPort;
  schedule(projectId: string, taskId: string): RunnerScheduleResult;
  /** 调度失败时安全终结任务（固定安全消息）；返回 settlement outcome */
  settle(projDb: ProjectDatabase, taskId: string): SettlementOutcome;
}

/**
 * 启动时扫描指定 taskType 的 PENDING 任务并调度。
 *
 * - 无法打开的数据库留待下一次恢复，不声称已成功调度。
 * - schedule 失败（OPEN_FAILED / SETUP_FAILED）：尝试安全终结，避免永久 PENDING。
 *   UNRESOLVED 不静默丢弃，但也不抛给调用方（留待下次恢复）。
 * - 不重复 claim（CAS 由引擎执行）；异常不阻塞其他项目恢复。
 */
export function recoverPendingRunnerTasks(deps: RunnerRecoveryDeps, taskType: string): void {
  let entries: Array<{ projectId: string; projDb: ProjectDatabase }>;
  try {
    entries = deps.listProjectDbs();
  } catch {
    return;
  }

  for (const { projectId, projDb } of entries) {
    try {
      const taskRepo = deps.getTaskRepo(projDb);
      const pendingTasks = taskRepo.listByStatus('PENDING').filter((t) => t.taskType === taskType);
      for (const task of pendingTasks) {
        const result = deps.schedule(projectId, task.id);
        if (!result.scheduled) {
          const outcome = deps.settle(projDb, task.id);
          if (outcome === 'UNRESOLVED') {
            // 无法安全终结：留待下次恢复（不静默当作成功，也不抛给调用方）
          }
        }
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
