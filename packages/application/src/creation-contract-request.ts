/**
 * 创作契约草案请求用例：RequestCreationContractProposal。
 *
 * Renderer 只提交 projectId / grillSessionId / expectedGrillSessionVersion /
 * expectedContractVersion。Worker 解析当前启用 provider 后，把
 * providerProfileId 作为内部依赖传入（Renderer 不传 provider/ID/time）。
 *
 * 用例职责：
 * 1. 验证输入（ID trim 非空、safe integer、null 语义严格）；
 * 2. 验证 Grill session：存在、属于 project、version 匹配、状态允许生成
 *    （冻结设计未明确其他状态，默认要求 COMPLETED）；
 * 3. 在同一事实视图读取 current contract：
 *    - 首次生成：current pointer 不存在，expectedContractVersion 必须为 null，
 *      baseline ref 三字段全 null；
 *    - 已有契约：严格验证 ownership/identity/版本一致，构造完整 ContractBaselineRef；
 * 4. 构造严格 canonical inputVersionJson（exact keys / 固定 key order / compact）；
 * 5. 创建 PENDING CREATION_CONTRACT_DRAFT 任务（payloadJson = "{}"）；
 * 6. dedupe key 绑定 session/version/baseline version/baseline hash，
 *    数据库 partial unique index 为最终并发保护（不先查后插）；
 * 7. 返回安全摘要，不含 prompt/provider/hash/内部路径。
 *
 * 绝不：直接创建 ContractVersion、修改 current pointer、自动接受、
 * 自动修改 lock、修改已存在 proposal。
 */

import {
  CREATION_CONTRACT_SCHEMA_VERSION,
  isLowercaseSha256Hex,
  type ContractBaselineRef,
} from '@ai-novel/domain';
import type { IdGenerator, Clock, TaskRepositoryPort } from './types.js';
import type { GrillSessionData, GrillSessionRepositoryPort } from './grill-types.js';
import type {
  CreationContractCurrentRepositoryPort,
  CreationContractVersionRepositoryPort,
} from './creation-contract-types.js';
import {
  ContractDraftAlreadyRunningError,
  ContractVersionConflictError,
  ContractDataCorruptionError,
  ContractSchemaUnsupportedError,
  ValidationError,
  GrillSessionNotFoundError,
  GrillStateConflictError,
  GrillVersionConflictError,
  GrillOwnershipConflictError,
  TaskDedupeConflictError,
} from './errors.js';

// ── 依赖 ──────────────────────────────────────────────────────

export interface RequestCreationContractProposalDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly sessionRepo: GrillSessionRepositoryPort;
  readonly currentRepo: CreationContractCurrentRepositoryPort;
  readonly versionRepo: CreationContractVersionRepositoryPort;
  readonly taskRepo: TaskRepositoryPort;
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
 * - 已有契约：验证 ownership/identity/版本号/schema/hash，构造完整 baseline。
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

  if (current.projectId !== projectId) {
    throw new ContractDataCorruptionError('current pointer 不属于该项目');
  }
  if (expectedContractVersion === null) {
    throw new ContractVersionConflictError(
      '存在 current contract 但 expectedContractVersion 为 null',
    );
  }

  const version = deps.versionRepo.getById(projectId, current.currentVersionId);
  if (!version) {
    throw new ContractDataCorruptionError('current pointer 引用不存在的版本');
  }
  if (version.projectId !== projectId) {
    throw new ContractDataCorruptionError('current version 不属于该项目');
  }
  if (version.id !== current.currentVersionId) {
    throw new ContractDataCorruptionError('current pointer 与 version id 不一致');
  }
  if (version.version !== expectedContractVersion) {
    throw new ContractVersionConflictError('当前创作契约版本已变化，请刷新后重试');
  }
  if (version.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
    throw new ContractSchemaUnsupportedError('当前创作契约 schema 版本不受支持');
  }
  if (!isLowercaseSha256Hex(version.contractSnapshotHash)) {
    throw new ContractDataCorruptionError('contractSnapshotHash 不是 lowercase SHA-256');
  }

  return {
    baseline: {
      contractVersionId: version.id,
      contractVersion: version.version,
      contractSnapshotHash: version.contractSnapshotHash,
    },
    baseContractVersion: version.version,
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
 * 创建创作契约草案任务（PENDING），返回安全摘要。
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

  // 1. Grill session：存在 / 归属 / 版本 / 状态
  const session = deps.sessionRepo.getById(input.grillSessionId);
  if (!session) {
    throw new GrillSessionNotFoundError(input.grillSessionId);
  }
  assertSessionAllowsContractDraft(session, input.projectId, input.expectedGrillSessionVersion);

  // 2. Current contract baseline（同一事实视图）
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

  // 5. 原子创建 PENDING 任务（dedupe 冲突由数据库唯一索引兜底）
  const taskId = deps.idGenerator.generate();
  try {
    deps.transaction(() => {
      deps.taskRepo.create({
        id: taskId,
        projectId: input.projectId,
        taskType: 'CREATION_CONTRACT_DRAFT',
        inputVersionJson,
        payloadJson: '{}',
        dedupeKey,
      });
    });
  } catch (err) {
    if (err instanceof TaskDedupeConflictError) {
      throw new ContractDraftAlreadyRunningError('同一输入版本已存在活跃的创作契约草案任务', err);
    }
    throw err;
  }

  return {
    taskId,
    grillSessionId: input.grillSessionId,
    baseGrillSessionVersion: session.version,
    baseContractVersion,
  };
}
