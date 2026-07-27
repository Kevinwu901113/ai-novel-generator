import { describe, it, expect } from 'vitest';
import {
  createGrillSession,
  getGrillSession,
  listGrillSessions,
  startGrillSession,
  pauseGrillSession,
  resumeGrillSession,
  completeGrillSession,
  abandonGrillSession,
  addGrillQuestions,
  markQuestionAsked,
  answerGrillQuestion,
  skipGrillQuestion,
  supersedeGrillQuestion,
  getCurrentAnswers,
  listAnswerHistory,
  createGrillProposal,
  reviewGrillProposal,
  listGrillProposals,
  type GrillSessionDeps,
} from './grill-session.js';
import type {
  GrillSessionData,
  GrillQuestionData,
  GrillAnswerData,
  GrillProposalData,
  GrillSessionRepositoryPort,
  GrillQuestionRepositoryPort,
  GrillAnswerRepositoryPort,
  GrillProposalRepositoryPort,
} from './grill-types.js';
import {
  GrillSessionNotFoundError,
  GrillQuestionNotFoundError,
  GrillProposalNotFoundError,
  GrillStateConflictError,
  GrillVersionConflictError,
  GrillOwnershipConflictError,
  GrillValidationError,
} from './errors.js';

// ── Mock 工厂 ─────────────────────────────────────────────────────

const NOW = '2024-06-15T12:00:00.000Z';

function createMockClock() {
  return { now: () => NOW };
}

let idCounter = 0;
function createMockIdGenerator() {
  return { generate: () => `id-${++idCounter}` };
}

interface MockSessionStore {
  sessions: Map<string, GrillSessionData>;
}

function createMockSessionRepo(store: MockSessionStore): GrillSessionRepositoryPort {
  return {
    create(data) {
      store.sessions.set(data.id, {
        id: data.id,
        projectId: data.projectId,
        status: 'DRAFT',
        version: 1,
        goal: data.goal,
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: null,
        completedAt: null,
        abandonedAt: null,
      });
    },
    getById(id) {
      return store.sessions.get(id) ?? null;
    },
    listByProject(projectId) {
      return [...store.sessions.values()].filter((s) => s.projectId === projectId);
    },
    transitionStatus(id, expectedVersion, newStatus) {
      const session = store.sessions.get(id);
      if (!session || session.version !== expectedVersion) return false;
      store.sessions.set(id, {
        ...session,
        status: newStatus,
        version: session.version + 1,
        updatedAt: NOW,
        startedAt: newStatus === 'ACTIVE' ? (session.startedAt ?? NOW) : session.startedAt,
        completedAt: newStatus === 'COMPLETED' ? NOW : session.completedAt,
        abandonedAt: newStatus === 'ABANDONED' ? NOW : session.abandonedAt,
      });
      return true;
    },
    bumpVersion(id, expectedVersion) {
      const session = store.sessions.get(id);
      if (!session || session.version !== expectedVersion) return false;
      store.sessions.set(id, { ...session, version: session.version + 1, updatedAt: NOW });
      return true;
    },
  };
}

interface MockQuestionStore {
  questions: Map<string, GrillQuestionData>;
}

function createMockQuestionRepo(store: MockQuestionStore): GrillQuestionRepositoryPort {
  return {
    create(data) {
      store.questions.set(data.id, {
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
    getById(id) {
      return store.questions.get(id) ?? null;
    },
    listBySession(sessionId) {
      return [...store.questions.values()]
        .filter((q) => q.sessionId === sessionId)
        .sort((a, b) => a.sequence - b.sequence);
    },
    markAsked(id) {
      const q = store.questions.get(id);
      if (!q || q.status !== 'PLANNED') return false;
      store.questions.set(id, { ...q, status: 'ASKED', askedAt: NOW });
      return true;
    },
    markAnswered(id) {
      const q = store.questions.get(id);
      if (!q || q.status !== 'ASKED') return false;
      store.questions.set(id, { ...q, status: 'ANSWERED', answeredAt: NOW });
      return true;
    },
    markSkipped(id) {
      const q = store.questions.get(id);
      if (!q || (q.status !== 'PLANNED' && q.status !== 'ASKED')) return false;
      store.questions.set(id, { ...q, status: 'SKIPPED', skippedAt: NOW });
      return true;
    },
    markSuperseded(id) {
      const q = store.questions.get(id);
      if (!q || (q.status !== 'PLANNED' && q.status !== 'ASKED' && q.status !== 'ANSWERED'))
        return false;
      store.questions.set(id, { ...q, status: 'SUPERSEDED', supersededAt: NOW });
      return true;
    },
    getMaxSequence(sessionId) {
      const qs = [...store.questions.values()].filter((q) => q.sessionId === sessionId);
      return qs.length > 0 ? Math.max(...qs.map((q) => q.sequence)) : 0;
    },
  };
}

interface MockAnswerStore {
  answers: Map<string, GrillAnswerData>;
}

function createMockAnswerRepo(store: MockAnswerStore): GrillAnswerRepositoryPort {
  return {
    create(data) {
      store.answers.set(data.id, {
        id: data.id,
        sessionId: data.sessionId,
        questionId: data.questionId,
        revision: data.revision,
        source: data.source,
        text: data.text,
        createdAt: NOW,
        supersededAt: null,
      });
    },
    getById(id) {
      return store.answers.get(id) ?? null;
    },
    getCurrentByQuestion(questionId) {
      return (
        [...store.answers.values()].find(
          (a) => a.questionId === questionId && a.supersededAt === null,
        ) ?? null
      );
    },
    listByQuestion(questionId) {
      return [...store.answers.values()]
        .filter((a) => a.questionId === questionId)
        .sort((a, b) => a.revision - b.revision);
    },
    listCurrentBySession(sessionId) {
      return [...store.answers.values()].filter(
        (a) => a.sessionId === sessionId && a.supersededAt === null,
      );
    },
    supersedeCurrent(questionId) {
      let found = false;
      for (const [id, a] of store.answers) {
        if (a.questionId === questionId && a.supersededAt === null) {
          store.answers.set(id, { ...a, supersededAt: NOW });
          found = true;
        }
      }
      return found;
    },
  };
}

interface MockProposalStore {
  proposals: Map<string, GrillProposalData>;
}

function createMockProposalRepo(store: MockProposalStore): GrillProposalRepositoryPort {
  return {
    create(data) {
      store.proposals.set(data.id, {
        id: data.id,
        sessionId: data.sessionId,
        basedOnAnswerIds: data.basedOnAnswerIds,
        key: data.key,
        proposedValueJson: data.proposedValueJson,
        confidence: data.confidence,
        rationale: data.rationale,
        status: 'PROPOSED',
        createdAt: NOW,
        reviewedAt: null,
      });
    },
    getById(id) {
      return store.proposals.get(id) ?? null;
    },
    listBySession(sessionId) {
      return [...store.proposals.values()].filter((p) => p.sessionId === sessionId);
    },
    markAccepted(id) {
      const p = store.proposals.get(id);
      if (!p || p.status !== 'PROPOSED') return false;
      store.proposals.set(id, { ...p, status: 'ACCEPTED', reviewedAt: NOW });
      return true;
    },
    markRejected(id) {
      const p = store.proposals.get(id);
      if (!p || p.status !== 'PROPOSED') return false;
      store.proposals.set(id, { ...p, status: 'REJECTED', reviewedAt: NOW });
      return true;
    },
    markSuperseded(id) {
      const p = store.proposals.get(id);
      if (!p || p.status !== 'PROPOSED') return false;
      store.proposals.set(id, { ...p, status: 'SUPERSEDED', reviewedAt: NOW });
      return true;
    },
  };
}

interface Stores {
  sessionStore: MockSessionStore;
  questionStore: MockQuestionStore;
  answerStore: MockAnswerStore;
  proposalStore: MockProposalStore;
}

function createDeps(overrides?: Partial<GrillSessionDeps>): GrillSessionDeps & { stores: Stores } {
  const sessionStore: MockSessionStore = { sessions: new Map() };
  const questionStore: MockQuestionStore = { questions: new Map() };
  const answerStore: MockAnswerStore = { answers: new Map() };
  const proposalStore: MockProposalStore = { proposals: new Map() };

  return {
    idGenerator: createMockIdGenerator(),
    clock: createMockClock(),
    sessionRepo: createMockSessionRepo(sessionStore),
    questionRepo: createMockQuestionRepo(questionStore),
    answerRepo: createMockAnswerRepo(answerStore),
    proposalRepo: createMockProposalRepo(proposalStore),
    transaction: <T>(fn: () => T) => fn(),
    stores: { sessionStore, questionStore, answerStore, proposalStore },
    ...overrides,
  };
}

function createActiveSession(deps: GrillSessionDeps): GrillSessionData {
  const session = createGrillSession(deps, { projectId: 'p1', goal: '测试目标' });
  return startGrillSession(deps, { sessionId: session.id, expectedVersion: 1 });
}

/** 创建一个已回答的问题，返回 question 和 current answer */
function createAnsweredQuestion(
  deps: GrillSessionDeps,
  sessionId: string,
  version: number,
): { question: GrillQuestionData; answer: GrillAnswerData; nextVersion: number } {
  const [question] = addGrillQuestions(deps, {
    sessionId,
    expectedVersion: version,
    questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
  });
  const answer = answerGrillQuestion(deps, {
    sessionId,
    expectedVersion: version + 1,
    questionId: question.id,
    text: '回答',
    source: 'USER',
  });
  return { question, answer, nextVersion: version + 2 };
}

// ── 会话管理测试 ──────────────────────────────────────────────────

describe('createGrillSession', () => {
  it('创建 DRAFT 会话', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: '目标' });
    expect(session.status).toBe('DRAFT');
    expect(session.version).toBe(1);
    expect(session.goal).toBe('目标');
  });

  it('空目标拒绝', () => {
    const deps = createDeps();
    expect(() => createGrillSession(deps, { projectId: 'p1', goal: '  ' })).toThrow(
      GrillValidationError,
    );
  });
});

describe('getGrillSession', () => {
  it('存在时返回', () => {
    const deps = createDeps();
    const created = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    expect(getGrillSession(deps, { sessionId: created.id }).id).toBe(created.id);
  });

  it('不存在时抛出', () => {
    const deps = createDeps();
    expect(() => getGrillSession(deps, { sessionId: 'nonexistent' })).toThrow(
      GrillSessionNotFoundError,
    );
  });
});

describe('listGrillSessions', () => {
  it('按项目过滤', () => {
    const deps = createDeps();
    createGrillSession(deps, { projectId: 'p1', goal: 'g1' });
    createGrillSession(deps, { projectId: 'p2', goal: 'g2' });
    expect(listGrillSessions(deps, { projectId: 'p1' })).toHaveLength(1);
  });
});

describe('会话状态转换', () => {
  it('DRAFT -> ACTIVE', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    const started = startGrillSession(deps, { sessionId: session.id, expectedVersion: 1 });
    expect(started.status).toBe('ACTIVE');
    expect(started.version).toBe(2);
  });

  it('ACTIVE -> PAUSED -> ACTIVE', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const paused = pauseGrillSession(deps, { sessionId: session.id, expectedVersion: 2 });
    expect(paused.status).toBe('PAUSED');
    const resumed = resumeGrillSession(deps, { sessionId: session.id, expectedVersion: 3 });
    expect(resumed.status).toBe('ACTIVE');
  });

  it('ACTIVE -> COMPLETED', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const completed = completeGrillSession(deps, { sessionId: session.id, expectedVersion: 2 });
    expect(completed.status).toBe('COMPLETED');
  });

  it('DRAFT -> ABANDONED', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    const abandoned = abandonGrillSession(deps, { sessionId: session.id, expectedVersion: 1 });
    expect(abandoned.status).toBe('ABANDONED');
  });

  it('非法转换抛出', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    expect(() => completeGrillSession(deps, { sessionId: session.id, expectedVersion: 1 })).toThrow(
      Error,
    );
  });

  it('版本冲突抛出 GrillVersionConflictError', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    expect(() => startGrillSession(deps, { sessionId: session.id, expectedVersion: 99 })).toThrow(
      GrillVersionConflictError,
    );
  });

  it('终态不可转换', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    abandonGrillSession(deps, { sessionId: session.id, expectedVersion: 1 });
    expect(() => startGrillSession(deps, { sessionId: session.id, expectedVersion: 2 })).toThrow();
  });
});

// ── 问题管理与依赖完整性 ──────────────────────────────────────────

describe('addGrillQuestions', () => {
  it('批量添加问题', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const questions = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [
        { topic: '主题1', text: '问题1', rationale: '原因1', dependsOnQuestionIds: [] },
        { topic: '主题2', text: '问题2', rationale: '', dependsOnQuestionIds: [] },
      ],
    });
    expect(questions).toHaveLength(2);
    expect(questions[0].sequence).toBe(1);
    expect(questions[1].sequence).toBe(2);
    expect(getGrillSession(deps, { sessionId: session.id }).version).toBe(3);
  });

  it('非 ACTIVE 会话拒绝', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    expect(() =>
      addGrillQuestions(deps, {
        sessionId: session.id,
        expectedVersion: 1,
        questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
      }),
    ).toThrow(GrillStateConflictError);
  });

  it('空问题列表拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      addGrillQuestions(deps, { sessionId: session.id, expectedVersion: 2, questions: [] }),
    ).toThrow(GrillValidationError);
  });

  it('依赖不能自引用', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      addGrillQuestions(deps, {
        sessionId: session.id,
        expectedVersion: 2,
        questions: [
          { id: 'q1', topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: ['q1'] },
        ],
      }),
    ).toThrow(GrillValidationError);
  });

  it('依赖不能包含空 ID', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      addGrillQuestions(deps, {
        sessionId: session.id,
        expectedVersion: 2,
        questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [''] }],
      }),
    ).toThrow(GrillValidationError);
  });

  it('依赖不能包含重复 ID', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const [existing] = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });
    expect(() =>
      addGrillQuestions(deps, {
        sessionId: session.id,
        expectedVersion: 3,
        questions: [
          {
            topic: 't2',
            text: 'x',
            rationale: '',
            dependsOnQuestionIds: [existing.id, existing.id],
          },
        ],
      }),
    ).toThrow(GrillValidationError);
  });

  it('依赖不能引用其他会话的问题', () => {
    const deps = createDeps();
    const sessionA = createActiveSession(deps);
    const [questionA] = addGrillQuestions(deps, {
      sessionId: sessionA.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });

    const sessionB = createGrillSession(deps, { projectId: 'p1', goal: 'g2' });
    startGrillSession(deps, { sessionId: sessionB.id, expectedVersion: 1 });

    expect(() =>
      addGrillQuestions(deps, {
        sessionId: sessionB.id,
        expectedVersion: 2,
        questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [questionA.id] }],
      }),
    ).toThrow(GrillOwnershipConflictError);
  });

  it('依赖不能引用不存在的问题', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      addGrillQuestions(deps, {
        sessionId: session.id,
        expectedVersion: 2,
        questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: ['ghost'] }],
      }),
    ).toThrow(GrillValidationError);
  });

  it('批次内二元环拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      addGrillQuestions(deps, {
        sessionId: session.id,
        expectedVersion: 2,
        questions: [
          { id: 'qa', topic: 'a', text: 'x', rationale: '', dependsOnQuestionIds: ['qb'] },
          { id: 'qb', topic: 'b', text: 'x', rationale: '', dependsOnQuestionIds: ['qa'] },
        ],
      }),
    ).toThrow(GrillValidationError);
  });

  it('批次内单向依赖允许', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const questions = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [
        { id: 'qa', topic: 'a', text: 'x', rationale: '', dependsOnQuestionIds: [] },
        { id: 'qb', topic: 'b', text: 'x', rationale: '', dependsOnQuestionIds: ['qa'] },
      ],
    });
    expect(questions).toHaveLength(2);
  });

  it('批次内 ID 重复拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      addGrillQuestions(deps, {
        sessionId: session.id,
        expectedVersion: 2,
        questions: [
          { id: 'qa', topic: 'a', text: 'x', rationale: '', dependsOnQuestionIds: [] },
          { id: 'qa', topic: 'b', text: 'x', rationale: '', dependsOnQuestionIds: [] },
        ],
      }),
    ).toThrow(GrillValidationError);
  });
});

describe('markQuestionAsked', () => {
  it('PLANNED -> ASKED', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const [q] = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });
    const asked = markQuestionAsked(deps, {
      sessionId: session.id,
      expectedVersion: 3,
      questionId: q.id,
    });
    expect(asked.status).toBe('ASKED');
  });

  it('跨会话问题拒绝（归属冲突）', () => {
    const deps = createDeps();
    const sessionA = createActiveSession(deps);
    const [q] = addGrillQuestions(deps, {
      sessionId: sessionA.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });
    const sessionB = createGrillSession(deps, { projectId: 'p1', goal: 'g2' });
    startGrillSession(deps, { sessionId: sessionB.id, expectedVersion: 1 });

    expect(() =>
      markQuestionAsked(deps, { sessionId: sessionB.id, expectedVersion: 2, questionId: q.id }),
    ).toThrow(GrillOwnershipConflictError);
  });
});

// ── 回答管理测试 ──────────────────────────────────────────────────

describe('answerGrillQuestion', () => {
  it('PLANNED 直接回答创建 revision 1 并转 ANSWERED', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const [q] = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });
    const answer = answerGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: 3,
      questionId: q.id,
      text: '我的回答',
      source: 'USER',
    });
    expect(answer.revision).toBe(1);
    expect(deps.questionRepo.getById(q.id)?.status).toBe('ANSWERED');
  });

  it('ASKED -> ANSWERED', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const [q] = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });
    markQuestionAsked(deps, { sessionId: session.id, expectedVersion: 3, questionId: q.id });
    const answer = answerGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: 4,
      questionId: q.id,
      text: '回答',
      source: 'USER',
    });
    expect(answer.revision).toBe(1);
    expect(deps.questionRepo.getById(q.id)?.status).toBe('ANSWERED');
  });

  it('ANSWERED 问题可生成 revision 2', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { question, nextVersion } = createAnsweredQuestion(deps, session.id, 2);

    const answer2 = answerGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: nextVersion,
      questionId: question.id,
      text: '修订版',
      source: 'USER',
    });
    expect(answer2.revision).toBe(2);

    const history = listAnswerHistory(deps, { sessionId: session.id, questionId: question.id });
    expect(history).toHaveLength(2);
    expect(history[0].supersededAt).toBe(NOW);
    expect(history[1].supersededAt).toBeNull();
  });

  it('SKIPPED 问题不能回答', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const [q] = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });
    skipGrillQuestion(deps, { sessionId: session.id, expectedVersion: 3, questionId: q.id });

    expect(() =>
      answerGrillQuestion(deps, {
        sessionId: session.id,
        expectedVersion: 4,
        questionId: q.id,
        text: '回答',
        source: 'USER',
      }),
    ).toThrow(GrillStateConflictError);
  });

  it('SUPERSEDED 问题不能回答', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { question, nextVersion } = createAnsweredQuestion(deps, session.id, 2);
    supersedeGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: nextVersion,
      questionId: question.id,
    });

    expect(() =>
      answerGrillQuestion(deps, {
        sessionId: session.id,
        expectedVersion: nextVersion + 1,
        questionId: question.id,
        text: '回答',
        source: 'USER',
      }),
    ).toThrow(GrillStateConflictError);
  });

  it('ANSWERED 但无 current answer 时拒绝（数据不一致）', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { question, answer, nextVersion } = createAnsweredQuestion(deps, session.id, 2);

    // 人为制造不一致：直接废弃当前答案但不新增
    deps.stores.answerStore.answers.set(answer.id, { ...answer, supersededAt: NOW });

    expect(() =>
      answerGrillQuestion(deps, {
        sessionId: session.id,
        expectedVersion: nextVersion,
        questionId: question.id,
        text: '回答',
        source: 'USER',
      }),
    ).toThrow(GrillStateConflictError);
  });

  it('跨会话问题不能回答（归属冲突）', () => {
    const deps = createDeps();
    const sessionA = createActiveSession(deps);
    const [q] = addGrillQuestions(deps, {
      sessionId: sessionA.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });
    const sessionB = createGrillSession(deps, { projectId: 'p1', goal: 'g2' });
    startGrillSession(deps, { sessionId: sessionB.id, expectedVersion: 1 });

    expect(() =>
      answerGrillQuestion(deps, {
        sessionId: sessionB.id,
        expectedVersion: 2,
        questionId: q.id,
        text: '回答',
        source: 'USER',
      }),
    ).toThrow(GrillOwnershipConflictError);
  });

  it('空回答拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const [q] = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });
    expect(() =>
      answerGrillQuestion(deps, {
        sessionId: session.id,
        expectedVersion: 3,
        questionId: q.id,
        text: '  ',
        source: 'USER',
      }),
    ).toThrow(GrillValidationError);
  });

  it('问题不存在抛出', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      answerGrillQuestion(deps, {
        sessionId: session.id,
        expectedVersion: 2,
        questionId: 'nonexistent',
        text: '回答',
        source: 'USER',
      }),
    ).toThrow(GrillQuestionNotFoundError);
  });
});

describe('skipGrillQuestion', () => {
  it('跳过问题', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const [q] = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });
    const skipped = skipGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: 3,
      questionId: q.id,
    });
    expect(skipped.status).toBe('SKIPPED');
  });

  it('跨会话问题拒绝', () => {
    const deps = createDeps();
    const sessionA = createActiveSession(deps);
    const [q] = addGrillQuestions(deps, {
      sessionId: sessionA.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });
    const sessionB = createGrillSession(deps, { projectId: 'p1', goal: 'g2' });
    startGrillSession(deps, { sessionId: sessionB.id, expectedVersion: 1 });
    expect(() =>
      skipGrillQuestion(deps, { sessionId: sessionB.id, expectedVersion: 2, questionId: q.id }),
    ).toThrow(GrillOwnershipConflictError);
  });
});

describe('supersedeGrillQuestion', () => {
  it('废弃已回答问题', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { question, nextVersion } = createAnsweredQuestion(deps, session.id, 2);
    const superseded = supersedeGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: nextVersion,
      questionId: question.id,
    });
    expect(superseded.status).toBe('SUPERSEDED');
  });

  it('跨会话问题拒绝', () => {
    const deps = createDeps();
    const sessionA = createActiveSession(deps);
    const { question } = createAnsweredQuestion(deps, sessionA.id, 2);
    const sessionB = createGrillSession(deps, { projectId: 'p1', goal: 'g2' });
    startGrillSession(deps, { sessionId: sessionB.id, expectedVersion: 1 });
    expect(() =>
      supersedeGrillQuestion(deps, {
        sessionId: sessionB.id,
        expectedVersion: 2,
        questionId: question.id,
      }),
    ).toThrow(GrillOwnershipConflictError);
  });
});

describe('getCurrentAnswers', () => {
  it('返回当前有效答案', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    createAnsweredQuestion(deps, session.id, 2);
    expect(getCurrentAnswers(deps, { sessionId: session.id })).toHaveLength(1);
  });
});

describe('listAnswerHistory', () => {
  it('跨会话问题拒绝', () => {
    const deps = createDeps();
    const sessionA = createActiveSession(deps);
    const { question } = createAnsweredQuestion(deps, sessionA.id, 2);
    const sessionB = createGrillSession(deps, { projectId: 'p1', goal: 'g2' });
    expect(() =>
      listAnswerHistory(deps, { sessionId: sessionB.id, questionId: question.id }),
    ).toThrow(GrillOwnershipConflictError);
  });
});

// ── 提案管理测试 ──────────────────────────────────────────────────

describe('createGrillProposal', () => {
  it('创建提案并递增版本', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { answer, nextVersion } = createAnsweredQuestion(deps, session.id, 2);

    const proposal = createGrillProposal(deps, {
      sessionId: session.id,
      expectedVersion: nextVersion,
      basedOnAnswerIds: [answer.id],
      key: 'genre',
      proposedValueJson: '"奇幻"',
      confidence: 0.85,
      rationale: '推断',
    });

    expect(proposal.status).toBe('PROPOSED');
    expect(getGrillSession(deps, { sessionId: session.id }).version).toBe(nextVersion + 1);
  });

  it('basedOnAnswerIds 为空拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      createGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: 2,
        basedOnAnswerIds: [],
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
      }),
    ).toThrow(GrillValidationError);
  });

  it('basedOnAnswerIds 重复拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { answer, nextVersion } = createAnsweredQuestion(deps, session.id, 2);
    expect(() =>
      createGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: nextVersion,
        basedOnAnswerIds: [answer.id, answer.id],
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
      }),
    ).toThrow(GrillValidationError);
  });

  it('引用不存在的 answer 拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      createGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: 2,
        basedOnAnswerIds: ['ghost'],
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
      }),
    ).toThrow(GrillValidationError);
  });

  it('引用其他会话的 answer 拒绝', () => {
    const deps = createDeps();
    const sessionA = createActiveSession(deps);
    const { answer } = createAnsweredQuestion(deps, sessionA.id, 2);

    const sessionB = createGrillSession(deps, { projectId: 'p1', goal: 'g2' });
    startGrillSession(deps, { sessionId: sessionB.id, expectedVersion: 1 });

    expect(() =>
      createGrillProposal(deps, {
        sessionId: sessionB.id,
        expectedVersion: 2,
        basedOnAnswerIds: [answer.id],
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
      }),
    ).toThrow(GrillOwnershipConflictError);
  });

  it('引用已废弃的 answer 拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { answer, nextVersion } = createAnsweredQuestion(deps, session.id, 2);
    deps.stores.answerStore.answers.set(answer.id, { ...answer, supersededAt: NOW });

    expect(() =>
      createGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: nextVersion,
        basedOnAnswerIds: [answer.id],
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
      }),
    ).toThrow(GrillValidationError);
  });

  it('无效 JSON 拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { answer, nextVersion } = createAnsweredQuestion(deps, session.id, 2);
    expect(() =>
      createGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: nextVersion,
        basedOnAnswerIds: [answer.id],
        key: 'k',
        proposedValueJson: 'not-json',
        confidence: 0.5,
        rationale: '',
      }),
    ).toThrow(GrillValidationError);
  });

  it('confidence 越界拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { answer, nextVersion } = createAnsweredQuestion(deps, session.id, 2);
    expect(() =>
      createGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: nextVersion,
        basedOnAnswerIds: [answer.id],
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 1.5,
        rationale: '',
      }),
    ).toThrow(GrillValidationError);
  });

  it('终态会话拒绝', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    abandonGrillSession(deps, { sessionId: session.id, expectedVersion: 1 });
    expect(() =>
      createGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: 2,
        basedOnAnswerIds: ['a'],
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
      }),
    ).toThrow(GrillStateConflictError);
  });

  it('版本冲突拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { answer } = createAnsweredQuestion(deps, session.id, 2);
    expect(() =>
      createGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: 99,
        basedOnAnswerIds: [answer.id],
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
      }),
    ).toThrow(GrillVersionConflictError);
  });
});

describe('reviewGrillProposal', () => {
  function createProposalFixture(deps: GrillSessionDeps, sessionId: string, version: number) {
    const { answer, nextVersion } = createAnsweredQuestion(deps, sessionId, version);
    const proposal = createGrillProposal(deps, {
      sessionId,
      expectedVersion: nextVersion,
      basedOnAnswerIds: [answer.id],
      key: 'k',
      proposedValueJson: '"v"',
      confidence: 0.5,
      rationale: '',
    });
    return { proposal, nextVersion: nextVersion + 1 };
  }

  it('接受提案', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { proposal, nextVersion } = createProposalFixture(deps, session.id, 2);
    const reviewed = reviewGrillProposal(deps, {
      sessionId: session.id,
      expectedVersion: nextVersion,
      proposalId: proposal.id,
      decision: 'ACCEPTED',
    });
    expect(reviewed.status).toBe('ACCEPTED');
  });

  it('拒绝提案', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { proposal, nextVersion } = createProposalFixture(deps, session.id, 2);
    const reviewed = reviewGrillProposal(deps, {
      sessionId: session.id,
      expectedVersion: nextVersion,
      proposalId: proposal.id,
      decision: 'REJECTED',
    });
    expect(reviewed.status).toBe('REJECTED');
  });

  it('跨会话提案拒绝', () => {
    const deps = createDeps();
    const sessionA = createActiveSession(deps);
    const { proposal } = createProposalFixture(deps, sessionA.id, 2);
    const sessionB = createGrillSession(deps, { projectId: 'p1', goal: 'g2' });
    startGrillSession(deps, { sessionId: sessionB.id, expectedVersion: 1 });
    expect(() =>
      reviewGrillProposal(deps, {
        sessionId: sessionB.id,
        expectedVersion: 2,
        proposalId: proposal.id,
        decision: 'ACCEPTED',
      }),
    ).toThrow(GrillOwnershipConflictError);
  });

  it('已审核提案不能再审核', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { proposal, nextVersion } = createProposalFixture(deps, session.id, 2);
    reviewGrillProposal(deps, {
      sessionId: session.id,
      expectedVersion: nextVersion,
      proposalId: proposal.id,
      decision: 'ACCEPTED',
    });
    expect(() =>
      reviewGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: nextVersion + 1,
        proposalId: proposal.id,
        decision: 'REJECTED',
      }),
    ).toThrow(GrillStateConflictError);
  });

  it('提案不存在抛出', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      reviewGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: 2,
        proposalId: 'nonexistent',
        decision: 'ACCEPTED',
      }),
    ).toThrow(GrillProposalNotFoundError);
  });
});

describe('listGrillProposals', () => {
  it('列出会话提案', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const { answer, nextVersion } = createAnsweredQuestion(deps, session.id, 2);
    createGrillProposal(deps, {
      sessionId: session.id,
      expectedVersion: nextVersion,
      basedOnAnswerIds: [answer.id],
      key: 'k1',
      proposedValueJson: '"v1"',
      confidence: 0.5,
      rationale: '',
    });
    expect(listGrillProposals(deps, { sessionId: session.id })).toHaveLength(1);
  });
});
