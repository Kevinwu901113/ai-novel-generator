/**
 * 创作契约 mutation 用例：Accept / Reject。
 *
 * 通过 CreationContractTransactionPort 在同一事务内执行所有读写，
 * 不直接依赖 node:sqlite 或具体 ProjectDatabase。
 */

import {
  validateCreationContractSections,
  canonicalSerializeContractSections,
  canonicalSerializeLockedFieldPaths,
  canonicalSerializeContractSnapshot,
  applyContractPatchOperations,
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
import { createHash } from 'node:crypto';
import type {
  CreationContractTransactionPort,
  AcceptCreationContractProposalInput,
  RejectCreationContractProposalInput,
  CreationContractProposalData,
} from './creation-contract-types.js';
import {
  ContractProposalNotFoundError,
  ContractProposalNotAcceptableError,
  ContractProposalStaleError,
  ContractVersionConflictError,
  ContractSchemaUnsupportedError,
  ContractDataCorruptionError,
  ValidationError,
} from './errors.js';

// ── 依赖 ──────────────────────────────────────────────────────

export interface CreationContractMutationDeps {
  readonly transactionPort: CreationContractTransactionPort;
}

// ── SHA-256 辅助 ──────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ── 内部辅助 ──────────────────────────────────────────────────

function parseSectionsJson(json: string, context: string): CreationContractSections {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ContractDataCorruptionError(`${context}: sectionsJson is not valid JSON`);
  }
  try {
    return validateCreationContractSections(parsed);
  } catch (e) {
    throw new ContractDataCorruptionError(
      `${context}: sectionsJson validation failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function parseLockedFieldPathsJson(json: string, context: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ContractDataCorruptionError(`${context}: lockedFieldPathsJson is not valid JSON`);
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

// ── Provenance 生成 ──────────────────────────────────────────

function computeFieldHash(value: unknown): string {
  const canonical = JSON.stringify(value);
  return sha256Hex(canonical);
}

function generateProvenance(
  proposal: CreationContractProposalData,
  sourceSections: CreationContractSections,
  resultSections: CreationContractSections,
  previousSections: CreationContractSections | null,
  operations: ReadonlyArray<ContractPatchOperation>,
): ReadonlyArray<ContractFieldProvenance> {
  const result: ContractFieldProvenance[] = [];

  // 收集 operations 涉及的 canonical paths
  const operatedPaths = new Set<string>();
  for (const op of operations) {
    const parsed = parseOperationTargetPath(op);
    if (parsed) operatedPaths.add(parsed);
  }

  // 遍历 result sections 的所有 canonical field paths
  const allPaths = collectAllFieldPaths(resultSections);

  for (const path of allPaths) {
    const source = determineProvenanceSource(path, operatedPaths, previousSections, sourceSections);
    const previousFieldHash = computePreviousFieldHash(path, previousSections);

    result.push({
      sectionKey: path,
      source,
      grillAnswerIds: [],
      grillProposalIds: [],
      aiTaskId: proposal.taskId,
      modelInvocationId: proposal.invocationId,
      sourceProposalId: proposal.id,
      previousFieldHash,
      rationale: null,
    });
  }

  // 按 sectionKey code-point 排序
  result.sort((a, b) => codePointCompare(a.sectionKey, b.sectionKey));
  return result;
}

function parseOperationTargetPath(op: ContractPatchOperation): string | null {
  switch (op.kind) {
    case 'set-scalar':
    case 'set-string-list':
    case 'set-structured':
    case 'remove-field':
      return canonicalizeContractFieldPath(op.path);
    case 'upsert-protagonist':
      return '/protagonist';
    case 'upsert-supporting-character':
    case 'remove-character':
      return `/supportingCharacters/${op.target}`;
    case 'upsert-relationship':
    case 'remove-relationship':
      return `/relationships/${op.target}`;
    default:
      return null;
  }
}

function collectAllFieldPaths(sections: CreationContractSections): string[] {
  const paths: string[] = [];
  const rec = sections as unknown as Record<string, unknown>;

  for (const key of Object.keys(rec)) {
    const value = rec[key];
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      // collection: protagonist is not array, but supportingCharacters/relationships are
      paths.push(`/${key}`);
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          const itemRec = item as Record<string, unknown>;
          // find the stable key
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
      // structured
      paths.push(`/${key}`);
      for (const child of Object.keys(value as Record<string, unknown>)) {
        paths.push(`/${key}/${child}`);
      }
    } else {
      // scalar
      paths.push(`/${key}`);
    }
  }

  return paths;
}

function determineProvenanceSource(
  path: string,
  operatedPaths: Set<string>,
  previousSections: CreationContractSections | null,
  _sourceSections: CreationContractSections,
): ProvenanceSource {
  // 如果该路径被 operations 修改过，来源是 AI_PROPOSAL
  // （因为 Accept 的 operations 是 review patch，但最终来源是 proposal）
  if (operatedPaths.has(path)) {
    return 'AI_PROPOSAL';
  }

  // 如果有 previousSections 且字段存在于 previous 中，来源是 PREVIOUS_VERSION
  if (previousSections && getFieldValueByPath(previousSections, path) !== undefined) {
    return 'PREVIOUS_VERSION';
  }

  // 否则来源于 AI proposal
  return 'AI_PROPOSAL';
}

function computePreviousFieldHash(
  path: string,
  previousSections: CreationContractSections | null,
): string | null {
  if (!previousSections) return null;
  const value = getFieldValueByPath(previousSections, path);
  if (value === undefined) return null;
  return computeFieldHash(value);
}

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
  if (typeof input.now !== 'string' || input.now.trim().length === 0) {
    throw new ValidationError('now 必须是非空字符串');
  }
  if (!Array.isArray(input.operations)) {
    throw new ValidationError('operations 必须是数组');
  }
  // operations 可以为空数组 — 表示原样接受 proposal
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
  if (typeof input.now !== 'string' || input.now.trim().length === 0) {
    throw new ValidationError('now 必须是非空字符串');
  }
}

// ── AcceptCreationContractProposal ───────────────────────────

export function acceptCreationContractProposal(
  deps: CreationContractMutationDeps,
  input: AcceptCreationContractProposalInput,
): ContractVersionPublicData {
  validateAcceptInput(input);

  return deps.transactionPort.runInTransaction((repos) => {
    const ctx = 'acceptCreationContractProposal';

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
      throw new ContractProposalStaleError(
        `${ctx}: grill session version mismatch: expected ${input.expectedGrillSessionVersion}, actual ${currentGrillVersion}`,
      );
    }
    if (proposal.baseGrillSessionVersion !== input.expectedGrillSessionVersion) {
      throw new ContractProposalStaleError(`${ctx}: proposal baseGrillSessionVersion mismatch`);
    }

    // 7. 当前 contract version 与 expectedContractVersion 一致
    const currentPointer = repos.currentRepo.get(input.projectId);
    const isFirstContract = currentPointer === null;

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
      // 读取当前 version 获取 version number
      const currentVersion = repos.versionRepo.getById(
        input.projectId,
        currentPointer!.currentVersionId,
      );
      if (!currentVersion) {
        throw new ContractDataCorruptionError(
          `${ctx}: current pointer references non-existent version ${currentPointer!.currentVersionId}`,
        );
      }
      if (currentVersion.version !== input.expectedContractVersion) {
        throw new ContractVersionConflictError(
          `${ctx}: contract version mismatch: expected ${input.expectedContractVersion}, actual ${currentVersion.version}`,
        );
      }
      if (proposal.baseContractVersion !== input.expectedContractVersion) {
        throw new ContractProposalStaleError(`${ctx}: proposal baseContractVersion mismatch`);
      }
    }

    // 8. 读取 authoritative baseline (current version sections)
    let authoritativeBaseSections: CreationContractSections | null = null;
    let currentLockedFieldPaths: readonly string[] = [];
    if (!isFirstContract && currentPointer) {
      const currentVersion = repos.versionRepo.getById(
        input.projectId,
        currentPointer.currentVersionId,
      );
      if (currentVersion) {
        authoritativeBaseSections = parseSectionsJson(currentVersion.sectionsJson, ctx);
        currentLockedFieldPaths = parseLockedFieldPathsJson(
          currentVersion.lockedFieldPathsJson,
          ctx,
        );
      }
    }

    // 9. 构造 source sections from proposal
    const sourceSections = parseSectionsJson(proposal.sectionsJson, ctx);

    // 10. 应用 operations
    let resultSections: CreationContractSections;
    if (input.operations.length === 0) {
      // 空 operations = 原样接受 proposal sections
      resultSections = validateCreationContractSections(sourceSections);
    } else {
      resultSections = applyContractPatchOperations(input.operations, sourceSections, {
        sourceSections,
        authoritativeBaseSections,
        lockedFieldPaths: currentLockedFieldPaths,
      });
    }

    // 11. 生成 provenance
    const provenance = generateProvenance(
      proposal,
      sourceSections,
      resultSections,
      authoritativeBaseSections,
      input.operations,
    );

    // 12. 计算新 version number
    const newVersionNumber = isFirstContract
      ? 1
      : (() => {
          const currentVersion = repos.versionRepo.getById(
            input.projectId,
            currentPointer!.currentVersionId,
          );
          if (!currentVersion) {
            throw new ContractDataCorruptionError(
              `${ctx}: current pointer references non-existent version`,
            );
          }
          return currentVersion.version + 1;
        })();

    // 13. 计算 snapshot hash
    const canonicalSnapshot = canonicalSerializeContractSnapshot({
      sections: resultSections,
      lockedFieldPaths: currentLockedFieldPaths,
      schemaVersion: CREATION_CONTRACT_SCHEMA_VERSION,
    });
    const snapshotHash = sha256Hex(canonicalSnapshot);

    // 14. 序列化 sections
    const sectionsJson = canonicalSerializeContractSections(resultSections);
    const lockedFieldPathsJson = canonicalSerializeLockedFieldPaths(
      currentLockedFieldPaths as string[],
    );
    const provenanceJson = JSON.stringify(provenance);

    // 15. 插入 version
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

    // 16. 更新 current pointer (CAS)
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

    // 17. Transition proposal status
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

    // 18. 返回 result
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
