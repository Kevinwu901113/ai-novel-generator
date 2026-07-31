/**
 * 创作契约草案请求用例：RequestCreationContractProposal。
 *
 * Renderer 只提交 projectId / grillSessionId / expectedGrillSessionVersion /
 * expectedContractVersion。Worker 解析当前启用 provider 后，把
 * providerProfileId 作为内部依赖传入（Renderer 不传 provider/ID/time）。
 *
 * 用例职责：
 * 1. 验证输入（ID trim 非空、safe integer、null 语义严格）；
 * 2. 在单个同步事务内完成全部事实读取与创建：
 *    - 读取并验证 Grill session（存在、属于 project、version 匹配、
 *      status 允许生成）；
 *    - 读取 current pointer；
 *    - 读取并严格验证 current version（共享权威 snapshot validator，
 *      与 Update/Lock/Unlock 和任务引擎同一套强度）；
 *    - 构造 ContractBaselineRef（首次契约三字段全 null）；
 *    - 构造严格 canonical inputVersionJson（exact keys / 固定 key order / compact）；
 *    - 构造 dedupe key（绑定 session/version/baseline version/hash）；
 *    - 创建 PENDING CREATION_CONTRACT_DRAFT 任务（payloadJson = "{}"）。
 * 3. dedupe key 由数据库 partial unique index 为最终并发保护（不先查后插），
 *    并发重复请求映射为稳定 CONTRACT_DRAFT_ALREADY_RUNNING；
 * 4. 返回安全摘要，不含 prompt/provider/hash/内部路径。
 *
 * 绝不：直接创建 ContractVersion、修改 current pointer、自动接受、
 * 自动修改 lock、修改已存在 proposal。
 */

import { CREATION_CONTRACT_SCHEMA_VERSION, type ContractBaselineRef } from '@ai-novel/domain';
import type { IdGenerator, Clock, TaskRepositoryPort } from './types.js';
import type { GrillSessionData, GrillSessionRepositoryPort } from './grill-types.js';
import type {
  CreationContractCurrentRepositoryPort,
  CreationContractVersionRepositoryPort,
  Sha256Port,
} from './creation-contract-types.js';
import { validateAuthoritativeContractVersionSnapshot } from './creation-contract-snapshot-validation.js';
import {
  ContractDraftAlreadyRunningError,
  ContractVersionConflictError,
  GrillSessionNotFoundError,
  GrillStateConflictError,
  GrillVersionConflictError,
  GrillOwnershipConflictError,
  TaskDedupeConflictError,
  ValidationError,
} from './errors.js';

// ── 依赖 ──────────────────────────────────────────────────────

export interface RequestCreationContractProposalDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly sessionRepo: GrillSessionRepositoryPort;
  readonly currentRepo: CreationContractCurrentRepositoryPort;
  readonly versionRepo: CreationContractVersionRepositoryPort;
  readonly taskRepo: TaskRepositoryPort;
  readonly sha256Port: Sha256Port;
  /** 整个用例在单个 BEGIN IMMEDIATE 事务内执行（由 Worker 注入 transactionImmediate） */
  readonly transaction: <T>(fn: () => T) => T;
}

// ── 输入 ──────────────────────────────────────────────────────

/** Renderer-facing 输入：不含 providerProfileId / ID / 时间戳。 */
export interface RequestCreationContractProposalInput {
  readonly projectId: string;
  readonly grillSessionId: string;
  readonly expectedGrillSessionVersion: number;
  readonly expectedContractVersion: number | null;
}

/** 完整命令：providerProfileId 由 Worker 作为内部依赖注入。 */
export interface RequestCreationContractProposalCommand extends RequestCreationContractProposalInput {
  readonly providerProfileId: string;
}

export interface RequestCreationContractProposalResult {
  readonly taskId: string;
  readonly grillSessionId: string;
  readonly baseGrillSessionVersion: number;
  readonly baseContractVersion: number | null;
}

// ── 输入验证 ──────────────────────────────────────────────────

function validateCommand(input: RequestCreationContractProposalCommand): void {
  if (typeof input.projectId !== 'string' || input.projectId.trim().length === 0) {
    throw new ValidationError('projectId 必须是非空字符串');
  }
  if (typeof input.grillSessionId !== 'string' || input.grillSessionId.trim().length === 0) {
    throw new ValidationError('grillSessionId 必须是非空字符串');
  }
  if (
    !Number.isSafeInteger(input.expectedGrillSessionVersion) ||
    input.expectedGrillSessionVersion < 1
  ) {
    throw new ValidationError('expectedGrillSessionVersion 必须是正安全整数');
  }
  if (input.expectedContractVersion !== null) {
    if (!Number.isSafeInteger(input.expectedContractVersion) || input.expectedContractVersion < 1) {
      throw new ValidationError('expectedContractVersion 必须是 null 或正安全整数');
    }
  }
  if (typeof input.providerProfileId !== 'string' || input.providerProfileId.trim().length === 0) {
    throw new ValidationError('providerProfileId 必须是非空字符串');
  }
}

// ── Grill session 验证 ────────────────────────────────────────

function assertSessionAllowsContractDraft(
  session: GrillSessionData,
  projectId: string,
  expectedGrillSessionVersion: number,
): void {
  if (session.projectId !== projectId) {
    throw new GrillOwnershipConflictError(`会话 ${session.id} 不属于项目 ${projectId}`);
  }
  if (session.version !== expectedGrillSessionVersion) {
    throw new GrillVersionConflictError(
      `会话 ${session.id} 版本冲突（期望 ${expectedGrillSessionVersion}，实际 ${session.version}）`,
    );
  }
  // 冻结设计未明确允许其他状态；默认要求 COMPLETED。不自行放宽。
  if (session.status !== 'COMPLETED') {
    throw new GrillStateConflictError('会话未完成，无法生成创作契约');
  }
}

// ── Current contract baseline 读取 ─────────────────────────────

interface ReadBaselineResult {
  readonly baseline: ContractBaselineRef;
  readonly baseContractVersion: number | null;
}

/**
 * 在同一事实视图读取 current contract 并构造 ContractBaselineRef。
 *
 * - 首次生成：pointer 不存在 → 三字段全 null，baseContractVersion = null。
 * - 已有契约：共享权威 snapshot validator 严格验证
 *   ownership/identity/版本号/schema/canonical bytes/provenance/hash/active locks，
 *   验证成功后再比较 expectedContractVersion，构造完整 baseline。
 * - 数据损坏 → ContractDataCorruptionError（INTERNAL_ERROR），不映射 stale。
 */
function readCurrentContractBaseline(
  deps: RequestCreationContractProposalDeps,
  projectId: string,
  expectedContractVersion: number | null,
): ReadBaselineResult {
  const current = deps.currentRepo.get(projectId);

  if (!current) {
    if (expectedContractVersion !== null) {
      throw new ContractVersionConflictError('期望首次契约但 expectedContractVersion 非 null');
    }
    return {
      baseline: {
        contractVersionId: null,
        contractVersion: null,
        contractSnapshotHash: null,
      },
      baseContractVersion: null,
    };
  }

  if (expectedContractVersion === null) {
    throw new ContractVersionConflictError(
      '存在 current contract 但 expectedContractVersion 为 null',
    );
  }

  const version = deps.versionRepo.getById(projectId, current.currentVersionId);
  const validated = validateAuthoritativeContractVersionSnapshot({
    requestedProjectId: projectId,
    current,
    version,
    sha256Port: deps.sha256Port,
    context: 'requestCreationContractProposal',
  });
  if (!validated.hasCurrent || validated.version === null) {
    throw new ContractVersionConflictError('当前创作契约数据异常，请刷新后重试');
  }

  // 严格验证成功后再比较版本号（真实但不同的权威 snapshot → CONTRACT_VERSION_CONFLICT）
  if (validated.version.version !== expectedContractVersion) {
    throw new ContractVersionConflictError('当前创作契约版本已变化，请刷新后重试');
  }

  return {
    baseline: {
      contractVersionId: validated.version.id,
      contractVersion: validated.version.version,
      contractSnapshotHash: validated.version.contractSnapshotHash,
    },
    baseContractVersion: validated.version.version,
  };
}

// ── Canonical inputVersionJson ─────────────────────────────────

function buildInputVersionJson(input: {
  readonly grillSessionId: string;
  readonly baseGrillSessionVersion: number;
  readonly contractBaseline: ContractBaselineRef;
  readonly schemaVersion: number;
  readonly providerProfileId: string;
}): string {
  return JSON.stringify({
    grillSessionId: input.grillSessionId,
    baseGrillSessionVersion: input.baseGrillSessionVersion,
    contractBaseline: {
      contractVersionId: input.contractBaseline.contractVersionId,
      contractVersion: input.contractBaseline.contractVersion,
      contractSnapshotHash: input.contractBaseline.contractSnapshotHash,
    },
    schemaVersion: input.schemaVersion,
    providerProfileId: input.providerProfileId,
  });
}

// ── 用例 ──────────────────────────────────────────────────────

/**
 * 在单个同步事务内创建创作契约草案任务（PENDING），返回安全摘要。
 *
 * session / current / version 的读取、baseline 构造、inputVersionJson、
 * dedupe key 与 task insert 全部在同一事务内完成：事务期间其他 writer
 * 不能改变 session 或 current，保证不产生 session version 与 contract
 * baseline 混合的 task。事务由 Worker 注入 transactionImmediate。
 *
 * dedupe key 绑定 session + base version + baseline contract version + hash。
 * 数据库 partial unique index 是最终并发保护；并发重复请求映射为稳定
 * CONTRACT_DRAFT_ALREADY_RUNNING，不暴露 dedupe key。
 */
export function requestCreationContractProposal(
  deps: RequestCreationContractProposalDeps,
  input: RequestCreationContractProposalCommand,
): RequestCreationContractProposalResult {
  validateCommand(input);

  const taskId = deps.idGenerator.generate();
  try {
    return deps.transaction(() => {
      // 1. Grill session：存在 / 归属 / 版本 / 状态
      const session = deps.sessionRepo.getById(input.grillSessionId);
      if (!session) {
        throw new GrillSessionNotFoundError(input.grillSessionId);
      }
      assertSessionAllowsContractDraft(session, input.projectId, input.expectedGrillSessionVersion);

      // 2. Current contract baseline（同一事实视图 + 共享权威验证）
      const { baseline, baseContractVersion } = readCurrentContractBaseline(
        deps,
        input.projectId,
        input.expectedContractVersion,
      );

      // 3. Canonical inputVersionJson
      const inputVersionJson = buildInputVersionJson({
        grillSessionId: input.grillSessionId,
        baseGrillSessionVersion: session.version,
        contractBaseline: baseline,
        schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
        providerProfileId: input.providerProfileId,
      });

      // 4. Dedupe key（单行、无换行）
      const dedupeKey = [
        'creation_contract_draft',
        input.grillSessionId,
        String(session.version),
        baseline.contractVersion === null ? 'none' : String(baseline.contractVersion),
        baseline.contractSnapshotHash === null ? 'none' : baseline.contractSnapshotHash,
      ].join(':');

      // 5. 创建 PENDING 任务（dedupe 冲突由数据库唯一索引兜底）
      deps.taskRepo.create({
        id: taskId,
        projectId: input.projectId,
        taskType: 'CREATION_CONTRACT_DRAFT',
        inputVersionJson,
        payloadJson: '{}',
        dedupeKey,
      });

      return {
        taskId,
        grillSessionId: input.grillSessionId,
        baseGrillSessionVersion: session.version,
        baseContractVersion,
      };
    });
  } catch (err) {
    if (err instanceof TaskDedupeConflictError) {
      throw new ContractDraftAlreadyRunningError('同一输入版本已存在活跃的创作契约草案任务', err);
    }
    throw err;
  }
}
