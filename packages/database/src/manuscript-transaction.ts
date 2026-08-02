/**
 * 稿件事务适配器。
 *
 * 实现 ManuscriptTransactionPort，在同一 SQLite 事务（BEGIN IMMEDIATE）内
 * 提供全部稿件仓库和读取端口。加固与创作契约事务适配器一致：
 * - BEGIN IMMEDIATE 失败分类（SQLITE_BUSY/LOCKED）；
 * - 嵌套事务检测；
 * - COMMIT 失败后尝试 rollback；
 * - 非 AppError（如 SQLite 约束错误）转换为安全基础设施错误；
 * - Promise/thenable 回调拒绝。
 *
 * 权威规格：manuscript-version-design.md §11（全部写操作单事务）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  ManuscriptTransactionPort,
  ManuscriptTransactionRepositories,
  ProjectExistsReadPort,
} from '@ai-novel/application';
import {
  AppError,
  ManuscriptTransactionBusyError,
  ManuscriptNestedTransactionError,
  ManuscriptTransactionError,
  ManuscriptAsyncTransactionCallbackError,
} from '@ai-novel/application';
import {
  ManuscriptRepositoryImpl,
  ChapterRepositoryImpl,
  ChapterVersionRepositoryImpl,
} from './manuscript-repositories.js';

// ── 项目存在性读取端口 ─────────────────────────────────────────

class ProjectExistsReadPortImpl implements ProjectExistsReadPort {
  constructor(private readonly db: DatabaseSync) {}

  exists(projectId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM project_metadata WHERE id = ?').get(projectId) as
      { 1: number } | undefined;
    return row !== undefined;
  }
}

// ── SQLite 错误分类 ────────────────────────────────────────────

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function sqlitePrimaryErrorCode(err: unknown): number | null {
  if (err !== null && typeof err === 'object' && 'errcode' in err) {
    const code = (err as { errcode?: unknown }).errcode;
    if (typeof code === 'number' && Number.isInteger(code)) {
      return code & 0xff;
    }
  }
  return null;
}

function hasBusyOrLockedMessage(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('SQLITE_BUSY') ||
    msg.includes('SQLITE_LOCKED') ||
    msg.includes('database is locked')
  );
}

function isBusyOrLockedError(err: unknown): boolean {
  const primary = sqlitePrimaryErrorCode(err);
  if (primary !== null) return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
  return hasBusyOrLockedMessage(err);
}

function toSafeTransactionError(err: unknown): Error {
  if (err instanceof AppError) return err;
  if (isBusyOrLockedError(err)) return new ManuscriptTransactionBusyError(err);
  return new ManuscriptTransactionError(err);
}

function assertSyncCallbackResult<T>(result: T): void {
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    throw new ManuscriptAsyncTransactionCallbackError();
  }
}

// ── 事务适配器实现 ──────────────────────────────────────────────

export class ManuscriptTransactionPortImpl implements ManuscriptTransactionPort {
  private readonly manuscriptRepo: ManuscriptRepositoryImpl;
  private readonly chapterRepo: ChapterRepositoryImpl;
  private readonly chapterVersionRepo: ChapterVersionRepositoryImpl;
  private readonly projectExistsPort: ProjectExistsReadPortImpl;
  private inTransaction = false;

  constructor(private readonly db: DatabaseSync) {
    this.manuscriptRepo = new ManuscriptRepositoryImpl(db);
    this.chapterRepo = new ChapterRepositoryImpl(db);
    this.chapterVersionRepo = new ChapterVersionRepositoryImpl(db);
    this.projectExistsPort = new ProjectExistsReadPortImpl(db);
  }

  runInTransaction<T>(operation: (repositories: ManuscriptTransactionRepositories) => T): T {
    if (this.inTransaction) {
      throw new ManuscriptNestedTransactionError();
    }

    this.inTransaction = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      this.inTransaction = false;
      throw toSafeTransactionError(err);
    }

    const repositories: ManuscriptTransactionRepositories = {
      manuscriptRepo: this.manuscriptRepo,
      chapterRepo: this.chapterRepo,
      chapterVersionRepo: this.chapterVersionRepo,
      projectExistsReadPort: this.projectExistsPort,
    };

    try {
      const result = operation(repositories);
      assertSyncCallbackResult(result);
      try {
        this.db.exec('COMMIT');
      } catch (commitErr) {
        this.inTransaction = false;
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // rollback 失败不覆盖原始 COMMIT 错误
        }
        throw toSafeTransactionError(commitErr);
      }
      this.inTransaction = false;
      return result;
    } catch (err) {
      if (this.inTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // rollback 失败不覆盖原始错误
        }
        this.inTransaction = false;
      }
      throw toSafeTransactionError(err);
    }
  }
}
