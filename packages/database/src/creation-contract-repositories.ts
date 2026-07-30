/**
 * 创作契约仓库实现。
 *
 * 使用 node:sqlite 的 DatabaseSync 同步 API。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  CreationContractProposalRepository,
  CreationContractProposalRow,
  CreateCreationContractProposalData,
  DbProposalStatus,
  CreationContractVersionRepository,
  CreationContractVersionRow,
  CreateCreationContractVersionData,
  CreationContractCurrentRepository,
  CreationContractCurrentRow,
  CreationContractLockEventRepository,
  CreationContractLockEventRow,
  CreateCreationContractLockEventData,
} from './types.js';

// ── 创作契约提案仓库实现 ──────────────────────────────────────

export class CreationContractProposalRepositoryImpl implements CreationContractProposalRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateCreationContractProposalData): void {
    this.db
      .prepare(
        `INSERT INTO creation_contract_proposals
           (id, project_id, task_id, invocation_id, status,
            base_grill_session_id, base_grill_session_version, base_contract_version,
            schema_version, sections_json, sections_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.taskId,
        data.invocationId,
        data.baseGrillSessionId,
        data.baseGrillSessionVersion,
        data.baseContractVersion,
        data.schemaVersion,
        data.sectionsJson,
        data.sectionsHash,
        data.createdAt,
        data.updatedAt,
      );
  }

  getById(projectId: string, id: string): CreationContractProposalRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, task_id, invocation_id, status,
                base_grill_session_id, base_grill_session_version, base_contract_version,
                schema_version, sections_json, sections_hash, created_at, updated_at
         FROM creation_contract_proposals
         WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toRow(row);
  }

  listByProject(projectId: string): ReadonlyArray<CreationContractProposalRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_id, invocation_id, status,
                base_grill_session_id, base_grill_session_version, base_contract_version,
                schema_version, sections_json, sections_hash, created_at, updated_at
         FROM creation_contract_proposals
         WHERE project_id = ?
         ORDER BY created_at DESC, id`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRow(r));
  }

  listByGrillSession(grillSessionId: string): ReadonlyArray<CreationContractProposalRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_id, invocation_id, status,
                base_grill_session_id, base_grill_session_version, base_contract_version,
                schema_version, sections_json, sections_hash, created_at, updated_at
         FROM creation_contract_proposals
         WHERE base_grill_session_id = ?
         ORDER BY created_at DESC, id`,
      )
      .all(grillSessionId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRow(r));
  }

  transitionStatus(
    projectId: string,
    id: string,
    expectedStatus: DbProposalStatus,
    newStatus: DbProposalStatus,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE creation_contract_proposals
         SET status = ?, updated_at = ?
         WHERE project_id = ? AND id = ? AND status = ?`,
      )
      .run(newStatus, now, projectId, id, expectedStatus);
    return result.changes === 1;
  }

  supersedeAllProposed(projectId: string, now: string): number {
    const result = this.db
      .prepare(
        `UPDATE creation_contract_proposals
         SET status = 'SUPERSEDED', updated_at = ?
         WHERE project_id = ? AND status = 'PROPOSED'`,
      )
      .run(now, projectId);
    return Number(result.changes);
  }

  private toRow(row: Record<string, unknown>): CreationContractProposalRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      taskId: row.task_id as string,
      invocationId: row.invocation_id as string,
      status: row.status as DbProposalStatus,
      baseGrillSessionId: row.base_grill_session_id as string,
      baseGrillSessionVersion: row.base_grill_session_version as number,
      baseContractVersion: (row.base_contract_version as number) ?? null,
      schemaVersion: row.schema_version as number,
      sectionsJson: row.sections_json as string,
      sectionsHash: row.sections_hash as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

// ── 创作契约版本仓库实现 ──────────────────────────────────────

export class CreationContractVersionRepositoryImpl implements CreationContractVersionRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateCreationContractVersionData): void {
    this.db
      .prepare(
        `INSERT INTO creation_contract_versions
           (id, project_id, version, schema_version, source_proposal_id,
            based_on_grill_session_id, based_on_grill_session_version,
            sections_json, locked_field_paths_json, contract_snapshot_hash,
            provenance_json, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.version,
        data.schemaVersion,
        data.sourceProposalId,
        data.basedOnGrillSessionId,
        data.basedOnGrillSessionVersion,
        data.sectionsJson,
        data.lockedFieldPathsJson,
        data.contractSnapshotHash,
        data.provenanceJson,
        data.createdAt,
        data.createdBy,
      );
  }

  getById(projectId: string, id: string): CreationContractVersionRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, version, schema_version, source_proposal_id,
                based_on_grill_session_id, based_on_grill_session_version,
                sections_json, locked_field_paths_json, contract_snapshot_hash,
                provenance_json, created_at, created_by
         FROM creation_contract_versions
         WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toRow(row);
  }

  getByVersion(projectId: string, version: number): CreationContractVersionRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, version, schema_version, source_proposal_id,
                based_on_grill_session_id, based_on_grill_session_version,
                sections_json, locked_field_paths_json, contract_snapshot_hash,
                provenance_json, created_at, created_by
         FROM creation_contract_versions
         WHERE project_id = ? AND version = ?`,
      )
      .get(projectId, version) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toRow(row);
  }

  listSummaries(projectId: string): ReadonlyArray<CreationContractVersionRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, version, schema_version, source_proposal_id,
                based_on_grill_session_id, based_on_grill_session_version,
                sections_json, locked_field_paths_json, contract_snapshot_hash,
                provenance_json, created_at, created_by
         FROM creation_contract_versions
         WHERE project_id = ?
         ORDER BY version DESC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRow(r));
  }

  resolveVersionId(projectId: string, expectedVersion: number): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM creation_contract_versions
         WHERE project_id = ? AND version = ?`,
      )
      .get(projectId, expectedVersion) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private toRow(row: Record<string, unknown>): CreationContractVersionRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      version: row.version as number,
      schemaVersion: row.schema_version as number,
      sourceProposalId: (row.source_proposal_id as string) ?? null,
      basedOnGrillSessionId: (row.based_on_grill_session_id as string) ?? null,
      basedOnGrillSessionVersion: (row.based_on_grill_session_version as number) ?? null,
      sectionsJson: row.sections_json as string,
      lockedFieldPathsJson: row.locked_field_paths_json as string,
      contractSnapshotHash: row.contract_snapshot_hash as string,
      provenanceJson: row.provenance_json as string,
      createdAt: row.created_at as string,
      createdBy: row.created_by as DbProposalStatus as unknown as
        'user' | 'ai-proposal-accepted' | 'lock' | 'unlock',
    };
  }
}

// ── 创作契约当前指针仓库实现 ──────────────────────────────────

export class CreationContractCurrentRepositoryImpl implements CreationContractCurrentRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertFirst(projectId: string, versionId: string, now: string): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO creation_contract_current (project_id, current_version_id, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(projectId, versionId, now);
      return true;
    } catch {
      return false;
    }
  }

  casUpdate(
    projectId: string,
    expectedVersionId: string,
    newVersionId: string,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE creation_contract_current
         SET current_version_id = ?, updated_at = ?
         WHERE project_id = ? AND current_version_id = ?`,
      )
      .run(newVersionId, now, projectId, expectedVersionId);
    return result.changes === 1;
  }

  get(projectId: string): CreationContractCurrentRow | null {
    const row = this.db
      .prepare(
        `SELECT project_id, current_version_id, updated_at
         FROM creation_contract_current
         WHERE project_id = ?`,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      projectId: row.project_id as string,
      currentVersionId: row.current_version_id as string,
      updatedAt: row.updated_at as string,
    };
  }
}

// ── 创作契约锁定事件仓库实现 ──────────────────────────────────

export class CreationContractLockEventRepositoryImpl implements CreationContractLockEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(data: CreateCreationContractLockEventData): void {
    this.db
      .prepare(
        `INSERT INTO creation_contract_lock_events
           (id, project_id, field_path, action, version_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.fieldPath,
        data.action,
        data.versionId,
        data.createdAt,
        data.createdBy,
      );
  }

  listByVersionId(
    projectId: string,
    versionId: string,
  ): ReadonlyArray<CreationContractLockEventRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, field_path, action, version_id, created_at, created_by
         FROM creation_contract_lock_events
         WHERE project_id = ? AND version_id = ?
         ORDER BY created_at`,
      )
      .all(projectId, versionId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRow(r));
  }

  listByProject(projectId: string): ReadonlyArray<CreationContractLockEventRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, field_path, action, version_id, created_at, created_by
         FROM creation_contract_lock_events
         WHERE project_id = ?
         ORDER BY created_at`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRow(r));
  }

  private toRow(row: Record<string, unknown>): CreationContractLockEventRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      fieldPath: row.field_path as string,
      action: row.action as 'LOCK' | 'UNLOCK',
      versionId: row.version_id as string,
      createdAt: row.created_at as string,
      createdBy: row.created_by as string,
    };
  }
}
