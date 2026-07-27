/**
 * Grill-me 会话用例。
 *
 * 所有操作通过端口接口与基础设施交互。
 * 事务性操作通过 deps.transaction 保证原子性。
 *
 * 完整性规则：
 * - 子实体（question/answer/proposal）必须归属于输入指定的 session；
 * - 只有 PLANNED/ASKED/ANSWERED 状态的问题可回答，SKIPPED/SUPERSEDED 拒绝；
 * - 每个问题至多一个 current answer（数据库 partial unique index 兜底）；
 * - proposal 必须基于存在、归属本会话、未废弃的答案；
 * - 问题依赖必须归属本会话或同批次，禁止自引用与批次内二元环。
 */

import {
  assertValidSessionTransition,
  isTerminalSessionStatus,
  type GrillSessionStatus,
  type GrillQuestionStatus,
  type GrillAnswerSource,
} from '@ai-novel/domain';
import type { IdGenerator, Clock } from './types.js';
import type {
  GrillSessionRepositoryPort,
  GrillQuestionRepositoryPort,
  GrillAnswerRepositoryPort,
  GrillProposalRepositoryPort,
  GrillSessionData,
  GrillQuestionData,
  GrillAnswerData,
  GrillProposalData,
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

// ── 依赖 ──────────────────────────────────────────────────────────

export interface GrillSessionDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly sessionRepo: GrillSessionRepositoryPort;
  readonly questionRepo: GrillQuestionRepositoryPort;
  readonly answerRepo: GrillAnswerRepositoryPort;
  readonly proposalRepo: GrillProposalRepositoryPort;
  readonly transaction: <T>(fn: () => T) => T;
}

// ── 辅助函数 ──────────────────────────────────────────────────────

function requireCas(updated: boolean, message: string): void {
  if (!updated) {
    throw new GrillVersionConflictError(message);
  }
}

function getSessionOrThrow(deps: GrillSessionDeps, sessionId: string): GrillSessionData {
  const session = deps.sessionRepo.getById(sessionId);
  if (!session) {
    throw new GrillSessionNotFoundError(sessionId);
  }
  return session;
}

function assertSessionActive(session: GrillSessionData): void {
  if (session.status !== 'ACTIVE') {
    throw new GrillStateConflictError(
      `会话 ${session.id} 当前状态为 ${session.status}，需要 ACTIVE`,
    );
  }
}

function assertQuestionBelongsToSession(question: GrillQuestionData, sessionId: string): void {
  if (question.sessionId !== sessionId) {
    throw new GrillOwnershipConflictError(`问题 ${question.id} 不属于会话 ${sessionId}`);
  }
}

function assertProposalBelongsToSession(proposal: GrillProposalData, sessionId: string): void {
  if (proposal.sessionId !== sessionId) {
    throw new GrillOwnershipConflictError(`提案 ${proposal.id} 不属于会话 ${sessionId}`);
  }
}

function assertAnswerBelongsToSession(answer: GrillAnswerData, sessionId: string): void {
  if (answer.sessionId !== sessionId) {
    throw new GrillOwnershipConflictError(`回答 ${answer.id} 不属于会话 ${sessionId}`);
  }
}

/** 可回答的问题状态：PLANNED（直接回答）、ASKED、ANSWERED（新增修订） */
const ANSWERABLE_QUESTION_STATUSES: ReadonlySet<GrillQuestionStatus> = new Set([
  'PLANNED',
  'ASKED',
  'ANSWERED',
]);

// ── 会话管理 ──────────────────────────────────────────────────────

export function createGrillSession(
  deps: GrillSessionDeps,
  input: { projectId: string; goal: string },
): GrillSessionData {
  const trimmedGoal = input.goal.trim();
  if (trimmedGoal.length === 0) {
    throw new GrillValidationError('会话目标不能为空');
  }

  const id = deps.idGenerator.generate();

  deps.sessionRepo.create({ id, projectId: input.projectId, goal: trimmedGoal });

  const session = deps.sessionRepo.getById(id);
  if (!session) throw new GrillSessionNotFoundError(id);
  return session;
}

export function getGrillSession(
  deps: GrillSessionDeps,
  input: { sessionId: string },
): GrillSessionData {
  return getSessionOrThrow(deps, input.sessionId);
}

export function listGrillSessions(
  deps: GrillSessionDeps,
  input: { projectId: string },
): ReadonlyArray<GrillSessionData> {
  return deps.sessionRepo.listByProject(input.projectId);
}

function transitionSession(
  deps: GrillSessionDeps,
  input: { sessionId: string; expectedVersion: number },
  targetStatus: GrillSessionStatus,
): GrillSessionData {
  const session = getSessionOrThrow(deps, input.sessionId);
  assertValidSessionTransition(session.status, targetStatus);

  const ok = deps.sessionRepo.transitionStatus(
    input.sessionId,
    input.expectedVersion,
    targetStatus,
  );
  requireCas(ok, `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedVersion}）`);

  return getSessionOrThrow(deps, input.sessionId);
}

export function startGrillSession(
  deps: GrillSessionDeps,
  input: { sessionId: string; expectedVersion: number },
): GrillSessionData {
  return transitionSession(deps, input, 'ACTIVE');
}

export function pauseGrillSession(
  deps: GrillSessionDeps,
  input: { sessionId: string; expectedVersion: number },
): GrillSessionData {
  return transitionSession(deps, input, 'PAUSED');
}

export function resumeGrillSession(
  deps: GrillSessionDeps,
  input: { sessionId: string; expectedVersion: number },
): GrillSessionData {
  return transitionSession(deps, input, 'ACTIVE');
}

export function completeGrillSession(
  deps: GrillSessionDeps,
  input: { sessionId: string; expectedVersion: number },
): GrillSessionData {
  return transitionSession(deps, input, 'COMPLETED');
}

export function abandonGrillSession(
  deps: GrillSessionDeps,
  input: { sessionId: string; expectedVersion: number },
): GrillSessionData {
  return transitionSession(deps, input, 'ABANDONED');
}

// ── 问题管理 ──────────────────────────────────────────────────────

export interface AddGrillQuestionsInput {
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly questions: ReadonlyArray<{
    /** 可选调用方指定 ID；用于批次内依赖引用。未提供时自动生成。 */
    id?: string;
    topic: string;
    text: string;
    rationale: string;
    dependsOnQuestionIds: ReadonlyArray<string>;
  }>;
}

export function addGrillQuestions(
  deps: GrillSessionDeps,
  input: AddGrillQuestionsInput,
): ReadonlyArray<GrillQuestionData> {
  const session = getSessionOrThrow(deps, input.sessionId);
  assertSessionActive(session);

  if (input.questions.length === 0) {
    throw new GrillValidationError('问题列表不能为空');
  }

  // 解析 ID（调用方指定或自动生成），检测批次内 ID 重复
  const resolvedIds: string[] = [];
  const batchIdSet = new Set<string>();
  for (let i = 0; i < input.questions.length; i++) {
    const q = input.questions[i];
    if (!q.topic.trim() || !q.text.trim()) {
      throw new GrillValidationError(`第 ${i + 1} 个问题的主题和文本不能为空`);
    }

    let id: string;
    if (q.id !== undefined) {
      if (q.id.trim().length === 0) {
        throw new GrillValidationError(`第 ${i + 1} 个问题的 ID 不能为空`);
      }
      id = q.id;
    } else {
      id = deps.idGenerator.generate();
    }

    if (batchIdSet.has(id)) {
      throw new GrillValidationError(`批次内问题 ID 重复: ${id}`);
    }
    batchIdSet.add(id);
    resolvedIds.push(id);
  }

  // 依赖完整性校验
  for (let i = 0; i < input.questions.length; i++) {
    const q = input.questions[i];
    const ownId = resolvedIds[i];
    const depSet = new Set<string>();

    for (const dep of q.dependsOnQuestionIds) {
      if (!dep || dep.trim().length === 0) {
        throw new GrillValidationError(`问题 ${ownId} 的依赖包含空 ID`);
      }
      if (depSet.has(dep)) {
        throw new GrillValidationError(`问题 ${ownId} 的依赖包含重复 ID: ${dep}`);
      }
      depSet.add(dep);

      if (dep === ownId) {
        throw new GrillValidationError(`问题 ${ownId} 不能依赖自己`);
      }

      // 批次内引用：允许，留待环检测
      if (batchIdSet.has(dep)) {
        continue;
      }

      // 批次外引用：必须是本会话已存在的问题
      const existing = deps.questionRepo.getById(dep);
      if (!existing) {
        throw new GrillValidationError(`问题 ${ownId} 依赖了不存在的问题: ${dep}`);
      }
      assertQuestionBelongsToSession(existing, input.sessionId);
    }
  }

  // 有限环检测：禁止批次内直接二元环（A->B 且 B->A）。
  // TECH DEBT: 完整环检测（拓扑排序/DFS）未实现；当前仅覆盖自引用与二元环。
  const batchInternalDeps = new Map<string, Set<string>>();
  for (let i = 0; i < input.questions.length; i++) {
    const internal = new Set<string>();
    for (const dep of input.questions[i].dependsOnQuestionIds) {
      if (batchIdSet.has(dep)) internal.add(dep);
    }
    batchInternalDeps.set(resolvedIds[i], internal);
  }
  for (const [id, depsOfId] of batchInternalDeps) {
    for (const dep of depsOfId) {
      if (batchInternalDeps.get(dep)?.has(id)) {
        throw new GrillValidationError(`问题依赖存在循环: ${id} <-> ${dep}`);
      }
    }
  }

  const createdIds: string[] = [];

  deps.transaction(() => {
    const maxSeq = deps.questionRepo.getMaxSequence(input.sessionId);

    for (let i = 0; i < input.questions.length; i++) {
      const q = input.questions[i];
      deps.questionRepo.create({
        id: resolvedIds[i],
        sessionId: input.sessionId,
        sequence: maxSeq + 1 + i,
        topic: q.topic.trim(),
        text: q.text.trim(),
        rationale: q.rationale,
        dependsOnQuestionIds: q.dependsOnQuestionIds,
      });
      createdIds.push(resolvedIds[i]);
    }

    requireCas(
      deps.sessionRepo.bumpVersion(input.sessionId, input.expectedVersion),
      `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedVersion}）`,
    );
  });

  return createdIds
    .map((id) => deps.questionRepo.getById(id))
    .filter((q): q is GrillQuestionData => q !== null);
}

export function markQuestionAsked(
  deps: GrillSessionDeps,
  input: { sessionId: string; expectedVersion: number; questionId: string },
): GrillQuestionData {
  const session = getSessionOrThrow(deps, input.sessionId);
  assertSessionActive(session);

  const question = deps.questionRepo.getById(input.questionId);
  if (!question) throw new GrillQuestionNotFoundError(input.questionId);
  assertQuestionBelongsToSession(question, input.sessionId);

  deps.transaction(() => {
    requireCas(
      deps.questionRepo.markAsked(input.questionId),
      `问题 ${input.questionId} 状态冲突（当前 ${question.status}）`,
    );
    requireCas(
      deps.sessionRepo.bumpVersion(input.sessionId, input.expectedVersion),
      `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedVersion}）`,
    );
  });

  const updated = deps.questionRepo.getById(input.questionId);
  if (!updated) throw new GrillQuestionNotFoundError(input.questionId);
  return updated;
}

// ── 回答管理 ──────────────────────────────────────────────────────

export interface AnswerGrillQuestionInput {
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly questionId: string;
  readonly text: string;
  readonly source: GrillAnswerSource;
}

export function answerGrillQuestion(
  deps: GrillSessionDeps,
  input: AnswerGrillQuestionInput,
): GrillAnswerData {
  const session = getSessionOrThrow(deps, input.sessionId);
  assertSessionActive(session);

  const trimmedText = input.text.trim();
  if (trimmedText.length === 0) {
    throw new GrillValidationError('回答内容不能为空');
  }

  // 事务前快速失败：存在性 + 归属
  const preQuestion = deps.questionRepo.getById(input.questionId);
  if (!preQuestion) throw new GrillQuestionNotFoundError(input.questionId);
  assertQuestionBelongsToSession(preQuestion, input.sessionId);

  const answerId = deps.idGenerator.generate();

  deps.transaction(() => {
    // 1. 事务内重新读取问题，避免使用事务外陈旧状态
    const question = deps.questionRepo.getById(input.questionId);
    if (!question) throw new GrillQuestionNotFoundError(input.questionId);

    // 2. 验证归属
    assertQuestionBelongsToSession(question, input.sessionId);

    // 3. 验证状态可回答（SKIPPED/SUPERSEDED 拒绝）
    if (!ANSWERABLE_QUESTION_STATUSES.has(question.status)) {
      throw new GrillStateConflictError(
        `问题 ${input.questionId} 当前状态为 ${question.status}，不能回答`,
      );
    }

    // 4. 废弃当前答案。首次回答无旧答案时返回 false 属正常。
    const hadCurrent = deps.answerRepo.supersedeCurrent(input.questionId);

    // 数据一致性：ANSWERED 状态的问题必须存在当前答案
    if (question.status === 'ANSWERED' && !hadCurrent) {
      throw new GrillStateConflictError(
        `问题 ${input.questionId} 状态为 ANSWERED 但缺少当前答案，数据不一致`,
      );
    }

    // 5. 计算下一个 revision
    const history = deps.answerRepo.listByQuestion(input.questionId);
    const maxRevision = history.length > 0 ? Math.max(...history.map((a) => a.revision)) : 0;

    // 6. 插入新答案
    deps.answerRepo.create({
      id: answerId,
      sessionId: input.sessionId,
      questionId: input.questionId,
      revision: maxRevision + 1,
      source: input.source,
      text: trimmedText,
    });

    // 7. 必要时转换问题状态至 ANSWERED
    if (question.status === 'PLANNED') {
      requireCas(
        deps.questionRepo.markAsked(input.questionId),
        `问题 ${input.questionId} 状态冲突`,
      );
      requireCas(
        deps.questionRepo.markAnswered(input.questionId),
        `问题 ${input.questionId} 状态冲突`,
      );
    } else if (question.status === 'ASKED') {
      requireCas(
        deps.questionRepo.markAnswered(input.questionId),
        `问题 ${input.questionId} 状态冲突`,
      );
    }
    // ANSWERED -> ANSWERED：仅新增修订，不转换状态

    // 8. 会话版本 CAS
    requireCas(
      deps.sessionRepo.bumpVersion(input.sessionId, input.expectedVersion),
      `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedVersion}）`,
    );
  });

  const answer = deps.answerRepo.getById(answerId);
  if (!answer) throw new GrillValidationError('回答创建失败');
  return answer;
}

export function skipGrillQuestion(
  deps: GrillSessionDeps,
  input: { sessionId: string; expectedVersion: number; questionId: string },
): GrillQuestionData {
  const session = getSessionOrThrow(deps, input.sessionId);
  assertSessionActive(session);

  const question = deps.questionRepo.getById(input.questionId);
  if (!question) throw new GrillQuestionNotFoundError(input.questionId);
  assertQuestionBelongsToSession(question, input.sessionId);

  deps.transaction(() => {
    requireCas(
      deps.questionRepo.markSkipped(input.questionId),
      `问题 ${input.questionId} 状态冲突（当前 ${question.status}）`,
    );
    requireCas(
      deps.sessionRepo.bumpVersion(input.sessionId, input.expectedVersion),
      `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedVersion}）`,
    );
  });

  const updated = deps.questionRepo.getById(input.questionId);
  if (!updated) throw new GrillQuestionNotFoundError(input.questionId);
  return updated;
}

export function supersedeGrillQuestion(
  deps: GrillSessionDeps,
  input: { sessionId: string; expectedVersion: number; questionId: string },
): GrillQuestionData {
  const session = getSessionOrThrow(deps, input.sessionId);
  assertSessionActive(session);

  const question = deps.questionRepo.getById(input.questionId);
  if (!question) throw new GrillQuestionNotFoundError(input.questionId);
  assertQuestionBelongsToSession(question, input.sessionId);

  deps.transaction(() => {
    requireCas(
      deps.questionRepo.markSuperseded(input.questionId),
      `问题 ${input.questionId} 状态冲突（当前 ${question.status}）`,
    );
    requireCas(
      deps.sessionRepo.bumpVersion(input.sessionId, input.expectedVersion),
      `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedVersion}）`,
    );
  });

  const updated = deps.questionRepo.getById(input.questionId);
  if (!updated) throw new GrillQuestionNotFoundError(input.questionId);
  return updated;
}

export function getCurrentAnswers(
  deps: GrillSessionDeps,
  input: { sessionId: string },
): ReadonlyArray<GrillAnswerData> {
  getSessionOrThrow(deps, input.sessionId);
  return deps.answerRepo.listCurrentBySession(input.sessionId);
}

export function listAnswerHistory(
  deps: GrillSessionDeps,
  input: { sessionId: string; questionId: string },
): ReadonlyArray<GrillAnswerData> {
  getSessionOrThrow(deps, input.sessionId);
  const question = deps.questionRepo.getById(input.questionId);
  if (!question) throw new GrillQuestionNotFoundError(input.questionId);
  assertQuestionBelongsToSession(question, input.sessionId);
  return deps.answerRepo.listByQuestion(input.questionId);
}

// ── 推理提案管理 ──────────────────────────────────────────────────

export interface CreateGrillProposalInput2 {
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly basedOnAnswerIds: ReadonlyArray<string>;
  readonly key: string;
  readonly proposedValueJson: string;
  readonly confidence: number;
  readonly rationale: string;
}

export function createGrillProposal(
  deps: GrillSessionDeps,
  input: CreateGrillProposalInput2,
): GrillProposalData {
  const session = getSessionOrThrow(deps, input.sessionId);
  if (isTerminalSessionStatus(session.status)) {
    throw new GrillStateConflictError(`会话 ${input.sessionId} 已终结，不能创建提案`);
  }

  if (!input.key.trim()) {
    throw new GrillValidationError('提案 key 不能为空');
  }

  try {
    JSON.parse(input.proposedValueJson);
  } catch {
    throw new GrillValidationError('proposedValueJson 必须是有效 JSON');
  }

  if (input.confidence < 0 || input.confidence > 1) {
    throw new GrillValidationError('confidence 必须在 0 到 1 之间');
  }

  // 依据完整性：basedOnAnswerIds 非空、无重复、存在、归属本会话、未废弃
  if (input.basedOnAnswerIds.length === 0) {
    throw new GrillValidationError('basedOnAnswerIds 不能为空');
  }
  const seenAnswerIds = new Set<string>();
  for (const answerId of input.basedOnAnswerIds) {
    if (!answerId || answerId.trim().length === 0) {
      throw new GrillValidationError('basedOnAnswerIds 包含空 ID');
    }
    if (seenAnswerIds.has(answerId)) {
      throw new GrillValidationError(`basedOnAnswerIds 包含重复 ID: ${answerId}`);
    }
    seenAnswerIds.add(answerId);

    const answer = deps.answerRepo.getById(answerId);
    if (!answer) {
      throw new GrillValidationError(`basedOnAnswerIds 引用了不存在的回答: ${answerId}`);
    }
    assertAnswerBelongsToSession(answer, input.sessionId);
    if (answer.supersededAt !== null) {
      throw new GrillValidationError(`basedOnAnswerIds 引用了已废弃的回答: ${answerId}`);
    }
  }

  const id = deps.idGenerator.generate();

  deps.transaction(() => {
    deps.proposalRepo.create({
      id,
      sessionId: input.sessionId,
      basedOnAnswerIds: input.basedOnAnswerIds,
      key: input.key.trim(),
      proposedValueJson: input.proposedValueJson,
      confidence: input.confidence,
      rationale: input.rationale,
    });

    requireCas(
      deps.sessionRepo.bumpVersion(input.sessionId, input.expectedVersion),
      `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedVersion}）`,
    );
  });

  const proposal = deps.proposalRepo.getById(id);
  if (!proposal) throw new GrillValidationError('提案创建失败');
  return proposal;
}

export interface ReviewGrillProposalInput {
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly proposalId: string;
  readonly decision: 'ACCEPTED' | 'REJECTED';
}

export function reviewGrillProposal(
  deps: GrillSessionDeps,
  input: ReviewGrillProposalInput,
): GrillProposalData {
  const session = getSessionOrThrow(deps, input.sessionId);
  assertSessionActive(session);

  const proposal = deps.proposalRepo.getById(input.proposalId);
  if (!proposal) throw new GrillProposalNotFoundError(input.proposalId);
  assertProposalBelongsToSession(proposal, input.sessionId);

  if (proposal.status !== 'PROPOSED') {
    throw new GrillStateConflictError(
      `提案 ${input.proposalId} 当前状态为 ${proposal.status}，不能审核`,
    );
  }

  deps.transaction(() => {
    const ok =
      input.decision === 'ACCEPTED'
        ? deps.proposalRepo.markAccepted(input.proposalId)
        : deps.proposalRepo.markRejected(input.proposalId);
    requireCas(ok, `提案 ${input.proposalId} 状态冲突`);

    requireCas(
      deps.sessionRepo.bumpVersion(input.sessionId, input.expectedVersion),
      `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedVersion}）`,
    );
  });

  const updated = deps.proposalRepo.getById(input.proposalId);
  if (!updated) throw new GrillProposalNotFoundError(input.proposalId);
  return updated;
}

export function listGrillProposals(
  deps: GrillSessionDeps,
  input: { sessionId: string },
): ReadonlyArray<GrillProposalData> {
  getSessionOrThrow(deps, input.sessionId);
  return deps.proposalRepo.listBySession(input.sessionId);
}
