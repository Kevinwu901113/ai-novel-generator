/**
 * 稿件 / 章节 / 章节版本 SQLite 仓库实现。
 *
 * 全部查询按 (project_id, …) 作用域，跨 project 自然返回 NOT_FOUND（§5 不变量 1）。
 * 权威规格：docs/development/manuscript-version-design.md（§4、§6.4）。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  isValidChapterStatus,
  isValidManuscriptStatus,
  isValidChapterVersionSourceType,
  isLowercaseSha256Hex,
  type ChapterStatus,
  type ChapterVersionSourceType,
  type ManuscriptStatus,
} from '@ai-novel/domain';
import {
  ContractDataCorruptionError,
  type ManuscriptRepositoryPort,
  type ChapterRepositoryPort,
  type ChapterVersionRepositoryPort,
  type ManuscriptData,
  type ChapterData,
  type ChapterVersionData,
  type ChapterVersionSummaryData,
  type CreateManuscriptInput,
  type CreateChapterInput,
  type CreateChapterVersionInput,
} from '@ai-novel/application';
import {
  sha256Utf8,
  requireString,
  requireNumber,
  optionalString,
} from './creation-contract-repositories.js';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function requireStatus<T extends 'active' | 'archived'>(
  row: Record<string, unknown>,
  context: string,
  check: (v: unknown) => v is T,
  label: string,
): T {
  const v = row.status;
  if (typeof v !== 'string' || !check(v)) {
    throw new ContractDataCorruptionError(`${context}: ${label} 无效 "${String(v)}"`);
  }
  return v as T;
}

function requireSourceType(
  row: Record<string, unknown>,
  context: string,
): ChapterVersionSourceType {
  const v = row.source_type;
  if (typeof v !== 'string' || !isValidChapterVersionSourceType(v)) {
    throw new ContractDataCorruptionError(`${context}: source_type 无效 "${String(v)}"`);
  }
  return v;
}

function requirePosition(row: Record<string, unknown>, context: string): number {
  const v = requireNumber(row, 'position', context);
  if (!Number.isSafeInteger(v) || v < 1) {
    throw new ContractDataCorruptionError(`${context}: position 必须为正安全整数`);
  }
  return v;
}

function requireVersionNumber(row: Record<string, unknown>, context: string): number {
  const v = requireNumber(row, 'version_number', context);
  if (!Number.isSafeInteger(v) || v < 1) {
    throw new ContractDataCorruptionError(`${context}: version_number 必须为正安全整数`);
  }
  return v;
}

function requireContentHash(row: Record<string, unknown>, context: string): string {
  const v = requireString(row, 'content_hash', context);
  if (!SHA256_HEX_RE.test(v)) {
    throw new ContractDataCorruptionError(`${context}: content_hash 不是 lowercase SHA-256 hex`);
  }
  return v;
}

// ── 稿件仓库 ──────────────────────────────────────────────

export class ManuscriptRepositoryImpl implements ManuscriptRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateManuscriptInput): void {
    this.db
      .prepare(
        `INSERT INTO manuscripts
           (id, project_id, title, status, creation_contract_version_id, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.title,
        data.creationContractVersionId,
        data.createdAt,
        data.updatedAt,
      );
  }

  getById(projectId: string, id: string): ManuscriptData | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, title, status, creation_contract_version_id, created_at, updated_at
         FROM manuscripts WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, id) as Record<string, unknown> | undefined;
    return row ? this.toRow(row) : null;
  }

  getActiveByProject(projectId: string): ManuscriptData | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, title, status, creation_contract_version_id, created_at, updated_at
         FROM manuscripts WHERE project_id = ? AND status = 'active'
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? this.toRow(row) : null;
  }

  updateTitle(
    projectId: string,
    id: string,
    title: string,
    expectedUpdatedAt: string,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE manuscripts SET title = ?, updated_at = ?
         WHERE project_id = ? AND id = ? AND updated_at = ?`,
      )
      .run(title, now, projectId, id, expectedUpdatedAt);
    return result.changes === 1;
  }

  touch(projectId: string, id: string, now: string): void {
    this.db
      .prepare(`UPDATE manuscripts SET updated_at = ? WHERE project_id = ? AND id = ?`)
      .run(now, projectId, id);
  }

  private toRow(row: Record<string, unknown>): ManuscriptData {
    const ctx = 'manuscripts';
    const status = requireStatus<ManuscriptStatus>(row, ctx, isValidManuscriptStatus, 'status');
    return {
      id: requireString(row, 'id', ctx),
      projectId: requireString(row, 'project_id', ctx),
      title: requireString(row, 'title', ctx),
      status,
      creationContractVersionId: optionalString(row, 'creation_contract_version_id'),
      createdAt: requireString(row, 'created_at', ctx),
      updatedAt: requireString(row, 'updated_at', ctx),
    };
  }
}

// ── 章节仓库 ──────────────────────────────────────────────

export class ChapterRepositoryImpl implements ChapterRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateChapterInput): void {
    this.db
      .prepare(
        `INSERT INTO chapters
           (id, project_id, manuscript_id, position, current_version_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.manuscriptId,
        data.position,
        data.createdAt,
        data.updatedAt,
      );
  }

  getById(projectId: string, id: string): ChapterData | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, manuscript_id, position, current_version_id, status, created_at, updated_at
         FROM chapters WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, id) as Record<string, unknown> | undefined;
    return row ? this.toRow(row) : null;
  }

  listByManuscript(projectId: string, manuscriptId: string): ReadonlyArray<ChapterData> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, manuscript_id, position, current_version_id, status, created_at, updated_at
         FROM chapters WHERE project_id = ? AND manuscript_id = ?
         ORDER BY position ASC, id ASC`,
      )
      .all(projectId, manuscriptId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toRow(r));
  }

  getMaxPosition(projectId: string, manuscriptId: string): number | null {
    const row = this.db
      .prepare(`SELECT MAX(position) as m FROM chapters WHERE project_id = ? AND manuscript_id = ?`)
      .get(projectId, manuscriptId) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  casUpdateCurrentVersionId(
    projectId: string,
    chapterId: string,
    expectedCurrentVersionId: string | null,
    newVersionId: string,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE chapters SET current_version_id = ?, updated_at = ?
         WHERE project_id = ? AND id = ? AND current_version_id IS ?`,
      )
      .run(newVersionId, now, projectId, chapterId, expectedCurrentVersionId);
    return result.changes === 1;
  }

  casUpdateStatus(
    projectId: string,
    chapterId: string,
    expectedCurrentVersionId: string | null,
    expectedStatus: ChapterStatus,
    newStatus: ChapterStatus,
    now: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE chapters SET status = ?, updated_at = ?
         WHERE project_id = ? AND id = ? AND current_version_id IS ? AND status = ?`,
      )
      .run(newStatus, now, projectId, chapterId, expectedCurrentVersionId, expectedStatus);
    return result.changes === 1;
  }

  updatePosition(projectId: string, chapterId: string, position: number, now: string): void {
    this.db
      .prepare(`UPDATE chapters SET position = ?, updated_at = ? WHERE project_id = ? AND id = ?`)
      .run(position, now, projectId, chapterId);
  }

  private toRow(row: Record<string, unknown>): ChapterData {
    const ctx = 'chapters';
    const status = requireStatus<ChapterStatus>(row, ctx, isValidChapterStatus, 'status');
    return {
      id: requireString(row, 'id', ctx),
      projectId: requireString(row, 'project_id', ctx),
      manuscriptId: requireString(row, 'manuscript_id', ctx),
      position: requirePosition(row, ctx),
      currentVersionId: optionalString(row, 'current_version_id'),
      status,
      createdAt: requireString(row, 'created_at', ctx),
      updatedAt: requireString(row, 'updated_at', ctx),
    };
  }
}

// ── 章节版本仓库 ──────────────────────────────────────────

export class ChapterVersionRepositoryImpl implements ChapterVersionRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateChapterVersionInput): void {
    if (!Number.isSafeInteger(data.versionNumber) || data.versionNumber < 1) {
      throw new ContractDataCorruptionError(
        'chapter version create: versionNumber 必须为正安全整数',
      );
    }
    if (!isLowercaseSha256Hex(data.contentHash)) {
      throw new ContractDataCorruptionError(
        'chapter version create: contentHash 不是 lowercase SHA-256 hex',
      );
    }
    const recomputed = sha256Utf8(data.content);
    if (recomputed !== data.contentHash) {
      throw new ContractDataCorruptionError('chapter version create: contentHash mismatch');
    }
    if (!isValidChapterVersionSourceType(data.sourceType)) {
      throw new ContractDataCorruptionError(
        `chapter version create: sourceType 无效 "${String(data.sourceType)}"`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO chapter_versions
           (id, project_id, chapter_id, version_number, title, content, content_hash,
            parent_version_id, source_type, created_by_task_id, invocation_id,
            creation_contract_version_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.chapterId,
        data.versionNumber,
        data.title,
        data.content,
        data.contentHash,
        data.parentVersionId,
        data.sourceType,
        data.createdByTaskId,
        data.invocationId,
        data.creationContractVersionId,
        data.createdAt,
      );
  }

  getById(projectId: string, chapterId: string, id: string): ChapterVersionData | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, chapter_id, version_number, title, content, content_hash,
                parent_version_id, source_type, created_by_task_id, invocation_id,
                creation_contract_version_id, created_at
         FROM chapter_versions WHERE project_id = ? AND chapter_id = ? AND id = ?`,
      )
      .get(projectId, chapterId, id) as Record<string, unknown> | undefined;
    return row ? this.toRow(row) : null;
  }

  getSummaryById(
    projectId: string,
    chapterId: string,
    id: string,
  ): ChapterVersionSummaryData | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, chapter_id, version_number, title, source_type, created_at,
                parent_version_id, creation_contract_version_id, content_hash
         FROM chapter_versions WHERE project_id = ? AND chapter_id = ? AND id = ?`,
      )
      .get(projectId, chapterId, id) as Record<string, unknown> | undefined;
    return row ? this.toSummary(row) : null;
  }

  listSummariesByChapter(
    projectId: string,
    chapterId: string,
  ): ReadonlyArray<ChapterVersionSummaryData> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, chapter_id, version_number, title, source_type, created_at,
                parent_version_id, creation_contract_version_id, content_hash
         FROM chapter_versions WHERE project_id = ? AND chapter_id = ?
         ORDER BY version_number DESC, id ASC`,
      )
      .all(projectId, chapterId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toSummary(r));
  }

  getMaxVersionNumber(projectId: string, chapterId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(version_number) as m FROM chapter_versions WHERE project_id = ? AND chapter_id = ?`,
      )
      .get(projectId, chapterId) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  countByChapter(projectId: string, chapterId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM chapter_versions WHERE project_id = ? AND chapter_id = ?`)
      .get(projectId, chapterId) as { c: number };
    return row.c;
  }

  private toRow(row: Record<string, unknown>): ChapterVersionData {
    const ctx = 'chapter_versions';
    return {
      id: requireString(row, 'id', ctx),
      projectId: requireString(row, 'project_id', ctx),
      chapterId: requireString(row, 'chapter_id', ctx),
      versionNumber: requireVersionNumber(row, ctx),
      title: requireString(row, 'title', ctx),
      content: requireString(row, 'content', ctx),
      contentHash: requireContentHash(row, ctx),
      parentVersionId: optionalString(row, 'parent_version_id'),
      sourceType: requireSourceType(row, ctx),
      createdByTaskId: optionalString(row, 'created_by_task_id'),
      invocationId: optionalString(row, 'invocation_id'),
      creationContractVersionId: optionalString(row, 'creation_contract_version_id'),
      createdAt: requireString(row, 'created_at', ctx),
    };
  }

  private toSummary(row: Record<string, unknown>): ChapterVersionSummaryData {
    const ctx = 'chapter_versions';
    return {
      id: requireString(row, 'id', ctx),
      chapterId: requireString(row, 'chapter_id', ctx),
      versionNumber: requireVersionNumber(row, ctx),
      title: requireString(row, 'title', ctx),
      sourceType: requireSourceType(row, ctx),
      createdAt: requireString(row, 'created_at', ctx),
      parentVersionId: optionalString(row, 'parent_version_id'),
      creationContractVersionId: optionalString(row, 'creation_contract_version_id'),
      contentHash: requireContentHash(row, ctx),
    };
  }
}
