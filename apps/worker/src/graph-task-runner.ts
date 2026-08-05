/**
 * Graph task 后台 runner（RW-1-R5, Blocker 2）。
 *
 * 生产 recoverGraphRuns 的 `scheduleTask` 接线：把 durable PENDING 的 Graph task
 * 真正调度执行（幂等：executeChapterDraft 内部 CAS claim，重复调度安全）。
 *
 * 复用 runner-kernel 的安全边界：独立 ProjectDatabase、单一异常边界、
 * settlement 收口、DB close exactly once、不产生 unhandled rejection。
 */

import type { ProjectDatabase } from '@ai-novel/database';
import type { TaskData } from '@ai-novel/application';
import { executeChapterDraft, type ChapterDraftExecutionDeps } from '@ai-novel/task-engine';
import {
  settleRunnerFailure,
  isTerminalStatus,
  type RunnerKernelDeps,
  type SettleMessages,
} from './runner-kernel.js';

/** 复用 runner-kernel 依赖契约（openDb + buildEngineDeps + getTaskRepo + getInvocationRepo） */
export type GraphTaskRunnerDeps = RunnerKernelDeps<ChapterDraftExecutionDeps>;

const GRAPH_TASK_MESSAGES: SettleMessages = {
  settleErrorCode: 'TASK_EXECUTION_FAILED',
  settleErrorMessage: 'Graph 任务执行失败',
  settleInvocationError: '模型调用因任务异常而未完成',
};

export type GraphTaskScheduleResult =
  | { readonly scheduled: true }
  | {
      readonly scheduled: false;
      readonly reason: 'OPEN_FAILED' | 'SETUP_FAILED' | 'UNSUPPORTED' | 'TERMINAL';
    };

function readPrompt(task: TaskData): string {
  try {
    const payload = JSON.parse(task.payloadJson ?? '{}') as { prompt?: unknown };
    return typeof payload.prompt === 'string' ? payload.prompt : '';
  } catch {
    return '';
  }
}

/**
 * 调度 Graph task 执行（幂等）。同步返回调度结果；异步执行在 async IIFE 内，
 * 失败经 settlement 收口，DB 关闭恰好一次。
 */
export function scheduleGraphTask(
  deps: GraphTaskRunnerDeps,
  projectId: string,
  taskId: string,
): GraphTaskScheduleResult {
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

  let engineDeps: ChapterDraftExecutionDeps;
  try {
    engineDeps = deps.buildEngineDeps(projDb);
    const task = engineDeps.taskRepo.getById(taskId);
    if (!task || isTerminalStatus(task.status)) {
      closeDb();
      return { scheduled: false, reason: 'TERMINAL' };
    }
    if (task.taskType !== 'CHAPTER_DRAFT') {
      closeDb();
      return { scheduled: false, reason: 'UNSUPPORTED' };
    }
    const prompt = readPrompt(task);
    void (async () => {
      try {
        await executeChapterDraft(engineDeps, taskId, prompt);
      } catch {
        settleRunnerFailure(deps, projDb, taskId, GRAPH_TASK_MESSAGES);
      } finally {
        closeDb();
      }
    })().catch(() => {
      // 最终保险：禁止 unhandled rejection
    });
    return { scheduled: true };
  } catch {
    settleRunnerFailure(deps, projDb, taskId, GRAPH_TASK_MESSAGES);
    closeDb();
    return { scheduled: false, reason: 'SETUP_FAILED' };
  }
}
