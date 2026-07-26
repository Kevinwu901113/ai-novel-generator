/**
 * App 数据库（app.sqlite）实现。
 *
 * 管理应用级项目索引。
 * 使用 node:sqlite 的 DatabaseSync 同步 API。
 */

import { DatabaseSync } from 'node:sqlite';
import { SQLiteMigrator } from './migrator.js';
import type {
  AppDatabaseManager,
  ProjectIndexRepository,
  ProjectIndexRow,
  CreateProjectIndexData,
  ProjectCreationRepository,
  ProjectCreationRow,
  CreateProjectCreationData,
  CreationPhase,
  Migration,
} from './types.js';

// ── 迁移定义 ──────────────────────────────────────────────────────

const APP_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        initial_idea TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idea',
        project_directory TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS project_creations (
        project_id TEXT PRIMARY KEY,
        temp_directory_name TEXT NOT NULL,
        final_directory_name TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'preparing',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
];

// ── 项目索引仓库实现 ──────────────────────────────────────────────

class ProjectIndexRepositoryImpl implements ProjectIndexRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateProjectIndexData): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, initial_idea, status, project_directory, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.name,
        data.initialIdea,
        data.status,
        data.projectDirectory,
        data.createdAt,
        data.updatedAt,
      );
  }

  list(): ReadonlyArray<ProjectIndexRow> {
    const rows = this.db
      .prepare(
        `SELECT id, name, initial_idea, status, project_directory, created_at, updated_at, last_opened_at
         FROM projects
         ORDER BY
           CASE WHEN last_opened_at IS NULL THEN 1 ELSE 0 END,
           last_opened_at DESC,
           created_at DESC`,
      )
      .all() as Array<{
      id: string;
      name: string;
      initial_idea: string;
      status: string;
      project_directory: string;
      created_at: string;
      updated_at: string;
      last_opened_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      initialIdea: row.initial_idea,
      status: row.status,
      projectDirectory: row.project_directory,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at,
    }));
  }

  getById(id: string): ProjectIndexRow | null {
    const row = this.db
      .prepare(
        `SELECT id, name, initial_idea, status, project_directory, created_at, updated_at, last_opened_at
         FROM projects WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          name: string;
          initial_idea: string;
          status: string;
          project_directory: string;
          created_at: string;
          updated_at: string;
          last_opened_at: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      initialIdea: row.initial_idea,
      status: row.status,
      projectDirectory: row.project_directory,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at,
    };
  }

  updateLastOpened(id: string, timestamp: string): void {
    this.db
      .prepare('UPDATE projects SET last_opened_at = ?, updated_at = ? WHERE id = ?')
      .run(timestamp, timestamp, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}

// ── 创建事务仓库实现 ──────────────────────────────────────────────

class ProjectCreationRepositoryImpl implements ProjectCreationRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateProjectCreationData): void {
    this.db
      .prepare(
        `INSERT INTO project_creations (project_id, temp_directory_name, final_directory_name, phase, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.projectId,
        data.tempDirectoryName,
        data.finalDirectoryName,
        data.phase,
        data.createdAt,
        data.updatedAt,
      );
  }

  getByProjectId(projectId: string): ProjectCreationRow | null {
    const row = this.db
      .prepare(
        `SELECT project_id, temp_directory_name, final_directory_name, phase, created_at, updated_at
         FROM project_creations WHERE project_id = ?`,
      )
      .get(projectId) as
      | {
          project_id: string;
          temp_directory_name: string;
          final_directory_name: string;
          phase: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      projectId: row.project_id,
      tempDirectoryName: row.temp_directory_name,
      finalDirectoryName: row.final_directory_name,
      phase: row.phase as CreationPhase,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): ReadonlyArray<ProjectCreationRow> {
    const rows = this.db
      .prepare(
        `SELECT project_id, temp_directory_name, final_directory_name, phase, created_at, updated_at
         FROM project_creations ORDER BY created_at`,
      )
      .all() as Array<{
      project_id: string;
      temp_directory_name: string;
      final_directory_name: string;
      phase: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      projectId: row.project_id,
      tempDirectoryName: row.temp_directory_name,
      finalDirectoryName: row.final_directory_name,
      phase: row.phase as CreationPhase,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updatePhase(projectId: string, phase: CreationPhase, updatedAt: string): void {
    this.db
      .prepare('UPDATE project_creations SET phase = ?, updated_at = ? WHERE project_id = ?')
      .run(phase, updatedAt, projectId);
  }

  delete(projectId: string): void {
    this.db.prepare('DELETE FROM project_creations WHERE project_id = ?').run(projectId);
  }
}

// ── App 数据库管理器 ──────────────────────────────────────────────

export class AppDatabase implements AppDatabaseManager {
  private readonly db: DatabaseSync;
  private readonly projectIndexRepo: ProjectIndexRepositoryImpl;
  private readonly projectCreationRepo: ProjectCreationRepositoryImpl;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);

    // 配置 SQLite
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');

    // 运行迁移
    const migrator = new SQLiteMigrator(this.db);
    migrator.migrate(0, APP_MIGRATIONS);

    this.projectIndexRepo = new ProjectIndexRepositoryImpl(this.db);
    this.projectCreationRepo = new ProjectCreationRepositoryImpl(this.db);
  }

  getProjectIndexRepository(): ProjectIndexRepository {
    return this.projectIndexRepo;
  }

  getProjectCreationRepository(): ProjectCreationRepository {
    return this.projectCreationRepo;
  }

  close(): void {
    this.db.close();
  }
}
