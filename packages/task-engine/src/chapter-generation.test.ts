/**
 * CHAPTER_DRAFT 任务引擎测试（GE-6）。
 *
 * - parseChapterDraftV1：严格解析（合法/非 JSON/多余字段/缺字段/坏 scenePlans）；
 * - executeChapterDraft：成功（task SUCCEEDED + draft 解析 + 安全摘要）；
 *   无效输出 → 任务失败不留半成品；模型错误 → 失败。
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  TaskRepositoryPort,
  ModelInvocationRepositoryPort,
  SecretStore,
  ProviderProfileRepository,
  IdGenerator,
  Clock,
  TaskData,
  ModelInvocationData,
  CreateInvocationInput,
  InvocationSuccessResult,
} from '@ai-novel/application';
import type { ModelInvocationOutput } from '@ai-novel/model-gateway';
import { executeChapterDraft, parseChapterDraftV1, type TaskEngineDeps } from './index.js';
import { TaskExecutionError } from './index.js';

const NOW = '2026-08-04T00:00:00.000Z';

function mockTask(taskId = 't1'): TaskData {
  return {
    id: taskId,
    projectId: 'p1',
    taskType: 'CHAPTER_DRAFT',
    status: 'PENDING',
    inputVersionJson: '{}',
    payloadJson: '{}',
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    dedupeKey: null,
    attemptCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    finishedAt: null,
    staleAt: null,
    cancelledAt: null,
  };
}

function mockInvocation(data: CreateInvocationInput): ModelInvocationData {
  return {
    ...data,
    status: 'PENDING',
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

function buildDeps(
  overrides: {
    invokeResult?: ModelInvocationOutput;
    invokeError?: unknown;
  } = {},
) {
  const taskStore = new Map<string, TaskData>([['t1', mockTask()]]);
  const invocationStore = new Map<string, ModelInvocationData>();

  const taskRepo: TaskRepositoryPort = {
    create: vi.fn(),
    getById: vi.fn((id: string) => taskStore.get(id) ?? null),
    listByProject: vi.fn(() => []),
    listByStatus: vi.fn(() => []),
    claimPending: vi.fn((id: string) => {
      const t = taskStore.get(id);
      if (!t || t.status !== 'PENDING') return false;
      taskStore.set(id, { ...t, status: 'RUNNING', attemptCount: t.attemptCount + 1 });
      return true;
    }),
    completeRunning: vi.fn((id: string, resultJson: string) => {
      const t = taskStore.get(id);
      if (!t || t.status !== 'RUNNING') return false;
      taskStore.set(id, { ...t, status: 'SUCCEEDED', resultJson });
      return true;
    }),
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
    create: vi.fn((data: CreateInvocationInput) =>
      invocationStore.set(data.id, mockInvocation(data)),
    ),
    getById: vi.fn((id: string) => invocationStore.get(id) ?? null),
    listByTask: vi.fn(() => []),
    markRunning: vi.fn((id: string) => {
      const inv = invocationStore.get(id);
      if (!inv || inv.status !== 'PENDING') return false;
      invocationStore.set(id, { ...inv, status: 'RUNNING' });
      return true;
    }),
    markSucceeded: vi.fn((id: string, _s: 'RUNNING', result: InvocationSuccessResult) => {
      const inv = invocationStore.get(id);
      if (!inv || inv.status !== 'RUNNING') return false;
      invocationStore.set(id, { ...inv, status: 'SUCCEEDED', ...result });
      return true;
    }),
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

  const secretStore: SecretStore = {
    hasSecret: vi.fn(async () => true),
    setSecret: vi.fn(async () => {}),
    getSecret: vi.fn(async () => 'test-key'),
    deleteSecret: vi.fn(async () => {}),
  };
  const providerRepo: ProviderProfileRepository = {
    getById: vi.fn(() => ({
      id: 'mimo-token-plan-cn',
      providerType: 'anthropic-compatible',
      displayName: 'MiMo',
      baseUrl: 'https://x',
      model: 'mimo-v2.5-pro',
      keychainService: 'svc',
      keychainAccount: 'acc',
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestErrorCode: null,
      lastTestLatencyMs: null,
    })),
    updateTestResult: vi.fn(),
  };
  const idGenerator: IdGenerator = { generate: vi.fn(() => 'inv-1') };
  const clock: Clock = { now: vi.fn(() => NOW) };

  const invokeModel = overrides.invokeError
    ? vi.fn(async () => {
        throw overrides.invokeError;
      })
    : vi.fn(async () => overrides.invokeResult ?? mockSuccessOutput());

  const deps: TaskEngineDeps = {
    taskRepo,
    invocationRepo,
    secretStore,
    providerRepo,
    idGenerator,
    clock,
    invokeModel,
    transaction: <T>(fn: () => T) => fn(),
  };
  return { deps, taskStore, invocationStore, taskRepo, invocationRepo };
}

function mockSuccessOutput(): ModelInvocationOutput {
  return {
    text: JSON.stringify({ title: '第一章', content: '正文', scenePlans: ['场景一'] }),
    providerRequestId: 'req-1',
    finishReason: 'end_turn',
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
    },
    latencyMs: 100,
    errorCode: null,
    errorMessage: null,
  };
}

describe('parseChapterDraftV1', () => {
  it('合法 JSON → 解析', () => {
    const draft = parseChapterDraftV1(
      JSON.stringify({ title: '第一章', content: '正文', scenePlans: ['a', 'b'] }),
    );
    expect(draft.title).toBe('第一章');
    expect(draft.scenePlans).toEqual(['a', 'b']);
  });

  it('拒绝非 JSON / 多余字段 / 缺字段 / 坏 scenePlans', () => {
    expect(() => parseChapterDraftV1('not json')).toThrow(TaskExecutionError);
    expect(() =>
      parseChapterDraftV1(JSON.stringify({ title: 'x', content: 'y', scenePlans: [], extra: 1 })),
    ).toThrow();
    expect(() => parseChapterDraftV1(JSON.stringify({ title: 'x', scenePlans: [] }))).toThrow();
    expect(() =>
      parseChapterDraftV1(JSON.stringify({ title: 'x', content: 'y', scenePlans: [42] })),
    ).toThrow();
  });
});

describe('executeChapterDraft', () => {
  it('成功：task SUCCEEDED + draft 解析 + 安全摘要（不含正文）', async () => {
    const { deps, taskRepo } = buildDeps();
    const result = await executeChapterDraft(deps, 't1', 'prompt');
    expect(result.draft.title).toBe('第一章');
    expect(result.draft.content).toBe('正文');
    const task = taskRepo.getById('t1')!;
    expect(task.status).toBe('SUCCEEDED');
    const summary = JSON.parse(task.resultJson ?? '{}');
    expect(summary.title).toBe('第一章');
    expect(summary.contentHash).toHaveLength(64);
    expect(JSON.stringify(task.resultJson)).not.toContain('正文');
  });

  it('无效输出 → 任务失败，不留半成品', async () => {
    const { deps, taskRepo } = buildDeps({
      invokeResult: { ...mockSuccessOutput(), text: '{"title":"x"}' },
    });
    await executeChapterDraft(deps, 't1', 'prompt');
    expect(taskRepo.getById('t1')!.status).toBe('FAILED');
    expect(taskRepo.getById('t1')!.errorCode).toBe('MODEL_RESPONSE_INVALID');
  });

  it('模型错误 → 任务失败', async () => {
    const { deps, taskRepo } = buildDeps({ invokeError: new Error('boom') });
    const result = await executeChapterDraft(deps, 't1', 'prompt');
    expect(taskRepo.getById('t1')!.status).toBe('FAILED');
    expect(result.draft).toBeNull();
  });
});
