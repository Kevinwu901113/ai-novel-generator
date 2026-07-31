/**
 * 创作契约 mutation 用例：Accept / Reject。
 *
 * 通过 CreationContractTransactionPort 在同一事务内执行所有读写，
 * 不依赖 node:sqlite、node:crypto 或具体 ProjectDatabase。
 */

import {
  validateCreationContractSections,
  canonicalSerializeContractSections,
  canonicalSerializeLockedFieldPaths,
  canonicalSerializeContractSnapshot,
  canonicalSerializeContractFieldValue,
  applyContractPatchOperations,
  parseContractPatchOperation,
  getCanonicalTargetPath,
  operationWriteSetConflictsWithLocks,
  pathsOverlap,
  isLowercaseSha256Hex,
  parseContractFieldPath,
  canonicalizeContractFieldPath,
  codePointCompare,
  CREATION_CONTRACT_SCHEMA_VERSION,
  type CreationContractSections,
  type ContractPatchOperation,
  type ContractFieldProvenance,
  type ProvenanceSource,
} from '@ai-novel/domain';
import type { ContractVersionPublicData, ProposalPublicData } from '@ai-novel/contracts';
import type {
  CreationContractTransactionPort,
  AcceptCreationContractProposalInput,
  RejectCreationContractProposalInput,
  CreationContractProposalData,
  CreationContractVersionData,
  Sha256Port,
} from './creation-contract-types.js';
import {
  ContractProposalNotFoundError,
  ContractProposalNotAcceptableError,
  ContractProposalStaleError,
  ContractVersionConflictError,
  ContractSchemaUnsupportedError,
  ContractDataCorruptionError,
  ContractModelLockViolationError,
  ContractLockConflictError,
  ContractValidationError,
  ValidationError,
} from './errors.js';
import { parseProvenanceArray, validateIso8601Timestamp } from './creation-contract-validation.js';

// ── 依赖 ──────────────────────────────────────────────────────

export interface CreationContractMutationDeps {
  readonly transactionPort: CreationContractTransactionPort;
  readonly sha256Port: Sha256Port;
}

// ── 内部辅助 ──────────────────────────────────────────────────

function parseSectionsJson(json: string, context: string): CreationContractSections {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new ContractDataCorruptionError(`${context}: sectionsJson is not valid JSON`, e);
  }
  try {
    return validateCreationContractSections(parsed);
  } catch (e) {
    throw new ContractDataCorruptionError(`${context}: sectionsJson validation failed`, e);
  }
}

function parseLockedFieldPathsJson(json: string, context: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new ContractDataCorruptionError(`${context}: lockedFieldPathsJson is not valid JSON`, e);
  }
  if (!Array.isArray(parsed)) {
    throw new ContractDataCorruptionError(`${context}: lockedFieldPathsJson must be an array`);
  }
  const result: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') {
      throw new ContractDataCorruptionError(`${context}: lockedFieldPaths item is not a string`);
    }
    try {
      const canonical = canonicalizeContractFieldPath(item);
      parseContractFieldPath(canonical);
      result.push(canonical);
    } catch {
      throw new ContractDataCorruptionError(`${context}: invalid locked field path "${item}"`);
    }
  }
  return result;
}

function validateProposalForMutation(
  proposal: CreationContractProposalData | null,
  projectId: string,
  proposalId: string,
  context: string,
): CreationContractProposalData {
  if (!proposal) {
    throw new ContractProposalNotFoundError(proposalId);
  }
  if (proposal.projectId !== projectId) {
    throw new ContractProposalNotFoundError(proposalId);
  }
  if (proposal.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
    throw new ContractSchemaUnsupportedError(
      `${context}: unsupported proposal schemaVersion ${proposal.schemaVersion}`,
    );
  }
  if (
    !Number.isSafeInteger(proposal.baseGrillSessionVersion) ||
    proposal.baseGrillSessionVersion < 1
  ) {
    throw new ContractDataCorruptionError(
      `${context}: baseGrillSessionVersion must be positive integer`,
    );
  }
  if (
    proposal.baseContractVersion !== null &&
    (!Number.isSafeInteger(proposal.baseContractVersion) || proposal.baseContractVersion < 1)
  ) {
    throw new ContractDataCorruptionError(
      `${context}: baseContractVersion must be null or positive integer`,
    );
  }
  return proposal;
}

function sectionsToPublicData(
  sections: CreationContractSections,
): import('@ai-novel/contracts').CreationContractSectionsPublicData {
  return {
    premise: sections.premise,
    genre: sections.genre,
    tone: sections.tone,
    ...(sections.themes !== undefined && { themes: sections.themes }),
    targetAudience: sections.targetAudience,
    narrativePov: sections.narrativePov,
    tense: sections.tense,
    ...(sections.targetLength !== undefined && {
      targetLength: { unit: sections.targetLength.unit, value: sections.targetLength.value },
    }),
    ...(sections.structure !== undefined && { structure: sections.structure }),
    protagonist: {
      characterKey: sections.protagonist.characterKey,
      name: sections.protagonist.name,
      ...(sections.protagonist.role !== undefined && { role: sections.protagonist.role }),
      ...(sections.protagonist.motivation !== undefined && {
        motivation: sections.protagonist.motivation,
      }),
      ...(sections.protagonist.arc !== undefined && { arc: sections.protagonist.arc }),
      ...(sections.protagonist.traits !== undefined && { traits: sections.protagonist.traits }),
    },
    ...(sections.supportingCharacters !== undefined && {
      supportingCharacters: sections.supportingCharacters.map((c) => ({
        characterKey: c.characterKey,
        name: c.name,
        ...(c.role !== undefined && { role: c.role }),
        ...(c.relationship !== undefined && { relationship: c.relationship }),
        ...(c.traits !== undefined && { traits: c.traits }),
      })),
    }),
    ...(sections.relationships !== undefined && {
      relationships: sections.relationships.map((r) => ({
        relationshipKey: r.relationshipKey,
        fromCharacterKey: r.fromCharacterKey,
        toCharacterKey: r.toCharacterKey,
        type: r.type,
        ...(r.dynamic !== undefined && { dynamic: r.dynamic }),
      })),
    }),
    ...(sections.worldRules !== undefined && { worldRules: sections.worldRules }),
    ...(sections.mustInclude !== undefined && { mustInclude: sections.mustInclude }),
    ...(sections.mustAvoid !== undefined && { mustAvoid: sections.mustAvoid }),
    ...(sections.contentBoundaries !== undefined && {
      contentBoundaries: {
        ...(sections.contentBoundaries.rating !== undefined && {
          rating: sections.contentBoundaries.rating,
        }),
        ...(sections.contentBoundaries.allowedContent !== undefined && {
          allowedContent: sections.contentBoundaries.allowedContent,
        }),
        ...(sections.contentBoundaries.prohibitedContent !== undefined && {
          prohibitedContent: sections.contentBoundaries.prohibitedContent,
        }),
        ...(sections.contentBoundaries.notes !== undefined && {
          notes: sections.contentBoundaries.notes,
        }),
      },
    }),
    ...(sections.unresolvedQuestions !== undefined && {
      unresolvedQuestions: sections.unresolvedQuestions,
    }),
  };
}

// ── Field value access ────────────────────────────────────────

function getFieldValueByPath(sections: CreationContractSections, path: string): unknown {
  const parsed = parseContractFieldPath(path);
  const rec = sections as unknown as Record<string, unknown>;

  if (parsed.entityKey !== undefined && parsed.field !== undefined) {
    const collection = rec[parsed.section];
    if (!Array.isArray(collection)) return undefined;
    const keyField = parsed.section === 'supportingCharacters' ? 'characterKey' : 'relationshipKey';
    const item = collection.find(
      (i: unknown) => (i as Record<string, unknown>)[keyField] === parsed.entityKey,
    );
    if (!item) return undefined;
    return (item as Record<string, unknown>)[parsed.field];
  }

  if (parsed.entityKey !== undefined) {
    const collection = rec[parsed.section];
    if (!Array.isArray(collection)) return undefined;
    const keyField = parsed.section === 'supportingCharacters' ? 'characterKey' : 'relationshipKey';
    return collection.find(
      (i: unknown) => (i as Record<string, unknown>)[keyField] === parsed.entityKey,
    );
  }

  if (parsed.field !== undefined) {
    const section = rec[parsed.section];
    if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined;
    return (section as Record<string, unknown>)[parsed.field];
  }

  return rec[parsed.section];
}

// ── Locked proposal source validation ─────────────────────────

function validateProposalAgainstLocks(
  proposalSections: CreationContractSections,
  baselineSections: CreationContractSections | null,
  lockedFieldPaths: readonly string[],
): void {
  for (const lockedPath of lockedFieldPaths) {
    const baselineValue = baselineSections
      ? getFieldValueByPath(baselineSections, lockedPath)
      : undefined;
    const proposalValue = getFieldValueByPath(proposalSections, lockedPath);

    const baselineAbsent = baselineValue === undefined;
    const proposalAbsent = proposalValue === undefined;

    if (baselineAbsent && proposalAbsent) continue;

    if (baselineAbsent !== proposalAbsent) {
      throw new ContractModelLockViolationError(
        `proposal 违反锁定字段 "${lockedPath}": 存在性变更`,
      );
    }

    const baselineCanonical = canonicalSerializeContractFieldValue(baselineValue);
    const proposalCanonical = canonicalSerializeContractFieldValue(proposalValue);

    if (baselineCanonical !== proposalCanonical) {
      throw new ContractModelLockViolationError(`proposal 违反锁定字段 "${lockedPath}": 值已变更`);
    }
  }
}

// ── Provenance 生成 ──────────────────────────────────────────

function collectAllFieldPaths(sections: CreationContractSections): string[] {
  const paths: string[] = [];
  const rec = sections as unknown as Record<string, unknown>;

  for (const key of Object.keys(rec)) {
    const value = rec[key];
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      paths.push(`/${key}`);
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          const itemRec = item as Record<string, unknown>;
          const stableKey = itemRec.characterKey || itemRec.relationshipKey;
          if (typeof stableKey === 'string') {
            for (const field of Object.keys(itemRec)) {
              if (field !== 'characterKey' && field !== 'relationshipKey') {
                paths.push(`/${key}/${stableKey}/${field}`);
              }
            }
          }
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      paths.push(`/${key}`);
      for (const child of Object.keys(value as Record<string, unknown>)) {
        paths.push(`/${key}/${child}`);
      }
    } else {
      paths.push(`/${key}`);
    }
  }

  return paths;
}

function isPathInOperationWriteSet(
  fieldPath: string,
  operations: ReadonlyArray<ContractPatchOperation>,
): boolean {
  for (const op of operations) {
    const targetPath = getCanonicalTargetPath(op);
    if (pathsOverlap(targetPath, fieldPath)) return true;
  }
  return false;
}

function generateProvenance(
  proposal: CreationContractProposalData,
  sourceSections: CreationContractSections,
  resultSections: CreationContractSections,
  baselineSections: CreationContractSections | null,
  previousVersion: CreationContractVersionData | null,
  operations: ReadonlyArray<ContractPatchOperation>,
  sha256Port: Sha256Port,
): ReadonlyArray<ContractFieldProvenance> {
  const result: ContractFieldProvenance[] = [];

  const previousProvenanceMap = loadPreviousProvenanceMap(previousVersion);
  const allPaths = collectAllFieldPaths(resultSections);

  for (const path of allPaths) {
    const isUserEdit = isPathInOperationWriteSet(path, operations);

    if (isUserEdit) {
      const proposalValue = getFieldValueByPath(sourceSections, path);
      const previousFieldHash =
        proposalValue !== undefined
          ? requireSha256Digest(
              sha256Port,
              canonicalSerializeContractFieldValue(proposalValue),
              `previousFieldHash for ${path}`,
            )
          : null;

      result.push({
        sectionKey: path,
        source: 'USER_EDIT',
        grillAnswerIds: [],
        grillProposalIds: [],
        aiTaskId: proposal.taskId,
        modelInvocationId: proposal.invocationId,
        sourceProposalId: proposal.id,
        previousFieldHash,
        rationale: null,
      });
      continue;
    }

    const proposalValue = getFieldValueByPath(sourceSections, path);
    const baselineValue = baselineSections
      ? getFieldValueByPath(baselineSections, path)
      : undefined;

    const isFirstContract = baselineSections === null;
    const proposalAbsent = proposalValue === undefined;
    const baselineAbsent = baselineValue === undefined;

    let isUnchanged = false;
    if (!isFirstContract && !proposalAbsent && !baselineAbsent) {
      const proposalCanonical = canonicalSerializeContractFieldValue(proposalValue);
      const baselineCanonical = canonicalSerializeContractFieldValue(baselineValue);
      isUnchanged = proposalCanonical === baselineCanonical;
    } else if (!isFirstContract && proposalAbsent && baselineAbsent) {
      isUnchanged = true;
    }

    if (isFirstContract || !isUnchanged) {
      result.push({
        sectionKey: path,
        source: 'AI_PROPOSAL',
        grillAnswerIds: [],
        grillProposalIds: [],
        aiTaskId: proposal.taskId,
        modelInvocationId: proposal.invocationId,
        sourceProposalId: proposal.id,
        previousFieldHash: null,
        rationale: null,
      });
    } else {
      const prevEntry = previousProvenanceMap?.get(path);
      result.push({
        sectionKey: path,
        source: 'PREVIOUS_VERSION' as ProvenanceSource,
        grillAnswerIds: prevEntry?.grillAnswerIds ?? [],
        grillProposalIds: prevEntry?.grillProposalIds ?? [],
        aiTaskId: prevEntry?.aiTaskId ?? null,
        modelInvocationId: prevEntry?.modelInvocationId ?? null,
        sourceProposalId: prevEntry?.sourceProposalId ?? null,
        previousFieldHash: null,
        rationale: null,
      });
    }
  }

  result.sort((a, b) => codePointCompare(a.sectionKey, b.sectionKey));
  return result;
}

function loadPreviousProvenanceMap(
  previousVersion: CreationContractVersionData | null,
): Map<string, ContractFieldProvenance> | null {
  if (!previousVersion) return null;
  // 权威 version provenance 损坏必须抛出，不能降级成空 provenance。
  // 共享严格 parser 校验 key 集合/canonical sectionKey/source/ID 数组/
  // nullable 字段/previousFieldHash/排序，损坏时抛 ContractDataCorruptionError。
  const parsed = parseProvenanceArray(previousVersion.provenanceJson, 'loadPreviousProvenanceMap');
  const map = new Map<string, ContractFieldProvenance>();
  for (const entry of parsed) {
    map.set(entry.sectionKey, entry);
  }
  return map;
}

// ── 输入验证 ──────────────────────────────────────────────────

function validateAcceptInput(input: AcceptCreationContractProposalInput): void {
  if (typeof input.projectId !== 'string' || input.projectId.trim().length === 0) {
    throw new ValidationError('projectId 必须是非空字符串');
  }
  if (typeof input.proposalId !== 'string' || input.proposalId.trim().length === 0) {
    throw new ValidationError('proposalId 必须是非空字符串');
  }
  if (typeof input.newVersionId !== 'string' || input.newVersionId.trim().length === 0) {
    throw new ValidationError('newVersionId 必须是非空字符串');
  }
  if (!isLowercaseSha256Hex(input.expectedProposalSectionsHash)) {
    throw new ValidationError('expectedProposalSectionsHash 必须是 lowercase SHA-256 hex');
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
  validateIso8601Timestamp(input.now, 'now');
  if (!Array.isArray(input.operations)) {
    throw new ValidationError('operations 必须是数组');
  }
}

function validateRejectInput(input: RejectCreationContractProposalInput): void {
  if (typeof input.projectId !== 'string' || input.projectId.trim().length === 0) {
    throw new ValidationError('projectId 必须是非空字符串');
  }
  if (typeof input.proposalId !== 'string' || input.proposalId.trim().length === 0) {
    throw new ValidationError('proposalId 必须是非空字符串');
  }
  if (!isLowercaseSha256Hex(input.expectedProposalSectionsHash)) {
    throw new ValidationError('expectedProposalSectionsHash 必须是 lowercase SHA-256 hex');
  }
  validateIso8601Timestamp(input.now, 'now');
}

function parseOperations(
  rawOperations: ReadonlyArray<unknown>,
): ReadonlyArray<ContractPatchOperation> {
  const result: ContractPatchOperation[] = [];
  for (let i = 0; i < rawOperations.length; i++) {
    try {
      result.push(parseContractPatchOperation(rawOperations[i]));
    } catch (e) {
      throw new ContractValidationError(`operation[${i}] 解析失败`, e);
    }
  }
  return result;
}

/**
 * Sha256Port 输出验证：version create 前必须确保 adapter 返回
 * lowercase SHA-256 hex。adapter 输出无效时抛出稳定 INTERNAL_ERROR，
 * 由外层事务回滚 proposal CAS。
 */
function requireSha256Digest(port: Sha256Port, input: string, detail: string): string {
  const digest = port.digestUtf8(input);
  if (!isLowercaseSha256Hex(digest)) {
    throw new ContractDataCorruptionError(`sha256 port 返回无效输出 (${detail})`);
  }
  return digest;
}

// ── AcceptCreationContractProposal ───────────────────────────

export function acceptCreationContractProposal(
  deps: CreationContractMutationDeps,
  input: AcceptCreationContractProposalInput,
): ContractVersionPublicData {
  validateAcceptInput(input);

  const normalizedOperations = parseOperations(input.operations as ReadonlyArray<unknown>);

  return deps.transactionPort.runInTransaction((repos) => {
    const ctx = 'acceptCreationContractProposal';

    // ── Phase 1: precondition reads ──

    // 1. Project 存在性
    if (!repos.projectExistsReadPort.exists(input.projectId)) {
      throw new ContractProposalNotFoundError(input.proposalId);
    }

    // 2. 读取 proposal
    const proposalRaw = repos.proposalRepo.getById(input.projectId, input.proposalId);
    const proposal = validateProposalForMutation(
      proposalRaw,
      input.projectId,
      input.proposalId,
      ctx,
    );

    // 3. Proposal status = PROPOSED
    if (proposal.status !== 'PROPOSED') {
      throw new ContractProposalNotAcceptableError(
        `${ctx}: proposal status is "${proposal.status}", expected "PROPOSED"`,
      );
    }

    // 4. Proposal sectionsHash 匹配
    if (proposal.sectionsHash !== input.expectedProposalSectionsHash) {
      throw new ContractProposalStaleError(`${ctx}: proposal sectionsHash mismatch`);
    }

    // 5. SchemaVersion 支持
    if (proposal.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
      throw new ContractSchemaUnsupportedError(
        `${ctx}: unsupported schemaVersion ${proposal.schemaVersion}`,
      );
    }

    // 6. Grill session version 匹配
    const currentGrillVersion = repos.grillSessionVersionReadPort.getVersion(
      input.projectId,
      proposal.baseGrillSessionId,
    );
    if (currentGrillVersion === null) {
      throw new ContractProposalStaleError(
        `${ctx}: grill session ${proposal.baseGrillSessionId} not found`,
      );
    }
    if (currentGrillVersion !== input.expectedGrillSessionVersion) {
      throw new ContractProposalStaleError(`${ctx}: grill session version mismatch`);
    }
    if (proposal.baseGrillSessionVersion !== input.expectedGrillSessionVersion) {
      throw new ContractProposalStaleError(`${ctx}: proposal baseGrillSessionVersion mismatch`);
    }

    // 7. 当前 contract version 与 expectedContractVersion 一致
    const currentPointer = repos.currentRepo.get(input.projectId);
    const isFirstContract = currentPointer === null;

    let currentVersionData: CreationContractVersionData | null = null;

    if (isFirstContract) {
      if (input.expectedContractVersion !== null) {
        throw new ContractVersionConflictError(
          `${ctx}: expected first contract but expectedContractVersion is not null`,
        );
      }
      if (proposal.baseContractVersion !== null) {
        throw new ContractProposalStaleError(
          `${ctx}: first contract but proposal baseContractVersion is not null`,
        );
      }
    } else {
      if (input.expectedContractVersion === null) {
        throw new ContractVersionConflictError(
          `${ctx}: contract exists but expectedContractVersion is null`,
        );
      }
      currentVersionData = repos.versionRepo.getById(
        input.projectId,
        currentPointer!.currentVersionId,
      );
      if (!currentVersionData) {
        throw new ContractDataCorruptionError(
          `${ctx}: current pointer references non-existent version`,
        );
      }
      if (currentVersionData.version !== input.expectedContractVersion) {
        throw new ContractVersionConflictError(`${ctx}: contract version mismatch`);
      }
      if (proposal.baseContractVersion !== input.expectedContractVersion) {
        throw new ContractProposalStaleError(`${ctx}: proposal baseContractVersion mismatch`);
      }
    }

    // 8. 读取 authoritative baseline
    let authoritativeBaseSections: CreationContractSections | null = null;
    let currentLockedFieldPaths: readonly string[] = [];
    if (currentVersionData) {
      authoritativeBaseSections = parseSectionsJson(currentVersionData.sectionsJson, ctx);
      currentLockedFieldPaths = parseLockedFieldPathsJson(
        currentVersionData.lockedFieldPathsJson,
        ctx,
      );
    }

    // 9. 构造 source sections from proposal
    const sourceSections = parseSectionsJson(proposal.sectionsJson, ctx);

    // ── Phase 2: locked proposal source validation ──

    validateProposalAgainstLocks(
      sourceSections,
      authoritativeBaseSections,
      currentLockedFieldPaths,
    );

    // 10. protagonist.characterKey 一致性检查（即使没有 upsert-protagonist operation）
    if (authoritativeBaseSections !== null) {
      if (
        sourceSections.protagonist.characterKey !==
        authoritativeBaseSections.protagonist.characterKey
      ) {
        throw new ContractValidationError(
          `${ctx}: proposal protagonist.characterKey 与 authoritative baseline 不一致`,
        );
      }
    }

    // ── Phase 3: proposal CAS (PROPOSED → ACCEPTED) ──

    const transitioned = repos.proposalRepo.transitionStatusWithHash(
      input.projectId,
      input.proposalId,
      'PROPOSED',
      input.expectedProposalSectionsHash,
      'ACCEPTED',
      input.now,
    );
    if (!transitioned) {
      throw new ContractProposalStaleError(`${ctx}: proposal status CAS failed`);
    }

    // ── Phase 4: parse/apply operations ──

    // Pre-check: user review operations vs locks
    for (const op of normalizedOperations) {
      if (operationWriteSetConflictsWithLocks(op, currentLockedFieldPaths)) {
        throw new ContractLockConflictError(
          `review operation "${getCanonicalTargetPath(op)}" 与锁定字段冲突`,
        );
      }
    }

    let resultSections: CreationContractSections;
    try {
      if (normalizedOperations.length === 0) {
        resultSections = validateCreationContractSections(sourceSections);
      } else {
        resultSections = applyContractPatchOperations(normalizedOperations, sourceSections, {
          sourceSections,
          authoritativeBaseSections,
          lockedFieldPaths: currentLockedFieldPaths,
        });
      }
    } catch (e) {
      if (
        e instanceof ContractLockConflictError ||
        e instanceof ContractModelLockViolationError ||
        e instanceof ContractValidationError
      ) {
        throw e;
      }
      throw new ContractValidationError('operation 应用失败', e);
    }

    // ── Phase 5: provenance ──

    const provenance = generateProvenance(
      proposal,
      sourceSections,
      resultSections,
      authoritativeBaseSections,
      currentVersionData,
      normalizedOperations,
      deps.sha256Port,
    );

    // ── Phase 6: snapshot hash ──

    const canonicalSnapshot = canonicalSerializeContractSnapshot({
      sections: resultSections,
      lockedFieldPaths: currentLockedFieldPaths,
      schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
    });
    const snapshotHash = requireSha256Digest(deps.sha256Port, canonicalSnapshot, 'snapshot hash');

    // ── Phase 7: serialize ──

    const sectionsJson = canonicalSerializeContractSections(resultSections);
    const lockedFieldPathsJson = canonicalSerializeLockedFieldPaths(
      currentLockedFieldPaths as string[],
    );
    const provenanceJson = JSON.stringify(provenance);

    // ── Phase 8: compute version number ──

    const newVersionNumber = isFirstContract ? 1 : currentVersionData!.version + 1;

    // ── Phase 9: insert version ──

    repos.versionRepo.create({
      id: input.newVersionId,
      projectId: input.projectId,
      version: newVersionNumber,
      schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
      sourceProposalId: proposal.id,
      basedOnGrillSessionId: proposal.baseGrillSessionId,
      basedOnGrillSessionVersion: proposal.baseGrillSessionVersion,
      sectionsJson,
      lockedFieldPathsJson,
      contractSnapshotHash: snapshotHash,
      provenanceJson,
      createdAt: input.now,
      createdBy: 'ai-proposal-accepted',
    });

    // ── Phase 10: insertFirst / current CAS ──

    if (isFirstContract) {
      const inserted = repos.currentRepo.insertFirst(
        input.projectId,
        input.newVersionId,
        input.now,
      );
      if (!inserted) {
        throw new ContractVersionConflictError(
          `${ctx}: concurrent first contract creation detected`,
        );
      }
    } else {
      const updated = repos.currentRepo.casUpdate(
        input.projectId,
        currentPointer!.currentVersionId,
        input.newVersionId,
        input.now,
      );
      if (!updated) {
        throw new ContractVersionConflictError(`${ctx}: current pointer CAS failed`);
      }
    }

    // ── Phase 11: return result ──

    return {
      id: input.newVersionId,
      projectId: input.projectId,
      version: newVersionNumber,
      schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
      sourceProposalId: proposal.id,
      basedOnGrillSessionId: proposal.baseGrillSessionId,
      basedOnGrillSessionVersion: proposal.baseGrillSessionVersion,
      sections: sectionsToPublicData(resultSections),
      lockedFieldPaths: [...currentLockedFieldPaths],
      contractSnapshotHash: snapshotHash,
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
      createdAt: input.now,
      createdBy: 'ai-proposal-accepted',
    };
  });
}

// ── RejectCreationContractProposal ───────────────────────────

export function rejectCreationContractProposal(
  deps: CreationContractMutationDeps,
  input: RejectCreationContractProposalInput,
): ProposalPublicData {
  validateRejectInput(input);

  return deps.transactionPort.runInTransaction((repos) => {
    const ctx = 'rejectCreationContractProposal';

    // 1. Project 存在性
    if (!repos.projectExistsReadPort.exists(input.projectId)) {
      throw new ContractProposalNotFoundError(input.proposalId);
    }

    // 2. 读取 proposal
    const proposalRaw = repos.proposalRepo.getById(input.projectId, input.proposalId);
    const proposal = validateProposalForMutation(
      proposalRaw,
      input.projectId,
      input.proposalId,
      ctx,
    );

    // 3. Proposal status = PROPOSED
    if (proposal.status !== 'PROPOSED') {
      throw new ContractProposalNotAcceptableError(
        `${ctx}: proposal status is "${proposal.status}", expected "PROPOSED"`,
      );
    }

    // 4. sectionsHash 匹配
    if (proposal.sectionsHash !== input.expectedProposalSectionsHash) {
      throw new ContractProposalStaleError(`${ctx}: proposal sectionsHash mismatch`);
    }

    // 5. SchemaVersion 支持
    if (proposal.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
      throw new ContractSchemaUnsupportedError(
        `${ctx}: unsupported schemaVersion ${proposal.schemaVersion}`,
      );
    }

    // 6. Transition PROPOSED → REJECTED
    const transitioned = repos.proposalRepo.transitionStatusWithHash(
      input.projectId,
      input.proposalId,
      'PROPOSED',
      input.expectedProposalSectionsHash,
      'REJECTED',
      input.now,
    );
    if (!transitioned) {
      throw new ContractProposalStaleError(`${ctx}: proposal status CAS failed`);
    }

    // 7. 返回更新后的 proposal
    const sections = parseSectionsJson(proposal.sectionsJson, ctx);
    return {
      id: proposal.id,
      projectId: proposal.projectId,
      taskId: proposal.taskId,
      invocationId: proposal.invocationId,
      status: 'REJECTED',
      baseGrillSessionId: proposal.baseGrillSessionId,
      baseGrillSessionVersion: proposal.baseGrillSessionVersion,
      baseContractVersion: proposal.baseContractVersion,
      schemaVersion: proposal.schemaVersion,
      sections: sectionsToPublicData(sections),
      sectionsHash: proposal.sectionsHash,
      createdAt: proposal.createdAt,
      updatedAt: input.now,
    };
  });
}
