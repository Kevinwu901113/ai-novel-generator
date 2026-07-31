/**
 * 创作契约草案测试工具：真实 SQLite 驱动的 engine / request deps 构建。
 *
 * 供 backend E2E 与真实 SQLite 并发测试复用。
 * 不包含业务逻辑，仅测试辅助。
 */

import type { ProjectDatabase } from '@ai-novel/database';
import { sha256Utf8 } from '@ai-novel/database';
import {
  TaskDedupeConflictError,
  type TaskRepositoryPort,
  type TaskData,
  type CreateTaskInput,
  type ModelInvocationRepositoryPort,
  type ModelInvocationData,
  type CreateInvocationInput,
  type InvocationSuccessResult,
  type GrillSessionData,
  type GrillQuestionData,
  type GrillAnswerData,
  type GrillProposalData,
  type RequestCreationContractProposalDeps,
} from '@ai-novel/application';
import type { TaskStatus, ModelInvocationStatus } from '@ai-novel/domain';
import type { ContractDraftEngineDeps } from '@ai-novel/task-engine';
import type { ModelInvocationOutput } from '@ai-novel/model-gateway';
import type { ErrorCode } from '@ai-novel/contracts';
import {
  canonicalSerializeContractSections,
  validateCreationContractSections,
} from '@ai-novel/domain';
import {
  GrillSessionRepositoryAdapter,
  GrillQuestionRepositoryAdapter,
  GrillAnswerRepositoryAdapter,
  GrillProposalRepositoryAdapter,
} from './grill-handlers.js';

export const NOW = '2026-01-10T08:00:00.000Z';
export const NOW2 = '2026-01-10T08:00:30.000Z';
export const HEX64 = 'c'.repeat(64);

/**
 * 精确判定 dedupe 冲突：必须是 tasks.dedupe_key 或 idx_tasks_dedupe_active
 * 的唯一约束冲突。duplicate task primary key 与其他 UNIQUE violation
 * 保持 infra/internal error，不得映射为 TaskDedupeConflictError。
 * errcode 仅作候选预过滤（UNIQUE=2067 / PRIMARY KEY=1555）。
 */
function isUniqueConstraintError(err: unknown): boolean {
  if (err !== null && typeof err === 'object' && 'errcode' in err) {
    const code = (err as { errcode?: unknown }).errcode;
    if (typeof code === 'number' && Number.isInteger(code) && code !== 2067 && code !== 1555) {
      return false;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('tasks.dedupe_key') || msg.includes('idx_tasks_dedupe_active');
}

// ── 真实 DB 适配器 ────────────────────────────────────────────────

export class TaskRepoAdapter implements TaskRepositoryPort {
  constructor(private readonly projDb: ProjectDatabase) {}

  create(data: CreateTaskInput): void {
    try {
      this.projDb.getTaskRepository().create({
        id: data.id,
        projectId: data.projectId,
        taskType: data.taskType,
        status: 'PENDING',
        inputVersionJson: data.inputVersionJson,
        payloadJson: data.payloadJson,
        dedupeKey: data.dedupeKey ?? null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    } catch (err) {
      if (isUniqueConstraintError(err) && data.dedupeKey !== undefined) {
        throw new TaskDedupeConflictError('已存在相同 dedupe key 的活跃任务');
      }
      throw err;
    }
  }
  getById(id: string): TaskData | null {
    const r = this.projDb.getTaskRepository().getById(id);
    if (!r) return null;
    return { ...r, taskType: r.taskType };
  }
  listByProject(projectId: string): ReadonlyArray<TaskData> {
    return this.projDb
      .getTaskRepository()
      .listByProject(projectId)
      .map((r) => ({ ...r }));
  }
  listByStatus(status: TaskStatus): ReadonlyArray<TaskData> {
    return this.projDb
      .getTaskRepository()
      .listByStatus(status)
      .map((r) => ({ ...r }));
  }
  claimPending(id: string): boolean {
    return this.projDb.getTaskRepository().claimPending(id, NOW);
  }
  completeRunning(id: string, resultJson: string): boolean {
    return this.projDb.getTaskRepository().completeRunning(id, resultJson, NOW);
  }
  failRunning(id: string, errorCode: string, errorMessage: string): boolean {
    return this.projDb.getTaskRepository().failRunning(id, errorCode, errorMessage, NOW);
  }
  failPending(id: string, errorCode: string, errorMessage: string): boolean {
    return this.projDb.getTaskRepository().failPending(id, errorCode, errorMessage, NOW);
  }
  markStale(id: string, expectedStatuses: ReadonlyArray<TaskStatus>): boolean {
    return this.projDb.getTaskRepository().markStale(id, expectedStatuses, NOW);
  }
  resetToPending(id: string, expectedStatus: TaskStatus): boolean {
    return this.projDb.getTaskRepository().resetToPending(id, expectedStatus, NOW);
  }
  listRunning(): ReadonlyArray<TaskData> {
    return this.projDb
      .getTaskRepository()
      .listRunning()
      .map((r) => ({ ...r }));
  }
}

export class InvocationRepoAdapter implements ModelInvocationRepositoryPort {
  constructor(private readonly projDb: ProjectDatabase) {}

  create(data: CreateInvocationInput): void {
    this.projDb.getModelInvocationRepository().create({
      id: data.id,
      projectId: data.projectId,
      taskId: data.taskId,
      providerProfileId: data.providerProfileId,
      model: data.model,
      status: 'PENDING',
      attemptNumber: data.attemptNumber,
      requestKind: data.requestKind,
      promptHash: data.promptHash,
      requestMetadataJson: data.requestMetadataJson,
      createdAt: NOW,
    });
  }
  getById(id: string): ModelInvocationData | null {
    const r = this.projDb.getModelInvocationRepository().getById(id);
    return r ? { ...r } : null;
  }
  listByTask(taskId: string): ReadonlyArray<ModelInvocationData> {
    return this.projDb
      .getModelInvocationRepository()
      .listByTask(taskId)
      .map((r) => ({ ...r }));
  }
  markRunning(id: string, expectedStatus: 'PENDING'): boolean {
    return this.projDb.getModelInvocationRepository().markRunning(id, expectedStatus, NOW);
  }
  markSucceeded(id: string, expectedStatus: 'RUNNING', result: InvocationSuccessResult): boolean {
    return this.projDb.getModelInvocationRepository().markSucceeded(id, expectedStatus, {
      responseMetadataJson: result.responseMetadataJson,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      totalTokens: result.totalTokens,
      latencyMs: result.latencyMs,
      finishReason: result.finishReason,
      providerRequestId: result.providerRequestId,
      finishedAt: NOW,
    });
  }
  markFailed(
    id: string,
    expectedStatuses: ReadonlyArray<ModelInvocationStatus>,
    errorCode: string,
    errorMessage: string,
    latencyMs: number | null,
  ): boolean {
    return this.projDb
      .getModelInvocationRepository()
      .markFailed(id, expectedStatuses, errorCode, errorMessage, latencyMs, NOW);
  }
  getStatsByProject(): import('@ai-novel/application').InvocationStatsData {
    return {
      invocationCount: 0,
      succeededCount: 0,
      failedCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
    };
  }
  listRunning(): ReadonlyArray<ModelInvocationData> {
    return this.projDb
      .getModelInvocationRepository()
      .listRunning()
      .map((r) => ({ ...r }));
  }
}

// ── 领域数据构造 ──────────────────────────────────────────────────

/** 与 validateCreationContractSections 结果一致的 canonical sectionsJson。 */
export function makeCanonicalSectionsJson(): string {
  return canonicalSerializeContractSections(
    validateCreationContractSections({
      premise: '一个关于契约的故事',
      genre: ['sci-fi'],
      tone: ['dark'],
      targetAudience: 'adults',
      narrativePov: 'FIRST',
      tense: 'PRESENT',
      protagonist: { characterKey: 'protag', name: '主角' },
    }),
  );
}

export function makeModelOutput(
  text: string,
  errorCode: ErrorCode | null = null,
): ModelInvocationOutput {
  return {
    text,
    providerRequestId: 'req-e2e',
    finishReason: 'end_turn',
    usage: {
      inputTokens: 80,
      outputTokens: 40,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 120,
    },
    latencyMs: 500,
    errorCode,
    errorMessage: errorCode ? '模型调用失败' : null,
  };
}

/** 创建一个已 COMPLETED 的 Grill session + 问题 + 答案 + 已接受提案。返回最终 session version。 */
export function seedCompletedGrillSession(
  projDb: ProjectDatabase,
  opts: { sessionId: string; projectId: string; goal?: string },
): number {
  const sessionRepo = projDb.getGrillSessionRepository();
  const questionRepo = projDb.getGrillQuestionRepository();
  const answerRepo = projDb.getGrillAnswerRepository();
  const proposalRepo = projDb.getGrillProposalRepository();

  sessionRepo.create({
    id: opts.sessionId,
    projectId: opts.projectId,
    goal: opts.goal ?? '一个目标',
    createdAt: NOW,
    updatedAt: NOW,
  });
  // 直接置为 COMPLETED（模拟用户完成会话），版本 1 → 2
  sessionRepo.transitionStatus(opts.sessionId, 1, 'COMPLETED', NOW);

  questionRepo.create({
    id: `${opts.sessionId}-q1`,
    sessionId: opts.sessionId,
    sequence: 1,
    topic: '主角',
    text: '主角是谁？',
    rationale: '了解主角',
    dependsOnQuestionIds: '[]',
    createdAt: NOW,
  });
  answerRepo.create({
    id: `${opts.sessionId}-a1`,
    sessionId: opts.sessionId,
    questionId: `${opts.sessionId}-q1`,
    revision: 1,
    source: 'USER',
    text: '主角是一个勇敢的少年',
    createdAt: NOW,
  });
  proposalRepo.create({
    id: `${opts.sessionId}-p1`,
    sessionId: opts.sessionId,
    basedOnAnswerIds: `["${opts.sessionId}-a1"]`,
    key: 'genre',
    proposedValueJson: '["sci-fi"]',
    confidence: 0.9,
    rationale: '依据用户答案',
    createdAt: NOW,
  });
  proposalRepo.transitionStatus(`${opts.sessionId}-p1`, 'PROPOSED', 'ACCEPTED', NOW);

  const session = sessionRepo.getById(opts.sessionId);
  return session ? session.version : 2;
}

// ── deps 构建 ─────────────────────────────────────────────────────

export interface EngineOpts {
  invokeModel?: (input: {
    baseUrl: string;
    model: string;
    apiKey: string;
    prompt: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }) => Promise<ModelInvocationOutput>;
  transactionMode?: 'deferred' | 'immediate';
}

export function buildEngineDeps(
  projDb: ProjectDatabase,
  opts: EngineOpts = {},
): ContractDraftEngineDeps {
  const clock = { now: () => NOW };
  const transaction =
    opts.transactionMode === 'deferred'
      ? <T>(fn: () => T) => projDb.transaction(fn)
      : <T>(fn: () => T) => projDb.transactionImmediate(fn);
  return {
    taskRepo: new TaskRepoAdapter(projDb),
    invocationRepo: new InvocationRepoAdapter(projDb),
    secretStore: {
      hasSecret: async () => true,
      getSecret: async () => 'test-key',
      setSecret: async () => {},
      deleteSecret: async () => {},
    },
    providerRepo: {
      getById: () => ({
        id: 'provider-1',
        providerType: 'anthropic-compatible',
        displayName: 'Test',
        baseUrl: 'https://test.example',
        model: 'test-model',
        keychainService: 'svc',
        keychainAccount: 'acct',
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
        lastTestedAt: null,
        lastTestStatus: null,
        lastTestErrorCode: null,
        lastTestLatencyMs: null,
      }),
      updateTestResult: () => {},
    },
    idGenerator: { generate: () => `gen-${Math.random().toString(36).slice(2, 10)}` },
    clock,
    sessionRepo: new GrillSessionRepositoryAdapter(projDb, clock),
    questionRepo: new GrillQuestionRepositoryAdapter(projDb, clock),
    answerRepo: new GrillAnswerRepositoryAdapter(projDb, clock),
    grillProposalRepo: new GrillProposalRepositoryAdapter(projDb, clock),
    ccProposalRepo: projDb.getCreationContractProposalRepository(),
    ccVersionRepo: projDb.getCreationContractVersionRepository(),
    ccCurrentRepo: projDb.getCreationContractCurrentRepository(),
    sha256Port: { digestUtf8: (s: string) => sha256Utf8(s) },
    invokeModel:
      opts.invokeModel ??
      (async () =>
        makeModelOutput(
          JSON.stringify({ schemaVersion: 1, sections: JSON.parse(makeCanonicalSectionsJson()) }),
        )),
    transaction,
  };
}

export function buildRequestDeps(
  projDb: ProjectDatabase,
  idGenerator: { generate(): string },
): RequestCreationContractProposalDeps {
  const clock = { now: () => NOW };
  return {
    idGenerator,
    clock,
    sessionRepo: new GrillSessionRepositoryAdapter(projDb, clock),
    currentRepo: projDb.getCreationContractCurrentRepository(),
    versionRepo: projDb.getCreationContractVersionRepository(),
    taskRepo: new TaskRepoAdapter(projDb),
    sha256Port: { digestUtf8: (s: string) => sha256Utf8(s) },
    transaction: <T>(fn: () => T) => projDb.transactionImmediate(fn),
  };
}

// 供测试直接使用的会话/问题/答案类型（避免未使用导入告警）
export type { GrillSessionData, GrillQuestionData, GrillAnswerData, GrillProposalData };
