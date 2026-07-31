/**
 * 创作契约事务适配器。
 *
 * 实现 CreationContractTransactionPort，在同一 SQLite 事务内
 * 提供所有创作契约仓库和读取端口。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  CreationContractTransactionPort,
  CreationContractTransactionRepositories,
  GrillSessionVersionReadPort,
  ProjectExistsReadPort,
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

// ── 事务适配器实现 ──────────────────────────────────────────────

export class CreationContractTransactionPortImpl implements CreationContractTransactionPort {
  private readonly proposalRepo: CreationContractProposalRepositoryImpl;
  private readonly versionRepo: CreationContractVersionRepositoryImpl;
  private readonly currentRepo: CreationContractCurrentRepositoryImpl;
  private readonly lockEventRepo: CreationContractLockEventRepositoryImpl;
  private readonly grillSessionVersionPort: GrillSessionVersionReadPortImpl;
  private readonly projectExistsPort: ProjectExistsReadPortImpl;

  constructor(private readonly db: DatabaseSync) {
    this.proposalRepo = new CreationContractProposalRepositoryImpl(db);
    this.versionRepo = new CreationContractVersionRepositoryImpl(db);
    this.currentRepo = new CreationContractCurrentRepositoryImpl(db);
    this.lockEventRepo = new CreationContractLockEventRepositoryImpl(db);
    this.grillSessionVersionPort = new GrillSessionVersionReadPortImpl(db);
    this.projectExistsPort = new ProjectExistsReadPortImpl(db);
  }

  runInTransaction<T>(operation: (repositories: CreationContractTransactionRepositories) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const repositories: CreationContractTransactionRepositories = {
        proposalRepo: this.proposalRepo,
        versionRepo: this.versionRepo,
        currentRepo: this.currentRepo,
        lockEventRepo: this.lockEventRepo,
        grillSessionVersionReadPort: this.grillSessionVersionPort,
        projectExistsReadPort: this.projectExistsPort,
      };
      const result = operation(repositories);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      // rollback 自身失败不得覆盖原始错误
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // rollback 失败时忽略，原始错误仍然抛出
      }
      throw err;
    }
  }
}
