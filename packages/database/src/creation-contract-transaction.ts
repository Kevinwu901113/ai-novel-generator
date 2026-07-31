/**
 * 创作契约事务适配器。
 *
 * 实现 CreationContractTransactionPort，在同一 SQLite 事务内
 * 提供所有创作契约仓库和读取端口。
 *
 * 加固：
 * - BEGIN IMMEDIATE 失败分类（SQLITE_BUSY/LOCKED，优先使用稳定 errcode）
 * - 嵌套事务检测
 * - COMMIT 失败后尝试 rollback
 * - rollback 失败不覆盖原始错误
 * - 非 AppError（如 SQLite 约束错误）转换为安全基础设施错误
 * - Promise/thenable 回调拒绝（同步事务不允许异步回调）
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  CreationContractTransactionPort,
  CreationContractTransactionRepositories,
  GrillSessionVersionReadPort,
  ProjectExistsReadPort,
} from '@ai-novel/application';
import {
  AppError,
  ContractTransactionBusyError,
  ContractNestedTransactionError,
  ContractTransactionError,
  ContractAsyncTransactionCallbackError,
} from '@ai-novel/application';
import {
  CreationContractProposalRepositoryImpl,
  CreationContractVersionRepositoryImpl,
  CreationContractCurrentRepositoryImpl,
  CreationContractLockEventRepositoryImpl,
} from './creation-contract-repositories.js';

// ── Grill Session 版本读取端口 ─────────────────────────────────

class GrillSessionVersionReadPortImpl implements GrillSessionVersionReadPort {
  constructor(private readonly db: DatabaseSync) {}

  getVersion(projectId: string, sessionId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT version FROM grill_sessions
         WHERE id = ? AND project_id = ?`,
      )
      .get(sessionId, projectId) as { version: number } | undefined;
    return row?.version ?? null;
  }
}

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

/**
 * node:sqlite 错误对象提供稳定 `errcode`（SQLite primary/extended result code）。
 * 优先使用 errcode，只有属性不可用（如非 node:sqlite 的 fake adapter）时
 * 才回退到受控的 message 文本匹配。
 */
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
    msg.includes('SQLITE_BUSY') || msg.includes('SQLITE_LOCKED') || msg.includes('database is locked')
  );
}

function isBusyOrLockedError(err: unknown): boolean {
  const primary = sqlitePrimaryErrorCode(err);
  if (primary !== null) return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
  return hasBusyOrLockedMessage(err);
}

/**
 * 把事务边界上的任意错误转换为安全错误：
 * - AppError 原样透传（应用层已定义自己的错误语义）
 * - busy/locked → ContractTransactionBusyError
 * - 其他（SQLite 约束、磁盘错误等）→ ContractTransactionError
 * 内部诊断均保存在 cause，不进入 public message。
 */
function toSafeTransactionError(err: unknown): Error {
  if (err instanceof AppError) return err;
  if (isBusyOrLockedError(err)) return new ContractTransactionBusyError(err);
  return new ContractTransactionError(err);
}

/**
 * 同步事务不允许回调返回 Promise/thenable：
 * 否则 adapter 会在 Promise 完成前 COMMIT，破坏事务生命周期。
 */
function assertSyncCallbackResult<T>(result: T): void {
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    throw new ContractAsyncTransactionCallbackError();
  }
}

// ── 事务适配器实现 ──────────────────────────────────────────────

export class CreationContractTransactionPortImpl implements CreationContractTransactionPort {
  private readonly proposalRepo: CreationContractProposalRepositoryImpl;
  private readonly versionRepo: CreationContractVersionRepositoryImpl;
  private readonly currentRepo: CreationContractCurrentRepositoryImpl;
  private readonly lockEventRepo: CreationContractLockEventRepositoryImpl;
  private readonly grillSessionVersionPort: GrillSessionVersionReadPortImpl;
  private readonly projectExistsPort: ProjectExistsReadPortImpl;
  private inTransaction = false;

  constructor(private readonly db: DatabaseSync) {
    this.proposalRepo = new CreationContractProposalRepositoryImpl(db);
    this.versionRepo = new CreationContractVersionRepositoryImpl(db);
    this.currentRepo = new CreationContractCurrentRepositoryImpl(db);
    this.lockEventRepo = new CreationContractLockEventRepositoryImpl(db);
    this.grillSessionVersionPort = new GrillSessionVersionReadPortImpl(db);
    this.projectExistsPort = new ProjectExistsReadPortImpl(db);
  }

  runInTransaction<T>(operation: (repositories: CreationContractTransactionRepositories) => T): T {
    if (this.inTransaction) {
      throw new ContractNestedTransactionError();
    }

    this.inTransaction = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      this.inTransaction = false;
      throw toSafeTransactionError(err);
    }

    const repositories: CreationContractTransactionRepositories = {
      proposalRepo: this.proposalRepo,
      versionRepo: this.versionRepo,
      currentRepo: this.currentRepo,
      lockEventRepo: this.lockEventRepo,
      grillSessionVersionReadPort: this.grillSessionVersionPort,
      projectExistsReadPort: this.projectExistsPort,
    };

    try {
      const result = operation(repositories);
      assertSyncCallbackResult(result);
      try {
        this.db.exec('COMMIT');
      } catch (commitErr) {
        // COMMIT 失败：尝试 ROLLBACK（失败不覆盖原始 COMMIT 错误），
        // 并标记事务已结束，外层 catch 不再重复 ROLLBACK
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
