/**
 * Grill planner runner 测试。
 *
 * 覆盖：异步调度、settlement 收口、DB 关闭保证、并发安全、startup recovery。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  scheduleGrillPlanRun,
  settleGrillPlanRunnerFailure,
  recoverPendingGrillPlans,
  type GrillPlanRunnerDeps,
  type GrillPlanRecoveryDeps,
} from './grill-plan-runner.js';
import type { GrillQuestionPlanEngineDeps } from '@ai-novel/task-engine';
import type {
  TaskRepositoryPort,
  ModelInvocationRepositoryPort,
  TaskData,
  ModelInvocationData,
  InvocationStatsData,
} from '@ai-novel/application';
import type { ProjectDatabase } from '@ai-novel/database';

// ── Mock 工具 ─────────────────────────────────────────────────────

const NOW = '2024-06-15T12:00:00.000Z';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableInvocation = Mutable<ModelInvocationData>;

function makeTask(overrides: Partial<TaskData> = {}): TaskData {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    taskType: 'GRILL_QUESTION_PLAN',
    status: 'PENDING',
    inputVersionJson: JSON.stringify({
      sessionId: 'sess-1',
      baseSessionVersion: 1,
      schemaVersion: 1,
      providerProfileId: 'provider-1',
    }),
    payloadJson: '{}',
    resultJson: null,
    errorCode: null,
    errorMessage: null,
    dedupeKey: 'grill_question_plan:sess-1:1',
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
    requestKind: 'grill_question_plan',
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
  executeShouldThrow: Error | null;
  executeDelay: number;
}

function createMockState(): MockState {
  return {
    task: makeTask(),
    invocations: [],
    dbCloseCount: 0,
    modelCallCount: 0,
    executeShouldThrow: null,
    executeDelay: 0,
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
    completeRunning: () => {
      if (state.task.status !== 'RUNNING') return false;
      state.task = { ...state.task, status: 'SUCCEEDED' };
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
  } as unknown as ProjectDatabase;
}

function createRunnerDeps(
  state: MockState,
  overrides: Partial<GrillPlanRunnerDeps> = {},
): GrillPlanRunnerDeps {
  const projDb = createMockProjDb(state);
  const taskRepo = createMockTaskRepo(state);
  const invocationRepo = createMockInvocationRepo(state);

  return {
    openDb: () => projDb,
    buildEngineDeps: () => {
      const engineDeps: GrillQuestionPlanEngineDeps = {
        taskRepo,
        invocationRepo,
        secretStore: {
          hasSecret: async () => true,
          getSecret: async () => 'key',
          setSecret: async () => {},
          deleteSecret: async () => {},
        },
        providerRepo: {
          getById: () => ({
            id: 'provider-1',
            providerType: 'anthropic-compatible',
            displayName: 'Test',
            baseUrl: 'https://test.example',
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
          }),
          updateTestResult: () => {},
        },
        idGenerator: { generate: () => `id-${state.invocations.length + 1}` },
        clock: { now: () => NOW },
        sessionRepo: {
          getById: () => ({
            id: 'sess-1',
            projectId: 'proj-1',
            goal: 'test',
            status: 'ACTIVE' as const,
            version: 1,
            createdAt: NOW,
            updatedAt: NOW,
            startedAt: null,
            completedAt: null,
            abandonedAt: null,
          }),
          create: vi.fn(),
          listByProject: () => [],
          transitionStatus: () => true,
          bumpVersion: () => true,
        },
        questionRepo: {
          listBySession: () => [],
          create: vi.fn(),
          getById: () => null,
          getMaxSequence: () => 0,
          markAsked: () => true,
          markAnswered: () => true,
          markSkipped: () => true,
          markSuperseded: () => true,
        },
        answerRepo: {
          listCurrentBySession: () => [],
          create: vi.fn(),
          getById: () => null,
          getCurrentByQuestion: () => null,
          listByQuestion: () => [],
          supersedeCurrent: () => true,
        },
        planProposalRepo: {
          create: vi.fn(),
          getById: () => null,
          listBySession: () => [],
          markAccepted: () => true,
          markRejected: () => true,
          markStale: () => true,
        },
        invokeModel: async () => {
          state.modelCallCount++;
          if (state.executeShouldThrow) {
            throw state.executeShouldThrow;
          }
          if (state.executeDelay > 0) {
            await new Promise((r) => setTimeout(r, state.executeDelay));
          }
          return {
            text: JSON.stringify({
              schemaVersion: 1,
              questions: [{ key: 'q1', topic: 't', text: 'x', rationale: 'r', dependencies: [] }],
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
      return engineDeps;
    },
    getTaskRepo: () => taskRepo,
    getInvocationRepo: () => invocationRepo,
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('scheduleGrillPlanRun', () => {
  let state: MockState;

  beforeEach(() => {
    state = createMockState();
  });

  it('1. deferred model 未完成时 schedule 已返回', async () => {
    state.executeDelay = 200;
    const deps = createRunnerDeps(state);
    scheduleGrillPlanRun(deps, 'proj-1', 'task-1');
    // schedule 同步返回，模型尚未完成
    expect(state.modelCallCount).toBe(0);
    expect(state.dbCloseCount).toBe(0);
    await flushPromises();
    await new Promise((r) => setTimeout(r, 250));
    expect(state.modelCallCount).toBe(1);
    expect(state.dbCloseCount).toBe(1);
  });

  it('2. runner 成功时 DB 关闭一次', async () => {
    const deps = createRunnerDeps(state);
    scheduleGrillPlanRun(deps, 'proj-1', 'task-1');
    await flushPromises();
    expect(state.task.status).toBe('SUCCEEDED');
    expect(state.dbCloseCount).toBe(1);
  });

  it('3. pre-claim provider/key 错误保持 FAILED、attempt=0', async () => {
    const deps = createRunnerDeps(state, {
      buildEngineDeps: () => {
        const base = createRunnerDeps(state).buildEngineDeps(createMockProjDb(state));
        return {
          ...base,
          providerRepo: { getById: () => null, updateTestResult: () => {} },
        };
      },
    });
    scheduleGrillPlanRun(deps, 'proj-1', 'task-1');
    await flushPromises();
    expect(state.task.status).toBe('FAILED');
    expect(state.task.errorCode).toBe('PROVIDER_NOT_CONFIGURED');
    expect(state.task.attemptCount).toBe(0);
    expect(state.dbCloseCount).toBe(1);
  });

  it('4. question reload 抛错后 task 不停留 RUNNING', async () => {
    const deps = createRunnerDeps(state);
    const engineDeps = deps.buildEngineDeps(createMockProjDb(state));
    // 覆盖 questionRepo 使其在 listBySession 时抛错
    const throwingQuestionRepo = {
      ...engineDeps.questionRepo,
      listBySession: () => {
        throw new Error('disk I/O error');
      },
    };
    const modifiedDeps: GrillPlanRunnerDeps = {
      ...deps,
      buildEngineDeps: () => ({ ...engineDeps, questionRepo: throwingQuestionRepo }),
    };
    scheduleGrillPlanRun(modifiedDeps, 'proj-1', 'task-1');
    await flushPromises();
    expect(state.task.status).toBe('FAILED');
    expect(state.task.status).not.toBe('RUNNING');
  });

  it('5. invocation.create 抛错后 task 不停留 RUNNING', async () => {
    const deps = createRunnerDeps(state);
    const projDb = createMockProjDb(state);
    const engineDeps = deps.buildEngineDeps(projDb);
    const throwingInvocationRepo: ModelInvocationRepositoryPort = {
      ...engineDeps.invocationRepo,
      create: () => {
        throw new Error('constraint violation');
      },
    };
    const modifiedDeps: GrillPlanRunnerDeps = {
      ...deps,
      buildEngineDeps: () => ({ ...engineDeps, invocationRepo: throwingInvocationRepo }),
      getInvocationRepo: () => throwingInvocationRepo,
    };
    scheduleGrillPlanRun(modifiedDeps, 'proj-1', 'task-1');
    await flushPromises();
    expect(state.task.status).toBe('FAILED');
  });

  it('6. markRunning CAS 抛错后 task/invocation 被安全终结', async () => {
    const deps = createRunnerDeps(state);
    const projDb = createMockProjDb(state);
    const engineDeps = deps.buildEngineDeps(projDb);
    const throwingInvocationRepo: ModelInvocationRepositoryPort = {
      ...engineDeps.invocationRepo,
      markRunning: () => {
        throw new Error('CAS conflict');
      },
    };
    const modifiedDeps: GrillPlanRunnerDeps = {
      ...deps,
      buildEngineDeps: () => ({ ...engineDeps, invocationRepo: throwingInvocationRepo }),
      getInvocationRepo: () => createMockInvocationRepo(state),
    };
    scheduleGrillPlanRun(modifiedDeps, 'proj-1', 'task-1');
    await flushPromises();
    expect(state.task.status).toBe('FAILED');
  });

  it('7. final proposal/task completion 事务失败后 task 不停留 RUNNING', async () => {
    const deps = createRunnerDeps(state);
    const projDb = createMockProjDb(state);
    const engineDeps = deps.buildEngineDeps(projDb);
    // completeRunning 失败模拟事务冲突
    const failingTaskRepo: TaskRepositoryPort = {
      ...engineDeps.taskRepo,
      completeRunning: () => false,
    };
    const modifiedDeps: GrillPlanRunnerDeps = {
      ...deps,
      buildEngineDeps: () => ({ ...engineDeps, taskRepo: failingTaskRepo }),
      getTaskRepo: () => createMockTaskRepo(state),
    };
    scheduleGrillPlanRun(modifiedDeps, 'proj-1', 'task-1');
    await flushPromises();
    // settlement 应将 RUNNING task 标记 FAILED
    expect(state.task.status).toBe('FAILED');
  });

  it('8. 非终态 invocation 被标记 FAILED', async () => {
    state.task = makeTask({ status: 'RUNNING', attemptCount: 1 });
    state.invocations = [
      makeInvocation({ id: 'inv-1', status: 'RUNNING' }),
      makeInvocation({ id: 'inv-2', status: 'PENDING' }),
      makeInvocation({ id: 'inv-3', status: 'SUCCEEDED' }),
    ];
    const taskRepo = createMockTaskRepo(state);
    const invocationRepo = createMockInvocationRepo(state);
    settleGrillPlanRunnerFailure(taskRepo, invocationRepo, (fn) => fn(), 'task-1');
    expect(state.task.status).toBe('FAILED');
    expect(state.invocations[0].status).toBe('FAILED');
    expect(state.invocations[1].status).toBe('FAILED');
    expect(state.invocations[2].status).toBe('SUCCEEDED');
  });

  it('9. 已 SUCCEEDED 的任务不被 catch 覆盖', () => {
    state.task = makeTask({ status: 'SUCCEEDED', resultJson: '{"proposalId":"p1"}' });
    const taskRepo = createMockTaskRepo(state);
    const invocationRepo = createMockInvocationRepo(state);
    settleGrillPlanRunnerFailure(taskRepo, invocationRepo, (fn) => fn(), 'task-1');
    expect(state.task.status).toBe('SUCCEEDED');
    expect(state.task.resultJson).toBe('{"proposalId":"p1"}');
  });

  it('10. 已 STALE/CANCELLED 的任务不被覆盖', () => {
    for (const status of ['STALE', 'CANCELLED'] as const) {
      state.task = makeTask({ status });
      const taskRepo = createMockTaskRepo(state);
      const invocationRepo = createMockInvocationRepo(state);
      settleGrillPlanRunnerFailure(taskRepo, invocationRepo, (fn) => fn(), 'task-1');
      expect(state.task.status).toBe(status);
    }
  });

  it('11. 两个 runner 同时调度只有一个模型调用', async () => {
    const deps = createRunnerDeps(state);
    scheduleGrillPlanRun(deps, 'proj-1', 'task-1');
    scheduleGrillPlanRun(deps, 'proj-1', 'task-1');
    await flushPromises();
    // 第二个 runner claim 失败（task 已 RUNNING），抛 TASK_STATE_CONFLICT
    // settlement 发现 task 已终态（第一个 runner 完成），no-op
    expect(state.modelCallCount).toBe(1);
    expect(state.task.status).toBe('SUCCEEDED');
  });

  it('13. runner catch 不产生 unhandled rejection', async () => {
    state.executeShouldThrow = new Error('unexpected crash');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const deps = createRunnerDeps(state);
    scheduleGrillPlanRun(deps, 'proj-1', 'task-1');
    await flushPromises();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).not.toHaveBeenCalled();
    expect(state.task.status).toBe('FAILED');
    process.removeListener('unhandledRejection', unhandled);
  });

  it('14. DB close 即使 settlement 失败也执行一次', async () => {
    state.executeShouldThrow = new Error('crash');
    const deps = createRunnerDeps(state, {
      // settlement 时 getTaskRepo 返回一个会抛错的 repo
      getTaskRepo: () => {
        throw new Error('settlement broken');
      },
    });
    scheduleGrillPlanRun(deps, 'proj-1', 'task-1');
    await flushPromises();
    expect(state.dbCloseCount).toBe(1);
  });
});

describe('scheduleGrillPlanRun — DB 打开失败', () => {
  it('DB 无法打开时不产生 unhandled rejection', async () => {
    const state = createMockState();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const deps = createRunnerDeps(state, {
      openDb: () => {
        throw new Error('SQLITE_CANTOPEN');
      },
    });
    scheduleGrillPlanRun(deps, 'proj-1', 'task-1');
    await flushPromises();
    expect(unhandled).not.toHaveBeenCalled();
    expect(state.dbCloseCount).toBe(0);
    process.removeListener('unhandledRejection', unhandled);
  });
});

describe('recoverPendingGrillPlans', () => {
  it('12. startup recovery 调度 PENDING GRILL_QUESTION_PLAN', () => {
    const scheduled: Array<{ projectId: string; taskId: string }> = [];
    const state = createMockState();
    const taskRepo = createMockTaskRepo(state);

    const projDb = { close: vi.fn() } as unknown as ProjectDatabase;
    const deps: GrillPlanRecoveryDeps = {
      listProjectDbs: () => [{ projectId: 'proj-1', projDb }],
      getTaskRepo: () => taskRepo,
      schedule: (projectId, taskId) => scheduled.push({ projectId, taskId }),
    };

    recoverPendingGrillPlans(deps);
    expect(scheduled).toEqual([{ projectId: 'proj-1', taskId: 'task-1' }]);
    expect(projDb.close).toHaveBeenCalledOnce();
  });

  it('非 GRILL_QUESTION_PLAN 任务不调度', () => {
    const scheduled: string[] = [];
    const state = createMockState();
    state.task = makeTask({ taskType: 'MODEL_INVOCATION_TEST' });
    const taskRepo = createMockTaskRepo(state);

    const projDb = { close: vi.fn() } as unknown as ProjectDatabase;
    const deps: GrillPlanRecoveryDeps = {
      listProjectDbs: () => [{ projectId: 'proj-1', projDb }],
      getTaskRepo: () => taskRepo,
      schedule: (_p, taskId) => scheduled.push(taskId),
    };

    recoverPendingGrillPlans(deps);
    expect(scheduled).toEqual([]);
  });

  it('无法打开的数据库不声称已调度', () => {
    const scheduled: string[] = [];
    const deps: GrillPlanRecoveryDeps = {
      listProjectDbs: () => [],
      getTaskRepo: () => createMockTaskRepo(createMockState()),
      schedule: (_p, taskId) => scheduled.push(taskId),
    };

    recoverPendingGrillPlans(deps);
    expect(scheduled).toEqual([]);
  });
});
