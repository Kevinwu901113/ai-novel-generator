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
  ProviderProfileRepository,
  ProviderProfileRow,
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
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        provider_type TEXT NOT NULL,
        display_name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        keychain_service TEXT NOT NULL,
        keychain_account TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_tested_at TEXT,
        last_test_status TEXT,
        last_test_error_code TEXT,
        last_test_latency_ms INTEGER
      ) STRICT;
    `,
  },
  {
    version: 4,
    sql: `
      -- Migration 4: 为 provider_profiles 添加 CHECK 约束。
      -- 处理两种场景：
      --   1. v3 表无约束 → 重建并规范化数据
      --   2. v3 表已有约束 → 数据安全复制
      --   3. v3 表不存在（首次启动直接到 v4）→ 创建新表

      CREATE TABLE IF NOT EXISTS provider_profiles_v4_upgrade AS
        SELECT * FROM provider_profiles WHERE 0;

      ALTER TABLE provider_profiles RENAME TO provider_profiles_v3_old;

      CREATE TABLE provider_profiles (
        id TEXT PRIMARY KEY,
        provider_type TEXT NOT NULL CHECK (provider_type = 'anthropic-compatible'),
        display_name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        keychain_service TEXT NOT NULL,
        keychain_account TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_tested_at TEXT,
        last_test_status TEXT CHECK (last_test_status IS NULL OR last_test_status IN ('never', 'success', 'failed')),
        last_test_error_code TEXT,
        last_test_latency_ms INTEGER CHECK (last_test_latency_ms IS NULL OR last_test_latency_ms >= 0)
      ) STRICT;

      INSERT INTO provider_profiles
        (id, provider_type, display_name, base_url, model,
         keychain_service, keychain_account, enabled,
         created_at, updated_at, last_tested_at, last_test_status,
         last_test_error_code, last_test_latency_ms)
      SELECT
        id, provider_type, display_name, base_url, model,
        keychain_service, keychain_account,
        CASE WHEN enabled IN (0, 1) THEN enabled ELSE 1 END,
        created_at, updated_at, last_tested_at,
        CASE WHEN last_test_status IN ('never', 'success', 'failed') THEN last_test_status ELSE NULL END,
        last_test_error_code,
        CASE WHEN last_test_latency_ms IS NULL OR last_test_latency_ms >= 0 THEN last_test_latency_ms ELSE NULL END
      FROM provider_profiles_v3_old;

      DROP TABLE provider_profiles_v3_old;
      DROP TABLE IF EXISTS provider_profiles_v4_upgrade;
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

// ── 提供商配置仓库实现 ──────────────────────────────────────────────

class ProviderProfileRepositoryImpl implements ProviderProfileRepository {
  constructor(private readonly db: DatabaseSync) {}

  getById(id: string): ProviderProfileRow | null {
    const row = this.db
      .prepare(
        `SELECT id, provider_type, display_name, base_url, model,
                keychain_service, keychain_account, enabled,
                created_at, updated_at, last_tested_at, last_test_status,
                last_test_error_code, last_test_latency_ms
         FROM provider_profiles WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          provider_type: string;
          display_name: string;
          base_url: string;
          model: string;
          keychain_service: string;
          keychain_account: string;
          enabled: number;
          created_at: string;
          updated_at: string;
          last_tested_at: string | null;
          last_test_status: string | null;
          last_test_error_code: string | null;
          last_test_latency_ms: number | null;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      providerType: row.provider_type,
      displayName: row.display_name,
      baseUrl: row.base_url,
      model: row.model,
      keychainService: row.keychain_service,
      keychainAccount: row.keychain_account,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastTestedAt: row.last_tested_at,
      lastTestStatus: row.last_test_status,
      lastTestErrorCode: row.last_test_error_code,
      lastTestLatencyMs: row.last_test_latency_ms,
    };
  }

  list(): ReadonlyArray<ProviderProfileRow> {
    const rows = this.db
      .prepare(
        `SELECT id, provider_type, display_name, base_url, model,
                keychain_service, keychain_account, enabled,
                created_at, updated_at, last_tested_at, last_test_status,
                last_test_error_code, last_test_latency_ms
         FROM provider_profiles ORDER BY created_at`,
      )
      .all() as Array<{
      id: string;
      provider_type: string;
      display_name: string;
      base_url: string;
      model: string;
      keychain_service: string;
      keychain_account: string;
      enabled: number;
      created_at: string;
      updated_at: string;
      last_tested_at: string | null;
      last_test_status: string | null;
      last_test_error_code: string | null;
      last_test_latency_ms: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      providerType: row.provider_type,
      displayName: row.display_name,
      baseUrl: row.base_url,
      model: row.model,
      keychainService: row.keychain_service,
      keychainAccount: row.keychain_account,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastTestedAt: row.last_tested_at,
      lastTestStatus: row.last_test_status,
      lastTestErrorCode: row.last_test_error_code,
      lastTestLatencyMs: row.last_test_latency_ms,
    }));
  }

  upsert(
    data: Omit<
      ProviderProfileRow,
      'lastTestedAt' | 'lastTestStatus' | 'lastTestErrorCode' | 'lastTestLatencyMs'
    >,
  ): void {
    this.db
      .prepare(
        `INSERT INTO provider_profiles
           (id, provider_type, display_name, base_url, model,
            keychain_service, keychain_account, enabled,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_type = excluded.provider_type,
           display_name = excluded.display_name,
           base_url = excluded.base_url,
           model = excluded.model,
           keychain_service = excluded.keychain_service,
           keychain_account = excluded.keychain_account,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        data.id,
        data.providerType,
        data.displayName,
        data.baseUrl,
        data.model,
        data.keychainService,
        data.keychainAccount,
        data.enabled ? 1 : 0,
        data.createdAt,
        data.updatedAt,
      );
  }

  updateTestResult(
    id: string,
    result: {
      lastTestedAt: string;
      lastTestStatus: string;
      lastTestErrorCode: string | null;
      lastTestLatencyMs: number | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE provider_profiles
         SET last_tested_at = ?, last_test_status = ?,
             last_test_error_code = ?, last_test_latency_ms = ?
         WHERE id = ?`,
      )
      .run(
        result.lastTestedAt,
        result.lastTestStatus,
        result.lastTestErrorCode,
        result.lastTestLatencyMs,
        id,
      );
  }
}

// ── 固定提供商配置 ──────────────────────────────────────────────────

export const FIXED_PROVIDER_PROFILE = {
  id: 'mimo-token-plan-cn',
  providerType: 'anthropic-compatible',
  displayName: 'Xiaomi MiMo Token Plan CN',
  baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  model: 'mimo-v2.5-pro',
  keychainService: 'com.ai-novel-generator.provider.mimo-token-plan-cn',
  keychainAccount: 'api-key',
} as const;

// ── App 数据库管理器 ──────────────────────────────────────────────

export class AppDatabase implements AppDatabaseManager {
  private readonly db: DatabaseSync;
  private readonly projectIndexRepo: ProjectIndexRepositoryImpl;
  private readonly projectCreationRepo: ProjectCreationRepositoryImpl;
  private readonly providerProfileRepo: ProviderProfileRepositoryImpl;

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
    this.providerProfileRepo = new ProviderProfileRepositoryImpl(this.db);

    // 确保固定提供商配置存在
    this.ensureFixedProviderProfile();
  }

  getProjectIndexRepository(): ProjectIndexRepository {
    return this.projectIndexRepo;
  }

  getProjectCreationRepository(): ProjectCreationRepository {
    return this.projectCreationRepo;
  }

  getProviderProfileRepository(): ProviderProfileRepository {
    return this.providerProfileRepo;
  }

  close(): void {
    this.db.close();
  }

  private ensureFixedProviderProfile(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO provider_profiles
           (id, provider_type, display_name, base_url, model,
            keychain_service, keychain_account, enabled,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_type = excluded.provider_type,
           display_name = excluded.display_name,
           base_url = excluded.base_url,
           model = excluded.model,
           keychain_service = excluded.keychain_service,
           keychain_account = excluded.keychain_account,
           updated_at = excluded.updated_at`,
      )
      .run(
        FIXED_PROVIDER_PROFILE.id,
        FIXED_PROVIDER_PROFILE.providerType,
        FIXED_PROVIDER_PROFILE.displayName,
        FIXED_PROVIDER_PROFILE.baseUrl,
        FIXED_PROVIDER_PROFILE.model,
        FIXED_PROVIDER_PROFILE.keychainService,
        FIXED_PROVIDER_PROFILE.keychainAccount,
        1,
        now,
        now,
      );
  }
}
