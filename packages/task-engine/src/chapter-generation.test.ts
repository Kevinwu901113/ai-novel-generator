/**
 * 任务终结补偿助手测试（`compensateFinalization`）。
 *
 * B9 前本文件还覆盖 GE-6 base 时期的 `executeChapterDraft` / `parseChapterDraftV1`，
 * 那两者已被 `chapter-nodes.ts` 的四个真实章节执行器整体取代（原因见
 * chapter-generation.ts 顶部说明），对应覆盖迁到 `chapter-nodes.test.ts`。
 * 本文件保留对补偿助手本身的覆盖——它被四个任务引擎共用，是"最终事务失败不留
 * 半成品"这条不变量的唯一实现。
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  Clock,
  CreateInvocationInput,
  IdGenerator,
  InvocationSuccessResult,
  ModelInvocationData,
  ModelInvocationRepositoryPort,
  ProviderProfileRepository,
  SecretStore,
  TaskData,
  TaskRepositoryPort,
} from '@ai-novel/application';
import { compensateFinalization, type TaskEngineDeps } from './index.js';

const NOW = '2026-08-13T00:00:00.000Z';

function mockTask(status: TaskData['status']): TaskData {
  return {
    id: 't1',
    projectId: 'p1',
    taskType: 'CHAPTER_DRAFT',
    status,
    inputVersionJson: '{}',
    payloadJson: '{}',
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    dedupeKey: null,
    attemptCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    finishedAt: null,
    staleAt: null,
    cancelledAt: null,
  };
}

function mockInvocation(status: ModelInvocationData['status']): ModelInvocationData {
  return {
    id: 'inv-1',
    projectId: 'p1',
    taskId: 't1',
    providerProfileId: 'prof-1',
    model: 'm',
    attemptNumber: 1,
    requestKind: 'chapter_draft',
    promptHash: 'h',
    requestMetadataJson: '{}',
    status,
    createdAt: NOW,
    responseMetadataJson: null,
    finishedAt: null,
    startedAt: null,
    latencyMs: null,
    errorCode: null,
    errorMessage: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    finishReason: null,
    providerRequestId: null,
  };
}

function buildDeps(options: {
  taskStatus: TaskData['status'];
  invocationStatus: ModelInvocationData['status'];
  transactionThrows?: boolean;
}) {
  const taskStore = new Map<string, TaskData>([['t1', mockTask(options.taskStatus)]]);
  const invocationStore = new Map<string, ModelInvocationData>([
    ['inv-1', mockInvocation(options.invocationStatus)],
  ]);

  const taskRepo: TaskRepositoryPort = {
    create: vi.fn(),
    getById: vi.fn((id: string) => taskStore.get(id) ?? null),
    listByProject: vi.fn(() => []),
    listByStatus: vi.fn(() => []),
    claimPending: vi.fn(() => true),
    completeRunning: vi.fn(() => true),
    failRunning: vi.fn((id: string, errorCode: string, errorMessage: string) => {
      const t = taskStore.get(id);
      if (!t || t.status !== 'RUNNING') return false;
      taskStore.set(id, { ...t, status: 'FAILED', errorCode, errorMessage });
      return true;
    }),
    failPending: vi.fn(() => true),
    markStale: vi.fn(() => true),
    resetToPending: vi.fn(() => true),
    listRunning: vi.fn(() => []),
  };

  const invocationRepo: ModelInvocationRepositoryPort = {
    create: vi.fn((data: CreateInvocationInput) => {
      invocationStore.set(data.id, { ...mockInvocation('PENDING'), ...data });
    }),
    getById: vi.fn((id: string) => invocationStore.get(id) ?? null),
    listByTask: vi.fn(() => []),
    markRunning: vi.fn(() => true),
    markSucceeded: vi.fn((_id: string, _s: 'RUNNING', _r: InvocationSuccessResult) => true),
    markFailed: vi.fn(
      (id: string, expected: ReadonlyArray<string>, errorCode: string, errorMessage: string) => {
        const inv = invocationStore.get(id);
        if (!inv || !expected.includes(inv.status)) return false;
        invocationStore.set(id, { ...inv, status: 'FAILED', errorCode, errorMessage });
        return true;
      },
    ),
    getStatsByProject: vi.fn(() => ({
      invocationCount: 0,
      succeededCount: 0,
      failedCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
    })),
    listRunning: vi.fn(() => []),
  };

  const deps: TaskEngineDeps = {
    taskRepo,
    invocationRepo,
    secretStore: {
      hasSecret: vi.fn(async () => true),
      setSecret: vi.fn(async () => {}),
      getSecret: vi.fn(async () => 'k'),
      deleteSecret: vi.fn(async () => {}),
    } as SecretStore,
    providerRepo: {} as ProviderProfileRepository,
    idGenerator: { generate: vi.fn(() => 'x') } as IdGenerator,
    clock: { now: vi.fn(() => NOW) } as Clock,
    invokeModel: vi.fn(),
    transaction: <T>(fn: () => T): T => {
      if (options.transactionThrows) throw new Error('事务失败');
      return fn();
    },
  };
  return { deps, taskStore, invocationStore };
}

describe('compensateFinalization', () => {
  it('仍 RUNNING 的 invocation 与 task 都被标记 FAILED', () => {
    const { deps, taskStore, invocationStore } = buildDeps({
      taskStatus: 'RUNNING',
      invocationStatus: 'RUNNING',
    });
    compensateFinalization(deps, 't1', 'inv-1', '任务最终提交失败');

    expect(invocationStore.get('inv-1')!.status).toBe('FAILED');
    expect(taskStore.get('t1')!.status).toBe('FAILED');
    expect(taskStore.get('t1')!.errorCode).toBe('TASK_EXECUTION_FAILED');
  });

  it('已终态的记录不再改写（补偿只针对半成品）', () => {
    const { deps, taskStore, invocationStore } = buildDeps({
      taskStatus: 'SUCCEEDED',
      invocationStatus: 'SUCCEEDED',
    });
    compensateFinalization(deps, 't1', 'inv-1', '任务最终提交失败');

    expect(invocationStore.get('inv-1')!.status).toBe('SUCCEEDED');
    expect(taskStore.get('t1')!.status).toBe('SUCCEEDED');
  });

  it('补偿自身失败不向外抛（不得掩盖原始错误）', () => {
    const { deps } = buildDeps({
      taskStatus: 'RUNNING',
      invocationStatus: 'RUNNING',
      transactionThrows: true,
    });
    expect(() => compensateFinalization(deps, 't1', 'inv-1', '任务最终提交失败')).not.toThrow();
  });
});
