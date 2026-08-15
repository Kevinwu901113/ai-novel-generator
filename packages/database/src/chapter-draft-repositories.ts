/**
 * 章节草稿 SQLite 仓库实现（TD-033-3）。
 *
 * chapter_drafts 是 autosave 独立层：每章至多一份草稿，upsert 只改草稿表，
 * 绝不触 chapter_versions / chapters.current_version_id。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ChapterDraftData, ChapterDraftRepositoryPort } from '@ai-novel/application';
import { requireString, optionalString } from './creation-contract-repositories.js';

export class ChapterDraftRepositoryImpl implements ChapterDraftRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  upsert(data: ChapterDraftData): void {
    this.db
      .prepare(
        `INSERT INTO chapter_drafts
           (project_id, chapter_id, title, content, base_version_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, chapter_id) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           base_version_id = excluded.base_version_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        data.projectId,
        data.chapterId,
        data.title,
        data.content,
        data.baseVersionId,
        data.updatedAt,
      );
  }

  getByChapter(projectId: string, chapterId: string): ChapterDraftData | null {
    const row = this.db
      .prepare(
        `SELECT project_id, chapter_id, title, content, base_version_id, updated_at
         FROM chapter_drafts WHERE project_id = ? AND chapter_id = ?`,
      )
      .get(projectId, chapterId) as Record<string, unknown> | undefined;
    return row ? this.toRow(row) : null;
  }

  deleteByChapter(projectId: string, chapterId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM chapter_drafts WHERE project_id = ? AND chapter_id = ?')
      .run(projectId, chapterId);
    return result.changes === 1;
  }

  private toRow(row: Record<string, unknown>): ChapterDraftData {
    const ctx = 'chapter_drafts';
    return {
      projectId: requireString(row, 'project_id', ctx),
      chapterId: requireString(row, 'chapter_id', ctx),
      title: optionalString(row, 'title'),
      content: requireString(row, 'content', ctx),
      baseVersionId: optionalString(row, 'base_version_id'),
      updatedAt: requireString(row, 'updated_at', ctx),
    };
  }
}
