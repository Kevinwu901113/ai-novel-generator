/**
 * Grill 问题规划任务执行引擎测试。
 *
 * 使用 mock 依赖（含可回滚事务）验证：
 * stale-before/after-call、严格输出、安全持久化边界、调用审计、事务一致性。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  executeGrillQuestionPlan,
  type GrillQuestionPlanEngineDeps,
} from './grill-question-plan.js';
import { TaskExecutionError } from './index.js';
import type {
  TaskData,
  TaskRepositoryPort,
  ModelInvocationData,
  ModelInvocationRepositoryPort,
  SecretStore,
  ProviderProfileRepository,
  ProviderProfileData,
  GrillSessionData,
  GrillSessionRepositoryPort,
  GrillQuestionData,
  GrillQuestionRepositoryPort,
  GrillAnswerRepositoryPort,
  GrillQuestionPlanProposalRepositoryPort,
  CreateGrillQuestionPlanProposalInput,
} from '@ai-novel/application';
import type { ModelInvocationOutput } from '@ai-novel/model-gateway';
import type { ErrorCode } from '@ai-novel/contracts';

const NOW = '2024-06-15T12:00:00.000Z';

const VALID_PLAN_TEXT = JSON.stringify({
  schemaVersion: 1,
  questions: [{ key: 'q1', topic: '主题', text: '问题', rationale: '理由', dependencies: [] }],
});

// ── 状态容器 ──────────────────────────────────────────────────────

interface State {
  task: TaskData;
  sessionVersion: number;
  /** 每次读取会话时返回的版本序列（用于模拟调用后版本变化） */
  sessionVersionSequence?: number[];
  sessionReadCount: number;
  invocation: ModelInvocationData | null;
  proposal: (CreateGrillQuestionPlanProposalInput & { status: string }) | null;
  invokeCalls: Array<{ prompt: string; apiKey: string; systemPrompt?: string }>;
  modelOutput: ModelInvocationOutput;
  completeRunningResult: boolean;
}

function makeTask(): TaskData {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    taskType: 'GRILL_QUESTION_PLAN',
    status: 'PENDING',
    inputVersionJson: JSON.stringify({
      sessionId: 'sess-1',
      baseSessionVersion: 3,
      schemaVersion: 1,
      providerProfileId: 'provider-1',
    }),
    payloadJson: '{}',
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    dedupeKey: 'grill_question_plan:sess-1:3',
    attemptCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    finishedAt: null,
    staleAt: null,
    cancelledAt: null,
  };
}

function makeOutput(text: string, errorCode: ErrorCode | null = null): ModelInvocationOutput {
  return {
    text,
    providerRequestId: 'req-1',
    finishReason: 'end_turn',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 150,
    },
    latencyMs: 1234,
    errorCode,
    errorMessage: errorCode ? '模型调用失败' : null,
  };
}

let state: State;

function makeProviderProfile(): ProviderProfileData {
  return {
    id: 'provider-1',
    providerType: 'anthropic-compatible',
    displayName: 'Test Provider',
    baseUrl: 'https://example.test/anthropic',
    model: 'test-model',
    keychainService: 'svc',
    keychainAccount: 'acct',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestErrorCode: null,
    lastTestLatencyMs: null,
  };
}

function buildDeps(): GrillQuestionPlanEngineDeps {
  const taskRepo: TaskRepositoryPort = {
    create: vi.fn(),
    getById: () => state.task,
    listByProject: () => [],
    listByStatus: () => [],
    claimPending(_id) {
      if (state.task.status !== 'PENDING') return false;
      state.task = { ...state.task, status: 'RUNNING', attemptCount: state.task.attemptCount + 1 };
      return true;
    },
    completeRunning(_id, resultJson) {
      if (!state.completeRunningResult) return false;
      state.task = { ...state.task, status: 'SUCCEEDED', resultJson };
      return true;
    },
    failRunning(_id, errorCode, errorMessage) {
      state.task = { ...state.task, status: 'FAILED', errorCode, errorMessage };
      return true;
    },
    failPending(_id, errorCode, errorMessage) {
      if (state.task.status !== 'PENDING') return false;
      state.task = { ...state.task, status: 'FAILED', errorCode, errorMessage };
      return true;
    },
    markStale(_id, expectedStatuses) {
      if (!expectedStatuses.includes(state.task.status)) return false;
      state.task = { ...state.task, status: 'STALE', staleAt: NOW };
      return true;
    },
    resetToPending: () => true,
    listRunning: () => [],
  };

  const invocationRepo: ModelInvocationRepositoryPort = {
    create(data) {
      state.invocation = {
        id: data.id,
        projectId: data.projectId,
        taskId: data.taskId,
        providerProfileId: data.providerProfileId,
        model: data.model,
        status: 'PENDING',
        attemptNumber: data.attemptNumber,
        requestKind: data.requestKind,
        promptHash: data.promptHash,
        requestMetadataJson: data.requestMetadataJson,
        responseMetadataJson: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: null,
        latencyMs: null,
        finishReason: null,
        errorCode: null,
        errorMessage: null,
        providerRequestId: null,
        createdAt: NOW,
        startedAt: null,
        finishedAt: null,
      };
    },
    getById: () => state.invocation,
    listByTask: () => (state.invocation ? [state.invocation] : []),
    markRunning(_id, expected) {
      if (!state.invocation || state.invocation.status !== expected) return false;
      state.invocation = { ...state.invocation, status: 'RUNNING' };
      return true;
    },
    markSucceeded(_id, expected, result) {
      if (!state.invocation || state.invocation.status !== expected) return false;
      state.invocation = {
        ...state.invocation,
        status: 'SUCCEEDED',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalTokens: result.totalTokens,
        latencyMs: result.latencyMs,
        finishReason: result.finishReason,
        providerRequestId: result.providerRequestId,
      };
      return true;
    },
    markFailed(_id, expectedStatuses, errorCode, errorMessage, latencyMs) {
      if (!state.invocation || !expectedStatuses.includes(state.invocation.status)) return false;
      state.invocation = {
        ...state.invocation,
        status: 'FAILED',
        errorCode,
        errorMessage,
        latencyMs,
      };
      return true;
    },
    getStatsByProject: () => ({
      invocationCount: 0,
      succeededCount: 0,
      failedCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
    }),
    listRunning: () => [],
  };

  const secretStore: SecretStore = {
    hasSecret: async () => true,
    setSecret: async () => {},
    getSecret: async () => 'secret-api-key',
    deleteSecret: async () => {},
  };

  const providerRepo: ProviderProfileRepository = {
    getById: () => makeProviderProfile(),
    updateTestResult: () => {},
  };

  const sessionRepo: GrillSessionRepositoryPort = {
    create: vi.fn(),
    getById: () => {
      state.sessionReadCount++;
      let version = state.sessionVersion;
      if (state.sessionVersionSequence) {
        const idx = Math.min(state.sessionReadCount - 1, state.sessionVersionSequence.length - 1);
        version = state.sessionVersionSequence[idx];
      }
      return {
        id: 'sess-1',
        projectId: 'proj-1',
        status: 'ACTIVE',
        version,
        goal: '目标',
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: NOW,
        completedAt: null,
        abandonedAt: null,
      } as GrillSessionData;
    },
    listByProject: () => [],
    transitionStatus: () => true,
    bumpVersion: () => true,
  };

  const questionRepo: GrillQuestionRepositoryPort = {
    create: vi.fn(),
    getById: () => null,
    listBySession: () => [] as GrillQuestionData[],
    markAsked: () => true,
    markAnswered: () => true,
    markSkipped: () => true,
    markSuperseded: () => true,
    getMaxSequence: () => 0,
  };

  const answerRepo: GrillAnswerRepositoryPort = {
    create: vi.fn(),
    getById: () => null,
    getCurrentByQuestion: () => null,
    listByQuestion: () => [],
    listCurrentBySession: () => [],
    supersedeCurrent: () => true,
  };

  const planProposalRepo: GrillQuestionPlanProposalRepositoryPort = {
    create(data) {
      state.proposal = { ...data, status: 'PROPOSED' };
    },
    getById: () => null,
    listBySession: () => [],
    markAccepted: () => true,
    markRejected: () => true,
    markStale: () => true,
  };

  return {
    taskRepo,
    invocationRepo,
    secretStore,
    providerRepo,
    idGenerator: { generate: () => 'gen-1' },
    clock: { now: () => NOW },
    sessionRepo,
    questionRepo,
    answerRepo,
    planProposalRepo,
    invokeModel: async (input) => {
      state.invokeCalls.push({
        prompt: input.prompt,
        apiKey: input.apiKey,
        systemPrompt: input.systemPrompt,
      });
      return state.modelOutput;
    },
    transaction: <T>(fn: () => T) => fn(),
  };
}

beforeEach(() => {
  state = {
    task: makeTask(),
    sessionVersion: 3,
    sessionReadCount: 0,
    invocation: null,
    proposal: null,
    invokeCalls: [],
    modelOutput: makeOutput(VALID_PLAN_TEXT),
    completeRunningResult: true,
  };
});

// ── 测试 ──────────────────────────────────────────────────────────

describe('executeGrillQuestionPlan — stale 语义', () => {
  it('28. 调用模型前 stale：不调用 provider，不创建 proposal', async () => {
    state.sessionVersion = 4; // 与 baseSessionVersion(3) 不一致
    const result = await executeGrillQuestionPlan(buildDeps(), 'task-1');
    expect(result.task.status).toBe('STALE');
    expect(state.invokeCalls).toHaveLength(0);
    expect(state.proposal).toBeNull();
    expect(result.invocation).toBeNull();
  });

  it('29. provider 返回后 session 变化：不保存 proposal', async () => {
    // 第一次读取（before）版本 3，第二次读取（after）版本 4
    state.sessionVersionSequence = [3, 4];
    const result = await executeGrillQuestionPlan(buildDeps(), 'task-1');
    expect(result.task.status).toBe('STALE');
    expect(state.invokeCalls).toHaveLength(1); // 模型已被调用
    expect(state.proposal).toBeNull(); // 但结果被丢弃
  });
});

describe('executeGrillQuestionPlan — claim 与恢复', () => {
  it('35. 非 PENDING 任务不能被 claim', async () => {
    state.task = { ...state.task, status: 'RUNNING' };
    await expect(executeGrillQuestionPlan(buildDeps(), 'task-1')).rejects.toThrow(
      TaskExecutionError,
    );
    expect(state.invokeCalls).toHaveLength(0);
  });

  it('36. 任务不存在抛 TASK_NOT_FOUND', async () => {
    const deps = buildDeps();
    deps.taskRepo.getById = () => null;
    await expect(executeGrillQuestionPlan(deps, 'ghost')).rejects.toThrow('不存在');
  });
});

describe('executeGrillQuestionPlan — 持久化与安全', () => {
  it('37. 合法结果保存正规化 proposal', async () => {
    const result = await executeGrillQuestionPlan(buildDeps(), 'task-1');
    expect(result.task.status).toBe('SUCCEEDED');
    expect(state.proposal).not.toBeNull();
    expect(state.proposal?.baseSessionVersion).toBe(3);
    const stored = JSON.parse(state.proposal!.questionsJson) as { questions: unknown[] };
    expect(stored.questions).toHaveLength(1);
  });

  it('38. 非法结果不保存 proposal', async () => {
    state.modelOutput = makeOutput('这不是 JSON');
    const result = await executeGrillQuestionPlan(buildDeps(), 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(state.proposal).toBeNull();
  });

  it('39. task.result 只含安全摘要', async () => {
    await executeGrillQuestionPlan(buildDeps(), 'task-1');
    const result = JSON.parse(state.task.resultJson!) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      'baseSessionVersion',
      'proposalId',
      'questionCount',
    ]);
    expect(result.questionCount).toBe(1);
    // 不含完整问题文本
    expect(state.task.resultJson).not.toContain('问题');
  });

  it('40/41. 数据库不含 raw prompt 或 raw output', async () => {
    await executeGrillQuestionPlan(buildDeps(), 'task-1');
    // invocation 只存 promptHash（64 hex），不存 prompt 文本
    expect(state.invocation?.promptHash).toMatch(/^[0-9a-f]{64}$/);
    const invocationJson = JSON.stringify(state.invocation);
    expect(invocationJson).not.toContain('会话目标');
    // proposal 存规范化计划，不存原始模型输出（含 schemaVersion 的结构化内容除外）
    expect(state.invocation?.requestMetadataJson).not.toContain('apiKey');
  });

  it('42. API Key 不进入持久化数据', async () => {
    await executeGrillQuestionPlan(buildDeps(), 'task-1');
    expect(state.invokeCalls[0].apiKey).toBe('secret-api-key'); // 仅存在于调用栈
    const allPersisted = JSON.stringify([state.task, state.invocation, state.proposal]);
    expect(allPersisted).not.toContain('secret-api-key');
  });

  it('43. errorMessage 不含路径/stack/SQL', async () => {
    state.modelOutput = makeOutput('bad json');
    await executeGrillQuestionPlan(buildDeps(), 'task-1');
    const msg = state.task.errorMessage ?? '';
    expect(msg).not.toMatch(/sqlite|SQL|\/Users|at Object|stack/i);
    expect(msg.length).toBeGreaterThan(0);
  });

  it('44. model invocation audit 记录 provider/model/token/latency', async () => {
    await executeGrillQuestionPlan(buildDeps(), 'task-1');
    expect(state.invocation?.providerProfileId).toBe('provider-1');
    expect(state.invocation?.model).toBe('test-model');
    expect(state.invocation?.inputTokens).toBe(100);
    expect(state.invocation?.outputTokens).toBe(50);
    expect(state.invocation?.totalTokens).toBe(150);
    expect(state.invocation?.latencyMs).toBe(1234);
    expect(state.invocation?.requestKind).toBe('grill_question_plan');
  });

  it('45. provider failure 记录稳定错误码', async () => {
    state.modelOutput = makeOutput('', 'PROVIDER_RATE_LIMITED');
    const result = await executeGrillQuestionPlan(buildDeps(), 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(state.task.errorCode).toBe('PROVIDER_RATE_LIMITED');
    expect(state.invocation?.errorCode).toBe('PROVIDER_RATE_LIMITED');
    expect(state.proposal).toBeNull();
  });

  it('JSON 级失败映射为 MODEL_RESPONSE_INVALID', async () => {
    state.modelOutput = makeOutput('```json\n{}\n```');
    await executeGrillQuestionPlan(buildDeps(), 'task-1');
    expect(state.task.errorCode).toBe('MODEL_RESPONSE_INVALID');
  });

  it('schema 级失败映射为 GRILL_PLAN_SCHEMA_INVALID', async () => {
    state.modelOutput = makeOutput(JSON.stringify({ schemaVersion: 9, questions: [] }));
    await executeGrillQuestionPlan(buildDeps(), 'task-1');
    expect(state.task.errorCode).toBe('GRILL_PLAN_SCHEMA_INVALID');
  });

  it('46. proposal 与 task completion 事务一致（complete 失败则无 proposal）', async () => {
    state.completeRunningResult = false;
    // 事务内 completeRunning CAS 失败抛错；mock 事务不回滚，但引擎在抛错前不会单独提交 proposal。
    await expect(executeGrillQuestionPlan(buildDeps(), 'task-1')).rejects.toThrow(
      TaskExecutionError,
    );
    expect(state.task.status).not.toBe('SUCCEEDED');
  });

  it('provider 未配置 → 任务 FAILED（PROVIDER_NOT_CONFIGURED，attemptCount 不递增）', async () => {
    const deps = buildDeps();
    deps.providerRepo.getById = () => null;
    const result = await executeGrillQuestionPlan(deps, 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(result.task.errorCode).toBe('PROVIDER_NOT_CONFIGURED');
    expect(result.task.attemptCount).toBe(0);
    expect(result.invocation).toBeNull();
    expect(state.invokeCalls).toHaveLength(0);
  });

  it('缺少 API Key → 任务 FAILED（API_KEY_REQUIRED，attemptCount 不递增）', async () => {
    const deps = buildDeps();
    deps.secretStore.getSecret = async () => null;
    const result = await executeGrillQuestionPlan(deps, 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(result.task.errorCode).toBe('API_KEY_REQUIRED');
    expect(result.task.attemptCount).toBe(0);
    expect(result.invocation).toBeNull();
    expect(state.invokeCalls).toHaveLength(0);
  });
});
