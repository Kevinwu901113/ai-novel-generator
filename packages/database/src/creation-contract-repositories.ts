import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CREATION_CONTRACT_SCHEMA_VERSION,
  isLowercaseSha256Hex,
  canonicalSerializeContractSections,
  canonicalSerializeLockedFieldPaths,
  canonicalSerializeContractSnapshot,
  validateCreationContractSections,
  parseContractFieldPath,
  canonicalizeContractFieldPath,
} from '@ai-novel/domain';
import {
  ContractDataCorruptionError,
  ContractSchemaUnsupportedError,
  type CreationContractProposalRepositoryPort,
  type CreationContractVersionRepositoryPort,
  type CreationContractCurrentRepositoryPort,
  type CreationContractLockEventRepositoryPort,
  type CreationContractProposalData,
  type CreateCreationContractProposalInput,
  type CreationContractVersionData,
  type CreateCreationContractVersionInput,
  type CreationContractCurrentData,
  type CreationContractLockEventData,
  type ProposalStatus,
  type ContractVersionCreatedBy,
} from '@ai-novel/application';

// ── SHA-256 helper ────────────────────────────────────────────────

export function sha256Utf8(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ── 读取验证辅助 ────────────────────────────────────────────────

function requireString(row: Record<string, unknown>, key: string, context: string): string {
  const v = row[key];
  if (typeof v !== 'string')
    throw new ContractDataCorruptionError(`${context}: ${key} 应为 string，实际 ${typeof v}`);
  return v;
}

function requireNumber(row: Record<string, unknown>, key: string, context: string): number {
  const v = row[key];
  if (typeof v !== 'number')
    throw new ContractDataCorruptionError(`${context}: ${key} 应为 number，实际 ${typeof v}`);
  return v;
}

function optionalString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string')
    throw new ContractDataCorruptionError(`${key} 应为 string | null，实际 ${typeof v}`);
  return v;
}

function optionalNumber(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number')
    throw new ContractDataCorruptionError(`${key} 应为 number | null，实际 ${typeof v}`);
  return v;
}

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

const VALID_PROVENANCE_SOURCES: ReadonlySet<string> = new Set([
  'GRILL_ANSWER',
  'AI_PROPOSAL',
  'USER_EDIT',
  'PREVIOUS_VERSION',
  'DEFAULT',
]);

function requireProposalStatus(row: Record<string, unknown>, context: string): ProposalStatus {
  const v = row.status;
  if (typeof v !== 'string' || !VALID_PROPOSAL_STATUSES.has(v)) {
    throw new ContractDataCorruptionError(`${context}: status 无效 "${String(v)}"`);
  }
  return v as ProposalStatus;
}

function requireCreatedBy(row: Record<string, unknown>, context: string): ContractVersionCreatedBy {
  const v = row.created_by;
  if (typeof v !== 'string' || !VALID_CREATED_BY.has(v)) {
    throw new ContractDataCorruptionError(`${context}: created_by 无效 "${String(v)}"`);
  }
  return v as ContractVersionCreatedBy;
}

function validateProvenanceArray(provenanceJson: string, context: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(provenanceJson);
  } catch {
    throw new ContractDataCorruptionError(`${context}: provenance_json is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new ContractDataCorruptionError(`${context}: provenance_json must be an array`);
  }
  const seenKeys = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      throw new ContractDataCorruptionError(`${context}: provenance item is not an object`);
    }
    const obj = item as Record<string, unknown>;
    const expectedKeys = [
      'sectionKey', 'source', 'grillAnswerIds', 'grillProposalIds',
      'aiTaskId', 'modelInvocationId', 'sourceProposalId', 'previousFieldHash', 'rationale',
    ];
    const objKeys = Object.keys(obj);
    if (objKeys.length !== expectedKeys.length || !expectedKeys.every((k) => k in obj)) {
      throw new ContractDataCorruptionError(`${context}: provenance item has invalid keys`);
    }
    if (typeof obj.sectionKey !== 'string' || obj.sectionKey.length === 0) {
      throw new ContractDataCorruptionError(`${context}: provenance sectionKey invalid`);
    }
    if (seenKeys.has(obj.sectionKey)) {
      throw new ContractDataCorruptionError(`${context}: duplicate provenance sectionKey`);
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
  }
}

// ── 创作契约提案仓库实现 ──────────────────────────────────────

export class CreationContractProposalRepositoryImpl implements CreationContractProposalRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateCreationContractProposalInput): void {
    if (data.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
      throw new ContractSchemaUnsupportedError(
        `proposal create: unsupported schemaVersion ${data.schemaVersion}`,
      );
    }
    if (!Number.isSafeInteger(data.baseGrillSessionVersion) || data.baseGrillSessionVersion < 1) {
      throw new ContractDataCorruptionError('proposal create: baseGrillSessionVersion must be positive');
    }
    if (data.baseContractVersion !== null && (!Number.isSafeInteger(data.baseContractVersion) || data.baseContractVersion < 1)) {
      throw new ContractDataCorruptionError('proposal create: baseContractVersion must be null or positive');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.sectionsJson);
    } catch {
      throw new ContractDataCorruptionError('proposal create: sectionsJson is not valid JSON');
    }
    const validated = validateCreationContractSections(parsed);
    const canonical = canonicalSerializeContractSections(validated);
    if (canonical !== data.sectionsJson) {
      throw new ContractDataCorruptionError('proposal create: sectionsJson is not canonical');
    }
    if (!isLowercaseSha256Hex(data.sectionsHash)) {
      throw new ContractDataCorruptionError('proposal create: sectionsHash is not lowercase hex');
    }
    const recomputedHash = sha256Utf8(canonical);
    if (recomputedHash !== data.sectionsHash) {
      throw new ContractDataCorruptionError('proposal create: sectionsHash mismatch');
    }
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

  getById(projectId: string, id: string): CreationContractProposalData | null {
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

  listByProject(projectId: string): ReadonlyArray<CreationContractProposalData> {
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

  listByGrillSession(grillSessionId: string): ReadonlyArray<CreationContractProposalData> {
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
    expectedStatus: ProposalStatus,
    newStatus: ProposalStatus,
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

  transitionStatusWithHash(
    projectId: string,
    id: string,
    expectedStatus: ProposalStatus,
    expectedSectionsHash: string,
    newStatus: ProposalStatus,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE creation_contract_proposals
         SET status = ?, updated_at = ?
         WHERE project_id = ? AND id = ? AND status = ? AND sections_hash = ?`,
      )
      .run(newStatus, now, projectId, id, expectedStatus, expectedSectionsHash);
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

  private toRow(row: Record<string, unknown>): CreationContractProposalData {
    const ctx = 'creation_contract_proposals';
    const schemaVersion = requireNumber(row, 'schema_version', ctx);
    if (schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
      throw new ContractSchemaUnsupportedError(`${ctx}: unsupported schemaVersion ${schemaVersion}`);
    }
    const sectionsHash = requireString(row, 'sections_hash', ctx);
    if (!isLowercaseSha256Hex(sectionsHash)) {
      throw new ContractDataCorruptionError(`${ctx}: sections_hash is not lowercase hex`);
    }
    const sectionsJson = requireString(row, 'sections_json', ctx);
    try {
      const parsed = JSON.parse(sectionsJson);
      const validated = validateCreationContractSections(parsed);
      const canonical = canonicalSerializeContractSections(validated);
      if (canonical !== sectionsJson) {
        throw new ContractDataCorruptionError(`${ctx}: sections_json is not canonical`);
      }
      const recomputed = sha256Utf8(canonical);
      if (recomputed !== sectionsHash) {
        throw new ContractDataCorruptionError(`${ctx}: sections_hash mismatch`);
      }
    } catch (e) {
      if (e instanceof ContractDataCorruptionError || e instanceof ContractSchemaUnsupportedError)
        throw e;
      throw new ContractDataCorruptionError(`${ctx}: sections_json validation failed`);
    }
    const baseGrillSessionVersion = requireNumber(row, 'base_grill_session_version', ctx);
    if (!Number.isSafeInteger(baseGrillSessionVersion) || baseGrillSessionVersion < 1) {
      throw new ContractDataCorruptionError(`${ctx}: base_grill_session_version must be positive`);
    }
    const baseContractVersion = optionalNumber(row, 'base_contract_version');
    if (baseContractVersion !== null && (!Number.isSafeInteger(baseContractVersion) || baseContractVersion < 1)) {
      throw new ContractDataCorruptionError(`${ctx}: base_contract_version must be null or positive`);
    }
    return {
      id: requireString(row, 'id', ctx),
      projectId: requireString(row, 'project_id', ctx),
      taskId: requireString(row, 'task_id', ctx),
      invocationId: requireString(row, 'invocation_id', ctx),
      status: requireProposalStatus(row, ctx),
      baseGrillSessionId: requireString(row, 'base_grill_session_id', ctx),
      baseGrillSessionVersion,
      baseContractVersion,
      schemaVersion,
      sectionsJson,
      sectionsHash,
      createdAt: requireString(row, 'created_at', ctx),
      updatedAt: requireString(row, 'updated_at', ctx),
    };
  }
}

// ── 创作契约版本仓库实现 ──────────────────────────────────────

export class CreationContractVersionRepositoryImpl implements CreationContractVersionRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateCreationContractVersionInput): void {
    if (data.schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
      throw new ContractSchemaUnsupportedError(
        `version create: unsupported schemaVersion ${data.schemaVersion}`,
      );
    }
    if (!Number.isSafeInteger(data.version) || data.version < 1) {
      throw new ContractDataCorruptionError('version create: version must be positive integer');
    }
    let parsedSections: unknown;
    try {
      parsedSections = JSON.parse(data.sectionsJson);
    } catch {
      throw new ContractDataCorruptionError('version create: sectionsJson is not valid JSON');
    }
    const validatedSections = validateCreationContractSections(parsedSections);
    const canonicalSections = canonicalSerializeContractSections(validatedSections);
    if (canonicalSections !== data.sectionsJson) {
      throw new ContractDataCorruptionError('version create: sectionsJson is not canonical');
    }
    let parsedPaths: unknown;
    try {
      parsedPaths = JSON.parse(data.lockedFieldPathsJson);
    } catch {
      throw new ContractDataCorruptionError('version create: lockedFieldPathsJson is not valid JSON');
    }
    if (!Array.isArray(parsedPaths) || !parsedPaths.every((p: unknown) => typeof p === 'string')) {
      throw new ContractDataCorruptionError('version create: lockedFieldPathsJson is not string[]');
    }
    const canonicalPaths = (parsedPaths as string[]).map((p) => canonicalizeContractFieldPath(p));
    for (const p of canonicalPaths) {
      parseContractFieldPath(p);
    }
    const canonicalPathsJson = canonicalSerializeLockedFieldPaths(canonicalPaths);
    if (canonicalPathsJson !== data.lockedFieldPathsJson) {
      throw new ContractDataCorruptionError('version create: lockedFieldPathsJson is not canonical');
    }
    if ((data.basedOnGrillSessionId === null) !== (data.basedOnGrillSessionVersion === null)) {
      throw new ContractDataCorruptionError('version create: based_on null-pair mismatch');
    }
    validateProvenanceArray(data.provenanceJson, 'version create');
    if (!isLowercaseSha256Hex(data.contractSnapshotHash)) {
      throw new ContractDataCorruptionError('version create: contractSnapshotHash is not lowercase hex');
    }
    const canonicalSnapshot = canonicalSerializeContractSnapshot({
      sections: validatedSections,
      lockedFieldPaths: canonicalPaths,
      schemaVersion: data.schemaVersion,
    });
    const expectedHash = sha256Utf8(canonicalSnapshot);
    if (expectedHash !== data.contractSnapshotHash) {
      throw new ContractDataCorruptionError('version create: contractSnapshotHash mismatch');
    }
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

  getById(projectId: string, id: string): CreationContractVersionData | null {
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

  getByVersion(projectId: string, version: number): CreationContractVersionData | null {
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

  listSummaries(projectId: string): ReadonlyArray<CreationContractVersionData> {
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

  private toRow(row: Record<string, unknown>): CreationContractVersionData {
    const ctx = 'creation_contract_versions';
    const schemaVersion = requireNumber(row, 'schema_version', ctx);
    if (schemaVersion !== CREATION_CONTRACT_SCHEMA_VERSION) {
      throw new ContractSchemaUnsupportedError(`${ctx}: unsupported schemaVersion ${schemaVersion}`);
    }
    const version = requireNumber(row, 'version', ctx);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new ContractDataCorruptionError(`${ctx}: version must be positive integer`);
    }
    const contractSnapshotHash = requireString(row, 'contract_snapshot_hash', ctx);
    if (!isLowercaseSha256Hex(contractSnapshotHash)) {
      throw new ContractDataCorruptionError(`${ctx}: contract_snapshot_hash is not lowercase hex`);
    }
    const sectionsJson = requireString(row, 'sections_json', ctx);
    const lockedFieldPathsJson = requireString(row, 'locked_field_paths_json', ctx);
    const provenanceJson = requireString(row, 'provenance_json', ctx);

    let validatedSections;
    try {
      const parsed = JSON.parse(sectionsJson);
      validatedSections = validateCreationContractSections(parsed);
      const canonical = canonicalSerializeContractSections(validatedSections);
      if (canonical !== sectionsJson) {
        throw new ContractDataCorruptionError(`${ctx}: sections_json is not canonical`);
      }
    } catch (e) {
      if (e instanceof ContractDataCorruptionError || e instanceof ContractSchemaUnsupportedError)
        throw e;
      throw new ContractDataCorruptionError(`${ctx}: sections_json validation failed`);
    }

    let canonicalPaths: string[];
    try {
      const paths = JSON.parse(lockedFieldPathsJson);
      if (!Array.isArray(paths) || !paths.every((p: unknown) => typeof p === 'string')) {
        throw new ContractDataCorruptionError(`${ctx}: locked_field_paths_json is not string[]`);
      }
      canonicalPaths = (paths as string[]).map((p) => canonicalizeContractFieldPath(p));
      for (const p of canonicalPaths) {
        parseContractFieldPath(p);
      }
      const sorted = canonicalSerializeLockedFieldPaths(canonicalPaths);
      if (sorted !== lockedFieldPathsJson) {
        throw new ContractDataCorruptionError(`${ctx}: locked_field_paths_json is not canonical`);
      }
    } catch (e) {
      if (e instanceof ContractDataCorruptionError || e instanceof ContractSchemaUnsupportedError)
        throw e;
      throw new ContractDataCorruptionError(`${ctx}: locked_field_paths validation failed`);
    }

    // Validate snapshot hash on read
    try {
      const canonicalSnapshot = canonicalSerializeContractSnapshot({
        sections: validatedSections,
        lockedFieldPaths: canonicalPaths,
        schemaVersion,
      });
      const expectedHash = sha256Utf8(canonicalSnapshot);
      if (expectedHash !== contractSnapshotHash) {
        throw new ContractDataCorruptionError(`${ctx}: contract_snapshot_hash mismatch (corruption detected)`);
      }
    } catch (e) {
      if (e instanceof ContractDataCorruptionError || e instanceof ContractSchemaUnsupportedError)
        throw e;
      throw new ContractDataCorruptionError(`${ctx}: snapshot hash recomputation failed`);
    }

    validateProvenanceArray(provenanceJson, ctx);

    const basedOnSessionId = optionalString(row, 'based_on_grill_session_id');
    const basedOnSessionVersion = optionalNumber(row, 'based_on_grill_session_version');
    if ((basedOnSessionId === null) !== (basedOnSessionVersion === null)) {
      throw new ContractDataCorruptionError(`${ctx}: based_on null-pair mismatch`);
    }

    return {
      id: requireString(row, 'id', ctx),
      projectId: requireString(row, 'project_id', ctx),
      version,
      schemaVersion,
      sourceProposalId: optionalString(row, 'source_proposal_id'),
      basedOnGrillSessionId: basedOnSessionId,
      basedOnGrillSessionVersion: basedOnSessionVersion,
      sectionsJson,
      lockedFieldPathsJson,
      contractSnapshotHash,
      provenanceJson,
      createdAt: requireString(row, 'created_at', ctx),
      createdBy: requireCreatedBy(row, ctx),
    };
  }
}

// ── 创作契约当前指针仓库实现 ──────────────────────────────────

export class CreationContractCurrentRepositoryImpl implements CreationContractCurrentRepositoryPort {
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE constraint failed')) {
        return false;
      }
      throw e;
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

  get(projectId: string): CreationContractCurrentData | null {
    const row = this.db
      .prepare(
        `SELECT project_id, current_version_id, updated_at
         FROM creation_contract_current
         WHERE project_id = ?`,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const ctx = 'creation_contract_current';
    return {
      projectId: requireString(row, 'project_id', ctx),
      currentVersionId: requireString(row, 'current_version_id', ctx),
      updatedAt: requireString(row, 'updated_at', ctx),
    };
  }
}

// ── 创作契约锁定事件仓库实现 ──────────────────────────────────

export class CreationContractLockEventRepositoryImpl implements CreationContractLockEventRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  append(data: CreationContractLockEventData): void {
    const canonicalPath = canonicalizeContractFieldPath(data.fieldPath);
    parseContractFieldPath(canonicalPath);
    if (data.action !== 'LOCK' && data.action !== 'UNLOCK') {
      throw new ContractDataCorruptionError(`lock event: invalid action "${data.action}"`);
    }
    this.db
      .prepare(
        `INSERT INTO creation_contract_lock_events
           (id, project_id, field_path, action, version_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        canonicalPath,
        data.action,
        data.versionId,
        data.createdAt,
        data.createdBy,
      );
  }

  listByVersionId(
    projectId: string,
    versionId: string,
  ): ReadonlyArray<CreationContractLockEventData> {
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

  listByProject(projectId: string): ReadonlyArray<CreationContractLockEventData> {
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

  private toRow(row: Record<string, unknown>): CreationContractLockEventData {
    const ctx = 'creation_contract_lock_events';
    const action = requireString(row, 'action', ctx);
    if (action !== 'LOCK' && action !== 'UNLOCK') {
      throw new ContractDataCorruptionError(`${ctx}: action 无效 "${action}"`);
    }
    const fieldPath = requireString(row, 'field_path', ctx);
    try {
      parseContractFieldPath(fieldPath);
    } catch {
      throw new ContractDataCorruptionError(`${ctx}: invalid field_path "${fieldPath}"`);
    }
    return {
      id: requireString(row, 'id', ctx),
      projectId: requireString(row, 'project_id', ctx),
      fieldPath,
      action,
      versionId: requireString(row, 'version_id', ctx),
      createdAt: requireString(row, 'created_at', ctx),
      createdBy: requireString(row, 'created_by', ctx),
    };
  }
}
