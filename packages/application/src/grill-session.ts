/**
 * Grill-me 会话用例。
 *
 * 所有操作通过端口接口与基础设施交互。
 * 事务性操作通过 deps.transaction 保证原子性。
 */

import {
  assertValidSessionTransition,
  isTerminalSessionStatus,
  type GrillSessionStatus,
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
    throw new GrillStateConflictError(`会话 ${session.id} 当前状态为 ${session.status}，需要 ACTIVE`);
  }
}

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

  const createdIds: string[] = [];

  deps.transaction(() => {
    const maxSeq = deps.questionRepo.getMaxSequence(input.sessionId);

    for (let i = 0; i < input.questions.length; i++) {
      const q = input.questions[i];
      if (!q.topic.trim() || !q.text.trim()) {
        throw new GrillValidationError(`第 ${i + 1} 个问题的主题和文本不能为空`);
      }

      const id = deps.idGenerator.generate();
      createdIds.push(id);

      deps.questionRepo.create({
        id,
        sessionId: input.sessionId,
        sequence: maxSeq + 1 + i,
        topic: q.topic.trim(),
        text: q.text.trim(),
        rationale: q.rationale,
        dependsOnQuestionIds: q.dependsOnQuestionIds,
      });
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

  const question = deps.questionRepo.getById(input.questionId);
  if (!question) throw new GrillQuestionNotFoundError(input.questionId);

  const answerId = deps.idGenerator.generate();

  deps.transaction(() => {
    // 废弃旧答案（如果存在）
    deps.answerRepo.supersedeCurrent(input.questionId);

    // 计算新 revision
    const history = deps.answerRepo.listByQuestion(input.questionId);
    const maxRevision = history.length > 0 ? Math.max(...history.map((a) => a.revision)) : 0;

    // 插入新答案
    deps.answerRepo.create({
      id: answerId,
      sessionId: input.sessionId,
      questionId: input.questionId,
      revision: maxRevision + 1,
      source: input.source,
      text: trimmedText,
    });

    // 问题状态 -> ANSWERED（如果当前是 ASKED）
    if (question.status === 'ASKED' || question.status === 'PLANNED') {
      if (question.status === 'PLANNED') {
        requireCas(
          deps.questionRepo.markAsked(input.questionId),
          `问题 ${input.questionId} 状态冲突`,
        );
      }
      requireCas(
        deps.questionRepo.markAnswered(input.questionId),
        `问题 ${input.questionId} 状态冲突`,
      );
    }

    // 会话版本递增
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
  input: { questionId: string },
): ReadonlyArray<GrillAnswerData> {
  const question = deps.questionRepo.getById(input.questionId);
  if (!question) throw new GrillQuestionNotFoundError(input.questionId);
  return deps.answerRepo.listByQuestion(input.questionId);
}

// ── 推理提案管理 ──────────────────────────────────────────────────

export interface CreateGrillProposalInput2 {
  readonly sessionId: string;
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

  const id = deps.idGenerator.generate();
  deps.proposalRepo.create({
    id,
    sessionId: input.sessionId,
    basedOnAnswerIds: input.basedOnAnswerIds,
    key: input.key.trim(),
    proposedValueJson: input.proposedValueJson,
    confidence: input.confidence,
    rationale: input.rationale,
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

  if (proposal.status !== 'PROPOSED') {
    throw new GrillStateConflictError(`提案 ${input.proposalId} 当前状态为 ${proposal.status}，不能审核`);
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
