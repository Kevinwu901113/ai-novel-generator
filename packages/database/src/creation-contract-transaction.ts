/**
 * 创作契约事务适配器。
 *
 * 实现 CreationContractTransactionPort，在同一 SQLite 事务内
 * 提供所有创作契约仓库和读取端口。
 *
 * 加固：
 * - BEGIN IMMEDIATE 失败分类（SQLITE_BUSY/LOCKED）
 * - 嵌套事务检测
 * - COMMIT 失败后尝试 rollback
 * - rollback 失败不覆盖原始错误
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  CreationContractTransactionPort,
  CreationContractTransactionRepositories,
  GrillSessionVersionReadPort,
  ProjectExistsReadPort,
} from '@ai-novel/application';
import {
  ContractTransactionBusyError,
  ContractNestedTransactionError,
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

function isSqliteBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('SQLITE_BUSY') || msg.includes('database is locked');
}

function isSqliteLockedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('SQLITE_LOCKED');
}

function classifySqliteError(err: unknown, phase: string): never {
  if (isSqliteBusyError(err) || isSqliteLockedError(err)) {
    throw new ContractTransactionBusyError(`事务 ${phase} 冲突，请重试`);
  }
  throw err;
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
      throw new ContractNestedTransactionError(
        '检测到嵌套创作契约事务 — 不允许在同一连接上嵌套 BEGIN IMMEDIATE',
      );
    }

    this.inTransaction = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      this.inTransaction = false;
      classifySqliteError(err, 'BEGIN');
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
      try {
        this.db.exec('COMMIT');
      } catch (commitErr) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // rollback 失败不覆盖原始 COMMIT 错误
        }
        this.inTransaction = false;
        classifySqliteError(commitErr, 'COMMIT');
      }
      this.inTransaction = false;
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // rollback 失败不覆盖原始错误
      }
      this.inTransaction = false;
      throw err;
    }
  }
}
