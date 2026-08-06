/**
 * 创作契约草案 runner 测试。
 *
 * 覆盖：异步调度、openDb/buildEngineDeps 同步失败、settlement 收口
 * （PENDING / RUNNING / terminal / CAS 冲突）、DB close exactly once、
 * 引擎异步异常收口、startup recovery、单任务单模型调用、
 * 其他项目失败不阻塞恢复。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeProviderRepo, makeTestProviderProfile } from './provider-test-fixtures.js';
import {
  scheduleContractDraftRun,
  settleContractDraftRunnerFailure,
  recoverPendingContractDrafts,
  type ContractDraftRunnerDeps,
  type ContractDraftRecoveryDeps,
} from './contract-draft-runner.js';
import type { ContractDraftEngineDeps } from '@ai-novel/task-engine';
import type {
  TaskRepositoryPort,
  ModelInvocationRepositoryPort,
  TaskData,
  ModelInvocationData,
  InvocationStatsData,
  GrillQuestionData,
  GrillAnswerData,
  GrillProposalData,
} from '@ai-novel/application';
import { sha256Hex } from '@ai-novel/task-engine';
import {
  canonicalSerializeContractSections,
  validateCreationContractSections,
} from '@ai-novel/domain';
import type { ProjectDatabase } from '@ai-novel/database';

const NOW = '2024-06-15T12:00:00.000Z';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableInvocation = Mutable<ModelInvocationData>;

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

function makeSectionsJson(): string {
  return canonicalSerializeContractSections(
    validateCreationContractSections({
      premise: '一个故事',
      genre: ['sci-fi'],
      tone: ['dark'],
      targetAudience: 'adults',
      narrativePov: 'FIRST',
      tense: 'PRESENT',
      protagonist: { characterKey: 'protag', name: '主角' },
    }),
  );
}

function makeTask(overrides: Partial<TaskData> = {}): TaskData {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    taskType: 'CREATION_CONTRACT_DRAFT',
    status: 'PENDING',
    inputVersionJson: FIRST_INPUT,
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
    ...overrides,
  };
}

function makeInvocation(overrides: Partial<MutableInvocation> = {}): MutableInvocation {
  return {
    id: 'inv-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    providerProfileId: 'provider-1',
    model: 'test-model',
    status: 'RUNNING',
    attemptNumber: 1,
    requestKind: 'creation_contract_draft',
    promptHash: 'a'.repeat(64),
    requestMetadataJson: '{}',
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
    startedAt: NOW,
    finishedAt: null,
    ...overrides,
  };
}

interface MockState {
  task: TaskData;
  invocations: MutableInvocation[];
  dbCloseCount: number;
  modelCallCount: number;
  executeDelay: number;
  invalidSha256: boolean;
  proposals: Array<{ id: string; status: string }>;
}

function createMockState(): MockState {
  return {
    task: makeTask(),
    invocations: [],
    dbCloseCount: 0,
    modelCallCount: 0,
    executeDelay: 0,
    invalidSha256: false,
    proposals: [],
  };
}

function createMockTaskRepo(state: MockState): TaskRepositoryPort {
  return {
    create: vi.fn(),
    getById: () => state.task,
    listByProject: () => [state.task],
    listByStatus: (status) => (state.task.status === status ? [state.task] : []),
    claimPending: () => {
      if (state.task.status !== 'PENDING') return false;
      state.task = { ...state.task, status: 'RUNNING', attemptCount: state.task.attemptCount + 1 };
      return true;
    },
    completeRunning: (_id, resultJson) => {
      if (state.task.status !== 'RUNNING') return false;
      state.task = { ...state.task, status: 'SUCCEEDED', resultJson };
      return true;
    },
    failRunning: (_id, errorCode, errorMessage) => {
      if (state.task.status !== 'RUNNING') return false;
      state.task = { ...state.task, status: 'FAILED', errorCode, errorMessage };
      return true;
    },
    failPending: (_id, errorCode, errorMessage) => {
      if (state.task.status !== 'PENDING') return false;
      state.task = { ...state.task, status: 'FAILED', errorCode, errorMessage };
      return true;
    },
    markStale: (_id, expectedStatuses) => {
      if (!expectedStatuses.includes(state.task.status)) return false;
      state.task = { ...state.task, status: 'STALE' };
      return true;
    },
    resetToPending: () => true,
    listRunning: () => (state.task.status === 'RUNNING' ? [state.task] : []),
  };
}

function createMockInvocationRepo(state: MockState): ModelInvocationRepositoryPort {
  return {
    create: vi.fn((data) => {
      state.invocations.push(makeInvocation({ id: data.id, status: 'PENDING' }));
    }),
    getById: (id) => state.invocations.find((i) => i.id === id) ?? null,
    listByTask: () => state.invocations,
    markRunning: (id) => {
      const inv = state.invocations.find((i) => i.id === id);
      if (!inv || inv.status !== 'PENDING') return false;
      inv.status = 'RUNNING';
      return true;
    },
    markSucceeded: (id) => {
      const inv = state.invocations.find((i) => i.id === id);
      if (!inv || inv.status !== 'RUNNING') return false;
      inv.status = 'SUCCEEDED';
      return true;
    },
    markFailed: (id, expectedStatuses, errorCode, errorMessage) => {
      const inv = state.invocations.find((i) => i.id === id);
      if (!inv || !expectedStatuses.includes(inv.status)) return false;
      inv.status = 'FAILED';
      inv.errorCode = errorCode;
      inv.errorMessage = errorMessage;
      return true;
    },
    getStatsByProject: (): InvocationStatsData => ({
      invocationCount: 0,
      succeededCount: 0,
      failedCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
    }),
    listRunning: () => state.invocations.filter((i) => i.status === 'RUNNING'),
  };
}

function createMockProjDb(state: MockState): ProjectDatabase {
  return {
    close: () => {
      state.dbCloseCount++;
    },
    transaction: <T>(fn: () => T) => fn(),
    transactionImmediate: <T>(fn: () => T) => fn(),
  } as unknown as ProjectDatabase;
}

function createContractEngineDeps(state: MockState): ContractDraftEngineDeps {
  const taskRepo = createMockTaskRepo(state);
  const invocationRepo = createMockInvocationRepo(state);
  const makeGrillData = {
    questions: [] as GrillQuestionData[],
    answers: [] as GrillAnswerData[],
    proposals: [] as GrillProposalData[],
  };
  return {
    taskRepo,
    invocationRepo,
    secretStore: {
      hasSecret: async () => true,
      getSecret: async () => 'key',
      setSecret: async () => {},
      deleteSecret: async () => {},
    },
    providerRepo: makeFakeProviderRepo(
      makeTestProviderProfile({ keychainService: 'svc', keychainAccount: 'acct' }),
    ),
    idGenerator: { generate: () => `gen-${state.invocations.length + 1}` },
    clock: { now: () => NOW },
    sessionRepo: {
      getById: () => ({
        id: 'gs-1',
        projectId: 'proj-1',
        goal: '目标',
        status: 'COMPLETED',
        version: 3,
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        abandonedAt: null,
      }),
      create: vi.fn(),
      listByProject: () => [],
      transitionStatus: () => true,
      bumpVersion: () => true,
    },
    questionRepo: {
      listBySession: () => makeGrillData.questions,
      create: vi.fn(),
      getById: () => null,
      getMaxSequence: () => 0,
      markAsked: () => true,
      markAnswered: () => true,
      markSkipped: () => true,
      markSuperseded: () => true,
    },
    answerRepo: {
      listCurrentBySession: () => makeGrillData.answers,
      create: vi.fn(),
      getById: () => null,
      getCurrentByQuestion: () => null,
      listByQuestion: () => [],
      supersedeCurrent: () => true,
    },
    grillProposalRepo: {
      listBySession: () => makeGrillData.proposals,
      create: vi.fn(),
      getById: () => null,
      markAccepted: () => true,
      markRejected: () => true,
      markSuperseded: () => true,
    },
    ccProposalRepo: {
      create: (data) => {
        state.proposals.push({ id: data.id, status: 'PROPOSED' });
      },
      getById: () => null,
      listByProject: () => [],
      listByGrillSession: () => [],
      transitionStatus: () => false,
      transitionStatusWithHash: () => false,
      supersedeAllProposed: () => 0,
    },
    ccVersionRepo: {
      create: vi.fn(),
      getById: () => null,
      getByVersion: () => null,
      listSummaries: () => [],
      resolveVersionId: () => null,
    },
    ccCurrentRepo: {
      insertFirst: () => false,
      casUpdate: () => false,
      get: () => null,
    },
    sha256Port: {
      digestUtf8: (s) => (state.invalidSha256 ? 'not-a-hash' : sha256Hex(s)),
    },
    invokeModel: async () => {
      state.modelCallCount++;
      if (state.executeDelay > 0) {
        await new Promise((r) => setTimeout(r, state.executeDelay));
      }
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          sections: JSON.parse(makeSectionsJson()),
        }),
        providerRequestId: 'req-1',
        finishReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: 15,
        },
        latencyMs: 100,
        errorCode: null,
        errorMessage: null,
      };
    },
    transaction: <T>(fn: () => T) => fn(),
  };
}

function createRunnerDeps(
  state: MockState,
  overrides: Partial<ContractDraftRunnerDeps> = {},
): ContractDraftRunnerDeps {
  const projDb = createMockProjDb(state);
  const engineDeps = createContractEngineDeps(state);
  return {
    openDb: () => projDb,
    buildEngineDeps: () => engineDeps,
    getTaskRepo: () => createMockTaskRepo(state),
    getInvocationRepo: () => createMockInvocationRepo(state),
    ...overrides,
  };
}

async function waitForRun(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

let state: MockState;

beforeEach(() => {
  state = createMockState();
});

describe('scheduleContractDraftRun', () => {
  it('deferred scheduling：立即返回 scheduled=true，随后异步完成', async () => {
    const result = scheduleContractDraftRun(createRunnerDeps(state), 'proj-1', 'task-1');
    expect(result).toEqual({ scheduled: true });
    await waitForRun();
    expect(state.task.status).toBe('SUCCEEDED');
    expect(state.proposals).toHaveLength(1);
    expect(state.modelCallCount).toBe(1);
    expect(state.dbCloseCount).toBe(1);
  });

  it('openDb 抛错 → OPEN_FAILED，不调度', () => {
    const result = scheduleContractDraftRun(
      createRunnerDeps(state, {
        openDb: () => {
          throw new Error('cannot open');
        },
      }),
      'proj-1',
      'task-1',
    );
    expect(result).toEqual({ scheduled: false, reason: 'OPEN_FAILED' });
  });

  it('buildEngineDeps 同步抛错 → SETUP_FAILED + settlement + close', () => {
    state.task = makeTask({ status: 'PENDING' });
    const result = scheduleContractDraftRun(
      createRunnerDeps(state, {
        buildEngineDeps: () => {
          throw new Error('setup failed');
        },
      }),
      'proj-1',
      'task-1',
    );
    expect(result).toEqual({ scheduled: false, reason: 'SETUP_FAILED' });
    // PENDING 任务被 failPending 终结（不留永久 PENDING）
    expect(state.task.status).toBe('FAILED');
    expect(state.task.errorCode).toBe('TASK_EXECUTION_FAILED');
    expect(state.dbCloseCount).toBe(1);
  });

  it('引擎异步抛错 → settlement 收口 + close once', async () => {
    state.task = makeTask({ status: 'RUNNING' }); // 引擎抛 TASK_STATE_CONFLICT
    const result = scheduleContractDraftRun(createRunnerDeps(state), 'proj-1', 'task-1');
    expect(result).toEqual({ scheduled: true });
    await waitForRun();
    // 非终态 RUNNING 被 settlement 标记 FAILED（固定安全消息）
    expect(state.task.status).toBe('FAILED');
    expect(state.task.errorCode).toBe('TASK_EXECUTION_FAILED');
    expect(state.task.errorMessage).toBe('创作契约草案任务执行失败');
    expect(state.dbCloseCount).toBe(1);
  });

  it('引擎 sha256 无效抛错 → settlement 收口', async () => {
    state.invalidSha256 = true;
    const result = scheduleContractDraftRun(createRunnerDeps(state), 'proj-1', 'task-1');
    expect(result).toEqual({ scheduled: true });
    await waitForRun();
    expect(state.task.status).toBe('FAILED');
    expect(state.task.errorCode).toBe('TASK_EXECUTION_FAILED');
    expect(state.dbCloseCount).toBe(1);
  });
});

describe('settleContractDraftRunnerFailure', () => {
  it('PENDING → failPending（attemptCount 不变）', () => {
    settleContractDraftRunnerFailure(createRunnerDeps(state), createMockProjDb(state), 'task-1');
    expect(state.task.status).toBe('FAILED');
    expect(state.task.errorCode).toBe('TASK_EXECUTION_FAILED');
    expect(state.task.errorMessage).toBe('创作契约草案任务执行失败');
    expect(state.task.attemptCount).toBe(0);
  });

  it('RUNNING + RUNNING invocation → 事务内双双 FAILED，无半成品', () => {
    state.task = makeTask({ status: 'RUNNING', attemptCount: 1 });
    state.invocations = [makeInvocation({ status: 'RUNNING' })];
    settleContractDraftRunnerFailure(createRunnerDeps(state), createMockProjDb(state), 'task-1');
    expect(state.task.status).toBe('FAILED');
    expect(state.invocations[0].status).toBe('FAILED');
    expect(state.invocations[0].errorMessage).toBe('模型调用因任务异常而未完成');
  });

  it('已终态任务 → no-op，不覆盖', () => {
    state.task = makeTask({ status: 'SUCCEEDED' });
    settleContractDraftRunnerFailure(createRunnerDeps(state), createMockProjDb(state), 'task-1');
    expect(state.task.status).toBe('SUCCEEDED');
  });

  it('getter 抛错 → settlement 静默返回', () => {
    const deps = createRunnerDeps(state, {
      getTaskRepo: () => {
        throw new Error('boom');
      },
    });
    expect(() =>
      settleContractDraftRunnerFailure(deps, createMockProjDb(state), 'task-1'),
    ).not.toThrow();
  });
});

describe('settleContractDraftRunnerFailure: 并发 CAS 语义（kernel 已由 Grill 测试覆盖）', () => {
  it('PENDING invocation + RUNNING task → 全部 FAILED', () => {
    state.task = makeTask({ status: 'RUNNING', attemptCount: 1 });
    state.invocations = [makeInvocation({ status: 'PENDING' })];
    settleContractDraftRunnerFailure(createRunnerDeps(state), createMockProjDb(state), 'task-1');
    expect(state.task.status).toBe('FAILED');
    expect(state.invocations[0].status).toBe('FAILED');
  });

  it('已终态 invocation 不覆盖', () => {
    state.task = makeTask({ status: 'RUNNING', attemptCount: 1 });
    state.invocations = [makeInvocation({ status: 'SUCCEEDED' })];
    settleContractDraftRunnerFailure(createRunnerDeps(state), createMockProjDb(state), 'task-1');
    expect(state.task.status).toBe('FAILED');
    expect(state.invocations[0].status).toBe('SUCCEEDED');
  });
});

describe('settleContractDraftRunnerFailure: 明确 settlement outcome', () => {
  interface OutcomeOpts {
    initialStatus: string;
    failPendingResult: boolean;
    rereadStatus: string;
  }

  function outcomeDeps(state: MockState, opts: OutcomeOpts): ContractDraftRunnerDeps {
    let current = makeTask({ status: opts.initialStatus as TaskData['status'] });
    let failPendingCalled = false;
    const taskRepo: TaskRepositoryPort = {
      ...createMockTaskRepo(state),
      getById: () => current,
      failPending: (_id, errorCode, errorMessage) => {
        if (failPendingCalled) return false;
        failPendingCalled = true;
        if (opts.failPendingResult) {
          current = makeTask({ status: 'FAILED', errorCode, errorMessage });
          return true;
        }
        current = makeTask({ status: opts.rereadStatus as TaskData['status'] });
        return false;
      },
    };
    return createRunnerDeps(state, { getTaskRepo: () => taskRepo });
  }

  it('PENDING failPending 成功 → FAILED', () => {
    const outcome = settleContractDraftRunnerFailure(
      outcomeDeps(state, {
        initialStatus: 'PENDING',
        failPendingResult: true,
        rereadStatus: 'PENDING',
      }),
      createMockProjDb(state),
      'task-1',
    );
    expect(outcome).toBe('FAILED');
  });

  it('PENDING failPending 失败 + reread terminal → TERMINAL', () => {
    const outcome = settleContractDraftRunnerFailure(
      outcomeDeps(state, {
        initialStatus: 'PENDING',
        failPendingResult: false,
        rereadStatus: 'STALE',
      }),
      createMockProjDb(state),
      'task-1',
    );
    expect(outcome).toBe('TERMINAL');
  });

  it('PENDING failPending 失败 + reread RUNNING → RUNNING_ELSEWHERE（不覆盖）', () => {
    const outcome = settleContractDraftRunnerFailure(
      outcomeDeps(state, {
        initialStatus: 'PENDING',
        failPendingResult: false,
        rereadStatus: 'RUNNING',
      }),
      createMockProjDb(state),
      'task-1',
    );
    expect(outcome).toBe('RUNNING_ELSEWHERE');
    expect(state.task.status).not.toBe('FAILED');
  });

  it('PENDING failPending 失败 + reread 仍 PENDING → UNRESOLVED（不静默忽略）', () => {
    const outcome = settleContractDraftRunnerFailure(
      outcomeDeps(state, {
        initialStatus: 'PENDING',
        failPendingResult: false,
        rereadStatus: 'PENDING',
      }),
      createMockProjDb(state),
      'task-1',
    );
    expect(outcome).toBe('UNRESOLVED');
    expect(state.task.status).not.toBe('FAILED');
  });

  it('已终态 task → TERMINAL（不覆盖）', () => {
    state.task = makeTask({ status: 'SUCCEEDED' });
    const outcome = settleContractDraftRunnerFailure(
      createRunnerDeps(state),
      createMockProjDb(state),
      'task-1',
    );
    expect(outcome).toBe('TERMINAL');
    expect(state.task.status).toBe('SUCCEEDED');
  });

  it('RUNNING + invocation/task CAS 成功 → FAILED', () => {
    state.task = makeTask({ status: 'RUNNING', attemptCount: 1 });
    state.invocations = [makeInvocation({ status: 'RUNNING' })];
    const outcome = settleContractDraftRunnerFailure(
      createRunnerDeps(state),
      createMockProjDb(state),
      'task-1',
    );
    expect(outcome).toBe('FAILED');
    expect(state.task.status).toBe('FAILED');
    expect(state.invocations[0].status).toBe('FAILED');
  });
});

describe('recoverPendingContractDrafts', () => {
  it('启动恢复：扫描 PENDING CREATION_CONTRACT_DRAFT 并调度', () => {
    const scheduled: string[] = [];
    const projDb = createMockProjDb(state);
    const recoveryDeps: ContractDraftRecoveryDeps = {
      listProjectDbs: () => [{ projectId: 'proj-1', projDb }],
      getTaskRepo: () => createMockTaskRepo(state),
      schedule: (projectId, taskId) => {
        scheduled.push(`${projectId}:${taskId}`);
        return { scheduled: true };
      },
      settle: () => 'TERMINAL',
    };
    recoverPendingContractDrafts(recoveryDeps);
    expect(scheduled).toContain('proj-1:task-1');
  });

  it('不扫描其他任务类型', () => {
    const scheduled: string[] = [];
    state.task = makeTask({ taskType: 'GRILL_QUESTION_PLAN' });
    const projDb = createMockProjDb(state);
    recoverPendingContractDrafts({
      listProjectDbs: () => [{ projectId: 'proj-1', projDb }],
      getTaskRepo: () => createMockTaskRepo(state),
      schedule: (projectId, taskId) => {
        scheduled.push(`${projectId}:${taskId}`);
        return { scheduled: true };
      },
      settle: () => 'TERMINAL',
    });
    expect(scheduled).toHaveLength(0);
  });

  it('其他项目失败不阻塞恢复', () => {
    const scheduled: string[] = [];
    const badDb = createMockProjDb(state);
    const goodDb = createMockProjDb(state);
    recoverPendingContractDrafts({
      listProjectDbs: () => [
        { projectId: 'bad', projDb: badDb },
        { projectId: 'good', projDb: goodDb },
      ],
      getTaskRepo: (projDb) => {
        if (projDb === badDb) throw new Error('cannot read bad project');
        return createMockTaskRepo(state);
      },
      schedule: (projectId, taskId) => {
        scheduled.push(`${projectId}:${taskId}`);
        return { scheduled: true };
      },
      settle: () => 'TERMINAL',
    });
    // bad 项目失败不阻塞 good 项目恢复
    expect(scheduled).toContain('good:task-1');
    expect(scheduled).not.toContain('bad:task-1');
  });

  it('startup recovery SETUP_FAILED：调度失败时安全终结，无永久 PENDING', () => {
    const settled: string[] = [];
    const projDb = createMockProjDb(state);
    const scheduled: string[] = [];
    recoverPendingContractDrafts({
      listProjectDbs: () => [{ projectId: 'proj-1', projDb }],
      getTaskRepo: () => createMockTaskRepo(state),
      schedule: (projectId, taskId) => {
        scheduled.push(`${projectId}:${taskId}`);
        return { scheduled: false, reason: 'SETUP_FAILED' };
      },
      settle: (_db, taskId) => {
        settled.push(taskId);
        return 'FAILED';
      },
    });
    expect(scheduled).toContain('proj-1:task-1');
    expect(settled).toContain('task-1');
  });
});
