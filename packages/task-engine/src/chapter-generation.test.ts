/**
 * CHAPTER_DRAFT 任务引擎测试（GE-6 base, RW-1-R5）。
 *
 * - parseChapterDraftV1：严格解析（合法/非 JSON/多余字段/缺字段/坏 scenePlans）；
 * - executeChapterDraft：
 *   - 成功（task SUCCEEDED + draft 解析 + 安全摘要 + execution-bound envelope 含真实
 *     artifactId）；
 *   - 权威 execution context 从 DB 经 getByTaskId 取得（不信任调用方手拼 context）；
 *   - 无效输出 → 任务失败不留半成品；模型错误 → 失败；
 *   - 最终事务失败 → 补偿标记仍 RUNNING 的 invocation/task FAILED。
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
  NodeExecutionRepositoryPort,
  NodeExecutionRecord,
  NodeExecutionResultEnvelope,
  NodeExecutionResultStorePort,
} from '@ai-novel/application';
import type { ModelInvocationOutput } from '@ai-novel/model-gateway';
import {
  executeChapterDraft,
  parseChapterDraftV1,
  type ChapterDraftExecutionDeps,
} from './index.js';
import { TaskExecutionError } from './index.js';

const NOW = '2026-08-04T00:00:00.000Z';

const EXECUTION: NodeExecutionRecord = {
  id: 'exec-1',
  graphRunId: 'run-1',
  graphId: 'chapter-generation',
  graphVersion: 'v1',
  nodeId: 'DRAFT',
  activationNo: 1,
  attemptNo: 1,
  executorId: 'chapter-draft-v1',
  executorVersion: 'v1',
  recoveryPolicy: 'settle_if_result',
  inputSnapshotJson: '{}',
  inputHash: 'h'.repeat(64),
  taskId: 't1',
  claimedBy: 'test-runner',
  leaseExpiresAt: null,
  status: 'running',
  artifactReceiptJson: null,
  errorCode: null,
  createdAt: NOW,
  updatedAt: NOW,
  settledAt: null,
};

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
    /** 预插入同 executionId 的不同内容 envelope → 最终事务 saveOrVerifySame 抛错 */
    preexistingResult?: NodeExecutionResultEnvelope;
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

  const resultStore = new Map<string, NodeExecutionResultEnvelope>();
  if (overrides.preexistingResult) {
    resultStore.set(overrides.preexistingResult.executionId, overrides.preexistingResult);
  }
  const nodeExecutionResultStore: NodeExecutionResultStorePort = {
    save: (r) => resultStore.set(r.executionId, r),
    saveOrVerifySame: (r) => {
      const existing = resultStore.get(r.executionId);
      if (existing === undefined) {
        resultStore.set(r.executionId, r);
        return;
      }
      if (JSON.stringify(existing) !== JSON.stringify(r)) {
        throw new Error(`execution ${r.executionId} 已有不同内容的权威 result，拒绝覆盖`);
      }
    },
    getByExecutionId: (id) => resultStore.get(id) ?? null,
  };

  // 权威 execution context（taskId → execution）
  const nodeExecutionRepo: NodeExecutionRepositoryPort = {
    create: vi.fn(() => true),
    getById: vi.fn(() => null),
    getByTaskId: vi.fn((taskId: string) => (taskId === 't1' ? { ...EXECUTION, taskId } : null)),
    getLatestByRunNode: vi.fn(() => null),
    getInFlightByRunNode: vi.fn(() => null),
    listActiveByRun: vi.fn(() => []),
    markRunning: vi.fn(() => true),
    markSettled: vi.fn(() => true),
    markFailed: vi.fn(() => true),
    markSuperseded: vi.fn(() => true),
  };

  const deps: ChapterDraftExecutionDeps = {
    taskRepo,
    invocationRepo,
    secretStore,
    providerRepo,
    idGenerator,
    clock,
    invokeModel,
    transaction: <T>(fn: () => T) => fn(),
    nodeExecutionResultStore,
    nodeExecutionRepo,
  };
  return {
    deps,
    taskStore,
    invocationStore,
    taskRepo,
    invocationRepo,
    resultStore,
    idGenerator,
  };
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
  it('成功：权威 context 从 DB 取得 + task SUCCEEDED + 真实 artifactId + envelope 持久化', async () => {
    const { deps, taskRepo, resultStore } = buildDeps();
    const result = await executeChapterDraft(deps, 't1', 'prompt');
    expect(result.draft).not.toBeNull();
    expect(result.draft!.title).toBe('第一章');
    expect(result.draft!.content).toBe('正文');
    const task = taskRepo.getById('t1')!;
    expect(task.status).toBe('SUCCEEDED');
    const summary = JSON.parse(task.resultJson ?? '{}');
    expect(summary.title).toBe('第一章');
    expect(summary.contentHash).toHaveLength(64);
    expect(JSON.stringify(task.resultJson)).not.toContain('正文');
    // 权威 envelope：真实 artifactId（非 executionId）、activation/attempt 来自 DB context
    const persisted = resultStore.get('exec-1');
    expect(persisted).not.toBeNull();
    expect(persisted!.graphRunId).toBe('run-1');
    expect(persisted!.nodeId).toBe('DRAFT');
    expect(persisted!.activationNo).toBe(1);
    expect(persisted!.attemptNo).toBe(1);
    expect(persisted!.artifactId).not.toBeNull();
    expect(persisted!.artifactId).not.toBe('exec-1'); // 真实 ID，非 executionId 伪校验
    expect(result.artifactId).toBe(persisted!.artifactId);
  });

  it('任务未绑定 execution → 任务 FAILED（TASK_NOT_BOUND）', async () => {
    const { deps, taskRepo } = buildDeps();
    // 覆盖 getByTaskId 返回 null
    const deps2 = {
      ...deps,
      nodeExecutionRepo: {
        ...deps.nodeExecutionRepo,
        getByTaskId: vi.fn(() => null),
      },
    };
    await executeChapterDraft(deps2 as never, 't1', 'prompt');
    expect(taskRepo.getById('t1')!.status).toBe('FAILED');
    expect(taskRepo.getById('t1')!.errorCode).toBe('TASK_NOT_BOUND');
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

  it('最终事务失败（envelope 内容冲突）→ 补偿标记仍 RUNNING 的 invocation/task FAILED', async () => {
    const { deps, taskRepo, invocationRepo } = buildDeps({
      preexistingResult: {
        executionId: 'exec-1',
        projectId: 'p1',
        graphRunId: 'run-1',
        nodeId: 'DRAFT',
        taskId: 't1',
        activationNo: 1,
        attemptNo: 1,
        executorId: 'chapter-draft-v1',
        executorVersion: 'v1',
        inputHash: 'h'.repeat(64),
        artifactKind: 'generationRun',
        artifactId: 'gen-other',
        artifactVersion: 1,
        contentJson: JSON.stringify({
          kind: 'generationRun',
          draft: { title: 'X', content: 'Y', scenePlans: [] },
        }),
        outcome: null,
        createdAt: NOW,
      },
    });
    await expect(executeChapterDraft(deps, 't1', 'prompt')).rejects.toThrow();
    // 补偿：invocation / task 都标记 FAILED，不留 RUNNING 半成品
    const task = taskRepo.getById('t1')!;
    expect(task.status).toBe('FAILED');
    expect(task.errorCode).toBe('TASK_EXECUTION_FAILED');
    const invocation = invocationRepo.getById('inv-1');
    expect(invocation).not.toBeNull();
    expect(invocation!.status).toBe('FAILED');
  });
});
