/**
 * Grill-me RPC 处理器。
 *
 * 验证 payload → 获取 ProjectDatabase → 构建 deps → 调用用例 → 返回 DTO。
 */

import {
  isValidGrillCreateSessionInput,
  isValidGrillSessionIdInput,
  isValidGrillSessionVersionInput,
  isValidGrillAddQuestionsInput,
  isValidGrillAnswerQuestionInput,
  isValidGrillQuestionActionInput,
  isValidGrillCreateProposalInput,
  isValidGrillReviewProposalInput,
  isValidGrillListProposalsInput,
  isValidGrillListAnswerHistoryInput,
  type GrillSessionPublicData,
  type GrillQuestionPublicData,
  type GrillAnswerPublicData,
  type GrillProposalPublicData,
} from '@ai-novel/contracts';
import {
  AppError,
  createGrillSession,
  getGrillSession,
  listGrillSessions,
  startGrillSession,
  pauseGrillSession,
  resumeGrillSession,
  completeGrillSession,
  abandonGrillSession,
  addGrillQuestions,
  answerGrillQuestion,
  skipGrillQuestion,
  supersedeGrillQuestion,
  getCurrentAnswers,
  listAnswerHistory,
  createGrillProposal,
  reviewGrillProposal,
  listGrillProposals,
  type GrillSessionDeps,
  type GrillSessionData,
  type GrillQuestionData,
  type GrillAnswerData,
  type GrillProposalData,
  type GrillSessionRepositoryPort,
  type GrillQuestionRepositoryPort,
  type GrillAnswerRepositoryPort,
  type GrillProposalRepositoryPort,
  type IdGenerator,
  type Clock,
} from '@ai-novel/application';
import type { ProjectDatabase } from '@ai-novel/database';
import type { GrillAnswerSource } from '@ai-novel/domain';

// ── 上下文 ────────────────────────────────────────────────────────

export interface GrillHandlerContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: IdGenerator;
  clock: Clock;
}

// ── 适配器 ────────────────────────────────────────────────────────

class GrillSessionRepositoryAdapter implements GrillSessionRepositoryPort {
  constructor(
    private readonly projDb: ProjectDatabase,
    private readonly clock: Clock,
  ) {}

  create(data: { id: string; projectId: string; goal: string }): void {
    const now = this.clock.now();
    this.projDb.getGrillSessionRepository().create({
      id: data.id,
      projectId: data.projectId,
      goal: data.goal,
      createdAt: now,
      updatedAt: now,
    });
  }

  getById(id: string): GrillSessionData | null {
    const row = this.projDb.getGrillSessionRepository().getById(id);
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      status: row.status,
      version: row.version,
      goal: row.goal,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      abandonedAt: row.abandonedAt,
    };
  }

  listByProject(projectId: string): ReadonlyArray<GrillSessionData> {
    return this.projDb
      .getGrillSessionRepository()
      .listByProject(projectId)
      .map((row) => ({
        id: row.id,
        projectId: row.projectId,
        status: row.status,
        version: row.version,
        goal: row.goal,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        abandonedAt: row.abandonedAt,
      }));
  }

  transitionStatus(id: string, expectedVersion: number, newStatus: string): boolean {
    const now = this.clock.now();
    return this.projDb
      .getGrillSessionRepository()
      .transitionStatus(id, expectedVersion, newStatus as never, now);
  }

  bumpVersion(id: string, expectedVersion: number): boolean {
    const now = this.clock.now();
    return this.projDb.getGrillSessionRepository().bumpVersion(id, expectedVersion, now);
  }
}

class GrillQuestionRepositoryAdapter implements GrillQuestionRepositoryPort {
  constructor(
    private readonly projDb: ProjectDatabase,
    private readonly clock: Clock,
  ) {}

  create(data: {
    id: string;
    sessionId: string;
    sequence: number;
    topic: string;
    text: string;
    rationale: string;
    dependsOnQuestionIds: ReadonlyArray<string>;
  }): void {
    const now = this.clock.now();
    this.projDb.getGrillQuestionRepository().create({
      id: data.id,
      sessionId: data.sessionId,
      sequence: data.sequence,
      topic: data.topic,
      text: data.text,
      rationale: data.rationale,
      dependsOnQuestionIds: JSON.stringify(data.dependsOnQuestionIds),
      createdAt: now,
    });
  }

  getById(id: string): GrillQuestionData | null {
    const row = this.projDb.getGrillQuestionRepository().getById(id);
    if (!row) return null;
    return this.toData(row);
  }

  listBySession(sessionId: string): ReadonlyArray<GrillQuestionData> {
    return this.projDb.getGrillQuestionRepository().listBySession(sessionId).map(this.toData);
  }

  markAsked(id: string): boolean {
    const now = this.clock.now();
    return this.projDb.getGrillQuestionRepository().transitionStatus(id, 'PLANNED', 'ASKED', now);
  }

  markAnswered(id: string): boolean {
    const now = this.clock.now();
    return this.projDb.getGrillQuestionRepository().transitionStatus(id, 'ASKED', 'ANSWERED', now);
  }

  markSkipped(id: string): boolean {
    const now = this.clock.now();
    const repo = this.projDb.getGrillQuestionRepository();
    return (
      repo.transitionStatus(id, 'PLANNED', 'SKIPPED', now) ||
      repo.transitionStatus(id, 'ASKED', 'SKIPPED', now)
    );
  }

  markSuperseded(id: string): boolean {
    const now = this.clock.now();
    const repo = this.projDb.getGrillQuestionRepository();
    return (
      repo.transitionStatus(id, 'PLANNED', 'SUPERSEDED', now) ||
      repo.transitionStatus(id, 'ASKED', 'SUPERSEDED', now) ||
      repo.transitionStatus(id, 'ANSWERED', 'SUPERSEDED', now)
    );
  }

  getMaxSequence(sessionId: string): number {
    return this.projDb.getGrillQuestionRepository().getMaxSequence(sessionId);
  }

  private toData(row: {
    id: string;
    sessionId: string;
    sequence: number;
    topic: string;
    text: string;
    rationale: string;
    status: string;
    dependsOnQuestionIds: string;
    createdAt: string;
    askedAt: string | null;
    answeredAt: string | null;
    skippedAt: string | null;
    supersededAt: string | null;
  }): GrillQuestionData {
    return {
      id: row.id,
      sessionId: row.sessionId,
      sequence: row.sequence,
      topic: row.topic,
      text: row.text,
      rationale: row.rationale,
      status: row.status as GrillQuestionData['status'],
      dependsOnQuestionIds: JSON.parse(row.dependsOnQuestionIds) as string[],
      createdAt: row.createdAt,
      askedAt: row.askedAt,
      answeredAt: row.answeredAt,
      skippedAt: row.skippedAt,
      supersededAt: row.supersededAt,
    };
  }
}

class GrillAnswerRepositoryAdapter implements GrillAnswerRepositoryPort {
  constructor(
    private readonly projDb: ProjectDatabase,
    private readonly clock: Clock,
  ) {}

  create(data: {
    id: string;
    sessionId: string;
    questionId: string;
    revision: number;
    source: GrillAnswerSource;
    text: string;
  }): void {
    const now = this.clock.now();
    this.projDb.getGrillAnswerRepository().create({
      id: data.id,
      sessionId: data.sessionId,
      questionId: data.questionId,
      revision: data.revision,
      source: data.source,
      text: data.text,
      createdAt: now,
    });
  }

  getById(id: string): GrillAnswerData | null {
    const row = this.projDb.getGrillAnswerRepository().getById(id);
    if (!row) return null;
    return this.toData(row);
  }

  getCurrentByQuestion(questionId: string): GrillAnswerData | null {
    const row = this.projDb.getGrillAnswerRepository().getCurrentByQuestion(questionId);
    if (!row) return null;
    return this.toData(row);
  }

  listByQuestion(questionId: string): ReadonlyArray<GrillAnswerData> {
    return this.projDb.getGrillAnswerRepository().listByQuestion(questionId).map(this.toData);
  }

  listCurrentBySession(sessionId: string): ReadonlyArray<GrillAnswerData> {
    return this.projDb.getGrillAnswerRepository().listCurrentBySession(sessionId).map(this.toData);
  }

  supersedeCurrent(questionId: string): boolean {
    const now = this.clock.now();
    return this.projDb.getGrillAnswerRepository().supersedeCurrent(questionId, now);
  }

  private toData(row: {
    id: string;
    sessionId: string;
    questionId: string;
    revision: number;
    source: string;
    text: string;
    createdAt: string;
    supersededAt: string | null;
  }): GrillAnswerData {
    return {
      id: row.id,
      sessionId: row.sessionId,
      questionId: row.questionId,
      revision: row.revision,
      source: row.source as GrillAnswerSource,
      text: row.text,
      createdAt: row.createdAt,
      supersededAt: row.supersededAt,
    };
  }
}

class GrillProposalRepositoryAdapter implements GrillProposalRepositoryPort {
  constructor(
    private readonly projDb: ProjectDatabase,
    private readonly clock: Clock,
  ) {}

  create(data: {
    id: string;
    sessionId: string;
    basedOnAnswerIds: ReadonlyArray<string>;
    key: string;
    proposedValueJson: string;
    confidence: number;
    rationale: string;
  }): void {
    const now = this.clock.now();
    this.projDb.getGrillProposalRepository().create({
      id: data.id,
      sessionId: data.sessionId,
      basedOnAnswerIds: JSON.stringify(data.basedOnAnswerIds),
      key: data.key,
      proposedValueJson: data.proposedValueJson,
      confidence: data.confidence,
      rationale: data.rationale,
      createdAt: now,
    });
  }

  getById(id: string): GrillProposalData | null {
    const row = this.projDb.getGrillProposalRepository().getById(id);
    if (!row) return null;
    return this.toData(row);
  }

  listBySession(sessionId: string): ReadonlyArray<GrillProposalData> {
    return this.projDb.getGrillProposalRepository().listBySession(sessionId).map(this.toData);
  }

  markAccepted(id: string): boolean {
    const now = this.clock.now();
    return this.projDb
      .getGrillProposalRepository()
      .transitionStatus(id, 'PROPOSED', 'ACCEPTED', now);
  }

  markRejected(id: string): boolean {
    const now = this.clock.now();
    return this.projDb
      .getGrillProposalRepository()
      .transitionStatus(id, 'PROPOSED', 'REJECTED', now);
  }

  markSuperseded(id: string): boolean {
    const now = this.clock.now();
    return this.projDb
      .getGrillProposalRepository()
      .transitionStatus(id, 'PROPOSED', 'SUPERSEDED', now);
  }

  private toData(row: {
    id: string;
    sessionId: string;
    basedOnAnswerIds: string;
    key: string;
    proposedValueJson: string;
    confidence: number;
    rationale: string;
    status: string;
    createdAt: string;
    reviewedAt: string | null;
  }): GrillProposalData {
    return {
      id: row.id,
      sessionId: row.sessionId,
      basedOnAnswerIds: JSON.parse(row.basedOnAnswerIds) as string[],
      key: row.key,
      proposedValueJson: row.proposedValueJson,
      confidence: row.confidence,
      rationale: row.rationale,
      status: row.status as GrillProposalData['status'],
      createdAt: row.createdAt,
      reviewedAt: row.reviewedAt,
    };
  }
}

// ── DTO 映射 ──────────────────────────────────────────────────────

function toSessionPublicData(s: GrillSessionData): GrillSessionPublicData {
  return {
    id: s.id,
    projectId: s.projectId,
    status: s.status,
    version: s.version,
    goal: s.goal,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    abandonedAt: s.abandonedAt,
  };
}

function toQuestionPublicData(q: GrillQuestionData): GrillQuestionPublicData {
  return {
    id: q.id,
    sessionId: q.sessionId,
    sequence: q.sequence,
    topic: q.topic,
    text: q.text,
    rationale: q.rationale,
    status: q.status,
    dependsOnQuestionIds: q.dependsOnQuestionIds,
    createdAt: q.createdAt,
    askedAt: q.askedAt,
    answeredAt: q.answeredAt,
    skippedAt: q.skippedAt,
    supersededAt: q.supersededAt,
  };
}

function toAnswerPublicData(a: GrillAnswerData): GrillAnswerPublicData {
  return {
    id: a.id,
    sessionId: a.sessionId,
    questionId: a.questionId,
    revision: a.revision,
    source: a.source,
    text: a.text,
    createdAt: a.createdAt,
    supersededAt: a.supersededAt,
  };
}

function toProposalPublicData(p: GrillProposalData): GrillProposalPublicData {
  return {
    id: p.id,
    sessionId: p.sessionId,
    basedOnAnswerIds: p.basedOnAnswerIds,
    key: p.key,
    proposedValue: JSON.parse(p.proposedValueJson),
    confidence: p.confidence,
    rationale: p.rationale,
    status: p.status,
    createdAt: p.createdAt,
    reviewedAt: p.reviewedAt,
  };
}

// ── Deps 构建 ─────────────────────────────────────────────────────

function buildDeps(projDb: ProjectDatabase, ctx: GrillHandlerContext): GrillSessionDeps {
  return {
    idGenerator: ctx.idGenerator,
    clock: ctx.clock,
    sessionRepo: new GrillSessionRepositoryAdapter(projDb, ctx.clock),
    questionRepo: new GrillQuestionRepositoryAdapter(projDb, ctx.clock),
    answerRepo: new GrillAnswerRepositoryAdapter(projDb, ctx.clock),
    proposalRepo: new GrillProposalRepositoryAdapter(projDb, ctx.clock),
    transaction: <T>(fn: () => T) => projDb.transaction(fn),
  };
}

// ── 处理器 ────────────────────────────────────────────────────────

function handleCreateSession(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (!isValidGrillCreateSessionInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的创建会话输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    const session = createGrillSession(deps, { projectId: payload.projectId, goal: payload.goal });
    return toSessionPublicData(session);
  } finally {
    projDb.close();
  }
}

function handleGetSession(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (!isValidGrillSessionIdInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的会话查询输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    return toSessionPublicData(getGrillSession(deps, { sessionId: payload.sessionId }));
  } finally {
    projDb.close();
  }
}

function handleListSessions(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (typeof payload !== 'object' || payload === null) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的会话列表输入');
  }
  const { projectId } = payload as { projectId?: string };
  if (typeof projectId !== 'string') {
    throw new AppError('GRILL_VALIDATION_ERROR', '缺少 projectId');
  }
  const projDb = ctx.getProjectDb(projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    return listGrillSessions(deps, { projectId }).map(toSessionPublicData);
  } finally {
    projDb.close();
  }
}

function handleSessionTransition(
  payload: unknown,
  ctx: GrillHandlerContext,
  action: 'start' | 'pause' | 'resume' | 'complete' | 'abandon',
): unknown {
  if (!isValidGrillSessionVersionInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的会话操作输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    const input = { sessionId: payload.sessionId, expectedVersion: payload.expectedVersion };
    const fn = {
      start: startGrillSession,
      pause: pauseGrillSession,
      resume: resumeGrillSession,
      complete: completeGrillSession,
      abandon: abandonGrillSession,
    }[action];
    return toSessionPublicData(fn(deps, input));
  } finally {
    projDb.close();
  }
}

function handleAddQuestions(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (!isValidGrillAddQuestionsInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的添加问题输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    const questions = addGrillQuestions(deps, {
      sessionId: payload.sessionId,
      expectedVersion: payload.expectedVersion,
      questions: payload.questions,
    });
    return questions.map(toQuestionPublicData);
  } finally {
    projDb.close();
  }
}

function handleAnswerQuestion(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (!isValidGrillAnswerQuestionInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的回答问题输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    const answer = answerGrillQuestion(deps, {
      sessionId: payload.sessionId,
      expectedVersion: payload.expectedVersion,
      questionId: payload.questionId,
      text: payload.text,
      source: payload.source,
    });
    return toAnswerPublicData(answer);
  } finally {
    projDb.close();
  }
}

function handleSkipQuestion(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (!isValidGrillQuestionActionInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的跳过问题输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    return toQuestionPublicData(
      skipGrillQuestion(deps, {
        sessionId: payload.sessionId,
        expectedVersion: payload.expectedVersion,
        questionId: payload.questionId,
      }),
    );
  } finally {
    projDb.close();
  }
}

function handleSupersedeQuestion(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (!isValidGrillQuestionActionInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的废弃问题输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    return toQuestionPublicData(
      supersedeGrillQuestion(deps, {
        sessionId: payload.sessionId,
        expectedVersion: payload.expectedVersion,
        questionId: payload.questionId,
      }),
    );
  } finally {
    projDb.close();
  }
}

function handleGetCurrentAnswers(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (!isValidGrillSessionIdInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的答案查询输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    return getCurrentAnswers(deps, { sessionId: payload.sessionId }).map(toAnswerPublicData);
  } finally {
    projDb.close();
  }
}

function handleListAnswerHistory(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (!isValidGrillListAnswerHistoryInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的答案历史输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    return listAnswerHistory(deps, {
      sessionId: payload.sessionId,
      questionId: payload.questionId,
    }).map(toAnswerPublicData);
  } finally {
    projDb.close();
  }
}

function handleCreateProposal(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (!isValidGrillCreateProposalInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的创建提案输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    return toProposalPublicData(
      createGrillProposal(deps, {
        sessionId: payload.sessionId,
        expectedVersion: payload.expectedVersion,
        basedOnAnswerIds: payload.basedOnAnswerIds,
        key: payload.key,
        proposedValueJson: payload.proposedValueJson,
        confidence: payload.confidence,
        rationale: payload.rationale,
      }),
    );
  } finally {
    projDb.close();
  }
}

function handleReviewProposal(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (!isValidGrillReviewProposalInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的审核提案输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    return toProposalPublicData(
      reviewGrillProposal(deps, {
        sessionId: payload.sessionId,
        expectedVersion: payload.expectedVersion,
        proposalId: payload.proposalId,
        decision: payload.decision,
      }),
    );
  } finally {
    projDb.close();
  }
}

function handleListProposals(payload: unknown, ctx: GrillHandlerContext): unknown {
  if (!isValidGrillListProposalsInput(payload)) {
    throw new AppError('GRILL_VALIDATION_ERROR', '无效的提案列表输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    const deps = buildDeps(projDb, ctx);
    return listGrillProposals(deps, { sessionId: payload.sessionId }).map(toProposalPublicData);
  } finally {
    projDb.close();
  }
}

// ── 分发 ──────────────────────────────────────────────────────────

export function dispatchGrillCommand(
  command: string,
  payload: unknown,
  ctx: GrillHandlerContext,
): unknown {
  switch (command) {
    case 'grill.createSession':
      return handleCreateSession(payload, ctx);
    case 'grill.getSession':
      return handleGetSession(payload, ctx);
    case 'grill.listSessions':
      return handleListSessions(payload, ctx);
    case 'grill.startSession':
      return handleSessionTransition(payload, ctx, 'start');
    case 'grill.pauseSession':
      return handleSessionTransition(payload, ctx, 'pause');
    case 'grill.resumeSession':
      return handleSessionTransition(payload, ctx, 'resume');
    case 'grill.completeSession':
      return handleSessionTransition(payload, ctx, 'complete');
    case 'grill.abandonSession':
      return handleSessionTransition(payload, ctx, 'abandon');
    case 'grill.addQuestions':
      return handleAddQuestions(payload, ctx);
    case 'grill.answerQuestion':
      return handleAnswerQuestion(payload, ctx);
    case 'grill.skipQuestion':
      return handleSkipQuestion(payload, ctx);
    case 'grill.supersedeQuestion':
      return handleSupersedeQuestion(payload, ctx);
    case 'grill.getCurrentAnswers':
      return handleGetCurrentAnswers(payload, ctx);
    case 'grill.listAnswerHistory':
      return handleListAnswerHistory(payload, ctx);
    case 'grill.createProposal':
      return handleCreateProposal(payload, ctx);
    case 'grill.reviewProposal':
      return handleReviewProposal(payload, ctx);
    case 'grill.listProposals':
      return handleListProposals(payload, ctx);
    default:
      throw new AppError('VALIDATION_ERROR', `未知命令: ${command}`);
  }
}
