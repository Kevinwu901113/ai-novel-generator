/**
 * 创作契约应用层端口接口。
 *
 * 应用用例通过这些接口与基础设施交互，
 * 不依赖 Electron、React 或 node:sqlite。
 */

import type {
  ProposalStatus,
  ContractVersionCreatedBy,
  ContractPatchOperation,
} from '@ai-novel/domain';

// ── 数据接口 ──────────────────────────────────────────────────

export interface CreationContractProposalData {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly status: ProposalStatus;
  readonly baseGrillSessionId: string;
  readonly baseGrillSessionVersion: number;
  readonly baseContractVersion: number | null;
  readonly schemaVersion: number;
  readonly sectionsJson: string;
  readonly sectionsHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreationContractVersionData {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly sourceProposalId: string | null;
  readonly basedOnGrillSessionId: string | null;
  readonly basedOnGrillSessionVersion: number | null;
  readonly sectionsJson: string;
  readonly lockedFieldPathsJson: string;
  readonly contractSnapshotHash: string;
  readonly provenanceJson: string;
  readonly createdAt: string;
  readonly createdBy: ContractVersionCreatedBy;
}

export interface CreationContractCurrentData {
  readonly projectId: string;
  readonly currentVersionId: string;
  readonly updatedAt: string;
}

export interface CreationContractLockEventData {
  readonly id: string;
  readonly projectId: string;
  readonly fieldPath: string;
  readonly action: 'LOCK' | 'UNLOCK';
  readonly versionId: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

// ── 创建输入 ──────────────────────────────────────────────────

export interface CreateCreationContractProposalInput {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly baseGrillSessionId: string;
  readonly baseGrillSessionVersion: number;
  readonly baseContractVersion: number | null;
  readonly schemaVersion: number;
  readonly sectionsJson: string;
  readonly sectionsHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateCreationContractVersionInput {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly sourceProposalId: string | null;
  readonly basedOnGrillSessionId: string | null;
  readonly basedOnGrillSessionVersion: number | null;
  readonly sectionsJson: string;
  readonly lockedFieldPathsJson: string;
  readonly contractSnapshotHash: string;
  readonly provenanceJson: string;
  readonly createdAt: string;
  readonly createdBy: ContractVersionCreatedBy;
}

// ── 仓库端口 ──────────────────────────────────────────────────

export interface CreationContractProposalRepositoryPort {
  create(data: CreateCreationContractProposalInput): void;
  getById(projectId: string, id: string): CreationContractProposalData | null;
  listByProject(projectId: string): ReadonlyArray<CreationContractProposalData>;
  listByGrillSession(grillSessionId: string): ReadonlyArray<CreationContractProposalData>;
  transitionStatus(
    projectId: string,
    id: string,
    expectedStatus: ProposalStatus,
    newStatus: ProposalStatus,
    now: string,
  ): boolean;
  transitionStatusWithHash(
    projectId: string,
    id: string,
    expectedStatus: ProposalStatus,
    expectedSectionsHash: string,
    newStatus: ProposalStatus,
    now: string,
  ): boolean;
  supersedeAllProposed(projectId: string, now: string): number;
}

export interface CreationContractVersionRepositoryPort {
  create(data: CreateCreationContractVersionInput): void;
  getById(projectId: string, id: string): CreationContractVersionData | null;
  getByVersion(projectId: string, version: number): CreationContractVersionData | null;
  listSummaries(projectId: string): ReadonlyArray<CreationContractVersionData>;
  resolveVersionId(projectId: string, expectedVersion: number): string | null;
}

export interface CreationContractCurrentRepositoryPort {
  insertFirst(projectId: string, versionId: string, now: string): boolean;
  casUpdate(
    projectId: string,
    expectedVersionId: string,
    newVersionId: string,
    now: string,
  ): boolean;
  get(projectId: string): CreationContractCurrentData | null;
}

export interface CreationContractLockEventRepositoryPort {
  append(data: CreationContractLockEventData): void;
  listByVersionId(
    projectId: string,
    versionId: string,
  ): ReadonlyArray<CreationContractLockEventData>;
  listByProject(projectId: string): ReadonlyArray<CreationContractLockEventData>;
}

// ── Hash 端口 ──────────────────────────────────────────────────

/** SHA-256 端口 — application 不直接依赖 node:crypto */
export interface Sha256Port {
  digestUtf8(input: string): string;
}

// ── 事务端口 ──────────────────────────────────────────────────

/** Grill session 版本读取端口（只读，用于 CAS 验证） */
export interface GrillSessionVersionReadPort {
  getVersion(projectId: string, sessionId: string): number | null;
}

/** 项目存在性读取端口（只读，用于归属验证） */
export interface ProjectExistsReadPort {
  exists(projectId: string): boolean;
}

/** 事务内可用的仓库集合 */
export interface CreationContractTransactionRepositories {
  readonly proposalRepo: CreationContractProposalRepositoryPort;
  readonly versionRepo: CreationContractVersionRepositoryPort;
  readonly currentRepo: CreationContractCurrentRepositoryPort;
  readonly lockEventRepo: CreationContractLockEventRepositoryPort;
  readonly grillSessionVersionReadPort: GrillSessionVersionReadPort;
  readonly projectExistsReadPort: ProjectExistsReadPort;
}

/** 事务端口 — database adapter 实现，application 依赖此接口 */
export interface CreationContractTransactionPort {
  runInTransaction<T>(operation: (repositories: CreationContractTransactionRepositories) => T): T;
}

// ── Accept/Reject 输入 ───────────────────────────────────────

export interface AcceptCreationContractProposalInput {
  readonly projectId: string;
  readonly proposalId: string;
  readonly expectedProposalSectionsHash: string;
  readonly expectedGrillSessionVersion: number;
  readonly expectedContractVersion: number | null;
  readonly operations: ReadonlyArray<ContractPatchOperation>;
  readonly now: string;
  readonly newVersionId: string;
}

export interface RejectCreationContractProposalInput {
  readonly projectId: string;
  readonly proposalId: string;
  readonly expectedProposalSectionsHash: string;
  readonly now: string;
}
