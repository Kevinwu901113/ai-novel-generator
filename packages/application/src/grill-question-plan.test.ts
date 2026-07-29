/**
 * Grill 问题规划器应用层测试。
 *
 * 使用带回滚语义的 mock 仓库（transaction 在异常时恢复快照），
 * 覆盖请求去重、版本/stale、显式接受事务与并发。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  requestGrillQuestionPlan,
  acceptGrillQuestionPlanProposal,
  getGrillQuestionPlanProposal,
  listGrillQuestionPlanProposals,
  type GrillQuestionPlanDeps,
  type GrillQuestionPlanRequestDeps,
} from './grill-question-plan.js';
import type {
  GrillSessionData,
  GrillQuestionData,
  GrillQuestionPlanProposalData,
  GrillSessionRepositoryPort,
  GrillQuestionRepositoryPort,
  GrillQuestionPlanProposalRepositoryPort,
  TaskRepositoryPort,
  TaskData,
} from './index.js';
import {
  GrillSessionNotFoundError,
  GrillVersionConflictError,
  GrillStateConflictError,
  GrillOwnershipConflictError,
  GrillPlanAlreadyRunningError,
  GrillPlanStaleError,
  GrillPlanProposalNotFoundError,
  GrillPlanProposalNotAcceptableError,
  TaskDedupeConflictError,
} from './errors.js';

const NOW = '2024-06-15T12:00:00.000Z';

// ── Mock 数据库（支持事务回滚）────────────────────────────────────

interface MockDb {
  sessions: Map<string, GrillSessionData>;
  questions: Map<string, GrillQuestionData>;
  proposals: Map<string, GrillQuestionPlanProposalData>;
  tasks: Map<string, TaskData>;
}

function snapshot(db: MockDb): MockDb {
  return {
    sessions: new Map(db.sessions),
    questions: new Map(db.questions),
    proposals: new Map(db.proposals),
    tasks: new Map(db.tasks),
  };
}

function restore(db: MockDb, snap: MockDb): void {
  db.sessions = snap.sessions;
  db.questions = snap.questions;
  db.proposals = snap.proposals;
  db.tasks = snap.tasks;
}

let idCounter = 0;
const idGen = { generate: () => `id-${++idCounter}` };
const clock = { now: () => NOW };

function makeSession(overrides: Partial<GrillSessionData> = {}): GrillSessionData {
  return {
    id: 'sess-1',
    projectId: 'proj-1',
    status: 'ACTIVE',
    version: 1,
    goal: '澄清需求',
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    abandonedAt: null,
    ...overrides,
  };
}

function makeProposal(
  overrides: Partial<GrillQuestionPlanProposalData> = {},
): GrillQuestionPlanProposalData {
  return {
    id: 'prop-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    taskId: 'task-1',
    invocationId: 'inv-1',
    baseSessionVersion: 1,
    schemaVersion: 1,
    questionsJson: JSON.stringify({
      schemaVersion: 1,
      questions: [
        { key: 'q1', topic: '主题一', text: '问题一', rationale: '理由一', dependencies: [] },
        {
          key: 'q2',
          topic: '主题二',
          text: '问题二',
          rationale: '理由二',
          dependencies: [{ kind: 'planned', questionKey: 'q1' }],
        },
      ],
    }),
    status: 'PROPOSED',
    createdAt: NOW,
    reviewedAt: null,
    ...overrides,
  };
}

// ── 仓库 mock ─────────────────────────────────────────────────────

function sessionRepo(db: MockDb): GrillSessionRepositoryPort {
  return {
    create() {
      throw new Error('not used');
    },
    getById: (id) => db.sessions.get(id) ?? null,
    listByProject: (projectId) =>
      [...db.sessions.values()].filter((s) => s.projectId === projectId),
    transitionStatus(id, expectedVersion, newStatus) {
      const s = db.sessions.get(id);
      if (!s || s.version !== expectedVersion) return false;
      db.sessions.set(id, { ...s, status: newStatus, version: s.version + 1 });
      return true;
    },
    bumpVersion(id, expectedVersion) {
      const s = db.sessions.get(id);
      if (!s || s.version !== expectedVersion) return false;
      db.sessions.set(id, { ...s, version: s.version + 1 });
      return true;
    },
  };
}

function questionRepo(db: MockDb): GrillQuestionRepositoryPort {
  return {
    create(data) {
      db.questions.set(data.id, {
        id: data.id,
        sessionId: data.sessionId,
        sequence: data.sequence,
        topic: data.topic,
        text: data.text,
        rationale: data.rationale,
        status: 'PLANNED',
        dependsOnQuestionIds: data.dependsOnQuestionIds,
        createdAt: NOW,
        askedAt: null,
        answeredAt: null,
        skippedAt: null,
        supersededAt: null,
      });
    },
    getById: (id) => db.questions.get(id) ?? null,
    listBySession: (sessionId) =>
      [...db.questions.values()].filter((q) => q.sessionId === sessionId),
    markAsked: () => true,
    markAnswered: () => true,
    markSkipped: () => true,
    markSuperseded: () => true,
    getMaxSequence(sessionId) {
      const seqs = [...db.questions.values()]
        .filter((q) => q.sessionId === sessionId)
        .map((q) => q.sequence);
      return seqs.length > 0 ? Math.max(...seqs) : 0;
    },
  };
}

function planProposalRepo(db: MockDb): GrillQuestionPlanProposalRepositoryPort {
  return {
    create(data) {
      db.proposals.set(data.id, {
        id: data.id,
        projectId: data.projectId,
        sessionId: data.sessionId,
        taskId: data.taskId,
        invocationId: data.invocationId,
        baseSessionVersion: data.baseSessionVersion,
        schemaVersion: data.schemaVersion,
        questionsJson: data.questionsJson,
        status: 'PROPOSED',
        createdAt: NOW,
        reviewedAt: null,
      });
    },
    getById: (id) => db.proposals.get(id) ?? null,
    listBySession: (sessionId) =>
      [...db.proposals.values()].filter((p) => p.sessionId === sessionId),
    markAccepted(id) {
      const p = db.proposals.get(id);
      if (!p || p.status !== 'PROPOSED') return false;
      db.proposals.set(id, { ...p, status: 'ACCEPTED', reviewedAt: NOW });
      return true;
    },
    markRejected(id) {
      const p = db.proposals.get(id);
      if (!p || p.status !== 'PROPOSED') return false;
      db.proposals.set(id, { ...p, status: 'REJECTED', reviewedAt: NOW });
      return true;
    },
    markStale(id) {
      const p = db.proposals.get(id);
      if (!p || p.status !== 'PROPOSED') return false;
      db.proposals.set(id, { ...p, status: 'STALE', reviewedAt: NOW });
      return true;
    },
  };
}

function taskRepo(db: MockDb): TaskRepositoryPort {
  return {
    create(data) {
      if (data.dedupeKey !== undefined) {
        for (const t of db.tasks.values()) {
          if (
            t.dedupeKey === data.dedupeKey &&
            (t.status === 'PENDING' || t.status === 'RUNNING')
          ) {
            throw new TaskDedupeConflictError('已存在活跃任务');
          }
        }
      }
      db.tasks.set(data.id, {
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
    getById: (id) => db.tasks.get(id) ?? null,
    listByProject: () => [],
    listByStatus: () => [],
    claimPending(id) {
      const t = db.tasks.get(id);
      if (!t || t.status !== 'PENDING') return false;
      db.tasks.set(id, { ...t, status: 'RUNNING', attemptCount: t.attemptCount + 1 });
      return true;
    },
    completeRunning(id, resultJson) {
      const t = db.tasks.get(id);
      if (!t || t.status !== 'RUNNING') return false;
      db.tasks.set(id, { ...t, status: 'SUCCEEDED', resultJson });
      return true;
    },
    failRunning(id, errorCode, errorMessage) {
      const t = db.tasks.get(id);
      if (!t || t.status !== 'RUNNING') return false;
      db.tasks.set(id, { ...t, status: 'FAILED', errorCode, errorMessage });
      return true;
    },
    failPending(id, errorCode, errorMessage) {
      const t = db.tasks.get(id);
      if (!t || t.status !== 'PENDING') return false;
      db.tasks.set(id, { ...t, status: 'FAILED', errorCode, errorMessage });
      return true;
    },
    markStale(id, expectedStatuses) {
      const t = db.tasks.get(id);
      if (!t || !expectedStatuses.includes(t.status)) return false;
      db.tasks.set(id, { ...t, status: 'STALE' });
      return true;
    },
    resetToPending(id, expectedStatus) {
      const t = db.tasks.get(id);
      if (!t || t.status !== expectedStatus) return false;
      db.tasks.set(id, { ...t, status: 'PENDING' });
      return true;
    },
    listRunning: () => [...db.tasks.values()].filter((t) => t.status === 'RUNNING'),
  };
}

function buildDeps(db: MockDb): GrillQuestionPlanRequestDeps {
  return {
    idGenerator: idGen,
    clock,
    sessionRepo: sessionRepo(db),
    questionRepo: questionRepo(db),
    planProposalRepo: planProposalRepo(db),
    taskRepo: taskRepo(db),
    transaction<T>(fn: () => T): T {
      const snap = snapshot(db);
      try {
        return fn();
      } catch (err) {
        restore(db, snap);
        throw err;
      }
    },
  };
}

function planDeps(db: MockDb): GrillQuestionPlanDeps {
  const deps = buildDeps(db);
  return {
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    sessionRepo: deps.sessionRepo,
    questionRepo: deps.questionRepo,
    planProposalRepo: deps.planProposalRepo,
    transaction: deps.transaction,
  };
}

// ── 测试 ──────────────────────────────────────────────────────────

let db: MockDb;

beforeEach(() => {
  idCounter = 0;
  db = {
    sessions: new Map([['sess-1', makeSession()]]),
    questions: new Map(),
    proposals: new Map(),
    tasks: new Map(),
  };
});

describe('requestGrillQuestionPlan', () => {
  it('27. expectedVersion 冲突拒绝', () => {
    expect(() =>
      requestGrillQuestionPlan(buildDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        expectedSessionVersion: 99,
        providerProfileId: 'provider-1',
      }),
    ).toThrow(GrillVersionConflictError);
  });

  it('会话不存在拒绝', () => {
    expect(() =>
      requestGrillQuestionPlan(buildDeps(db), {
        projectId: 'proj-1',
        sessionId: 'ghost',
        expectedSessionVersion: 1,
        providerProfileId: 'provider-1',
      }),
    ).toThrow(GrillSessionNotFoundError);
  });

  it('非 ACTIVE 状态拒绝', () => {
    db.sessions.set('sess-1', makeSession({ status: 'COMPLETED' }));
    expect(() =>
      requestGrillQuestionPlan(buildDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        expectedSessionVersion: 1,
        providerProfileId: 'provider-1',
      }),
    ).toThrow(GrillStateConflictError);
  });

  it('归属错误拒绝', () => {
    expect(() =>
      requestGrillQuestionPlan(buildDeps(db), {
        projectId: 'other-proj',
        sessionId: 'sess-1',
        expectedSessionVersion: 1,
        providerProfileId: 'provider-1',
      }),
    ).toThrow(GrillOwnershipConflictError);
  });

  it('成功创建任务并返回安全引用', () => {
    const result = requestGrillQuestionPlan(buildDeps(db), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      expectedSessionVersion: 1,
      providerProfileId: 'provider-1',
    });
    expect(result.sessionId).toBe('sess-1');
    expect(result.baseSessionVersion).toBe(1);
    expect(result.taskId).toBeTruthy();
    const task = db.tasks.get(result.taskId);
    expect(task?.taskType).toBe('GRILL_QUESTION_PLAN');
    expect(task?.dedupeKey).toBe('grill_question_plan:sess-1:1');
  });

  it('33. 同 session/version 并发请求只生成一个活跃任务', () => {
    requestGrillQuestionPlan(buildDeps(db), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      expectedSessionVersion: 1,
      providerProfileId: 'provider-1',
    });
    expect(() =>
      requestGrillQuestionPlan(buildDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        expectedSessionVersion: 1,
        providerProfileId: 'provider-1',
      }),
    ).toThrow(GrillPlanAlreadyRunningError);
    const active = [...db.tasks.values()].filter(
      (t) => t.status === 'PENDING' || t.status === 'RUNNING',
    );
    expect(active).toHaveLength(1);
  });

  it('34. 不同 session 可分别生成任务', () => {
    db.sessions.set('sess-2', makeSession({ id: 'sess-2' }));
    requestGrillQuestionPlan(buildDeps(db), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      expectedSessionVersion: 1,
      providerProfileId: 'provider-1',
    });
    requestGrillQuestionPlan(buildDeps(db), {
      projectId: 'proj-1',
      sessionId: 'sess-2',
      expectedSessionVersion: 1,
      providerProfileId: 'provider-1',
    });
    expect(db.tasks.size).toBe(2);
  });
});

describe('acceptGrillQuestionPlanProposal', () => {
  function seedProposal(overrides: Partial<GrillQuestionPlanProposalData> = {}): void {
    db.proposals.set('prop-1', makeProposal(overrides));
  }

  it('47. 接受后问题全部创建', () => {
    seedProposal();
    const result = acceptGrillQuestionPlanProposal(planDeps(db), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      proposalId: 'prop-1',
      expectedSessionVersion: 1,
    });
    expect(result.questions).toHaveLength(2);
    expect(result.proposal.status).toBe('ACCEPTED');
    expect(result.session.version).toBe(2);
  });

  it('48. planned key 正确映射为正式 ID', () => {
    seedProposal();
    const result = acceptGrillQuestionPlanProposal(planDeps(db), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      proposalId: 'prop-1',
      expectedSessionVersion: 1,
    });
    const ids = result.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(2);
    ids.forEach((id) => expect(id).not.toMatch(/^q[12]$/));
  });

  it('49. dependencies 正确映射（planned → 正式 ID）', () => {
    seedProposal();
    const result = acceptGrillQuestionPlanProposal(planDeps(db), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      proposalId: 'prop-1',
      expectedSessionVersion: 1,
    });
    const q2 = result.questions.find((q) => q.text === '问题二');
    const q1 = result.questions.find((q) => q.text === '问题一');
    expect(q2?.dependsOnQuestionIds).toEqual([q1?.id]);
  });

  it('按拓扑顺序插入（依赖在前，sequence 递增）', () => {
    seedProposal();
    const result = acceptGrillQuestionPlanProposal(planDeps(db), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      proposalId: 'prop-1',
      expectedSessionVersion: 1,
    });
    const q1 = result.questions.find((q) => q.text === '问题一')!;
    const q2 = result.questions.find((q) => q.text === '问题二')!;
    expect(q1.sequence).toBeLessThan(q2.sequence);
  });

  it('50. 部分插入失败时全部回滚', () => {
    seedProposal();
    const deps = planDeps(db);
    let calls = 0;
    const origCreate = deps.questionRepo.create.bind(deps.questionRepo);
    const failingRepo: GrillQuestionRepositoryPort = {
      ...deps.questionRepo,
      create(data) {
        calls++;
        if (calls === 2) throw new Error('模拟插入失败');
        origCreate(data);
      },
    };
    const failingDeps: GrillQuestionPlanDeps = { ...deps, questionRepo: failingRepo };

    expect(() =>
      acceptGrillQuestionPlanProposal(failingDeps, {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 1,
      }),
    ).toThrow('模拟插入失败');

    // 回滚：无问题残留、提案仍 PROPOSED、版本未变
    expect(db.questions.size).toBe(0);
    expect(db.proposals.get('prop-1')?.status).toBe('PROPOSED');
    expect(db.sessions.get('sess-1')?.version).toBe(1);
  });

  it('51/52. 不修改已有答案或已有问题', () => {
    db.questions.set('existing-q', {
      id: 'existing-q',
      sessionId: 'sess-1',
      sequence: 1,
      topic: '已有',
      text: '已有问题',
      rationale: '',
      status: 'ANSWERED',
      dependsOnQuestionIds: [],
      createdAt: NOW,
      askedAt: NOW,
      answeredAt: NOW,
      skippedAt: null,
      supersededAt: null,
    });
    seedProposal();
    acceptGrillQuestionPlanProposal(planDeps(db), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      proposalId: 'prop-1',
      expectedSessionVersion: 1,
    });
    const existing = db.questions.get('existing-q');
    expect(existing?.status).toBe('ANSWERED');
    expect(existing?.text).toBe('已有问题');
  });

  it('53. 重复接受行为稳定（第二次拒绝）', () => {
    seedProposal();
    acceptGrillQuestionPlanProposal(planDeps(db), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      proposalId: 'prop-1',
      expectedSessionVersion: 1,
    });
    expect(() =>
      acceptGrillQuestionPlanProposal(planDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 2,
      }),
    ).toThrow(GrillPlanProposalNotAcceptableError);
  });

  it('54. ownership 错误拒绝', () => {
    seedProposal();
    expect(() =>
      acceptGrillQuestionPlanProposal(planDeps(db), {
        projectId: 'other-proj',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 1,
      }),
    ).toThrow(GrillOwnershipConflictError);
  });

  it('30. session 版本已前进 → 提案标记 STALE 并抛 GrillPlanStaleError', () => {
    seedProposal({ baseSessionVersion: 1 });
    // 会话已前进到版本 2
    db.sessions.set('sess-1', makeSession({ version: 2 }));
    expect(() =>
      acceptGrillQuestionPlanProposal(planDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 2,
      }),
    ).toThrow(GrillPlanStaleError);
    expect(db.questions.size).toBe(0);
    expect(db.proposals.get('prop-1')?.status).toBe('STALE');
  });

  it('31. 调用方版本错误但会话仍等于 base → GrillVersionConflictError，不标记 STALE', () => {
    seedProposal({ baseSessionVersion: 1 });
    // 会话版本仍为 1（等于 proposal base），但调用方传错误版本 99
    expect(() =>
      acceptGrillQuestionPlanProposal(planDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 99,
      }),
    ).toThrow(GrillVersionConflictError);
    expect(db.proposals.get('prop-1')?.status).toBe('PROPOSED');
  });

  it('32. 两个并发接受只有一个成功', () => {
    seedProposal();
    const first = () =>
      acceptGrillQuestionPlanProposal(planDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 1,
      });
    const second = () =>
      acceptGrillQuestionPlanProposal(planDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 1,
      });
    expect(first()).toBeTruthy();
    expect(second).toThrow();
    expect(db.proposals.get('prop-1')?.status).toBe('ACCEPTED');
    // 仅创建一批问题（2 个）
    expect(db.questions.size).toBe(2);
  });

  it('stale 标记与 accept 互斥：已 STALE 的提案不可接受', () => {
    seedProposal({ baseSessionVersion: 1 });
    // 会话前进 → 触发 stale
    db.sessions.set('sess-1', makeSession({ version: 2 }));
    expect(() =>
      acceptGrillQuestionPlanProposal(planDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 2,
      }),
    ).toThrow(GrillPlanStaleError);
    expect(db.proposals.get('prop-1')?.status).toBe('STALE');

    // 即使会话版本回退（不可能，但模拟），已 STALE 的提案仍不可接受
    db.sessions.set('sess-1', makeSession({ version: 1 }));
    expect(() =>
      acceptGrillQuestionPlanProposal(planDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 1,
      }),
    ).toThrow();
    expect(db.questions.size).toBe(0);
  });

  it('提案不存在拒绝', () => {
    expect(() =>
      acceptGrillQuestionPlanProposal(planDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'ghost',
        expectedSessionVersion: 1,
      }),
    ).toThrow(GrillPlanProposalNotFoundError);
  });

  it('引用非法的计划拒绝接受', () => {
    seedProposal({
      questionsJson: JSON.stringify({
        schemaVersion: 1,
        questions: [
          {
            key: 'q1',
            topic: 't',
            text: 'x',
            rationale: '',
            dependencies: [{ kind: 'existing', questionId: 'not-in-session' }],
          },
        ],
      }),
    });
    expect(() =>
      acceptGrillQuestionPlanProposal(planDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        proposalId: 'prop-1',
        expectedSessionVersion: 1,
      }),
    ).toThrow();
    expect(db.questions.size).toBe(0);
  });
});

describe('get/list 问题规划提案', () => {
  it('list 返回会话提案', () => {
    db.proposals.set('prop-1', makeProposal());
    const list = listGrillQuestionPlanProposals(planDeps(db), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
    expect(list).toHaveLength(1);
  });

  it('get 校验归属', () => {
    db.proposals.set('prop-1', makeProposal());
    expect(() =>
      getGrillQuestionPlanProposal(planDeps(db), {
        projectId: 'proj-1',
        sessionId: 'sess-other',
        proposalId: 'prop-1',
      }),
    ).toThrow();
  });
});
