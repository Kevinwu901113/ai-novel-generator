/**
 * 项目数据库（project.sqlite）实现。
 *
 * 管理单个小说项目的元数据。
 * 使用 node:sqlite 的 DatabaseSync 同步 API。
 */

import { DatabaseSync } from 'node:sqlite';
import { SQLiteMigrator } from './migrator.js';
import type {
  ProjectDatabaseManager,
  ProjectMetadataRepository,
  ProjectMetadataRow,
  CreateProjectMetadataData,
  Migration,
} from './types.js';

// ── 迁移定义 ──────────────────────────────────────────────────────

const PROJECT_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_metadata (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        initial_idea TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idea',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
];

// ── 项目元数据仓库实现 ────────────────────────────────────────────

class ProjectMetadataRepositoryImpl implements ProjectMetadataRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateProjectMetadataData): void {
    this.db
      .prepare(
        `INSERT INTO project_metadata (id, name, initial_idea, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(data.id, data.name, data.initialIdea, data.status, data.createdAt, data.updatedAt);
  }

  get(): ProjectMetadataRow | null {
    const row = this.db
      .prepare(
        'SELECT id, name, initial_idea, status, created_at, updated_at FROM project_metadata LIMIT 1',
      )
      .get() as
      | {
          id: string;
          name: string;
          initial_idea: string;
          status: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      initialIdea: row.initial_idea,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  update(data: Partial<Omit<ProjectMetadataRow, 'id'>>): void {
    const sets: string[] = [];
    const values: Array<string | null> = [];

    if (data.name !== undefined) {
      sets.push('name = ?');
      values.push(data.name);
    }
    if (data.initialIdea !== undefined) {
      sets.push('initial_idea = ?');
      values.push(data.initialIdea);
    }
    if (data.status !== undefined) {
      sets.push('status = ?');
      values.push(data.status);
    }
    if (data.createdAt !== undefined) {
      sets.push('created_at = ?');
      values.push(data.createdAt);
    }
    if (data.updatedAt !== undefined) {
      sets.push('updated_at = ?');
      values.push(data.updatedAt);
    }

    if (sets.length === 0) return;

    this.db.prepare(`UPDATE project_metadata SET ${sets.join(', ')}`).run(...values);
  }
}

// ── 项目数据库管理器 ──────────────────────────────────────────────

export class ProjectDatabase implements ProjectDatabaseManager {
  private readonly db: DatabaseSync;
  private readonly metadataRepo: ProjectMetadataRepositoryImpl;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);

    // 配置 SQLite
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');

    // 运行迁移
    const migrator = new SQLiteMigrator(this.db);
    migrator.migrate(0, PROJECT_MIGRATIONS);

    this.metadataRepo = new ProjectMetadataRepositoryImpl(this.db);
  }

  getProjectMetadataRepository(): ProjectMetadataRepository {
    return this.metadataRepo;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 验证项目数据库版本兼容性（不创建连接）。
 *
 * 打开项目时先检查版本，版本不兼容时给出明确错误。
 */
export function checkProjectDatabaseVersion(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const migrator = new SQLiteMigrator(db);
    const currentVersion = migrator.getCurrentVersion();
    const maxSupported = Math.max(...PROJECT_MIGRATIONS.map((m) => m.version), 0);
    if (currentVersion > maxSupported) {
      throw new Error(
        `项目数据库版本 ${currentVersion} 高于应用支持的最高版本 ${maxSupported}，无法打开。请升级应用。`,
      );
    }
  } finally {
    db.close();
  }
}
