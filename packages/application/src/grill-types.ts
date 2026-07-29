/**
 * Grill-me 应用层端口接口。
 *
 * 应用用例通过这些接口与基础设施交互，
 * 不依赖 Electron、React 或 node:sqlite。
 */

import type {
  GrillSessionStatus,
  GrillQuestionStatus,
  GrillAnswerSource,
  GrillProposalStatus,
  GrillQuestionPlanProposalStatus,
} from '@ai-novel/domain';

// ── 数据接口 ──────────────────────────────────────────────────────

export interface GrillSessionData {
  readonly id: string;
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

export interface GrillQuestionData {
  readonly id: string;
  readonly sessionId: string;
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

export interface GrillAnswerData {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly revision: number;
  readonly source: GrillAnswerSource;
  readonly text: string;
  readonly createdAt: string;
  readonly supersededAt: string | null;
}

export interface GrillProposalData {
  readonly id: string;
  readonly sessionId: string;
  readonly basedOnAnswerIds: ReadonlyArray<string>;
  readonly key: string;
  readonly proposedValueJson: string;
  readonly confidence: number;
  readonly rationale: string;
  readonly status: GrillProposalStatus;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

// ── 创建输入 ──────────────────────────────────────────────────────

export interface CreateGrillSessionInput {
  readonly id: string;
  readonly projectId: string;
  readonly goal: string;
}

export interface CreateGrillQuestionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly topic: string;
  readonly text: string;
  readonly rationale: string;
  readonly dependsOnQuestionIds: ReadonlyArray<string>;
}

export interface CreateGrillAnswerInput {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly revision: number;
  readonly source: GrillAnswerSource;
  readonly text: string;
}

export interface CreateGrillProposalInput {
  readonly id: string;
  readonly sessionId: string;
  readonly basedOnAnswerIds: ReadonlyArray<string>;
  readonly key: string;
  readonly proposedValueJson: string;
  readonly confidence: number;
  readonly rationale: string;
}

// ── 仓库端口 ──────────────────────────────────────────────────────

export interface GrillSessionRepositoryPort {
  create(data: CreateGrillSessionInput): void;
  getById(id: string): GrillSessionData | null;
  listByProject(projectId: string): ReadonlyArray<GrillSessionData>;
  transitionStatus(id: string, expectedVersion: number, newStatus: GrillSessionStatus): boolean;
  bumpVersion(id: string, expectedVersion: number): boolean;
}

export interface GrillQuestionRepositoryPort {
  create(data: CreateGrillQuestionInput): void;
  getById(id: string): GrillQuestionData | null;
  listBySession(sessionId: string): ReadonlyArray<GrillQuestionData>;
  markAsked(id: string): boolean;
  markAnswered(id: string): boolean;
  markSkipped(id: string): boolean;
  markSuperseded(id: string): boolean;
  getMaxSequence(sessionId: string): number;
}

export interface GrillAnswerRepositoryPort {
  create(data: CreateGrillAnswerInput): void;
  getById(id: string): GrillAnswerData | null;
  getCurrentByQuestion(questionId: string): GrillAnswerData | null;
  listByQuestion(questionId: string): ReadonlyArray<GrillAnswerData>;
  listCurrentBySession(sessionId: string): ReadonlyArray<GrillAnswerData>;
  supersedeCurrent(questionId: string): boolean;
}

export interface GrillProposalRepositoryPort {
  create(data: CreateGrillProposalInput): void;
  getById(id: string): GrillProposalData | null;
  listBySession(sessionId: string): ReadonlyArray<GrillProposalData>;
  markAccepted(id: string): boolean;
  markRejected(id: string): boolean;
  markSuperseded(id: string): boolean;
}

// ── 问题规划提案端口 ──────────────────────────────────────────────

export interface GrillQuestionPlanProposalData {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly baseSessionVersion: number;
  readonly schemaVersion: number;
  readonly questionsJson: string;
  readonly status: GrillQuestionPlanProposalStatus;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

export interface CreateGrillQuestionPlanProposalInput {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly baseSessionVersion: number;
  readonly schemaVersion: number;
  readonly questionsJson: string;
}

export interface GrillQuestionPlanProposalRepositoryPort {
  create(data: CreateGrillQuestionPlanProposalInput): void;
  getById(id: string): GrillQuestionPlanProposalData | null;
  listBySession(sessionId: string): ReadonlyArray<GrillQuestionPlanProposalData>;
  markAccepted(id: string): boolean;
  markRejected(id: string): boolean;
  markStale(id: string): boolean;
}
