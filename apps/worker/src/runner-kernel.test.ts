import { describe, expect, it, vi } from 'vitest';
import type {
  ModelInvocationRepositoryPort,
  TaskData,
  TaskRepositoryPort,
} from '@ai-novel/application';
import type { ProjectDatabase } from '@ai-novel/database';
import { TaskAlreadyClaimedError } from '@ai-novel/task-engine';
import { scheduleRunnerRun, type SettleMessages } from './runner-kernel.js';

const MESSAGES: SettleMessages = {
  settleErrorCode: 'TASK_EXECUTION_FAILED',
  settleErrorMessage: '任务执行失败',
  settleInvocationError: '模型调用因任务异常而未完成',
};

function pendingTask(): TaskData {
  return {
    id: 'task-1',
    projectId: 'project-1',
    taskType: 'SPEC_EXTRACT',
    status: 'PENDING',
    inputVersionJson: '{}',
    payloadJson: '{}',
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    dedupeKey: null,
    attemptCount: 0,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    staleAt: null,
    cancelledAt: null,
  };
}

describe('runner kernel duplicate scheduling', () => {
  it('后到 runner claim 冲突时不把先到 runner 的 RUNNING task 误标失败', async () => {
    let task = pendingTask();
    const failRunning = vi.fn(() => {
      task = { ...task, status: 'FAILED' };
      return true;
    });
    const taskRepo = {
      getById: () => task,
      failRunning,
    } as unknown as TaskRepositoryPort;
    const invocationRepo = {
      listByTask: () => [],
    } as unknown as ModelInvocationRepositoryPort;
    const close = vi.fn();
    const projDb = {
      close,
      transaction: <T>(fn: () => T): T => fn(),
    } as unknown as ProjectDatabase;

    const scheduled = scheduleRunnerRun(
      {
        openDb: () => projDb,
        buildEngineDeps: () => ({ taskRepo }),
        getTaskRepo: () => taskRepo,
        getInvocationRepo: () => invocationRepo,
      },
      'project-1',
      'task-1',
      async () => {
        task = { ...task, status: 'RUNNING', attemptCount: 1 };
        throw new TaskAlreadyClaimedError('任务已被其他进程领取');
      },
      MESSAGES,
    );

    expect(scheduled).toEqual({ scheduled: true });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(task.status).toBe('RUNNING');
    expect(failRunning).not.toHaveBeenCalled();
  });
});
