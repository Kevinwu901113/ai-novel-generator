/**
 * Grill-me 问题规划器用例。
 *
 * AI 只生成“问题计划提案”，不直接创建/修改正式问题。
 * - requestGrillQuestionPlan：验证会话并创建去重的规划任务（不含模型结果）。
 * - acceptGrillQuestionPlanProposal：显式接受提案，事务内重新验证并创建正式问题。
 * - get/list：读取提案（供后续审查）。
 *
 * 所有正式实体字段（id/sequence/status/version 等）由应用层生成，模型不控制。
 */

import {
  GRILL_QUESTION_PLAN_SCHEMA_VERSION,
  parseQuestionPlanV1,
  validatePlanReferences,
  validateExistingGraphIntegrity,
  topologicalPlanOrder,
  type NormalizedQuestionPlan,
  type PlanParseResult,
} from '@ai-novel/domain';
import type { IdGenerator, Clock, TaskRepositoryPort } from './types.js';
import type {
  GrillSessionRepositoryPort,
  GrillQuestionRepositoryPort,
  GrillQuestionPlanProposalRepositoryPort,
  GrillSessionData,
  GrillQuestionData,
  GrillQuestionPlanProposalData,
} from './grill-types.js';
import {
  AppError,
  GrillValidationError,
  GrillSessionNotFoundError,
  GrillStateConflictError,
  GrillVersionConflictError,
  GrillOwnershipConflictError,
  GrillPlanAlreadyRunningError,
  GrillPlanStaleError,
  GrillPlanSchemaInvalidError,
  GrillPlanReferenceInvalidError,
  GrillPlanCycleDetectedError,
  GrillPlanProposalNotFoundError,
  GrillPlanProposalNotAcceptableError,
  TaskDedupeConflictError,
} from './errors.js';

// ── 依赖 ──────────────────────────────────────────────────────────

export interface GrillQuestionPlanDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly sessionRepo: GrillSessionRepositoryPort;
  readonly questionRepo: GrillQuestionRepositoryPort;
  readonly planProposalRepo: GrillQuestionPlanProposalRepositoryPort;
  readonly transaction: <T>(fn: () => T) => T;
}

export interface GrillQuestionPlanRequestDeps extends GrillQuestionPlanDeps {
  readonly taskRepo: TaskRepositoryPort;
}

// ── 辅助 ──────────────────────────────────────────────────────────

function requireCas(updated: boolean, message: string): void {
  if (!updated) {
    throw new GrillVersionConflictError(message);
  }
}

function assertSessionOwnership(session: GrillSessionData, projectId: string): void {
  if (session.projectId !== projectId) {
    throw new GrillOwnershipConflictError(`会话 ${session.id} 不属于项目 ${projectId}`);
  }
}

/** 从已有问题构建依赖图：问题 ID → 其依赖的问题 ID 列表 */
export function existingDepsFromQuestions(
  questions: ReadonlyArray<{
    readonly id: string;
    readonly dependsOnQuestionIds: ReadonlyArray<string>;
  }>,
): Map<string, ReadonlyArray<string>> {
  const map = new Map<string, ReadonlyArray<string>>();
  for (const q of questions) {
    map.set(q.id, q.dependsOnQuestionIds);
  }
  return map;
}

function mapPlanError(result: { readonly code: string; readonly message: string }): AppError {
  switch (result.code) {
    case 'GRILL_PLAN_SCHEMA_INVALID':
      return new GrillPlanSchemaInvalidError(result.message);
    case 'GRILL_PLAN_REFERENCE_INVALID':
      return new GrillPlanReferenceInvalidError(result.message);
    case 'GRILL_PLAN_CYCLE_DETECTED':
      return new GrillPlanCycleDetectedError(result.message);
    default:
      return new GrillPlanSchemaInvalidError(result.message);
  }
}

/**
 * 对已持久化的计划重新执行完整验证：结构 schema、引用完整性、完整依赖图环检测。
 *
 * 不信任提案创建阶段的历史验证结果；接受前必须基于当前会话状态再次验证。
 */
export function validateStoredPlan(
  questionsJson: string,
  existingQuestions: ReadonlyArray<GrillQuestionData>,
): { readonly plan: NormalizedQuestionPlan; readonly plannedOrder: ReadonlyArray<string> } {
  const parsed: PlanParseResult = parseQuestionPlanV1(questionsJson);
  if (!parsed.ok) {
    throw mapPlanError(parsed);
  }

  const existingIds = new Set(existingQuestions.map((q) => q.id));
  const refs = validatePlanReferences(parsed.plan, existingIds);
  if (!refs.ok) {
    throw mapPlanError(refs);
  }

  const existingDeps = existingDepsFromQuestions(existingQuestions);
  const integrity = validateExistingGraphIntegrity(existingDeps);
  if (!integrity.ok) {
    throw mapPlanError(integrity);
  }

  const order = topologicalPlanOrder(parsed.plan, existingDeps);
  if (!order.ok) {
    throw new GrillPlanCycleDetectedError(order.message);
  }

  return { plan: parsed.plan, plannedOrder: order.plannedOrder };
}

// ── 请求规划任务 ──────────────────────────────────────────────────

export interface RequestGrillQuestionPlanInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedSessionVersion: number;
  readonly providerProfileId: string;
}

export interface RequestGrillQuestionPlanResult {
  readonly taskId: string;
  readonly sessionId: string;
  readonly baseSessionVersion: number;
}

/**
 * 创建一个 Grill 问题规划任务。
 *
 * 验证：项目内会话存在、归属、版本匹配、状态允许规划（ACTIVE）。
 * 去重：同一 session + base version 至多一个 PENDING/RUNNING 任务，
 * 由数据库 partial unique index（dedupe_key）原子保证，非先查后插。
 *
 * 返回的 taskId 不包含任何模型结果。
 */
export function requestGrillQuestionPlan(
  deps: GrillQuestionPlanRequestDeps,
  input: RequestGrillQuestionPlanInput,
): RequestGrillQuestionPlanResult {
  const session = deps.sessionRepo.getById(input.sessionId);
  if (!session) {
    throw new GrillSessionNotFoundError(input.sessionId);
  }
  assertSessionOwnership(session, input.projectId);

  if (session.version !== input.expectedSessionVersion) {
    throw new GrillVersionConflictError(
      `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedSessionVersion}，实际 ${session.version}）`,
    );
  }

  if (session.status !== 'ACTIVE') {
    throw new GrillStateConflictError(
      `会话 ${input.sessionId} 当前状态为 ${session.status}，需要 ACTIVE 才能规划问题`,
    );
  }

  if (typeof input.providerProfileId !== 'string' || input.providerProfileId.trim().length === 0) {
    throw new GrillValidationError('缺少启用的模型提供商配置');
  }

  const baseSessionVersion = session.version;
  const taskId = deps.idGenerator.generate();
  const dedupeKey = `grill_question_plan:${input.sessionId}:${baseSessionVersion}`;
  const inputVersionJson = JSON.stringify({
    sessionId: input.sessionId,
    baseSessionVersion,
    schemaVersion: GRILL_QUESTION_PLAN_SCHEMA_VERSION,
    providerProfileId: input.providerProfileId,
  });

  try {
    deps.transaction(() => {
      deps.taskRepo.create({
        id: taskId,
        projectId: input.projectId,
        taskType: 'GRILL_QUESTION_PLAN',
        inputVersionJson,
        payloadJson: '{}',
        dedupeKey,
      });
    });
  } catch (err) {
    if (err instanceof TaskDedupeConflictError) {
      throw new GrillPlanAlreadyRunningError(
        `会话 ${input.sessionId} 版本 ${baseSessionVersion} 已存在活跃的规划任务`,
      );
    }
    throw err;
  }

  return { taskId, sessionId: input.sessionId, baseSessionVersion };
}

// ── 接受提案 ──────────────────────────────────────────────────────

export interface AcceptGrillQuestionPlanProposalInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly proposalId: string;
  readonly expectedSessionVersion: number;
}

export interface AcceptGrillQuestionPlanProposalResult {
  readonly session: GrillSessionData;
  readonly questions: ReadonlyArray<GrillQuestionData>;
  readonly proposal: GrillQuestionPlanProposalData;
}

/**
 * 显式接受问题规划提案，在一个事务内创建正式问题。
 *
 * 事务步骤：
 * 1. ownership 验证（会话、提案归属）；
 * 2. 提案状态验证（必须 PROPOSED）；
 * 3. base version 验证（expectedSessionVersion 同时匹配提案基础版本与会话当前版本）；
 * 4. 再次执行完整依赖图验证（结构 + 引用 + 环）；
 * 5. 为计划问题生成正式 ID，建立 planned key → questionId 映射；
 * 6. 按拓扑顺序插入问题并写入依赖；
 * 7. 标记提案 ACCEPTED（CAS）；
 * 8. 会话版本 CAS 递增。
 *
 * 全部成功或全部回滚；不修改已有答案或用户问题；不自动触发下一轮规划。
 */
export function acceptGrillQuestionPlanProposal(
  deps: GrillQuestionPlanDeps,
  input: AcceptGrillQuestionPlanProposalInput,
): AcceptGrillQuestionPlanProposalResult {
  // Phase 1：事务前快速失败（存在性 / 归属 / 状态）
  const preSession = deps.sessionRepo.getById(input.sessionId);
  if (!preSession) {
    throw new GrillSessionNotFoundError(input.sessionId);
  }
  assertSessionOwnership(preSession, input.projectId);

  const preProposal = deps.planProposalRepo.getById(input.proposalId);
  if (!preProposal) {
    throw new GrillPlanProposalNotFoundError(input.proposalId);
  }
  if (preProposal.sessionId !== input.sessionId || preProposal.projectId !== input.projectId) {
    throw new GrillOwnershipConflictError(`提案 ${input.proposalId} 不属于会话 ${input.sessionId}`);
  }
  if (preProposal.status !== 'PROPOSED') {
    throw new GrillPlanProposalNotAcceptableError(
      `提案 ${input.proposalId} 当前状态为 ${preProposal.status}，不能接受`,
    );
  }

  // Phase 2：会话已越过提案基础版本 → 标记 STALE（独立事务提交），不插入、不 bump
  if (preSession.version !== preProposal.baseSessionVersion) {
    const staled = deps.transaction(() => deps.planProposalRepo.markStale(input.proposalId));
    if (staled) {
      throw new GrillPlanStaleError(`提案 ${input.proposalId} 已过期：会话版本已变化`);
    }
    // CAS 失败：并发状态变更（如已被接受）
    throw new GrillPlanProposalNotAcceptableError(`提案 ${input.proposalId} 状态已变更，不能接受`);
  }

  // Phase 3：仅调用者期望版本错误（会话仍等于 base）→ 版本冲突，不标记 stale
  if (input.expectedSessionVersion !== preSession.version) {
    throw new GrillVersionConflictError(
      `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedSessionVersion}，实际 ${preSession.version}）`,
    );
  }

  // Phase 4：主事务 —— 重新验证 + 插入 + 接受 + bump
  const createdIds: string[] = [];
  let staleDuringTx = false;
  try {
    deps.transaction(() => {
      const session = deps.sessionRepo.getById(input.sessionId);
      if (!session) {
        throw new GrillSessionNotFoundError(input.sessionId);
      }
      assertSessionOwnership(session, input.projectId);
      if (session.status !== 'ACTIVE') {
        throw new GrillStateConflictError(
          `会话 ${input.sessionId} 当前状态为 ${session.status}，需要 ACTIVE 才能接受规划`,
        );
      }

      const proposal = deps.planProposalRepo.getById(input.proposalId);
      if (!proposal) {
        throw new GrillPlanProposalNotFoundError(input.proposalId);
      }
      if (proposal.sessionId !== input.sessionId || proposal.projectId !== input.projectId) {
        throw new GrillOwnershipConflictError(
          `提案 ${input.proposalId} 不属于会话 ${input.sessionId}`,
        );
      }
      if (proposal.status !== 'PROPOSED') {
        throw new GrillPlanProposalNotAcceptableError(
          `提案 ${input.proposalId} 当前状态为 ${proposal.status}，不能接受`,
        );
      }

      // 事务内再次确认版本关系（并发可能已改变）
      if (session.version !== proposal.baseSessionVersion) {
        staleDuringTx = true;
        throw new GrillPlanStaleError(`提案 ${input.proposalId} 已过期：会话版本已变化`);
      }
      if (session.version !== input.expectedSessionVersion) {
        throw new GrillVersionConflictError(
          `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedSessionVersion}）`,
        );
      }

      // 基于当前会话状态重新执行完整验证
      const existingQuestions = deps.questionRepo.listBySession(input.sessionId);
      const { plan, plannedOrder } = validateStoredPlan(proposal.questionsJson, existingQuestions);

      // 生成正式 ID 映射
      const keyToId = new Map<string, string>();
      for (const q of plan.questions) {
        keyToId.set(q.key, deps.idGenerator.generate());
      }

      // 按拓扑顺序插入（依赖在前）
      const maxSeq = deps.questionRepo.getMaxSequence(input.sessionId);
      let offset = 1;
      for (const key of plannedOrder) {
        const planned = plan.questions.find((q) => q.key === key);
        if (!planned) {
          throw new GrillPlanSchemaInvalidError(`拓扑顺序引用了不存在的计划 key: ${key}`);
        }
        const formalId = keyToId.get(key)!;
        const dependsOnQuestionIds = planned.dependencies.map((d) =>
          d.kind === 'existing' ? d.questionId : keyToId.get(d.questionKey)!,
        );
        deps.questionRepo.create({
          id: formalId,
          sessionId: input.sessionId,
          sequence: maxSeq + offset,
          topic: planned.topic,
          text: planned.text,
          rationale: planned.rationale,
          dependsOnQuestionIds,
        });
        createdIds.push(formalId);
        offset++;
      }

      // 标记提案 ACCEPTED（CAS：PROPOSED → ACCEPTED）
      requireCas(
        deps.planProposalRepo.markAccepted(input.proposalId),
        `提案 ${input.proposalId} 状态冲突，可能已被并发接受`,
      );

      // 会话版本 CAS 递增
      requireCas(
        deps.sessionRepo.bumpVersion(input.sessionId, input.expectedSessionVersion),
        `会话 ${input.sessionId} 版本冲突（期望 ${input.expectedSessionVersion}）`,
      );
    });
  } catch (err) {
    if (staleDuringTx) {
      // 主事务已回滚（未插入、未 bump）；以独立事务提交 STALE 标记
      const staled = deps.transaction(() => deps.planProposalRepo.markStale(input.proposalId));
      if (staled) {
        throw new GrillPlanStaleError(`提案 ${input.proposalId} 已过期：会话版本已变化`);
      }
      throw new GrillPlanProposalNotAcceptableError(
        `提案 ${input.proposalId} 状态已变更，不能接受`,
      );
    }
    throw err;
  }

  const session = deps.sessionRepo.getById(input.sessionId);
  if (!session) throw new GrillSessionNotFoundError(input.sessionId);
  const proposal = deps.planProposalRepo.getById(input.proposalId);
  if (!proposal) throw new GrillPlanProposalNotFoundError(input.proposalId);
  const questions = createdIds
    .map((id) => deps.questionRepo.getById(id))
    .filter((q): q is GrillQuestionData => q !== null);

  return { session, questions, proposal };
}

// ── 查询提案 ──────────────────────────────────────────────────────

export function getGrillQuestionPlanProposal(
  deps: GrillQuestionPlanDeps,
  input: { projectId: string; sessionId: string; proposalId: string },
): GrillQuestionPlanProposalData {
  const session = deps.sessionRepo.getById(input.sessionId);
  if (!session) {
    throw new GrillSessionNotFoundError(input.sessionId);
  }
  assertSessionOwnership(session, input.projectId);

  const proposal = deps.planProposalRepo.getById(input.proposalId);
  if (!proposal) {
    throw new GrillPlanProposalNotFoundError(input.proposalId);
  }
  if (proposal.sessionId !== input.sessionId) {
    throw new GrillOwnershipConflictError(`提案 ${input.proposalId} 不属于会话 ${input.sessionId}`);
  }
  return proposal;
}

export function listGrillQuestionPlanProposals(
  deps: GrillQuestionPlanDeps,
  input: { projectId: string; sessionId: string },
): ReadonlyArray<GrillQuestionPlanProposalData> {
  const session = deps.sessionRepo.getById(input.sessionId);
  if (!session) {
    throw new GrillSessionNotFoundError(input.sessionId);
  }
  assertSessionOwnership(session, input.projectId);
  return deps.planProposalRepo.listBySession(input.sessionId);
}
