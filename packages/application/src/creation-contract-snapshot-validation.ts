/**
 * 创作契约权威 snapshot 共享严格验证。
 *
 * 三条路径必须使用同一套强度一致的验证，不得各自漂移：
 * - RequestCreationContractProposal（请求草案时读取当前契约）；
 * - executeCreationContractDraft（任务引擎读取 baseline）；
 * - Update / Lock / Unlock（用户变更用例读取 current version）。
 *
 * validateAuthoritativeContractVersionSnapshot 对 current pointer + version
 * 执行完整权威验证，返回已解析的 sections / lockedFieldPaths / provenance。
 * 全部数据损坏统一抛 ContractDataCorruptionError（public message 固定安全，
 * code = INTERNAL_ERROR），绝不映射为 stale 或 validation failure。
 *
 * 关键区分：本模块只验证数据库"内部自洽"（recompute hash 与数据库存储 hash
 * 一致）。真实但不同的权威 snapshot（例如用户已更新契约）由调用方在验证成功后
 * 另行比较版本号 / hash 并映射为 stale / conflict。
 */

import {
  canonicalSerializeContractSections,
  canonicalSerializeLockedFieldPaths,
  canonicalSerializeContractSnapshot,
  isLowercaseSha256Hex,
  validateNewLockPath,
  codePointCompare,
  CREATION_CONTRACT_SCHEMA_VERSION,
  type CreationContractSections,
  type ContractFieldProvenance,
} from '@ai-novel/domain';
import { ContractDataCorruptionError, ContractSchemaUnsupportedError } from './errors.js';
import { parseProvenanceArray } from './creation-contract-validation.js';
import {
  parseSectionsJson,
  parseLockedFieldPathsJson,
  requireSha256Digest,
} from './creation-contract-mutations.js';
import type {
  CreationContractCurrentData,
  CreationContractVersionData,
  Sha256Port,
} from './creation-contract-types.js';

// ── 常量 ──────────────────────────────────────────────────────────

const VALID_CREATED_BY: ReadonlySet<string> = new Set([
  'user',
  'ai-proposal-accepted',
  'lock',
  'unlock',
]);

// ── 返回类型 ──────────────────────────────────────────────────────

export interface ValidatedAuthoritativeContractSnapshot {
  /** false 表示项目尚无 current contract（首次契约） */
  readonly hasCurrent: boolean;
  /** 通过全部权威验证的 version 数据（hasCurrent=false 时为 null） */
  readonly version: CreationContractVersionData | null;
  readonly currentVersionId: string | null;
  /** 已解析且与 canonical bytes 一致的 sections（hasCurrent=false 时为 null） */
  readonly sections: CreationContractSections | null;
  /** 已解析且通过 active lock 语义验证的 lockedFieldPaths */
  readonly lockedFieldPaths: readonly string[];
  /** 已通过共享严格 parser 的 provenance */
  readonly provenance: ReadonlyArray<ContractFieldProvenance>;
}

// ── Active lock set 语义验证 ─────────────────────────────────────

/**
 * 校验当前活跃 lock set 快照语义：对 canonical sorted 的每个路径逐项验证
 * grammar / schema path / entity 存在性 / structured parent 存在性 /
 * absent optional child 规则 / fixed optional top-level absent 规则 /
 * duplicate / symmetric overlap。
 *
 * Domain 验证错误在 Application current-data 边界映射为
 * ContractDataCorruptionError（INTERNAL_ERROR），不映射为
 * CONTRACT_VALIDATION_FAILED 或 CONTRACT_LOCK_CONFLICT；
 * 也不静默修复（lock 集合是版本快照的一部分）。
 */
export function assertValidExistingLockSet(
  lockedFieldPaths: readonly string[],
  sections: CreationContractSections,
): void {
  const arr = [...lockedFieldPaths];
  for (let i = 1; i < arr.length; i++) {
    if (codePointCompare(arr[i - 1], arr[i]) >= 0) {
      throw new ContractDataCorruptionError('lockedFieldPaths 未按 code-point 排序');
    }
  }
  for (let i = 0; i < arr.length; i++) {
    try {
      validateNewLockPath(arr[i], arr.slice(0, i), sections);
    } catch (e) {
      throw new ContractDataCorruptionError('lockedFieldPaths 存在非法、重复或重叠路径', e);
    }
  }
}

// ── 权威 snapshot 验证 ────────────────────────────────────────────

/**
 * 完整验证一个权威契约 snapshot（current pointer + version）。
 *
 * 验证项：
 * 1. current.projectId === requestedProjectId；
 * 2. version.projectId === requestedProjectId；
 * 3. version.id === current.currentVersionId；
 * 4. version 为正安全整数；
 * 5. schemaVersion 支持（不支持的 schema 抛 ContractSchemaUnsupportedError）；
 * 6. createdBy 合法；
 * 7. sectionsJson 可解析且等于 canonical bytes；
 * 8. lockedFieldPathsJson 可解析且等于 canonical bytes；
 * 9. provenanceJson 使用共享严格 parser；
 * 10. basedOnGrillSessionId/version 同时 null 或同时非 null、id trim 非空、
 *     version 正安全整数；
 * 11. contractSnapshotHash 为 lowercase 64-hex；
 * 12. 用 Sha256Port 重算 sections + lockedFieldPaths + schemaVersion；
 * 13. 重算 hash 必须与数据库存储 hash 完全一致；
 * 14. active locks 验证 grammar / canonical / sorted / duplicate /
 *     symmetric overlap / entity 存在性 / structured parent 存在性 /
 *     absent optional 规则。
 *
 * current 为 null（首次契约）：version 必须也为 null，返回 hasCurrent=false。
 * current 非 null 但 version 为 null（pointer 引用缺失版本）→ 数据损坏。
 * 所有损坏统一 ContractDataCorruptionError（INTERNAL_ERROR），不映射 stale。
 */
export function validateAuthoritativeContractVersionSnapshot(input: {
  readonly requestedProjectId: string;
  readonly current: CreationContractCurrentData | null;
  readonly version: CreationContractVersionData | null;
  readonly sha256Port: Sha256Port;
  readonly context: string;
}): ValidatedAuthoritativeContractSnapshot {
  const { requestedProjectId, current, version, sha256Port, context } = input;

  if (current === null) {
    if (version !== null) {
      throw new ContractDataCorruptionError(`${context}: current pointer 不存在但提供了 version`);
    }
    return {
      hasCurrent: false,
      version: null,
      currentVersionId: null,
      sections: null,
      lockedFieldPaths: [],
      provenance: [],
    };
  }

  // ── Identity / ownership / lineage ──
  if (current.projectId !== requestedProjectId) {
    throw new ContractDataCorruptionError(`${context}: current pointer 不属于该项目`);
  }
  if (version === null) {
    throw new ContractDataCorruptionError(`${context}: current pointer 引用不存在的版本`);
  }
  if (version.projectId !== requestedProjectId) {
    throw new ContractDataCorruptionError(`${context}: version 不属于该项目`);
  }
  if (version.id !== current.currentVersionId) {
    throw new ContractDataCorruptionError(`${context}: version id 与 current pointer 不一致`);
  }
  if (!Number.isSafeInteger(version.version) || version.version < 1) {
    throw new ContractDataCorruptionError(`${context}: version 不是正安全整数`);
  }
  if (version.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
    throw new ContractSchemaUnsupportedError(
      `${context}: unsupported schemaVersion ${version.schemaVersion}`,
    );
  }
  if (!VALID_CREATED_BY.has(version.createdBy)) {
    throw new ContractDataCorruptionError(`${context}: invalid createdBy`);
  }

  // ── 解析（损坏即抛 ContractDataCorruptionError）──
  const sections = parseSectionsJson(version.sectionsJson, context);
  const lockedFieldPaths = parseLockedFieldPathsJson(version.lockedFieldPathsJson, context);
  const provenance = parseProvenanceArray(version.provenanceJson, context);

  // ── Canonical bytes：不得静默修复 key 顺序 / NFC / 空白 ──
  let canonicalSectionsJson: string;
  try {
    canonicalSectionsJson = canonicalSerializeContractSections(sections);
  } catch (e) {
    throw new ContractDataCorruptionError(`${context}: sectionsJson canonical 序列化失败`, e);
  }
  if (version.sectionsJson !== canonicalSectionsJson) {
    throw new ContractDataCorruptionError(`${context}: sectionsJson 不是 canonical bytes`);
  }
  let canonicalLocksJson: string;
  try {
    canonicalLocksJson = canonicalSerializeLockedFieldPaths([...lockedFieldPaths]);
  } catch (e) {
    throw new ContractDataCorruptionError(
      `${context}: lockedFieldPathsJson canonical 序列化失败`,
      e,
    );
  }
  if (version.lockedFieldPathsJson !== canonicalLocksJson) {
    throw new ContractDataCorruptionError(`${context}: lockedFieldPathsJson 不是 canonical bytes`);
  }

  // ── basedOnGrill null pair ──
  if ((version.basedOnGrillSessionId === null) !== (version.basedOnGrillSessionVersion === null)) {
    throw new ContractDataCorruptionError(`${context}: basedOnGrill 空值对不一致`);
  }
  if (version.basedOnGrillSessionId !== null && version.basedOnGrillSessionId.trim().length === 0) {
    throw new ContractDataCorruptionError(`${context}: basedOnGrillSessionId 必须是非空字符串`);
  }
  if (
    version.basedOnGrillSessionVersion !== null &&
    (!Number.isSafeInteger(version.basedOnGrillSessionVersion) ||
      version.basedOnGrillSessionVersion < 1)
  ) {
    throw new ContractDataCorruptionError(
      `${context}: basedOnGrillSessionVersion 必须是正安全整数`,
    );
  }

  // ── contractSnapshotHash：lowercase 64-hex + 重算一致 ──
  if (!isLowercaseSha256Hex(version.contractSnapshotHash)) {
    throw new ContractDataCorruptionError(
      `${context}: contractSnapshotHash is not lowercase SHA-256`,
    );
  }
  const canonicalSnapshot = canonicalSerializeContractSnapshot({
    sections,
    lockedFieldPaths,
    schemaVersion: version.schemaVersion,
  });
  const recomputed = requireSha256Digest(
    sha256Port,
    canonicalSnapshot,
    'snapshot hash verification',
  );
  if (recomputed !== version.contractSnapshotHash) {
    throw new ContractDataCorruptionError(`${context}: contractSnapshotHash mismatch`);
  }

  // ── Active locks 语义验证 ──
  assertValidExistingLockSet(lockedFieldPaths, sections);

  return {
    hasCurrent: true,
    version,
    currentVersionId: current.currentVersionId,
    sections,
    lockedFieldPaths,
    provenance,
  };
}
