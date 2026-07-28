/**
 * Grill-me 领域模型。
 *
 * 纯 TypeScript，不依赖 Electron、Node.js 专有 API 或 SQLite。
 * ID 由调用方注入，domain 不负责随机 ID 生成。
 */

// ── 品牌类型 ──────────────────────────────────────────────────────

export type GrillSessionId = string & { readonly __brand: 'GrillSessionId' };
export type GrillQuestionId = string & { readonly __brand: 'GrillQuestionId' };
export type GrillAnswerId = string & { readonly __brand: 'GrillAnswerId' };
export type GrillProposalId = string & { readonly __brand: 'GrillProposalId' };
export type GrillQuestionPlanProposalId = string & {
  readonly __brand: 'GrillQuestionPlanProposalId';
};

// ── 状态类型 ──────────────────────────────────────────────────────

export type GrillSessionStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABANDONED';

export type GrillQuestionStatus = 'PLANNED' | 'ASKED' | 'ANSWERED' | 'SKIPPED' | 'SUPERSEDED';

export type GrillAnswerSource = 'USER' | 'IMPORTED';

export type GrillProposalStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED';

export type GrillQuestionPlanProposalStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'STALE';

// ── 实体接口 ──────────────────────────────────────────────────────

export interface GrillSession {
  readonly id: GrillSessionId;
  readonly projectId: string;
  readonly status: GrillSessionStatus;
  readonly version: number;
  readonly goal: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly abandonedAt: string | null;
}

export interface GrillQuestion {
  readonly id: GrillQuestionId;
  readonly sessionId: GrillSessionId;
  readonly sequence: number;
  readonly topic: string;
  readonly text: string;
  readonly rationale: string;
  readonly status: GrillQuestionStatus;
  readonly dependsOnQuestionIds: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly askedAt: string | null;
  readonly answeredAt: string | null;
  readonly skippedAt: string | null;
  readonly supersededAt: string | null;
}

export interface GrillAnswer {
  readonly id: GrillAnswerId;
  readonly sessionId: GrillSessionId;
  readonly questionId: GrillQuestionId;
  readonly revision: number;
  readonly source: GrillAnswerSource;
  readonly text: string;
  readonly createdAt: string;
  readonly supersededAt: string | null;
}

export interface GrillInferenceProposal {
  readonly id: GrillProposalId;
  readonly sessionId: GrillSessionId;
  readonly basedOnAnswerIds: ReadonlyArray<string>;
  readonly key: string;
  readonly proposedValueJson: string;
  readonly confidence: number;
  readonly rationale: string;
  readonly status: GrillProposalStatus;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

export interface GrillQuestionPlanProposal {
  readonly id: GrillQuestionPlanProposalId;
  readonly sessionId: GrillSessionId;
  readonly basedOnSessionVersion: number;
  readonly status: GrillQuestionPlanProposalStatus;
  readonly questionsJson: string;
  readonly stopRecommendationJson: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

// ── 会话状态转换 ──────────────────────────────────────────────────

const ALLOWED_SESSION_TRANSITIONS = new Map<GrillSessionStatus, Set<GrillSessionStatus>>([
  ['DRAFT', new Set<GrillSessionStatus>(['ACTIVE', 'ABANDONED'])],
  ['ACTIVE', new Set<GrillSessionStatus>(['PAUSED', 'COMPLETED', 'ABANDONED'])],
  ['PAUSED', new Set<GrillSessionStatus>(['ACTIVE', 'ABANDONED'])],
]);

export function isValidSessionTransition(
  from: GrillSessionStatus,
  to: GrillSessionStatus,
): boolean {
  const allowed = ALLOWED_SESSION_TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

export function assertValidSessionTransition(
  from: GrillSessionStatus,
  to: GrillSessionStatus,
): void {
  if (!isValidSessionTransition(from, to)) {
    throw new Error(`非法烧烤会话状态转换: ${from} -> ${to}`);
  }
}

export function isTerminalSessionStatus(status: GrillSessionStatus): boolean {
  return status === 'COMPLETED' || status === 'ABANDONED';
}

// ── 问题状态转换 ──────────────────────────────────────────────────

const ALLOWED_QUESTION_TRANSITIONS = new Map<GrillQuestionStatus, Set<GrillQuestionStatus>>([
  ['PLANNED', new Set<GrillQuestionStatus>(['ASKED', 'SKIPPED', 'SUPERSEDED'])],
  ['ASKED', new Set<GrillQuestionStatus>(['ANSWERED', 'SKIPPED', 'SUPERSEDED'])],
  ['ANSWERED', new Set<GrillQuestionStatus>(['SUPERSEDED'])],
]);

export function isValidQuestionTransition(
  from: GrillQuestionStatus,
  to: GrillQuestionStatus,
): boolean {
  const allowed = ALLOWED_QUESTION_TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

export function assertValidQuestionTransition(
  from: GrillQuestionStatus,
  to: GrillQuestionStatus,
): void {
  if (!isValidQuestionTransition(from, to)) {
    throw new Error(`非法烧烤问题状态转换: ${from} -> ${to}`);
  }
}

export function isTerminalQuestionStatus(status: GrillQuestionStatus): boolean {
  return status === 'SKIPPED' || status === 'SUPERSEDED';
}

// ── 提案状态转换 ──────────────────────────────────────────────────

const ALLOWED_PROPOSAL_TRANSITIONS = new Map<GrillProposalStatus, Set<GrillProposalStatus>>([
  ['PROPOSED', new Set<GrillProposalStatus>(['ACCEPTED', 'REJECTED', 'SUPERSEDED'])],
]);

export function isValidProposalTransition(
  from: GrillProposalStatus,
  to: GrillProposalStatus,
): boolean {
  const allowed = ALLOWED_PROPOSAL_TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

export function assertValidProposalTransition(
  from: GrillProposalStatus,
  to: GrillProposalStatus,
): void {
  if (!isValidProposalTransition(from, to)) {
    throw new Error(`非法推理提案状态转换: ${from} -> ${to}`);
  }
}

export function isTerminalProposalStatus(status: GrillProposalStatus): boolean {
  return status === 'ACCEPTED' || status === 'REJECTED' || status === 'SUPERSEDED';
}

// ── 验证函数 ──────────────────────────────────────────────────────

export function createGrillSessionId(raw: string): GrillSessionId {
  if (!raw || raw.trim().length === 0) {
    throw new Error('GrillSessionId 不能为空');
  }
  return raw as GrillSessionId;
}

export function createGrillQuestionId(raw: string): GrillQuestionId {
  if (!raw || raw.trim().length === 0) {
    throw new Error('GrillQuestionId 不能为空');
  }
  return raw as GrillQuestionId;
}

export function createGrillAnswerId(raw: string): GrillAnswerId {
  if (!raw || raw.trim().length === 0) {
    throw new Error('GrillAnswerId 不能为空');
  }
  return raw as GrillAnswerId;
}

export function createGrillProposalId(raw: string): GrillProposalId {
  if (!raw || raw.trim().length === 0) {
    throw new Error('GrillProposalId 不能为空');
  }
  return raw as GrillProposalId;
}
