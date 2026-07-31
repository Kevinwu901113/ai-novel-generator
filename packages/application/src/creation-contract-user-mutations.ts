/**
 * 创作契约用户变更用例：Update / Lock / Unlock。
 *
 * - UpdateCreationContractByUser：直接用户编辑，创建新权威版本。
 * - LockCreationContractField / UnlockCreationContractField：
 *   sections/provenance 字节不变，只改变 lockedFieldPaths，
 *   并追加 lock-event 审计记录。
 *
 * 三个用例都在同一事务内完成：读取并验证 current version、
 * 构造新 version、current pointer CAS（以及 lock/unlock 的 event append）。
 * 任一失败由事务适配器完整回滚，不留下 orphan version / 错误 pointer /
 * 孤立 lock event。
 *
 * 不依赖 node:sqlite 或 node:crypto；所有 runtime input 重新解析验证。
 */

import {
  canonicalSerializeContractSections,
  canonicalSerializeLockedFieldPaths,
  canonicalSerializeContractSnapshot,
  canonicalSerializeContractFieldValue,
  applyContractPatchOperations,
  getCanonicalTargetPath,
  operationWriteSetConflictsWithLocks,
  pathsOverlap,
  isLowercaseSha256Hex,
  canonicalizeContractFieldPath,
  codePointCompare,
  validateNewLockPath,
  CREATION_CONTRACT_SCHEMA_VERSION,
  type CreationContractSections,
  type ContractPatchOperation,
  type ContractFieldProvenance,
  type ProvenanceSource,
  type ContractVersionCreatedBy,
} from '@ai-novel/domain';
import type { ContractVersionPublicData } from '@ai-novel/contracts';
import type {
  UpdateCreationContractByUserInput,
  LockCreationContractFieldInput,
  UnlockCreationContractFieldInput,
  CreationContractTransactionRepositories,
  CreationContractVersionData,
} from './creation-contract-types.js';
import {
  ContractVersionConflictError,
  ContractSchemaUnsupportedError,
  ContractDataCorruptionError,
  ContractLockConflictError,
  ContractValidationError,
  ValidationError,
} from './errors.js';
import { parseProvenanceArray, validateIso8601Timestamp } from './creation-contract-validation.js';
import {
  parseSectionsJson,
  parseLockedFieldPathsJson,
  sectionsToPublicData,
  getFieldValueByPath,
  collectAllFieldPaths,
  requireSha256Digest,
  loadPreviousProvenanceMap,
  parseOperations,
  type CreationContractMutationDeps,
} from './creation-contract-mutations.js';

// ── 依赖 ──────────────────────────────────────────────────────

const VALID_CREATED_BY: ReadonlySet<string> = new Set([
  'user',
  'ai-proposal-accepted',
  'lock',
  'unlock',
]);

// ── 输入验证 ──────────────────────────────────────────────────

function validateUpdateInput(input: UpdateCreationContractByUserInput): void {
  if (typeof input.projectId !== 'string' || input.projectId.trim().length === 0) {
    throw new ValidationError('projectId 必须是非空字符串');
  }
  if (!Number.isSafeInteger(input.expectedContractVersion) || input.expectedContractVersion < 1) {
    throw new ValidationError('expectedContractVersion 必须是正安全整数');
  }
  if (typeof input.newVersionId !== 'string' || input.newVersionId.trim().length === 0) {
    throw new ValidationError('newVersionId 必须是非空字符串');
  }
  validateIso8601Timestamp(input.now, 'now');
  if (!Array.isArray(input.operations)) {
    throw new ValidationError('operations 必须是数组');
  }
  if (input.operations.length === 0) {
    throw new ValidationError('operations 不能为空');
  }
}

function validateLockInput(
  input: LockCreationContractFieldInput | UnlockCreationContractFieldInput,
): void {
  if (typeof input.projectId !== 'string' || input.projectId.trim().length === 0) {
    throw new ValidationError('projectId 必须是非空字符串');
  }
  if (!Number.isSafeInteger(input.expectedContractVersion) || input.expectedContractVersion < 1) {
    throw new ValidationError('expectedContractVersion 必须是正安全整数');
  }
  if (typeof input.fieldPath !== 'string' || input.fieldPath.trim().length === 0) {
    throw new ValidationError('fieldPath 必须是非空字符串');
  }
  if (typeof input.newVersionId !== 'string' || input.newVersionId.trim().length === 0) {
    throw new ValidationError('newVersionId 必须是非空字符串');
  }
  if (typeof input.lockEventId !== 'string' || input.lockEventId.trim().length === 0) {
    throw new ValidationError('lockEventId 必须是非空字符串');
  }
  if (input.newVersionId === input.lockEventId) {
    throw new ValidationError('newVersionId 与 lockEventId 不得相同');
  }
  validateIso8601Timestamp(input.now, 'now');
}

// ── 共用 current version 加载 ────────────────────────────────

interface LoadedCurrentVersion {
  readonly currentVersionId: string;
  readonly versionData: CreationContractVersionData;
  readonly sections: CreationContractSections;
  readonly lockedFieldPaths: readonly string[];
  readonly provenance: ReadonlyArray<ContractFieldProvenance>;
}

/**
 * 在事务内加载并严格验证 current version。
 *
 * 验证：project 存在 / current pointer / current 与 version 归属及 id 一致性 /
 * version 号与 expectedContractVersion 一致 / schemaVersion 支持 /
 * createdBy 合法 / sectionsJson 与 lockedFieldPathsJson 为 canonical bytes /
 * basedOnGrill null pair / provenanceJson /
 * contractSnapshotHash 完整性（用 Sha256Port 重算并比对）。
 *
 * - 不存在 current 或版本号不匹配 → CONTRACT_VERSION_CONFLICT
 * - 任意解析/哈希不一致 → ContractDataCorruptionError（INTERNAL_ERROR）
 */
function loadAndValidateCurrentVersion(
  repos: CreationContractTransactionRepositories,
  projectId: string,
  expectedContractVersion: number,
  context: string,
  sha256Port: CreationContractMutationDeps['sha256Port'],
): LoadedCurrentVersion {
  if (!repos.projectExistsReadPort.exists(projectId)) {
    throw new ContractVersionConflictError(`${context}: project does not exist`);
  }

  const current = repos.currentRepo.get(projectId);
  if (!current) {
    throw new ContractVersionConflictError(`${context}: no current contract version`);
  }

  const versionData = repos.versionRepo.getById(projectId, current.currentVersionId);
  if (!versionData) {
    throw new ContractDataCorruptionError(`${context}: current pointer references missing version`);
  }

  // Identity / ownership：current 与 version 必须属于本项目，且 pointer 与 version id 一致。
  // 归属不匹配是权威数据损坏（INTERNAL_ERROR），不得当作普通 stale conflict。
  if (current.projectId !== projectId) {
    throw new ContractDataCorruptionError(`${context}: current pointer 不属于该项目`);
  }
  if (versionData.projectId !== projectId) {
    throw new ContractDataCorruptionError(`${context}: version 不属于该项目`);
  }
  if (versionData.id !== current.currentVersionId) {
    throw new ContractDataCorruptionError(`${context}: version id 与 current pointer 不一致`);
  }

  if (versionData.version !== expectedContractVersion) {
    throw new ContractVersionConflictError(`${context}: version mismatch`);
  }

  if (versionData.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
    throw new ContractSchemaUnsupportedError(
      `${context}: unsupported schemaVersion ${versionData.schemaVersion}`,
    );
  }

  if (!VALID_CREATED_BY.has(versionData.createdBy)) {
    throw new ContractDataCorruptionError(`${context}: invalid createdBy`);
  }

  const sections = parseSectionsJson(versionData.sectionsJson, context);
  const lockedFieldPaths = parseLockedFieldPathsJson(versionData.lockedFieldPathsJson, context);
  const provenance = parseProvenanceArray(versionData.provenanceJson, context);

  // canonical bytes：不允许静默修复 object key 顺序 / Unicode NFC / 多余空白 /
  // 非 canonical representation。当前快照必须是原始 canonical JSON。
  let canonicalSectionsJson: string;
  try {
    canonicalSectionsJson = canonicalSerializeContractSections(sections);
  } catch (e) {
    throw new ContractDataCorruptionError(`${context}: sectionsJson canonical 序列化失败`, e);
  }
  if (versionData.sectionsJson !== canonicalSectionsJson) {
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
  if (versionData.lockedFieldPathsJson !== canonicalLocksJson) {
    throw new ContractDataCorruptionError(`${context}: lockedFieldPathsJson 不是 canonical bytes`);
  }

  // basedOnGrill null pair：两个字段必须同时为 null 或同时非 null；
  // 非 null version 必须是正安全整数；非 null id 必须是非空字符串。
  if (
    (versionData.basedOnGrillSessionId === null) !==
    (versionData.basedOnGrillSessionVersion === null)
  ) {
    throw new ContractDataCorruptionError(`${context}: basedOnGrill 空值对不一致`);
  }
  if (
    versionData.basedOnGrillSessionId !== null &&
    versionData.basedOnGrillSessionId.trim().length === 0
  ) {
    throw new ContractDataCorruptionError(`${context}: basedOnGrillSessionId 必须是非空字符串`);
  }
  if (
    versionData.basedOnGrillSessionVersion !== null &&
    (!Number.isSafeInteger(versionData.basedOnGrillSessionVersion) ||
      versionData.basedOnGrillSessionVersion < 1)
  ) {
    throw new ContractDataCorruptionError(
      `${context}: basedOnGrillSessionVersion 必须是正安全整数`,
    );
  }

  if (!isLowercaseSha256Hex(versionData.contractSnapshotHash)) {
    throw new ContractDataCorruptionError(
      `${context}: contractSnapshotHash is not lowercase SHA-256`,
    );
  }
  const canonicalSnapshot = canonicalSerializeContractSnapshot({
    sections,
    lockedFieldPaths,
    schemaVersion: versionData.schemaVersion,
  });
  const recomputed = requireSha256Digest(
    sha256Port,
    canonicalSnapshot,
    'snapshot hash verification',
  );
  if (recomputed !== versionData.contractSnapshotHash) {
    throw new ContractDataCorruptionError(`${context}: contractSnapshotHash mismatch`);
  }

  return {
    currentVersionId: current.currentVersionId,
    versionData,
    sections,
    lockedFieldPaths,
    provenance,
  };
}

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
function assertValidExistingLockSet(
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

/**
 * 安全生成下一版本号：当前版本号非法或 +1 超出安全整数范围时，
 * 抛出安全 INTERNAL_ERROR，绝不构造 unsafe version number。
 */
function nextContractVersionNumber(current: number, context: string): number {
  if (!Number.isSafeInteger(current) || current < 1) {
    throw new ContractDataCorruptionError(`${context}: 当前版本号非法`);
  }
  const next = current + 1;
  if (!Number.isSafeInteger(next)) {
    throw new ContractDataCorruptionError(`${context}: 无法生成下一版本号（超出安全整数范围）`);
  }
  return next;
}

// ── 返回值构造 ────────────────────────────────────────────────

function buildVersionPublicData(
  projectId: string,
  newVersionId: string,
  now: string,
  newVersionNumber: number,
  basedOnGrillSessionId: string | null,
  basedOnGrillSessionVersion: number | null,
  sections: CreationContractSections,
  lockedFieldPaths: readonly string[],
  contractSnapshotHash: string,
  provenance: ReadonlyArray<ContractFieldProvenance>,
  createdBy: ContractVersionCreatedBy,
): ContractVersionPublicData {
  return {
    id: newVersionId,
    projectId,
    version: newVersionNumber,
    schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
    sourceProposalId: null,
    basedOnGrillSessionId,
    basedOnGrillSessionVersion,
    sections: sectionsToPublicData(sections),
    lockedFieldPaths: [...lockedFieldPaths],
    contractSnapshotHash,
    provenance: provenance.map((p) => ({
      sectionKey: p.sectionKey,
      source: p.source,
      grillAnswerIds: p.grillAnswerIds,
      grillProposalIds: p.grillProposalIds,
      aiTaskId: p.aiTaskId,
      modelInvocationId: p.modelInvocationId,
      sourceProposalId: p.sourceProposalId,
      previousFieldHash: p.previousFieldHash,
      rationale: p.rationale,
    })),
    createdAt: now,
    createdBy,
  };
}

// ── User Update provenance ────────────────────────────────────

/**
 * 方向性 provenance write-set 判定（与设计文档第 9 节 operation write-set 定义一致）：
 *
 * - scalar / list child operation（set-scalar、set-string-list）：
 *   write-set = 精确目标路径，仅 finalFieldPath === canonicalTargetPath 是 USER_EDIT。
 * - structured / entity 完整替换（set-structured、remove-field、upsert-*、remove-*）：
 *   write-set = 目标路径及其所有 descendant，不含 target 的 ancestor。
 *
 * ancestor 路径不得因子字段被编辑而标为 USER_EDIT；remove 后已删除字段
 * 不产生 tombstone，也不得为补偿删除而把 ancestor 标为 USER_EDIT。
 */
function operationAffectsProvenancePath(
  operation: ContractPatchOperation,
  finalFieldPath: string,
): boolean {
  const targetPath = getCanonicalTargetPath(operation);
  switch (operation.kind) {
    case 'set-scalar':
    case 'set-string-list':
      return finalFieldPath === targetPath;
    default:
      return finalFieldPath === targetPath || finalFieldPath.startsWith(targetPath + '/');
  }
}

function isFieldUserEdited(
  finalFieldPath: string,
  operations: ReadonlyArray<ContractPatchOperation>,
): boolean {
  return operations.some((op) => operationAffectsProvenancePath(op, finalFieldPath));
}

/**
 * 生成 User Update 的确定性 provenance。
 *
 * 对最终仍存在的每个 canonical field path：
 * - 位于 operation 的方向性 write-set 内（见 operationAffectsProvenancePath：
 *   scalar/list 仅精确目标路径；structured/entity 为目标 + descendants）：
 *   source = USER_EDIT，previousFieldHash = 应用前 current authoritative value
 *   的 canonical hash（此前缺失为 null）；sourceProposalId / aiTaskId /
 *   modelInvocationId / grillAnswerIds / grillProposalIds 从 previous provenance
 *   保留历史证据（无则 null/[]）；rationale = null。
 * - 未修改且与 current value 相同：source = PREVIOUS_VERSION，完整保留
 *   previous provenance evidence，不伪造当前 user 编辑为 AI 来源。
 *
 * 结果按 sectionKey code-point 排序；remove 后不存在的字段不产生 tombstone；
 * 与 operation 输入顺序无关。
 */
function generateUserUpdateProvenance(
  currentSections: CreationContractSections,
  resultSections: CreationContractSections,
  previousVersion: CreationContractVersionData,
  operations: ReadonlyArray<ContractPatchOperation>,
  sha256Port: CreationContractMutationDeps['sha256Port'],
): ReadonlyArray<ContractFieldProvenance> {
  const previousProvenanceMap = loadPreviousProvenanceMap(previousVersion);
  const result: ContractFieldProvenance[] = [];

  for (const path of collectAllFieldPaths(resultSections)) {
    if (isFieldUserEdited(path, operations)) {
      const currentValue = getFieldValueByPath(currentSections, path);
      const previousFieldHash =
        currentValue !== undefined
          ? requireSha256Digest(
              sha256Port,
              canonicalSerializeContractFieldValue(currentValue),
              `previousFieldHash for ${path}`,
            )
          : null;
      const prev = previousProvenanceMap?.get(path);
      result.push({
        sectionKey: path,
        source: 'USER_EDIT',
        grillAnswerIds: prev?.grillAnswerIds ?? [],
        grillProposalIds: prev?.grillProposalIds ?? [],
        aiTaskId: prev?.aiTaskId ?? null,
        modelInvocationId: prev?.modelInvocationId ?? null,
        sourceProposalId: prev?.sourceProposalId ?? null,
        previousFieldHash,
        rationale: null,
      });
      continue;
    }

    const prev = previousProvenanceMap?.get(path);
    result.push({
      sectionKey: path,
      source: 'PREVIOUS_VERSION' as ProvenanceSource,
      grillAnswerIds: prev?.grillAnswerIds ?? [],
      grillProposalIds: prev?.grillProposalIds ?? [],
      aiTaskId: prev?.aiTaskId ?? null,
      modelInvocationId: prev?.modelInvocationId ?? null,
      sourceProposalId: prev?.sourceProposalId ?? null,
      previousFieldHash: null,
      rationale: null,
    });
  }

  result.sort((a, b) => codePointCompare(a.sectionKey, b.sectionKey));
  return result;
}

// ── UpdateCreationContractByUser ─────────────────────────────

export function updateCreationContractByUser(
  deps: CreationContractMutationDeps,
  input: UpdateCreationContractByUserInput,
): ContractVersionPublicData {
  validateUpdateInput(input);
  const normalizedOperations = parseOperations(input.operations as ReadonlyArray<unknown>);

  return deps.transactionPort.runInTransaction((repos) => {
    const ctx = 'updateCreationContractByUser';

    const loaded = loadAndValidateCurrentVersion(
      repos,
      input.projectId,
      input.expectedContractVersion,
      ctx,
      deps.sha256Port,
    );
    const currentSections = loaded.sections;
    const currentLocks = loaded.lockedFieldPaths;
    assertValidExistingLockSet(currentLocks, loaded.sections);

    // write-set 与 active lock overlap → CONTRACT_LOCK_CONFLICT
    for (const op of normalizedOperations) {
      if (operationWriteSetConflictsWithLocks(op, currentLocks)) {
        throw new ContractLockConflictError(`${ctx}: operation 与锁定字段冲突`);
      }
    }

    // 应用现有 Domain ChangeSet（sourceSections = authoritativeBaseSections = current.sections）
    let resultSections: CreationContractSections;
    try {
      resultSections = applyContractPatchOperations(normalizedOperations, currentSections, {
        sourceSections: currentSections,
        authoritativeBaseSections: currentSections,
        lockedFieldPaths: currentLocks,
      });
    } catch (e) {
      if (e instanceof ContractLockConflictError) throw e;
      throw new ContractValidationError('operation 应用失败', e);
    }

    // 禁止创建无意义 identical version
    if (
      canonicalSerializeContractSections(resultSections) ===
      canonicalSerializeContractSections(currentSections)
    ) {
      throw new ContractValidationError(`${ctx}: 无语义变更，拒绝创建相同版本`);
    }

    // 确定性 provenance
    const provenance = generateUserUpdateProvenance(
      currentSections,
      resultSections,
      loaded.versionData,
      normalizedOperations,
      deps.sha256Port,
    );

    // snapshot hash（active lock set 保持不变）
    const canonicalSnapshot = canonicalSerializeContractSnapshot({
      sections: resultSections,
      lockedFieldPaths: currentLocks,
      schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
    });
    const snapshotHash = requireSha256Digest(deps.sha256Port, canonicalSnapshot, 'snapshot hash');

    const sectionsJson = canonicalSerializeContractSections(resultSections);
    const lockedFieldPathsJson = canonicalSerializeLockedFieldPaths(currentLocks as string[]);
    const provenanceJson = JSON.stringify(provenance);
    const newVersionNumber = nextContractVersionNumber(loaded.versionData.version, ctx);

    repos.versionRepo.create({
      id: input.newVersionId,
      projectId: input.projectId,
      version: newVersionNumber,
      schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
      sourceProposalId: null,
      basedOnGrillSessionId: loaded.versionData.basedOnGrillSessionId,
      basedOnGrillSessionVersion: loaded.versionData.basedOnGrillSessionVersion,
      sectionsJson,
      lockedFieldPathsJson,
      contractSnapshotHash: snapshotHash,
      provenanceJson,
      createdAt: input.now,
      createdBy: 'user',
    });

    const updated = repos.currentRepo.casUpdate(
      input.projectId,
      loaded.currentVersionId,
      input.newVersionId,
      input.now,
    );
    if (!updated) {
      throw new ContractVersionConflictError(`${ctx}: current pointer CAS failed`);
    }

    return buildVersionPublicData(
      input.projectId,
      input.newVersionId,
      input.now,
      newVersionNumber,
      loaded.versionData.basedOnGrillSessionId,
      loaded.versionData.basedOnGrillSessionVersion,
      resultSections,
      currentLocks,
      snapshotHash,
      provenance,
      'user',
    );
  });
}

// ── 共用 lock path 验证 ──────────────────────────────────────

/**
 * 解析并验证 lock field path。
 * - grammar：canonicalizeContractFieldPath（内部 parseContractFieldPath）
 * - raw fieldPath 必须等于 canonical path
 * - schema / entity 存在性 / absent optional 规则：validateNewLockPath
 * 失败均映射为 CONTRACT_VALIDATION_FAILED。
 */
function parseCanonicalLockPath(fieldPath: string, context: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = canonicalizeContractFieldPath(fieldPath);
  } catch (e) {
    throw new ContractValidationError(`${context}: lock path 解析失败`, e);
  }
  if (fieldPath !== canonicalPath) {
    throw new ContractValidationError(`${context}: fieldPath 必须为 canonical path`);
  }
  return canonicalPath;
}

// ── LockCreationContractField ────────────────────────────────

export function lockCreationContractField(
  deps: CreationContractMutationDeps,
  input: LockCreationContractFieldInput,
): ContractVersionPublicData {
  validateLockInput(input);

  return deps.transactionPort.runInTransaction((repos) => {
    const ctx = 'lockCreationContractField';

    const loaded = loadAndValidateCurrentVersion(
      repos,
      input.projectId,
      input.expectedContractVersion,
      ctx,
      deps.sha256Port,
    );
    assertValidExistingLockSet(loaded.lockedFieldPaths, loaded.sections);

    const canonicalPath = parseCanonicalLockPath(input.fieldPath, ctx);

    // 验证 path 可锁（schema / entity 存在性 / absent optional 规则）
    try {
      validateNewLockPath(canonicalPath, [], loaded.sections);
    } catch (e) {
      throw new ContractValidationError(`${ctx}: lock path 不可锁定`, e);
    }

    // 与所有 existing locks 的 symmetric overlap → CONTRACT_LOCK_CONFLICT
    for (const existing of loaded.lockedFieldPaths) {
      if (pathsOverlap(canonicalPath, existing)) {
        throw new ContractLockConflictError(`${ctx}: 与现有 lock 重叠`);
      }
    }

    const newLocks = [...loaded.lockedFieldPaths, canonicalPath].sort(codePointCompare);

    // sections / provenance 完全不变（canonical bytes 原样传递）
    const sectionsJson = loaded.versionData.sectionsJson;
    const provenanceJson = loaded.versionData.provenanceJson;
    const lockedFieldPathsJson = canonicalSerializeLockedFieldPaths(newLocks);

    const canonicalSnapshot = canonicalSerializeContractSnapshot({
      sections: loaded.sections,
      lockedFieldPaths: newLocks,
      schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
    });
    const snapshotHash = requireSha256Digest(deps.sha256Port, canonicalSnapshot, 'snapshot hash');
    const newVersionNumber = nextContractVersionNumber(loaded.versionData.version, ctx);

    repos.versionRepo.create({
      id: input.newVersionId,
      projectId: input.projectId,
      version: newVersionNumber,
      schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
      sourceProposalId: null,
      basedOnGrillSessionId: loaded.versionData.basedOnGrillSessionId,
      basedOnGrillSessionVersion: loaded.versionData.basedOnGrillSessionVersion,
      sectionsJson,
      lockedFieldPathsJson,
      contractSnapshotHash: snapshotHash,
      provenanceJson,
      createdAt: input.now,
      createdBy: 'lock',
    });

    const updated = repos.currentRepo.casUpdate(
      input.projectId,
      loaded.currentVersionId,
      input.newVersionId,
      input.now,
    );
    if (!updated) {
      throw new ContractVersionConflictError(`${ctx}: current pointer CAS failed`);
    }

    repos.lockEventRepo.append({
      id: input.lockEventId,
      projectId: input.projectId,
      fieldPath: canonicalPath,
      action: 'LOCK',
      versionId: input.newVersionId,
      createdAt: input.now,
      createdBy: 'user',
    });

    return buildVersionPublicData(
      input.projectId,
      input.newVersionId,
      input.now,
      newVersionNumber,
      loaded.versionData.basedOnGrillSessionId,
      loaded.versionData.basedOnGrillSessionVersion,
      loaded.sections,
      newLocks,
      snapshotHash,
      loaded.provenance,
      'lock',
    );
  });
}

// ── UnlockCreationContractField ──────────────────────────────

export function unlockCreationContractField(
  deps: CreationContractMutationDeps,
  input: UnlockCreationContractFieldInput,
): ContractVersionPublicData {
  validateLockInput(input);

  return deps.transactionPort.runInTransaction((repos) => {
    const ctx = 'unlockCreationContractField';

    const loaded = loadAndValidateCurrentVersion(
      repos,
      input.projectId,
      input.expectedContractVersion,
      ctx,
      deps.sha256Port,
    );
    assertValidExistingLockSet(loaded.lockedFieldPaths, loaded.sections);

    const canonicalPath = parseCanonicalLockPath(input.fieldPath, ctx);

    // 精确 unlock：ancestor/descendant 都不是精确匹配
    if (!loaded.lockedFieldPaths.includes(canonicalPath)) {
      throw new ContractLockConflictError(`${ctx}: 路径未被精确锁定`);
    }

    const newLocks = loaded.lockedFieldPaths
      .filter((p) => p !== canonicalPath)
      .sort(codePointCompare);

    const sectionsJson = loaded.versionData.sectionsJson;
    const provenanceJson = loaded.versionData.provenanceJson;
    const lockedFieldPathsJson = canonicalSerializeLockedFieldPaths(newLocks);

    const canonicalSnapshot = canonicalSerializeContractSnapshot({
      sections: loaded.sections,
      lockedFieldPaths: newLocks,
      schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
    });
    const snapshotHash = requireSha256Digest(deps.sha256Port, canonicalSnapshot, 'snapshot hash');
    const newVersionNumber = nextContractVersionNumber(loaded.versionData.version, ctx);

    repos.versionRepo.create({
      id: input.newVersionId,
      projectId: input.projectId,
      version: newVersionNumber,
      schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
      sourceProposalId: null,
      basedOnGrillSessionId: loaded.versionData.basedOnGrillSessionId,
      basedOnGrillSessionVersion: loaded.versionData.basedOnGrillSessionVersion,
      sectionsJson,
      lockedFieldPathsJson,
      contractSnapshotHash: snapshotHash,
      provenanceJson,
      createdAt: input.now,
      createdBy: 'unlock',
    });

    const updated = repos.currentRepo.casUpdate(
      input.projectId,
      loaded.currentVersionId,
      input.newVersionId,
      input.now,
    );
    if (!updated) {
      throw new ContractVersionConflictError(`${ctx}: current pointer CAS failed`);
    }

    repos.lockEventRepo.append({
      id: input.lockEventId,
      projectId: input.projectId,
      fieldPath: canonicalPath,
      action: 'UNLOCK',
      versionId: input.newVersionId,
      createdAt: input.now,
      createdBy: 'user',
    });

    return buildVersionPublicData(
      input.projectId,
      input.newVersionId,
      input.now,
      newVersionNumber,
      loaded.versionData.basedOnGrillSessionId,
      loaded.versionData.basedOnGrillSessionVersion,
      loaded.sections,
      newLocks,
      snapshotHash,
      loaded.provenance,
      'unlock',
    );
  });
}
