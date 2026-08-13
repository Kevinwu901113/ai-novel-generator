/**
 * 任务终结补偿（RW-1-R5 起的共享助手）。
 *
 * `compensateFinalization`：最终提交事务失败后，把仍处于 RUNNING 的 invocation/task
 * 标记 FAILED，避免留下半成品。SPEC_EXTRACT / RESEARCH_RUN / BLUEPRINT_GENERATE /
 * 四个章节任务（chapter-nodes.ts）共用同一份实现。
 *
 * B9 变更：本文件原本还承载 GE-6 base 时期的 `executeChapterDraft` / `parseChapterDraftV1`
 * ——那一版的 prompt 由调用方经 payload 传入、产物只进 execution envelope、不落任何
 * 章节领域表，无法承载真实章节生成（蓝图/场景计划上下文、候选修订链、改写循环）。
 * GE-6 接线批次（B9）以 `chapter-nodes.ts` 的四个执行器整体取代它，故此处一并移除，
 * 只保留仍被四个任务引擎共用的补偿助手。
 */

import { TaskExecutionError } from './index.js';
import type { TaskEngineDeps } from './index.js';

/** 补偿：最终提交事务失败后，仍 RUNNING 的 invocation/task 标记 FAILED（best-effort）。
 *  导出供其他 task-backed 执行器（spec-extract 等）复用同一补偿语义。 */
export function compensateFinalization(
  deps: TaskEngineDeps,
  taskId: string,
  invocationId: string,
  message: string,
): void {
  try {
    deps.transaction(() => {
      const inv = deps.invocationRepo.getById(invocationId);
      if (inv !== null && inv.status === 'RUNNING') {
        requireCas(
          deps.invocationRepo.markFailed(
            invocationId,
            ['RUNNING'],
            'TASK_EXECUTION_FAILED',
            message,
            null,
          ),
          '无法补偿标记调用失败',
        );
      }
      const task = deps.taskRepo.getById(taskId);
      if (task !== null && task.status === 'RUNNING') {
        requireCas(
          deps.taskRepo.failRunning(taskId, 'TASK_EXECUTION_FAILED', message),
          '无法补偿标记任务失败',
        );
      }
    });
  } catch {
    // 补偿本身失败不掩盖原始错误
  }
}

function requireCas(updated: boolean, message: string): void {
  if (!updated) throw new TaskExecutionError('TASK_STATE_CONFLICT', message);
}
