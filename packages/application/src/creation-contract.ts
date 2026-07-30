/**
 * 创作契约只读查询用例。
 *
 * 四个查询用例：
 * - GetCurrentCreationContract：获取当前版本
 * - ListCreationContractVersions：列出所有版本
 * - GetCreationContractProposal：获取单个提案
 * - ListCreationContractProposals：列出所有提案
 *
 * 不实现 mutation（Accept/Reject/Lock/Unlock）。
 * 不接 Worker/Main IPC。
 */

import { validateCreationContractSections, type CreationContractSections } from '@ai-novel/domain';
import type {
  ContractVersionPublicData,
  ContractVersionSummary,
  ProposalPublicData,
  CreationContractSectionsPublicData,
} from '@ai-novel/contracts';
import type {
  CreationContractProposalRepositoryPort,
  CreationContractVersionRepositoryPort,
  CreationContractCurrentRepositoryPort,
} from './creation-contract-types.js';
import { ContractProposalNotFoundError } from './errors.js';

// ── 依赖 ──────────────────────────────────────────────────────

export interface CreationContractQueryDeps {
  readonly proposalRepo: CreationContractProposalRepositoryPort;
  readonly versionRepo: CreationContractVersionRepositoryPort;
  readonly currentRepo: CreationContractCurrentRepositoryPort;
}

// ── 辅助 ──────────────────────────────────────────────────────

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

function parseSectionsJson(json: string): CreationContractSections {
  const parsed: unknown = JSON.parse(json);
  return validateCreationContractSections(parsed);
}

function parseLockedFieldPathsJson(json: string): ReadonlyArray<string> {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('lockedFieldPathsJson must be an array');
  return parsed as ReadonlyArray<string>;
}

// ── GetCurrentCreationContract ─────────────────────────────────

export interface GetCurrentCreationContractInput {
  readonly projectId: string;
}

/**
 * 获取当前创作契约版本。
 *
 * 返回 null 表示项目尚无创作契约。
 */
export function getCurrentCreationContract(
  deps: CreationContractQueryDeps,
  input: GetCurrentCreationContractInput,
): ContractVersionPublicData | null {
  const current = deps.currentRepo.get(input.projectId);
  if (!current) return null;

  const version = deps.versionRepo.getById(input.projectId, current.currentVersionId);
  if (!version) return null;

  const sections = parseSectionsJson(version.sectionsJson);
  const lockedFieldPaths = parseLockedFieldPathsJson(version.lockedFieldPathsJson);

  return {
    id: version.id,
    projectId: version.projectId,
    version: version.version,
    schemaVersion: version.schemaVersion,
    sourceProposalId: version.sourceProposalId,
    sections: sectionsToPublicData(sections),
    lockedFieldPaths,
    contractSnapshotHash: version.contractSnapshotHash,
    createdAt: version.createdAt,
    createdBy: version.createdBy,
  };
}

// ── ListCreationContractVersions ───────────────────────────────

export interface ListCreationContractVersionsInput {
  readonly projectId: string;
}

/**
 * 列出项目的所有创作契约版本摘要。
 *
 * 按 version DESC 排序。
 */
export function listCreationContractVersions(
  deps: CreationContractQueryDeps,
  input: ListCreationContractVersionsInput,
): ReadonlyArray<ContractVersionSummary> {
  const versions = deps.versionRepo.listSummaries(input.projectId);
  return versions.map((v) => ({
    id: v.id,
    projectId: v.projectId,
    version: v.version,
    schemaVersion: v.schemaVersion,
    contractSnapshotHash: v.contractSnapshotHash,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
  }));
}

// ── GetCreationContractProposal ────────────────────────────────

export interface GetCreationContractProposalInput {
  readonly projectId: string;
  readonly proposalId: string;
}

/**
 * 获取单个创作契约提案。
 *
 * 提案不存在时抛出 ContractProposalNotFoundError。
 */
export function getCreationContractProposal(
  deps: CreationContractQueryDeps,
  input: GetCreationContractProposalInput,
): ProposalPublicData {
  const proposal = deps.proposalRepo.getById(input.projectId, input.proposalId);
  if (!proposal) {
    throw new ContractProposalNotFoundError(input.proposalId);
  }

  const sections = parseSectionsJson(proposal.sectionsJson);

  return {
    id: proposal.id,
    projectId: proposal.projectId,
    taskId: proposal.taskId,
    invocationId: proposal.invocationId,
    status: proposal.status,
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

/**
 * 列出项目的所有创作契约提案。
 *
 * 按 createdAt DESC，再以 id 作为稳定 tie-breaker。
 */
export function listCreationContractProposals(
  deps: CreationContractQueryDeps,
  input: ListCreationContractProposalsInput,
): ReadonlyArray<ProposalPublicData> {
  const proposals = deps.proposalRepo.listByProject(input.projectId);
  return proposals.map((proposal) => {
    const sections = parseSectionsJson(proposal.sectionsJson);
    return {
      id: proposal.id,
      projectId: proposal.projectId,
      taskId: proposal.taskId,
      invocationId: proposal.invocationId,
      status: proposal.status,
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
