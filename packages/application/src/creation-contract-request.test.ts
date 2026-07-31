/**
 * RequestCreationContractProposal 用例测试。
 *
 * 覆盖：首次/已有契约 baseline、session 归属/版本/状态、
 * expectedContractVersion null 语义、pointer/hash corruption、
 * dedupe 冲突、inputVersionJson canonical、无副作用失败、
 * Renderer 输入不含 provider/ID/time。
 */

import { describe, it, expect } from 'vitest';
import { requestCreationContractProposal } from './creation-contract-request.js';
import type { RequestCreationContractProposalDeps } from './creation-contract-request.js';
import {
  ContractDraftAlreadyRunningError,
  ContractVersionConflictError,
  ContractDataCorruptionError,
  ContractSchemaUnsupportedError,
  ValidationError,
  GrillSessionNotFoundError,
  GrillStateConflictError,
  GrillVersionConflictError,
  GrillOwnershipConflictError,
  TaskDedupeConflictError,
} from './errors.js';
import type { GrillSessionRepositoryPort, GrillSessionData } from './grill-types.js';
import type {
  CreationContractCurrentRepositoryPort,
  CreationContractVersionRepositoryPort,
  CreationContractCurrentData,
  CreationContractVersionData,
} from './creation-contract-types.js';
import type { TaskRepositoryPort, CreateTaskInput, TaskData } from './types.js';

const NOW = '2024-06-15T12:00:00.000Z';
const HEX64 = 'a'.repeat(64);

function makeSession(overrides: Partial<GrillSessionData> = {}): GrillSessionData {
  return {
    id: 'gs-1',
    projectId: 'proj-1',
    status: 'COMPLETED',
    version: 3,
    goal: '一个目标',
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
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
    sectionsJson: '{}',
    lockedFieldPathsJson: '[]',
    contractSnapshotHash: HEX64,
    provenanceJson: '[]',
    createdAt: NOW,
    createdBy: 'ai-proposal-accepted',
    ...overrides,
  };
}

function makeCurrent(
  overrides: Partial<CreationContractCurrentData> = {},
): CreationContractCurrentData {
  return {
    projectId: 'proj-1',
    currentVersionId: 'ver-2',
    updatedAt: NOW,
    ...overrides,
  };
}

interface MockRepos {
  sessions: Map<string, GrillSessionData>;
  currents: Map<string, CreationContractCurrentData>;
  versions: Map<string, CreationContractVersionData>;
  tasks: Map<string, TaskData>;
  createdTasks: CreateTaskInput[];
}

function buildDeps(repos: MockRepos): {
  deps: RequestCreationContractProposalDeps;
  repos: MockRepos;
} {
  const sessionRepo: GrillSessionRepositoryPort = {
    create: () => {},
    getById: (id: string) => repos.sessions.get(id) ?? null,
    listByProject: () => [],
    transitionStatus: () => false,
    bumpVersion: () => false,
  };
  const currentRepo: CreationContractCurrentRepositoryPort = {
    insertFirst: () => false,
    casUpdate: () => false,
    get: (projectId: string) => repos.currents.get(projectId) ?? null,
  };
  const versionRepo: CreationContractVersionRepositoryPort = {
    create: () => {},
    getById: (projectId: string, id: string) => {
      const v = repos.versions.get(id);
      return v && v.projectId === projectId ? v : null;
    },
    getByVersion: () => null,
    listSummaries: () => [],
    resolveVersionId: () => null,
  };
  const taskRepo: TaskRepositoryPort = {
    create: (data: CreateTaskInput) => {
      repos.createdTasks.push(data);
      repos.tasks.set(data.id, {
        id: data.id,
        projectId: data.projectId,
        taskType: data.taskType,
        status: 'PENDING',
        inputVersionJson: data.inputVersionJson,
        payloadJson: data.payloadJson,
        resultJson: null,
        errorCode: null,
        errorMessage: null,
        dedupeKey: data.dedupeKey ?? null,
        attemptCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: null,
        finishedAt: null,
        staleAt: null,
        cancelledAt: null,
      });
    },
    getById: (id: string) => repos.tasks.get(id) ?? null,
    listByProject: () => [],
    listByStatus: () => [],
    claimPending: () => false,
    completeRunning: () => false,
    failRunning: () => false,
    failPending: () => false,
    markStale: () => false,
    resetToPending: () => false,
    listRunning: () => [],
  };

  let idCounter = 0;
  const deps: RequestCreationContractProposalDeps = {
    idGenerator: { generate: () => `task-${++idCounter}` },
    clock: { now: () => NOW },
    sessionRepo,
    currentRepo,
    versionRepo,
    taskRepo,
    transaction: <T>(fn: () => T) => fn(),
  };
  return { deps, repos };
}

function freshRepos(): MockRepos {
  return {
    sessions: new Map(),
    currents: new Map(),
    versions: new Map(),
    tasks: new Map(),
    createdTasks: [],
  };
}

function assertCanonicalInputJson(json: string, expected: Record<string, unknown>): void {
  expect(json).toBe(JSON.stringify(expected));
  // compact、无换行、key 顺序固定
  expect(json).not.toContain('\n');
  expect(JSON.parse(json)).toEqual(expected);
  expect(Object.keys(JSON.parse(json) as Record<string, unknown>)).toEqual(Object.keys(expected));
}

describe('requestCreationContractProposal', () => {
  it('首次契约：成功创建 PENDING 任务，baseline 三字段全 null', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    const { deps } = buildDeps(repos);

    const result = requestCreationContractProposal(deps, {
      projectId: 'proj-1',
      grillSessionId: 'gs-1',
      expectedGrillSessionVersion: 3,
      expectedContractVersion: null,
      providerProfileId: 'mimo-token-plan-cn',
    });

    expect(result).toEqual({
      taskId: 'task-1',
      grillSessionId: 'gs-1',
      baseGrillSessionVersion: 3,
      baseContractVersion: null,
    });

    expect(repos.createdTasks).toHaveLength(1);
    const task = repos.createdTasks[0];
    expect(task.taskType).toBe('CREATION_CONTRACT_DRAFT');
    expect(task.payloadJson).toBe('{}');
    expect(task.dedupeKey).toBe('creation_contract_draft:gs-1:3:none:none');
    assertCanonicalInputJson(task.inputVersionJson, {
      grillSessionId: 'gs-1',
      baseGrillSessionVersion: 3,
      contractBaseline: {
        contractVersionId: null,
        contractVersion: null,
        contractSnapshotHash: null,
      },
      schemaVersion: 1,
      providerProfileId: 'mimo-token-plan-cn',
    });
  });

  it('已有契约：捕获完整 ContractBaselineRef，dedupe 绑定版本与 hash', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    repos.currents.set('proj-1', makeCurrent());
    repos.versions.set('ver-2', makeVersion());
    const { deps } = buildDeps(repos);

    const result = requestCreationContractProposal(deps, {
      projectId: 'proj-1',
      grillSessionId: 'gs-1',
      expectedGrillSessionVersion: 3,
      expectedContractVersion: 2,
      providerProfileId: 'mimo-token-plan-cn',
    });

    expect(result.baseContractVersion).toBe(2);
    const task = repos.createdTasks[0];
    expect(task.dedupeKey).toBe(`creation_contract_draft:gs-1:3:2:${HEX64}`);
    assertCanonicalInputJson(task.inputVersionJson, {
      grillSessionId: 'gs-1',
      baseGrillSessionVersion: 3,
      contractBaseline: {
        contractVersionId: 'ver-2',
        contractVersion: 2,
        contractSnapshotHash: HEX64,
      },
      schemaVersion: 1,
      providerProfileId: 'mimo-token-plan-cn',
    });
  });

  it('session 不存在 → GRILL_SESSION_NOT_FOUND，无副作用', () => {
    const repos = freshRepos();
    const { deps } = buildDeps(repos);
    expect(() =>
      requestCreationContractProposal(deps, {
        projectId: 'proj-1',
        grillSessionId: 'missing',
        expectedGrillSessionVersion: 3,
        expectedContractVersion: null,
        providerProfileId: 'p',
      }),
    ).toThrow(GrillSessionNotFoundError);
    expect(repos.createdTasks).toHaveLength(0);
  });

  it('session 不属于项目 → GRILL_OWNERSHIP_CONFLICT', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession({ projectId: 'other-proj' }));
    const { deps } = buildDeps(repos);
    expect(() =>
      requestCreationContractProposal(deps, {
        projectId: 'proj-1',
        grillSessionId: 'gs-1',
        expectedGrillSessionVersion: 3,
        expectedContractVersion: null,
        providerProfileId: 'p',
      }),
    ).toThrow(GrillOwnershipConflictError);
    expect(repos.createdTasks).toHaveLength(0);
  });

  it('session 版本不匹配 → GRILL_VERSION_CONFLICT', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession({ version: 4 }));
    const { deps } = buildDeps(repos);
    expect(() =>
      requestCreationContractProposal(deps, {
        projectId: 'proj-1',
        grillSessionId: 'gs-1',
        expectedGrillSessionVersion: 3,
        expectedContractVersion: null,
        providerProfileId: 'p',
      }),
    ).toThrow(GrillVersionConflictError);
  });

  it('session 未完成 → GRILL_STATE_CONFLICT（冻结设计默认 COMPLETED）', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession({ status: 'ACTIVE' }));
    const { deps } = buildDeps(repos);
    expect(() =>
      requestCreationContractProposal(deps, {
        projectId: 'proj-1',
        grillSessionId: 'gs-1',
        expectedGrillSessionVersion: 3,
        expectedContractVersion: null,
        providerProfileId: 'p',
      }),
    ).toThrow(GrillStateConflictError);
  });

  it('首次生成但 expectedContractVersion 非 null → CONTRACT_VERSION_CONFLICT', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    const { deps } = buildDeps(repos);
    expect(() =>
      requestCreationContractProposal(deps, {
        projectId: 'proj-1',
        grillSessionId: 'gs-1',
        expectedGrillSessionVersion: 3,
        expectedContractVersion: 2,
        providerProfileId: 'p',
      }),
    ).toThrow(ContractVersionConflictError);
  });

  it('存在契约但 expectedContractVersion 为 null → CONTRACT_VERSION_CONFLICT', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    repos.currents.set('proj-1', makeCurrent());
    repos.versions.set('ver-2', makeVersion());
    const { deps } = buildDeps(repos);
    expect(() =>
      requestCreationContractProposal(deps, {
        projectId: 'proj-1',
        grillSessionId: 'gs-1',
        expectedGrillSessionVersion: 3,
        expectedContractVersion: null,
        providerProfileId: 'p',
      }),
    ).toThrow(ContractVersionConflictError);
  });

  it('契约版本号不匹配 → CONTRACT_VERSION_CONFLICT', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    repos.currents.set('proj-1', makeCurrent());
    repos.versions.set('ver-2', makeVersion({ version: 3 }));
    const { deps } = buildDeps(repos);
    expect(() =>
      requestCreationContractProposal(deps, {
        projectId: 'proj-1',
        grillSessionId: 'gs-1',
        expectedGrillSessionVersion: 3,
        expectedContractVersion: 2,
        providerProfileId: 'p',
      }),
    ).toThrow(ContractVersionConflictError);
  });

  it('current pointer 引用不存在的版本 → ContractDataCorruptionError', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    repos.currents.set('proj-1', makeCurrent({ currentVersionId: 'missing' }));
    const { deps } = buildDeps(repos);
    expect(() =>
      requestCreationContractProposal(deps, {
        projectId: 'proj-1',
        grillSessionId: 'gs-1',
        expectedGrillSessionVersion: 3,
        expectedContractVersion: 2,
        providerProfileId: 'p',
      }),
    ).toThrow(ContractDataCorruptionError);
  });

  it('current pointer 与 version id 不一致 → ContractDataCorruptionError', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    repos.currents.set('proj-1', makeCurrent({ currentVersionId: 'ver-2' }));
    repos.versions.set('ver-2', makeVersion({ id: 'ver-x' }));
    const { deps } = buildDeps(repos);
    expect(() =>
      requestCreationContractProposal(deps, {
        projectId: 'proj-1',
        grillSessionId: 'gs-1',
        expectedGrillSessionVersion: 3,
        expectedContractVersion: 2,
        providerProfileId: 'p',
      }),
    ).toThrow(ContractDataCorruptionError);
  });

  it('contractSnapshotHash 非 lowercase SHA-256 → ContractDataCorruptionError', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    repos.currents.set('proj-1', makeCurrent());
    repos.versions.set('ver-2', makeVersion({ contractSnapshotHash: 'NOT_A_HASH' }));
    const { deps } = buildDeps(repos);
    expect(() =>
      requestCreationContractProposal(deps, {
        projectId: 'proj-1',
        grillSessionId: 'gs-1',
        expectedGrillSessionVersion: 3,
        expectedContractVersion: 2,
        providerProfileId: 'p',
      }),
    ).toThrow(ContractDataCorruptionError);
  });

  it('schemaVersion 不支持 → ContractSchemaUnsupportedError', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    repos.currents.set('proj-1', makeCurrent());
    repos.versions.set('ver-2', makeVersion({ schemaVersion: 99 }));
    const { deps } = buildDeps(repos);
    expect(() =>
      requestCreationContractProposal(deps, {
        projectId: 'proj-1',
        grillSessionId: 'gs-1',
        expectedGrillSessionVersion: 3,
        expectedContractVersion: 2,
        providerProfileId: 'p',
      }),
    ).toThrow(ContractSchemaUnsupportedError);
  });

  it('dedupe 冲突 → 稳定 CONTRACT_DRAFT_ALREADY_RUNNING，不暴露 dedupe key', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    const { deps } = buildDeps(repos);
    const taskRepo = deps.taskRepo;
    const originalCreate = taskRepo.create.bind(taskRepo);
    // 第一次创建成功后，第二次触发 dedupe 冲突
    let calls = 0;
    taskRepo.create = (data: CreateTaskInput) => {
      calls++;
      if (calls > 1) {
        throw new TaskDedupeConflictError('已存在相同 dedupe key 的活跃任务');
      }
      originalCreate(data);
    };

    const input = {
      projectId: 'proj-1',
      grillSessionId: 'gs-1',
      expectedGrillSessionVersion: 3,
      expectedContractVersion: null,
      providerProfileId: 'p',
    };
    expect(requestCreationContractProposal(deps, input).taskId).toBeTruthy();
    let thrown: unknown;
    try {
      requestCreationContractProposal(deps, input);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ContractDraftAlreadyRunningError);
    const err = thrown as ContractDraftAlreadyRunningError;
    expect(err.code).toBe('CONTRACT_DRAFT_ALREADY_RUNNING');
    expect(err.message).not.toContain('creation_contract_draft');
    expect(err.message).not.toContain('gs-1');
  });

  it('输入验证：空 projectId / 无效版本 / 无效 expectedContractVersion 拒绝', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    const { deps } = buildDeps(repos);
    const base = {
      projectId: 'proj-1',
      grillSessionId: 'gs-1',
      expectedGrillSessionVersion: 3,
      expectedContractVersion: null as number | null,
      providerProfileId: 'p',
    };
    expect(() => requestCreationContractProposal(deps, { ...base, projectId: '  ' })).toThrow(
      ValidationError,
    );
    expect(() =>
      requestCreationContractProposal(deps, { ...base, expectedGrillSessionVersion: 0 }),
    ).toThrow(ValidationError);
    expect(() =>
      requestCreationContractProposal(deps, { ...base, expectedGrillSessionVersion: 1.5 }),
    ).toThrow(ValidationError);
    expect(() =>
      requestCreationContractProposal(deps, { ...base, expectedContractVersion: -1 }),
    ).toThrow(ValidationError);
    expect(() => requestCreationContractProposal(deps, { ...base, providerProfileId: '' })).toThrow(
      ValidationError,
    );
    expect(repos.createdTasks).toHaveLength(0);
  });

  it('同一版本重复请求：任务去重（dedupe key 一致性）', () => {
    const repos = freshRepos();
    repos.sessions.set('gs-1', makeSession());
    const { deps } = buildDeps(repos);
    const input = {
      projectId: 'proj-1',
      grillSessionId: 'gs-1',
      expectedGrillSessionVersion: 3,
      expectedContractVersion: null,
      providerProfileId: 'p',
    };
    requestCreationContractProposal(deps, input);
    requestCreationContractProposal(deps, input);
    const keys = repos.createdTasks.map((t) => t.dedupeKey);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(1);
  });
});
