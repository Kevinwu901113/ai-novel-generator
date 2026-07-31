/**
 * 创作契约草案任务执行引擎测试（mock 控制流）。
 *
 * 覆盖：claim 前 provider/key 失败、无效输入、错误 task type、CAS 冲突、
 * stale-before-call（session/contract）、first/existing 成功、provider 错误、
 * model throw、严格输出解析（JSON/markdown/额外字段/无效 sections）、
 * 锁保护、stable identity、stale-after-call、stale final-transaction race、
 * prompt deterministic hash、不持久化 prompt/raw、安全 task result。
 *
 * 原子性/回滚/并发由真实 SQLite 测试（apps/worker）覆盖。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { executeCreationContractDraft, sha256Hex } from './index.js';
import { TaskExecutionError } from './index.js';
import type { ContractDraftEngineDeps } from './creation-contract-draft.js';
import {
  canonicalSerializeContractSections,
  canonicalSerializeLockedFieldPaths,
  validateCreationContractSections,
  type CreationContractSections,
} from '@ai-novel/domain';
import type {
  TaskData,
  TaskRepositoryPort,
  ModelInvocationData,
  ModelInvocationRepositoryPort,
  SecretStore,
  ProviderProfileRepository,
  ProviderProfileData,
  GrillSessionRepositoryPort,
  GrillSessionData,
  GrillQuestionRepositoryPort,
  GrillQuestionData,
  GrillAnswerRepositoryPort,
  GrillAnswerData,
  GrillProposalRepositoryPort,
  GrillProposalData,
  CreationContractProposalRepositoryPort,
  CreationContractVersionRepositoryPort,
  CreationContractCurrentRepositoryPort,
  CreateCreationContractProposalInput,
  CreationContractCurrentData,
  CreationContractVersionData,
  Sha256Port,
} from '@ai-novel/application';
import type { ModelInvocationOutput } from '@ai-novel/model-gateway';
import type { ErrorCode } from '@ai-novel/contracts';

const NOW = '2024-06-15T12:00:00.000Z';
const HEX64 = 'a'.repeat(64);
const OTHER_HEX64 = 'b'.repeat(64);

function makeSections(overrides: Record<string, unknown> = {}): CreationContractSections {
  return validateCreationContractSections({
    premise: '一个关于契约的故事',
    genre: ['sci-fi'],
    tone: ['dark'],
    targetAudience: 'adults',
    narrativePov: 'FIRST',
    tense: 'PRESENT',
    protagonist: { characterKey: 'protag', name: '主角' },
    ...overrides,
  });
}

function sectionsJson(overrides: Record<string, unknown> = {}): string {
  return canonicalSerializeContractSections(makeSections(overrides));
}

function modelText(sections: unknown = makeSections()): string {
  return JSON.stringify({ schemaVersion: 1, sections });
}

const FIRST_INPUT = JSON.stringify({
  grillSessionId: 'gs-1',
  baseGrillSessionVersion: 3,
  contractBaseline: {
    contractVersionId: null,
    contractVersion: null,
    contractSnapshotHash: null,
  },
  schemaVersion: 1,
  providerProfileId: 'provider-1',
});

const EXISTING_INPUT = JSON.stringify({
  grillSessionId: 'gs-1',
  baseGrillSessionVersion: 3,
  contractBaseline: {
    contractVersionId: 'ver-2',
    contractVersion: 2,
    contractSnapshotHash: HEX64,
  },
  schemaVersion: 1,
  providerProfileId: 'provider-1',
});

function makeTask(inputVersionJson: string = FIRST_INPUT): TaskData {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    taskType: 'CREATION_CONTRACT_DRAFT',
    status: 'PENDING',
    inputVersionJson,
    payloadJson: '{}',
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    dedupeKey: 'creation_contract_draft:gs-1:3:none:none',
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

function makeSession(overrides: Partial<GrillSessionData> = {}): GrillSessionData {
  return {
    id: 'gs-1',
    projectId: 'proj-1',
    status: 'COMPLETED',
    version: 3,
    goal: '一个目标',
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    abandonedAt: null,
    ...overrides,
  };
}

function makeVersion(
  overrides: Partial<CreationContractVersionData> = {},
): CreationContractVersionData {
  return {
    id: 'ver-2',
    projectId: 'proj-1',
    version: 2,
    schemaVersion: 1,
    sourceProposalId: 'prop-1',
    basedOnGrillSessionId: 'gs-1',
    basedOnGrillSessionVersion: 3,
    sectionsJson: sectionsJson(),
    lockedFieldPathsJson: canonicalSerializeLockedFieldPaths([]),
    contractSnapshotHash: HEX64,
    provenanceJson: '[]',
    createdAt: NOW,
    createdBy: 'ai-proposal-accepted',
    ...overrides,
  };
}

interface MockState {
  task: TaskData;
  sessionQueue: GrillSessionData[];
  defaultSession: GrillSessionData;
  currentQueue: Array<CreationContractCurrentData | null>;
  defaultCurrent: CreationContractCurrentData | null;
  versionQueue: CreationContractVersionData[];
  defaultVersion: CreationContractVersionData | null;
  invocation: ModelInvocationData | null;
  proposal: CreateCreationContractProposalInput | null;
  invokeCalls: Array<{ prompt: string; systemPrompt?: string; maxTokens?: number }>;
  modelOutput: ModelInvocationOutput;
  providerProfile: ProviderProfileData | null;
  secretValue: string | null;
  secretError: boolean;
  questions: GrillQuestionData[];
  answers: GrillAnswerData[];
  grillProposals: GrillProposalData[];
  completeRunningResult: boolean;
  markSucceededResult: boolean;
}

function makeQuestion(overrides: Partial<GrillQuestionData> = {}): GrillQuestionData {
  return {
    id: 'q-1',
    sessionId: 'gs-1',
    sequence: 1,
    topic: '主题',
    text: '问题',
    rationale: '理由',
    status: 'ANSWERED',
    dependsOnQuestionIds: [],
    createdAt: NOW,
    askedAt: NOW,
    answeredAt: NOW,
    skippedAt: null,
    supersededAt: null,
    ...overrides,
  };
}

function makeAnswer(overrides: Partial<GrillAnswerData> = {}): GrillAnswerData {
  return {
    id: 'a-1',
    sessionId: 'gs-1',
    questionId: 'q-1',
    revision: 1,
    source: 'USER',
    text: '主角是一个勇敢的少年',
    createdAt: NOW,
    supersededAt: null,
    ...overrides,
  };
}

function makeGrillProposal(overrides: Partial<GrillProposalData> = {}): GrillProposalData {
  return {
    id: 'gp-1',
    sessionId: 'gs-1',
    basedOnAnswerIds: ['a-1'],
    key: 'genre',
    proposedValueJson: JSON.stringify(['sci-fi']),
    confidence: 0.9,
    rationale: '依据用户答案',
    status: 'ACCEPTED',
    createdAt: NOW,
    reviewedAt: NOW,
    ...overrides,
  };
}

let state: MockState;

function buildDeps(overrides: Partial<ContractDraftEngineDeps> = {}): ContractDraftEngineDeps {
  const taskRepo: TaskRepositoryPort = {
    create: () => {},
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
      if (!state.markSucceededResult) return false;
      if (!state.invocation || state.invocation.status !== expected) return false;
      state.invocation = {
        ...state.invocation,
        status: 'SUCCEEDED',
        responseMetadataJson: result.responseMetadataJson,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
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
    getSecret: async () => {
      if (state.secretError) throw new Error('keychain unavailable');
      return state.secretValue;
    },
    deleteSecret: async () => {},
  };

  const providerRepo: ProviderProfileRepository = {
    getById: () => state.providerProfile,
    updateTestResult: () => {},
  };

  const sessionRepo: GrillSessionRepositoryPort = {
    create: () => {},
    getById: () => {
      if (state.sessionQueue.length > 0) return state.sessionQueue.shift()!;
      return state.defaultSession;
    },
    listByProject: () => [],
    transitionStatus: () => true,
    bumpVersion: () => true,
  };

  const questionRepo: GrillQuestionRepositoryPort = {
    create: () => {},
    getById: () => null,
    listBySession: () => state.questions,
    markAsked: () => true,
    markAnswered: () => true,
    markSkipped: () => true,
    markSuperseded: () => true,
    getMaxSequence: () => 0,
  };

  const answerRepo: GrillAnswerRepositoryPort = {
    create: () => {},
    getById: () => null,
    getCurrentByQuestion: () => null,
    listByQuestion: () => [],
    listCurrentBySession: () => state.answers,
    supersedeCurrent: () => true,
  };

  const grillProposalRepo: GrillProposalRepositoryPort = {
    create: () => {},
    getById: () => null,
    listBySession: () => state.grillProposals,
    markAccepted: () => true,
    markRejected: () => true,
    markSuperseded: () => true,
  };

  const ccProposalRepo: CreationContractProposalRepositoryPort = {
    create: (data) => {
      state.proposal = data;
    },
    getById: () => null,
    listByProject: () => [],
    listByGrillSession: () => [],
    transitionStatus: () => false,
    transitionStatusWithHash: () => false,
    supersedeAllProposed: () => 0,
  };

  const ccVersionRepo: CreationContractVersionRepositoryPort = {
    create: () => {},
    getById: () => {
      if (state.versionQueue.length > 0) return state.versionQueue.shift()!;
      return state.defaultVersion;
    },
    getByVersion: () => null,
    listSummaries: () => [],
    resolveVersionId: () => null,
  };

  const ccCurrentRepo: CreationContractCurrentRepositoryPort = {
    insertFirst: () => false,
    casUpdate: () => false,
    get: () => {
      if (state.currentQueue.length > 0) return state.currentQueue.shift()!;
      return state.defaultCurrent;
    },
  };

  const sha256Port: Sha256Port = {
    digestUtf8: (s) => sha256Hex(s),
  };

  const base: ContractDraftEngineDeps = {
    taskRepo,
    invocationRepo,
    secretStore,
    providerRepo,
    idGenerator: { generate: () => `gen-${Math.floor(Math.random() * 1e9)}` },
    clock: { now: () => NOW },
    sessionRepo,
    questionRepo,
    answerRepo,
    grillProposalRepo,
    ccProposalRepo,
    ccVersionRepo,
    ccCurrentRepo,
    sha256Port,
    invokeModel: async (input: {
      baseUrl: string;
      model: string;
      apiKey: string;
      prompt: string;
      systemPrompt?: string;
      maxTokens?: number;
    }) => {
      state.invokeCalls.push({
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        maxTokens: input.maxTokens,
      });
      return state.modelOutput;
    },
    transaction: <T>(fn: () => T) => fn(),
  };
  return { ...base, ...overrides };
}

function freshState(inputVersionJson: string = FIRST_INPUT): MockState {
  return {
    task: makeTask(inputVersionJson),
    sessionQueue: [],
    defaultSession: makeSession(),
    currentQueue: [],
    defaultCurrent: null,
    versionQueue: [],
    defaultVersion: null,
    invocation: null,
    proposal: null,
    invokeCalls: [],
    modelOutput: makeOutput(modelText()),
    providerProfile: makeProviderProfile(),
    secretValue: 'secret-key',
    secretError: false,
    questions: [makeQuestion()],
    answers: [makeAnswer()],
    grillProposals: [makeGrillProposal()],
    completeRunningResult: true,
    markSucceededResult: true,
  };
}

beforeEach(() => {
  state = freshState();
});

describe('executeCreationContractDraft: claim 前失败', () => {
  it('provider 缺失 → failPending，不增加 attempt，不创建 invocation', async () => {
    state.providerProfile = null;
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(result.task.errorCode).toBe('PROVIDER_NOT_CONFIGURED');
    expect(result.task.attemptCount).toBe(0);
    expect(state.invocation).toBeNull();
  });

  it('provider 被禁用 → failPending', async () => {
    state.providerProfile = { ...makeProviderProfile(), enabled: false };
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(result.task.errorCode).toBe('PROVIDER_NOT_CONFIGURED');
    expect(result.task.attemptCount).toBe(0);
  });

  it('provider baseUrl/model/keychain 无效 → failPending', async () => {
    state.providerProfile = { ...makeProviderProfile(), baseUrl: '' };
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.errorCode).toBe('PROVIDER_NOT_CONFIGURED');
    expect(result.task.attemptCount).toBe(0);
  });

  it('keychain 读取失败 → failPending', async () => {
    state.secretError = true;
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.errorCode).toBe('API_KEY_READ_FAILED');
    expect(result.task.attemptCount).toBe(0);
    expect(state.invocation).toBeNull();
  });

  it('API Key 缺失 → failPending', async () => {
    state.secretValue = null;
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.errorCode).toBe('API_KEY_REQUIRED');
    expect(result.task.attemptCount).toBe(0);
  });

  it('无效任务输入 → failPending，不创建 invocation', async () => {
    state.task = makeTask('{"not":"canonical"}');
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(result.task.attemptCount).toBe(0);
    expect(state.invocation).toBeNull();
  });

  it('错误 task type → 抛 TaskExecutionError', async () => {
    state.task = { ...makeTask(), taskType: 'GRILL_QUESTION_PLAN' };
    await expect(executeCreationContractDraft(buildDeps(), 'task-1')).rejects.toThrow(
      TaskExecutionError,
    );
  });

  it('非 PENDING 任务 → 抛 TaskExecutionError', async () => {
    state.task = { ...makeTask(), status: 'RUNNING' };
    await expect(executeCreationContractDraft(buildDeps(), 'task-1')).rejects.toThrow(
      TaskExecutionError,
    );
  });
});

describe('executeCreationContractDraft: CAS claim 冲突', () => {
  it('claim 失败 → 抛 TASK_STATE_CONFLICT', async () => {
    state.task = { ...makeTask(), status: 'RUNNING' };
    await expect(executeCreationContractDraft(buildDeps(), 'task-1')).rejects.toThrow(
      '任务状态不是 PENDING',
    );
  });
});

describe('executeCreationContractDraft: stale-before-call', () => {
  it('session 版本变化 → task STALE，不调用模型，不创建 invocation', async () => {
    state.sessionQueue = [makeSession({ version: 4 })];
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('STALE');
    expect(state.invocation).toBeNull();
    expect(state.invokeCalls).toHaveLength(0);
  });

  it('session 状态变化 → task STALE', async () => {
    state.sessionQueue = [makeSession({ status: 'PAUSED' })];
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('STALE');
    expect(state.invokeCalls).toHaveLength(0);
  });

  it('首次契约但 current pointer 出现 → task STALE', async () => {
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW };
    state.defaultVersion = makeVersion();
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('STALE');
    expect(state.invokeCalls).toHaveLength(0);
  });

  it('已有契约但 current pointer 变化 → task STALE', async () => {
    state.task = makeTask(EXISTING_INPUT);
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-x', updatedAt: NOW };
    state.defaultVersion = makeVersion({ id: 'ver-x' });
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('STALE');
  });

  it('已有契约但 version 号变化 → task STALE', async () => {
    state.task = makeTask(EXISTING_INPUT);
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW };
    state.defaultVersion = makeVersion({ version: 3 });
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('STALE');
  });

  it('已有契约但 snapshot hash 变化 → task STALE', async () => {
    state.task = makeTask(EXISTING_INPUT);
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW };
    state.defaultVersion = makeVersion({ contractSnapshotHash: OTHER_HEX64 });
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('STALE');
  });

  it('current pointer 引用缺失版本 → ContractDataCorruptionError（数据损坏不是 STALE）', async () => {
    state.task = makeTask(EXISTING_INPUT);
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW };
    state.defaultVersion = null;
    await expect(executeCreationContractDraft(buildDeps(), 'task-1')).rejects.toThrow(
      /契约数据完整性异常/,
    );
  });
});

describe('executeCreationContractDraft: 首次契约成功', () => {
  it('proposal PROPOSED + invocation SUCCEEDED + task SUCCEEDED', async () => {
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('SUCCEEDED');
    expect(state.invocation?.status).toBe('SUCCEEDED');
    expect(state.invocation?.requestKind).toBe('creation_contract_draft');
    expect(state.proposal).not.toBeNull();
    // status 由数据库层在 INSERT 时硬编码为 PROPOSED（engine 不控制）
    expect(state.proposal?.baseGrillSessionId).toBe('gs-1');
    expect(state.proposal?.baseGrillSessionVersion).toBe(3);
    expect(state.proposal?.baseContractVersion).toBeNull();
    expect(state.proposal?.schemaVersion).toBe(1);
    expect(state.proposal?.taskId).toBe('task-1');
    expect(state.proposal?.invocationId).toBe(state.invocation?.id);
    expect(state.proposal?.sectionsHash).toBe(sha256Hex(state.proposal!.sectionsJson));
    // safe task result
    const parsed = JSON.parse(result.task.resultJson!);
    expect(parsed).toEqual({
      proposalId: state.proposal!.id,
      schemaVersion: 1,
      baseGrillSessionVersion: 3,
      baseContractVersion: null,
      sectionCount: 7,
    });
  });

  it('requestMetadataJson 只含安全元数据，不含 prompt/baseline sections', async () => {
    await executeCreationContractDraft(buildDeps(), 'task-1');
    const meta = JSON.parse(state.invocation!.requestMetadataJson) as Record<string, unknown>;
    expect(meta.promptLength).toBeGreaterThan(0);
    expect(meta.schemaVersion).toBe(1);
    expect(meta.baseGrillSessionVersion).toBe(3);
    expect(meta.baseContractVersion).toBeNull();
    expect(meta.maxTokens).toBeGreaterThan(0);
    expect(meta.temperature).toBeGreaterThan(0);
    expect(JSON.stringify(meta)).not.toContain('sections');
    expect(JSON.stringify(meta)).not.toContain('promise');
  });

  it('prompt hash 与 promptLength 记录，raw prompt 不落库', async () => {
    await executeCreationContractDraft(buildDeps(), 'task-1');
    const prompt = state.invokeCalls[0].prompt;
    expect(state.invocation?.promptHash).toBe(sha256Hex(prompt));
    const meta = JSON.parse(state.invocation!.requestMetadataJson) as Record<string, unknown>;
    expect(meta.promptLength).toBe(prompt.length);
    // 检查 prompt 内容不进入任何持久化字段
    const allPersisted = JSON.stringify({
      requestMeta: state.invocation!.requestMetadataJson,
      responseMeta: state.invocation!.responseMetadataJson,
      result: state.task.resultJson,
    });
    expect(allPersisted).not.toContain('sessionGoal');
    expect(allPersisted).not.toContain('一个目标');
  });

  it('prompt 构建 deterministic：相同 source-of-truth 产生相同 hash', async () => {
    await executeCreationContractDraft(buildDeps(), 'task-1');
    const hash1 = state.invocation!.promptHash;
    state = freshState();
    await executeCreationContractDraft(buildDeps(), 'task-1');
    const hash2 = state.invocation!.promptHash;
    expect(hash1).toBe(hash2);
    expect(state.invokeCalls[0].prompt).toBeDefined();
  });

  it('接受已 accepted proposal 作为上下文，REJECTED 不使用', async () => {
    state.grillProposals = [
      makeGrillProposal(),
      makeGrillProposal({ id: 'gp-rej', key: 'rejected-key', status: 'REJECTED' }),
      makeGrillProposal({ id: 'gp-sup', key: 'superseded-key', status: 'SUPERSEDED' }),
    ];
    await executeCreationContractDraft(buildDeps(), 'task-1');
    const prompt = state.invokeCalls[0].prompt;
    expect(prompt).toContain('"key":"genre"');
    expect(prompt).not.toContain('rejected-key');
    expect(prompt).not.toContain('superseded-key');
  });
});

describe('executeCreationContractDraft: 已有契约成功', () => {
  it('保留 baseline 的 locked 字段与 protagonist key', async () => {
    state.task = makeTask(EXISTING_INPUT);
    const baselineSections = makeSections();
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW };
    state.defaultVersion = makeVersion({
      sectionsJson: sectionsJson(),
      lockedFieldPathsJson: canonicalSerializeLockedFieldPaths(['/protagonist/name']),
    });
    // 模型输出与 baseline 一致（locked name 相同）
    state.modelOutput = makeOutput(modelText(makeSections()));

    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('SUCCEEDED');
    expect(state.proposal).not.toBeNull();
    expect(state.proposal?.baseContractVersion).toBe(2);
    expect(state.invocation?.requestKind).toBe('creation_contract_draft');
    // requestMetadataJson 记录 baseContractVersion
    const meta = JSON.parse(state.invocation!.requestMetadataJson) as Record<string, unknown>;
    expect(meta.baseContractVersion).toBe(2);
    void baselineSections;
  });
});

describe('executeCreationContractDraft: 模型/Provider 错误', () => {
  it('provider 返回稳定错误码 → invocation + task FAILED，不保存 response body', async () => {
    state.modelOutput = makeOutput('', 'PROVIDER_RATE_LIMITED');
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(result.task.errorCode).toBe('PROVIDER_RATE_LIMITED');
    expect(state.invocation?.status).toBe('FAILED');
    expect(state.invocation?.errorCode).toBe('PROVIDER_RATE_LIMITED');
    expect(state.proposal).toBeNull();
  });

  it('model gateway 抛异常 → invocation + task FAILED', async () => {
    const deps = buildDeps({
      invokeModel: async () => {
        throw new Error('network down');
      },
    });
    const result = await executeCreationContractDraft(deps, 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(result.task.errorCode).toBe('TASK_EXECUTION_FAILED');
    expect(state.invocation?.status).toBe('FAILED');
    expect(state.invocation?.errorMessage).toBe('模型调用异常');
    expect(state.proposal).toBeNull();
  });
});

describe('executeCreationContractDraft: 严格输出解析', () => {
  async function expectInvalid(text: string): Promise<void> {
    state.modelOutput = makeOutput(text);
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(result.task.errorCode).toBe('MODEL_RESPONSE_INVALID');
    expect(state.invocation?.status).toBe('FAILED');
    expect(state.proposal).toBeNull();
  }

  it('非 JSON', async () => {
    await expectInvalid('这不是 JSON');
  });
  it('markdown 代码块', async () => {
    await expectInvalid('```json\n' + modelText() + '\n```');
  });
  it('前后额外文字', async () => {
    await expectInvalid('好的，输出如下：' + modelText());
  });
  it('额外顶层字段', async () => {
    await expectInvalid(JSON.stringify({ schemaVersion: 1, sections: makeSections(), extra: 1 }));
  });
  it('schemaVersion 错误', async () => {
    await expectInvalid(JSON.stringify({ schemaVersion: 2, sections: makeSections() }));
  });
  it('缺少 sections', async () => {
    await expectInvalid(JSON.stringify({ schemaVersion: 1 }));
  });
  it('sections 无效（缺 required 字段）', async () => {
    await expectInvalid(JSON.stringify({ schemaVersion: 1, sections: { premise: 'x' } }));
  });
  it('sections 含未知 section', async () => {
    await expectInvalid(
      JSON.stringify({
        schemaVersion: 1,
        sections: { ...makeSections(), nonsense: 1 },
      }),
    );
  });
  it('reference integrity：relationship 引用未知角色', async () => {
    await expectInvalid(
      JSON.stringify({
        schemaVersion: 1,
        sections: {
          ...makeSections(),
          relationships: [
            {
              relationshipKey: 'r1',
              fromCharacterKey: 'ghost',
              toCharacterKey: 'protag',
              type: 'friend',
            },
          ],
        },
      }),
    );
  });
});

describe('executeCreationContractDraft: 锁保护', () => {
  function setupLockedBaseline(): void {
    state.task = makeTask(EXISTING_INPUT);
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW };
    state.defaultVersion = makeVersion({
      sectionsJson: sectionsJson(),
      lockedFieldPathsJson: canonicalSerializeLockedFieldPaths(['/protagonist/name']),
    });
  }

  it('locked scalar 值变化 → CONTRACT_MODEL_LOCK_VIOLATION，不创建 proposal', async () => {
    setupLockedBaseline();
    state.modelOutput = makeOutput(
      modelText(makeSections({ protagonist: { characterKey: 'protag', name: '改名' } })),
    );
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(result.task.errorCode).toBe('CONTRACT_MODEL_LOCK_VIOLATION');
    expect(state.invocation?.status).toBe('FAILED');
    expect(state.proposal).toBeNull();
  });

  it('locked absent 字段被新增 → CONTRACT_MODEL_LOCK_VIOLATION', async () => {
    state.task = makeTask(EXISTING_INPUT);
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW };
    state.defaultVersion = makeVersion({
      sectionsJson: sectionsJson(),
      // /themes 在 baseline 中缺失，被锁定为缺失
      lockedFieldPathsJson: canonicalSerializeLockedFieldPaths(['/themes']),
    });
    state.modelOutput = makeOutput(modelText(makeSections({ themes: ['成长'] })));
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.errorCode).toBe('CONTRACT_MODEL_LOCK_VIOLATION');
    expect(state.proposal).toBeNull();
  });

  it('locked parent（entity）被整体替换 → CONTRACT_MODEL_LOCK_VIOLATION', async () => {
    state.task = makeTask(EXISTING_INPUT);
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW };
    state.defaultVersion = makeVersion({
      sectionsJson: sectionsJson(),
      // 锁定整个 protagonist（entity 父路径）
      lockedFieldPathsJson: canonicalSerializeLockedFieldPaths(['/protagonist']),
    });
    state.modelOutput = makeOutput(
      modelText(makeSections({ protagonist: { characterKey: 'protag', name: '完全不同' } })),
    );
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.errorCode).toBe('CONTRACT_MODEL_LOCK_VIOLATION');
    expect(state.proposal).toBeNull();
  });

  it('锁定字段保持不变 → 成功', async () => {
    setupLockedBaseline();
    state.modelOutput = makeOutput(modelText(makeSections()));
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('SUCCEEDED');
    expect(state.proposal).not.toBeNull();
  });
});

describe('executeCreationContractDraft: stable identity', () => {
  it('protagonist.characterKey 变化 → MODEL_RESPONSE_INVALID', async () => {
    state.task = makeTask(EXISTING_INPUT);
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW };
    state.defaultVersion = makeVersion({
      sectionsJson: sectionsJson(),
      lockedFieldPathsJson: canonicalSerializeLockedFieldPaths([]),
    });
    state.modelOutput = makeOutput(
      modelText(makeSections({ protagonist: { characterKey: 'renamed', name: '主角' } })),
    );
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('FAILED');
    expect(result.task.errorCode).toBe('MODEL_RESPONSE_INVALID');
    expect(state.proposal).toBeNull();
  });
});

describe('executeCreationContractDraft: stale-after-call', () => {
  it('session 版本变化 → invocation SUCCEEDED + task STALE，无 proposal', async () => {
    // 第一次读取（before-call）版本 3；之后（after-call / final）版本 4
    state.sessionQueue = [makeSession(), makeSession({ version: 4 })];
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('STALE');
    expect(state.invocation?.status).toBe('SUCCEEDED');
    expect(state.invocation?.totalTokens).toBe(150);
    expect(state.proposal).toBeNull();
    expect(state.invokeCalls).toHaveLength(1);
  });

  it('contract baseline 变化 → invocation SUCCEEDED + task STALE', async () => {
    state.task = makeTask(EXISTING_INPUT);
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW };
    state.defaultVersion = makeVersion();
    // 第一次读取正常；第二次（after-call）pointer 变化
    state.currentQueue = [
      { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW },
      { projectId: 'proj-1', currentVersionId: 'ver-3', updatedAt: NOW },
    ];
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('STALE');
    expect(state.invocation?.status).toBe('SUCCEEDED');
    expect(state.proposal).toBeNull();
  });
});

describe('executeCreationContractDraft: stale final-transaction race', () => {
  it('最终事务中发现 session 版本变化 → 回滚后 invocation SUCCEEDED + task STALE，无 proposal', async () => {
    // before-call 与 after-call 正常，最终事务内第三次读取版本变化
    state.sessionQueue = [
      makeSession(), // before-call
      makeSession(), // after-call
      makeSession({ version: 9 }), // final transaction
    ];
    const result = await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(result.task.status).toBe('STALE');
    expect(state.invocation?.status).toBe('SUCCEEDED');
    expect(state.proposal).toBeNull();
  });
});

describe('executeCreationContractDraft: 无重试与调用次数', () => {
  it('同任务只调用一次模型（dedupe/re-execution 不重复调用）', async () => {
    state.task = makeTask(EXISTING_INPUT);
    state.defaultCurrent = { projectId: 'proj-1', currentVersionId: 'ver-2', updatedAt: NOW };
    state.defaultVersion = makeVersion();
    await executeCreationContractDraft(buildDeps(), 'task-1');
    expect(state.invokeCalls).toHaveLength(1);
    // 任务已 SUCCEEDED，重复执行被拒绝（状态非 PENDING）
    state.task = { ...state.task, status: 'SUCCEEDED' };
    await expect(executeCreationContractDraft(buildDeps(), 'task-1')).rejects.toThrow(
      TaskExecutionError,
    );
    expect(state.invokeCalls).toHaveLength(1);
  });
});
