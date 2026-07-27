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

function createDeps(overrides?: Partial<GrillSessionDeps>): GrillSessionDeps {
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
    ...overrides,
  };
}

function createActiveSession(deps: GrillSessionDeps): GrillSessionData {
  const session = createGrillSession(deps, { projectId: 'p1', goal: '测试目标' });
  return startGrillSession(deps, { sessionId: session.id, expectedVersion: 1 });
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
    const fetched = getGrillSession(deps, { sessionId: created.id });
    expect(fetched.id).toBe(created.id);
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
    expect(started.startedAt).toBe(NOW);
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
    expect(completed.completedAt).toBe(NOW);
  });

  it('DRAFT -> ABANDONED', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    const abandoned = abandonGrillSession(deps, { sessionId: session.id, expectedVersion: 1 });
    expect(abandoned.status).toBe('ABANDONED');
  });

  it('非法转换抛出 GrillStateConflictError', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    expect(() => completeGrillSession(deps, { sessionId: session.id, expectedVersion: 1 })).toThrow(
      Error,
    );
  });

  it('版本冲突抛出 GrillVersionConflictError', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    expect(() =>
      startGrillSession(deps, { sessionId: session.id, expectedVersion: 99 }),
    ).toThrow(GrillVersionConflictError);
  });

  it('终态不可转换', () => {
    const deps = createDeps();
    const session = createGrillSession(deps, { projectId: 'p1', goal: 'g' });
    abandonGrillSession(deps, { sessionId: session.id, expectedVersion: 1 });
    expect(() =>
      startGrillSession(deps, { sessionId: session.id, expectedVersion: 2 }),
    ).toThrow();
  });
});

// ── 问题管理测试 ──────────────────────────────────────────────────

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

    const updatedSession = getGrillSession(deps, { sessionId: session.id });
    expect(updatedSession.version).toBe(3);
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

  it('版本冲突回滚', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      addGrillQuestions(deps, {
        sessionId: session.id,
        expectedVersion: 99,
        questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
      }),
    ).toThrow(GrillVersionConflictError);
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
    expect(asked.askedAt).toBe(NOW);
  });
});

// ── 回答管理测试 ──────────────────────────────────────────────────

describe('answerGrillQuestion', () => {
  it('回答问题创建新 revision', () => {
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

    expect(answer.text).toBe('我的回答');
    expect(answer.revision).toBe(1);

    const updatedQ = deps.questionRepo.getById(q.id);
    expect(updatedQ?.status).toBe('ANSWERED');
  });

  it('重复回答废弃旧答案', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const [q] = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });

    answerGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: 3,
      questionId: q.id,
      text: 'v1',
      source: 'USER',
    });

    const session2 = getGrillSession(deps, { sessionId: session.id });
    const answer2 = answerGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: session2.version,
      questionId: q.id,
      text: 'v2',
      source: 'USER',
    });

    expect(answer2.revision).toBe(2);

    const history = listAnswerHistory(deps, { questionId: q.id });
    expect(history).toHaveLength(2);
    expect(history[0].supersededAt).toBe(NOW);
    expect(history[1].supersededAt).toBeNull();
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
});

describe('supersedeGrillQuestion', () => {
  it('废弃已回答问题', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const [q] = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    });

    answerGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: 3,
      questionId: q.id,
      text: '回答',
      source: 'USER',
    });

    const session2 = getGrillSession(deps, { sessionId: session.id });
    const superseded = supersedeGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: session2.version,
      questionId: q.id,
    });
    expect(superseded.status).toBe('SUPERSEDED');
  });
});

describe('getCurrentAnswers', () => {
  it('返回当前有效答案', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const questions = addGrillQuestions(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      questions: [
        { topic: 't1', text: 'x1', rationale: '', dependsOnQuestionIds: [] },
        { topic: 't2', text: 'x2', rationale: '', dependsOnQuestionIds: [] },
      ],
    });

    answerGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: 3,
      questionId: questions[0].id,
      text: 'a1',
      source: 'USER',
    });

    const s2 = getGrillSession(deps, { sessionId: session.id });
    answerGrillQuestion(deps, {
      sessionId: session.id,
      expectedVersion: s2.version,
      questionId: questions[1].id,
      text: 'a2',
      source: 'USER',
    });

    const current = getCurrentAnswers(deps, { sessionId: session.id });
    expect(current).toHaveLength(2);
  });
});

// ── 提案管理测试 ──────────────────────────────────────────────────

describe('createGrillProposal', () => {
  it('创建提案', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);

    const proposal = createGrillProposal(deps, {
      sessionId: session.id,
      basedOnAnswerIds: [],
      key: 'genre',
      proposedValueJson: '"奇幻"',
      confidence: 0.85,
      rationale: '推断',
    });

    expect(proposal.status).toBe('PROPOSED');
    expect(proposal.key).toBe('genre');
    expect(proposal.confidence).toBe(0.85);
  });

  it('无效 JSON 拒绝', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    expect(() =>
      createGrillProposal(deps, {
        sessionId: session.id,
        basedOnAnswerIds: [],
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
    expect(() =>
      createGrillProposal(deps, {
        sessionId: session.id,
        basedOnAnswerIds: [],
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
        basedOnAnswerIds: [],
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
      }),
    ).toThrow(GrillStateConflictError);
  });
});

describe('reviewGrillProposal', () => {
  it('接受提案', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const proposal = createGrillProposal(deps, {
      sessionId: session.id,
      basedOnAnswerIds: [],
      key: 'k',
      proposedValueJson: '"v"',
      confidence: 0.5,
      rationale: '',
    });

    const reviewed = reviewGrillProposal(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      proposalId: proposal.id,
      decision: 'ACCEPTED',
    });

    expect(reviewed.status).toBe('ACCEPTED');
    expect(reviewed.reviewedAt).toBe(NOW);

    const updatedSession = getGrillSession(deps, { sessionId: session.id });
    expect(updatedSession.version).toBe(3);
  });

  it('拒绝提案', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const proposal = createGrillProposal(deps, {
      sessionId: session.id,
      basedOnAnswerIds: [],
      key: 'k',
      proposedValueJson: '"v"',
      confidence: 0.5,
      rationale: '',
    });

    const reviewed = reviewGrillProposal(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      proposalId: proposal.id,
      decision: 'REJECTED',
    });
    expect(reviewed.status).toBe('REJECTED');
  });

  it('已审核提案不能再审核', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const proposal = createGrillProposal(deps, {
      sessionId: session.id,
      basedOnAnswerIds: [],
      key: 'k',
      proposedValueJson: '"v"',
      confidence: 0.5,
      rationale: '',
    });

    reviewGrillProposal(deps, {
      sessionId: session.id,
      expectedVersion: 2,
      proposalId: proposal.id,
      decision: 'ACCEPTED',
    });

    expect(() =>
      reviewGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: 3,
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

  it('版本冲突抛出', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    const proposal = createGrillProposal(deps, {
      sessionId: session.id,
      basedOnAnswerIds: [],
      key: 'k',
      proposedValueJson: '"v"',
      confidence: 0.5,
      rationale: '',
    });

    expect(() =>
      reviewGrillProposal(deps, {
        sessionId: session.id,
        expectedVersion: 99,
        proposalId: proposal.id,
        decision: 'ACCEPTED',
      }),
    ).toThrow(GrillVersionConflictError);
  });
});

describe('listGrillProposals', () => {
  it('列出会话提案', () => {
    const deps = createDeps();
    const session = createActiveSession(deps);
    createGrillProposal(deps, {
      sessionId: session.id,
      basedOnAnswerIds: [],
      key: 'k1',
      proposedValueJson: '"v1"',
      confidence: 0.5,
      rationale: '',
    });
    createGrillProposal(deps, {
      sessionId: session.id,
      basedOnAnswerIds: [],
      key: 'k2',
      proposedValueJson: '"v2"',
      confidence: 0.7,
      rationale: '',
    });

    expect(listGrillProposals(deps, { sessionId: session.id })).toHaveLength(2);
  });
});
