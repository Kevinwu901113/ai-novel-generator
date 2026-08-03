/**
 * Graph Run 事务适配器（GE-1）。
 *
 * 实现 GraphRunTransactionPort，在同一 SQLite 事务内提供 graph-run 仓库、
 * 幂等命令日志与权威 answer 存储。
 *
 * 加固（与 creation-contract-transaction.ts 同一模式）：
 * - BEGIN IMMEDIATE 失败分类（SQLITE_BUSY/LOCKED）
 * - 嵌套事务检测
 * - COMMIT 失败后尝试 rollback（失败不覆盖原始错误）
 * - 非 AppError（如 SQLite 约束错误）转换为安全基础设施错误
 * - Promise/thenable 回调拒绝（同步事务不允许异步回调）
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  GraphRunTransactionPort,
  GraphRunTransactionRepositories,
} from '@ai-novel/application';
import {
  AppError,
  GraphRunAsyncTransactionCallbackError,
  GraphRunNestedTransactionError,
  GraphRunTransactionBusyError,
  GraphRunTransactionError,
} from '@ai-novel/application';
import {
  GraphRunCommandLogRepositoryImpl,
  GraphRunRepositoryImpl,
  IdeaIntakeAnswerPortImpl,
} from './graph-run-repositories.js';

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
  if (isBusyOrLockedError(err)) return new GraphRunTransactionBusyError(err);
  return new GraphRunTransactionError(err);
}

function assertSyncCallbackResult<T>(result: T): void {
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    throw new GraphRunAsyncTransactionCallbackError();
  }
}

// ── 事务适配器实现 ──────────────────────────────────────────────

export class GraphRunTransactionPortImpl implements GraphRunTransactionPort {
  private readonly graphRunRepo: GraphRunRepositoryImpl;
  private readonly commandLogRepo: GraphRunCommandLogRepositoryImpl;
  private readonly intakeAnswerPort: IdeaIntakeAnswerPortImpl;
  private inTransaction = false;

  constructor(private readonly db: DatabaseSync) {
    this.graphRunRepo = new GraphRunRepositoryImpl(db);
    this.commandLogRepo = new GraphRunCommandLogRepositoryImpl(db);
    this.intakeAnswerPort = new IdeaIntakeAnswerPortImpl(db);
  }

  runInTransaction<T>(operation: (repos: GraphRunTransactionRepositories) => T): T {
    if (this.inTransaction) {
      throw new GraphRunNestedTransactionError();
    }

    this.inTransaction = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      this.inTransaction = false;
      throw toSafeTransactionError(err);
    }

    const repositories: GraphRunTransactionRepositories = {
      graphRunRepo: this.graphRunRepo,
      commandLog: this.commandLogRepo,
      intakeAnswer: this.intakeAnswerPort,
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
