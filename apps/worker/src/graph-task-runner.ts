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
import type { NodeRunnerDeps, TaskData } from '@ai-novel/application';
import { driveRun } from '@ai-novel/application';
import {
  executeBlueprintGenerate,
  executeChapterDraft,
  executeResearchRun,
  executeSpecExtract,
  TaskExecutionError,
  type BlueprintGenerateExecutionDeps,
  type ChapterDraftExecutionDeps,
  type ResearchRunExecutionDeps,
  type SpecExtractExecutionDeps,
} from '@ai-novel/task-engine';
import {
  settleRunnerFailure,
  isTerminalStatus,
  type RunnerKernelDeps,
  type SettleMessages,
} from './runner-kernel.js';

/** Graph 任务引擎 deps：CHAPTER_DRAFT / SPEC_EXTRACT / RESEARCH_RUN / BLUEPRINT_GENERATE 的并集（B3/B5/B7） */
export type GraphEngineDeps = ChapterDraftExecutionDeps &
  SpecExtractExecutionDeps &
  ResearchRunExecutionDeps &
  BlueprintGenerateExecutionDeps;

/**
 * 复用 runner-kernel 依赖契约（openDb + buildEngineDeps + getTaskRepo + getInvocationRepo）。
 * B3 增 `buildNodeRunnerDeps`（可选）：任务执行终结后在同一 projDb 上驱动一次 driveRun，
 * 结算刚完成的 task-backed 节点并推进后续 frontier（live drive 的任务侧一半，D-B3-1）。
 */
export type GraphTaskRunnerDeps = RunnerKernelDeps<GraphEngineDeps> & {
  readonly buildNodeRunnerDeps?: (projDb: ProjectDatabase, projectId: string) => NodeRunnerDeps;
};

const GRAPH_TASK_MESSAGES: SettleMessages = {
  settleErrorCode: 'TASK_EXECUTION_FAILED',
  settleErrorMessage: 'Graph 任务执行失败',
  settleInvocationError: '模型调用因任务异常而未完成',
};

/**
 * 配置类错误（B3 复查 BLK-2）：任务引擎在 claim 前抛出，task 仍是 PENDING——设计意图
 * 就是"可在用户配置后重试"。此类错误不得 settle 为 FAILED，也不得触发任务后 driveRun
 * （否则 reDispatchPending 会与本失败形成热循环）；保持 PENDING，由用户配置后的下一次
 * 驱动 / 启动恢复自然重调度。
 */
const CONFIG_ERROR_CODES: ReadonlySet<string> = new Set([
  'PROVIDER_NOT_CONFIGURED',
  'API_KEY_READ_FAILED',
  'API_KEY_REQUIRED',
  // B5（D-B5-7）：搜索服务 key 未配置同属配置类——保持 PENDING，key 录入后重驱动
  'SEARCH_KEY_REQUIRED',
  'SEARCH_KEY_READ_FAILED',
]);

function isConfigError(err: unknown): boolean {
  return err instanceof TaskExecutionError && CONFIG_ERROR_CODES.has(err.code);
}

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

  let engineDeps: GraphEngineDeps;
  try {
    engineDeps = deps.buildEngineDeps(projDb);
    const task = engineDeps.taskRepo.getById(taskId);
    if (!task || isTerminalStatus(task.status)) {
      closeDb();
      return { scheduled: false, reason: 'TERMINAL' };
    }
    if (
      task.taskType !== 'CHAPTER_DRAFT' &&
      task.taskType !== 'SPEC_EXTRACT' &&
      task.taskType !== 'RESEARCH_RUN' &&
      task.taskType !== 'BLUEPRINT_GENERATE'
    ) {
      closeDb();
      return { scheduled: false, reason: 'UNSUPPORTED' };
    }
    const taskType = task.taskType;
    const prompt = readPrompt(task);
    void (async () => {
      try {
        if (taskType === 'CHAPTER_DRAFT') {
          await executeChapterDraft(engineDeps, taskId, prompt);
        } else if (taskType === 'RESEARCH_RUN') {
          await executeResearchRun(engineDeps, taskId);
        } else if (taskType === 'BLUEPRINT_GENERATE') {
          await executeBlueprintGenerate(engineDeps, taskId);
        } else {
          await executeSpecExtract(engineDeps, taskId);
        }
      } catch (err) {
        if (isConfigError(err)) {
          // BLK-2：保持 PENDING，不 settle、不 drive，等配置后重调度
          closeDb();
          return;
        }
        settleRunnerFailure(deps, projDb, taskId, GRAPH_TASK_MESSAGES);
      }
      // D-B3-1：任务终结（成功或失败）后驱动一次 driveRun —— 结算刚完成的节点并
      // 推进后续 frontier。失败被吞：推进属尽力而为，权威路径仍是启动恢复的 driveRun。
      try {
        if (deps.buildNodeRunnerDeps) {
          const exec = engineDeps.nodeExecutionRepo.getByTaskId(taskId);
          if (exec) {
            await driveRun(deps.buildNodeRunnerDeps(projDb, projectId), projectId, exec.graphRunId);
          }
        }
      } catch {
        // 推进失败不影响任务终态；下一次 driveRun（人工决策/重启）会重试
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
