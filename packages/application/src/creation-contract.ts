import {
  validateCreationContractSections,
  canonicalizeContractFieldPath,
  parseContractFieldPath,
  isLowercaseSha256Hex,
  CREATION_CONTRACT_SCHEMA_VERSION,
  type CreationContractSections,
  type ProvenanceSource,
  type ProposalStatus,
  type ContractVersionCreatedBy,
} from '@ai-novel/domain';
import type {
  ContractVersionPublicData,
  ContractVersionSummary,
  ProposalPublicData,
  CreationContractSectionsPublicData,
  ContractFieldProvenanceDTO,
} from '@ai-novel/contracts';
import type {
  CreationContractProposalRepositoryPort,
  CreationContractVersionRepositoryPort,
  CreationContractCurrentRepositoryPort,
} from './creation-contract-types.js';
import {
  ContractProposalNotFoundError,
  ContractDataCorruptionError,
  ContractSchemaUnsupportedError,
} from './errors.js';

// ── 依赖 ──────────────────────────────────────────────────────

export interface CreationContractQueryDeps {
  readonly proposalRepo: CreationContractProposalRepositoryPort;
  readonly versionRepo: CreationContractVersionRepositoryPort;
  readonly currentRepo: CreationContractCurrentRepositoryPort;
}

// ── 辅助 ──────────────────────────────────────────────────────

const VALID_PROVENANCE_SOURCES: ReadonlySet<string> = new Set([
  'GRILL_ANSWER',
  'AI_PROPOSAL',
  'USER_EDIT',
  'PREVIOUS_VERSION',
  'DEFAULT',
]);

const VALID_PROPOSAL_STATUSES: ReadonlySet<string> = new Set([
  'PROPOSED',
  'ACCEPTED',
  'REJECTED',
  'SUPERSEDED',
  'STALE',
]);

const VALID_CREATED_BY: ReadonlySet<string> = new Set([
  'user',
  'ai-proposal-accepted',
  'lock',
  'unlock',
]);

function sectionsToPublicData(
  sections: CreationContractSections,
): CreationContractSectionsPublicData {
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

function parseLockedFieldPathsJson(json: string, context: string): ReadonlyArray<string> {
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

function parseProvenanceJson(json: string, context: string): ReadonlyArray<ContractFieldProvenanceDTO> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ContractDataCorruptionError(`${context}: provenanceJson is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new ContractDataCorruptionError(`${context}: provenanceJson must be an array`);
  }
  const seenKeys = new Set<string>();
  const result: ContractFieldProvenanceDTO[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      throw new ContractDataCorruptionError(`${context}: provenance item is not an object`);
    }
    const obj = item as Record<string, unknown>;
    const expectedKeys = [
      'sectionKey',
      'source',
      'grillAnswerIds',
      'grillProposalIds',
      'aiTaskId',
      'modelInvocationId',
      'sourceProposalId',
      'previousFieldHash',
      'rationale',
    ];
    const objKeys = Object.keys(obj);
    if (objKeys.length !== expectedKeys.length || !expectedKeys.every((k) => k in obj)) {
      throw new ContractDataCorruptionError(`${context}: provenance item has invalid keys`);
    }
    if (typeof obj.sectionKey !== 'string' || obj.sectionKey.length === 0) {
      throw new ContractDataCorruptionError(`${context}: provenance sectionKey invalid`);
    }
    if (seenKeys.has(obj.sectionKey)) {
      throw new ContractDataCorruptionError(
        `${context}: duplicate provenance sectionKey "${obj.sectionKey}"`,
      );
    }
    seenKeys.add(obj.sectionKey);
    if (typeof obj.source !== 'string' || !VALID_PROVENANCE_SOURCES.has(obj.source)) {
      throw new ContractDataCorruptionError(`${context}: provenance source invalid`);
    }
    if (!Array.isArray(obj.grillAnswerIds) || !obj.grillAnswerIds.every((x: unknown) => typeof x === 'string')) {
      throw new ContractDataCorruptionError(`${context}: provenance grillAnswerIds invalid`);
    }
    if (!Array.isArray(obj.grillProposalIds) || !obj.grillProposalIds.every((x: unknown) => typeof x === 'string')) {
      throw new ContractDataCorruptionError(`${context}: provenance grillProposalIds invalid`);
    }
    if (obj.aiTaskId !== null && typeof obj.aiTaskId !== 'string') {
      throw new ContractDataCorruptionError(`${context}: provenance aiTaskId invalid`);
    }
    if (obj.modelInvocationId !== null && typeof obj.modelInvocationId !== 'string') {
      throw new ContractDataCorruptionError(`${context}: provenance modelInvocationId invalid`);
    }
    if (obj.sourceProposalId !== null && typeof obj.sourceProposalId !== 'string') {
      throw new ContractDataCorruptionError(`${context}: provenance sourceProposalId invalid`);
    }
    if (obj.previousFieldHash !== null) {
      if (typeof obj.previousFieldHash !== 'string' || !isLowercaseSha256Hex(obj.previousFieldHash)) {
        throw new ContractDataCorruptionError(`${context}: provenance previousFieldHash invalid`);
      }
    }
    if (obj.rationale !== null && typeof obj.rationale !== 'string') {
      throw new ContractDataCorruptionError(`${context}: provenance rationale invalid`);
    }
    result.push({
      sectionKey: obj.sectionKey,
      source: obj.source as ProvenanceSource,
      grillAnswerIds: obj.grillAnswerIds as ReadonlyArray<string>,
      grillProposalIds: obj.grillProposalIds as ReadonlyArray<string>,
      aiTaskId: obj.aiTaskId as string | null,
      modelInvocationId: obj.modelInvocationId as string | null,
      sourceProposalId: obj.sourceProposalId as string | null,
      previousFieldHash: obj.previousFieldHash as string | null,
      rationale: obj.rationale as string | null,
    });
  }
  return result;
}

function validateVersionData(
  version: {
    readonly id: string;
    readonly projectId: string;
    readonly version: number;
    readonly schemaVersion: number;
    readonly createdBy: string;
  },
  context: string,
): void {
  if (!Number.isSafeInteger(version.version) || version.version < 1) {
    throw new ContractDataCorruptionError(`${context}: version must be positive integer`);
  }
  if (version.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
    throw new ContractSchemaUnsupportedError(
      `${context}: unsupported schemaVersion ${version.schemaVersion}`,
    );
  }
  if (!VALID_CREATED_BY.has(version.createdBy)) {
    throw new ContractDataCorruptionError(`${context}: invalid createdBy "${version.createdBy}"`);
  }
}

function validateProposalData(
  proposal: {
    readonly status: string;
    readonly schemaVersion: number;
    readonly baseGrillSessionVersion: number;
    readonly baseContractVersion: number | null;
  },
  context: string,
): void {
  if (!VALID_PROPOSAL_STATUSES.has(proposal.status)) {
    throw new ContractDataCorruptionError(`${context}: invalid status "${proposal.status}"`);
  }
  if (proposal.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
    throw new ContractSchemaUnsupportedError(
      `${context}: unsupported schemaVersion ${proposal.schemaVersion}`,
    );
  }
  if (!Number.isSafeInteger(proposal.baseGrillSessionVersion) || proposal.baseGrillSessionVersion < 1) {
    throw new ContractDataCorruptionError(`${context}: baseGrillSessionVersion must be positive`);
  }
  if (
    proposal.baseContractVersion !== null &&
    (!Number.isSafeInteger(proposal.baseContractVersion) || proposal.baseContractVersion < 1)
  ) {
    throw new ContractDataCorruptionError(`${context}: baseContractVersion must be null or positive`);
  }
}

// ── GetCurrentCreationContract ─────────────────────────────────

export interface GetCurrentCreationContractInput {
  readonly projectId: string;
}

export function getCurrentCreationContract(
  deps: CreationContractQueryDeps,
  input: GetCurrentCreationContractInput,
): ContractVersionPublicData | null {
  const current = deps.currentRepo.get(input.projectId);
  if (!current) return null;

  const version = deps.versionRepo.getById(input.projectId, current.currentVersionId);
  if (!version) {
    throw new ContractDataCorruptionError(
      `current pointer 引用不存在的版本: projectId=${input.projectId}, versionId=${current.currentVersionId}`,
    );
  }

  const ctx = 'getCurrentCreationContract';
  validateVersionData(version, ctx);
  const sections = parseSectionsJson(version.sectionsJson, ctx);
  const lockedFieldPaths = parseLockedFieldPathsJson(version.lockedFieldPathsJson, ctx);
  const provenance = parseProvenanceJson(version.provenanceJson, ctx);

  if (!isLowercaseSha256Hex(version.contractSnapshotHash)) {
    throw new ContractDataCorruptionError(`${ctx}: contractSnapshotHash is not lowercase SHA-256`);
  }

  return {
    id: version.id,
    projectId: version.projectId,
    version: version.version,
    schemaVersion: version.schemaVersion,
    sourceProposalId: version.sourceProposalId,
    basedOnGrillSessionId: version.basedOnGrillSessionId,
    basedOnGrillSessionVersion: version.basedOnGrillSessionVersion,
    sections: sectionsToPublicData(sections),
    lockedFieldPaths,
    contractSnapshotHash: version.contractSnapshotHash,
    provenance,
    createdAt: version.createdAt,
    createdBy: version.createdBy as ContractVersionCreatedBy,
  };
}

// ── ListCreationContractVersions ───────────────────────────────

export interface ListCreationContractVersionsInput {
  readonly projectId: string;
}

export function listCreationContractVersions(
  deps: CreationContractQueryDeps,
  input: ListCreationContractVersionsInput,
): ReadonlyArray<ContractVersionSummary> {
  const versions = deps.versionRepo.listSummaries(input.projectId);
  return versions.map((v) => {
    const ctx = 'listCreationContractVersions';
    validateVersionData(v, ctx);
    return {
      id: v.id,
      projectId: v.projectId,
      version: v.version,
      schemaVersion: v.schemaVersion,
      contractSnapshotHash: v.contractSnapshotHash,
      createdAt: v.createdAt,
      createdBy: v.createdBy as ContractVersionCreatedBy,
    };
  });
}

// ── GetCreationContractProposal ────────────────────────────────

export interface GetCreationContractProposalInput {
  readonly projectId: string;
  readonly proposalId: string;
}

export function getCreationContractProposal(
  deps: CreationContractQueryDeps,
  input: GetCreationContractProposalInput,
): ProposalPublicData {
  const proposal = deps.proposalRepo.getById(input.projectId, input.proposalId);
  if (!proposal) {
    throw new ContractProposalNotFoundError(input.proposalId);
  }

  const ctx = 'getCreationContractProposal';
  validateProposalData(proposal, ctx);
  const sections = parseSectionsJson(proposal.sectionsJson, ctx);

  if (!isLowercaseSha256Hex(proposal.sectionsHash)) {
    throw new ContractDataCorruptionError(`${ctx}: sectionsHash is not lowercase SHA-256`);
  }

  return {
    id: proposal.id,
    projectId: proposal.projectId,
    taskId: proposal.taskId,
    invocationId: proposal.invocationId,
    status: proposal.status as ProposalStatus,
    baseGrillSessionId: proposal.baseGrillSessionId,
    baseGrillSessionVersion: proposal.baseGrillSessionVersion,
    baseContractVersion: proposal.baseContractVersion,
    schemaVersion: proposal.schemaVersion,
    sections: sectionsToPublicData(sections),
    sectionsHash: proposal.sectionsHash,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

// ── ListCreationContractProposals ──────────────────────────────

export interface ListCreationContractProposalsInput {
  readonly projectId: string;
}

export function listCreationContractProposals(
  deps: CreationContractQueryDeps,
  input: ListCreationContractProposalsInput,
): ReadonlyArray<ProposalPublicData> {
  const proposals = deps.proposalRepo.listByProject(input.projectId);
  return proposals.map((proposal) => {
    const ctx = 'listCreationContractProposals';
    validateProposalData(proposal, ctx);
    const sections = parseSectionsJson(proposal.sectionsJson, ctx);
    return {
      id: proposal.id,
      projectId: proposal.projectId,
      taskId: proposal.taskId,
      invocationId: proposal.invocationId,
      status: proposal.status as ProposalStatus,
      baseGrillSessionId: proposal.baseGrillSessionId,
      baseGrillSessionVersion: proposal.baseGrillSessionVersion,
      baseContractVersion: proposal.baseContractVersion,
      schemaVersion: proposal.schemaVersion,
      sections: sectionsToPublicData(sections),
      sectionsHash: proposal.sectionsHash,
      createdAt: proposal.createdAt,
      updatedAt: proposal.updatedAt,
    };
  });
}
