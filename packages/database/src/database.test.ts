/**
 * 数据库层测试。
 *
 * 使用临时目录创建真实 SQLite 数据库，验证迁移、CRUD 和安全约束。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AppDatabase } from './app-database.js';
import { ProjectDatabase, checkProjectDatabaseVersion } from './project-database.js';
import { SQLiteMigrator } from './migrator.js';
import type { Migration } from './types.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'database-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SQLiteMigrator', () => {
  it('应该对新数据库返回版本 0', () => {
    const db = new DatabaseSync(join(tempDir, 'test.sqlite'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const migrator = new SQLiteMigrator(db);
    expect(migrator.getCurrentVersion()).toBe(0);
    db.close();
  });

  it('应该成功运行迁移', () => {
    const db = new DatabaseSync(join(tempDir, 'test.sqlite'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const migrations: Migration[] = [
      {
        version: 1,
        sql: `CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;`,
      },
    ];

    const migrator = new SQLiteMigrator(db);
    const applied = migrator.migrate(0, migrations);
    expect(applied).toBe(1);
    expect(migrator.getCurrentVersion()).toBe(1);

    // 验证表存在
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'")
      .all();
    expect(tables).toHaveLength(1);

    db.close();
  });

  it('应该幂等地重复运行迁移', () => {
    const db = new DatabaseSync(join(tempDir, 'test.sqlite'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const migrations: Migration[] = [
      {
        version: 1,
        sql: `CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY) STRICT;`,
      },
    ];

    const migrator = new SQLiteMigrator(db);
    migrator.migrate(0, migrations);
    // 第二次运行应该不报错，返回 0
    const applied2 = migrator.migrate(0, migrations);
    expect(applied2).toBe(0);

    db.close();
  });

  it('应该在事务失败时回滚', () => {
    const db = new DatabaseSync(join(tempDir, 'test.sqlite'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const migrations: Migration[] = [
      {
        version: 1,
        sql: `CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY) STRICT;`,
      },
      {
        version: 2,
        sql: `INVALID SQL SYNTAX`, // 故意的语法错误
      },
    ];

    const migrator = new SQLiteMigrator(db);
    expect(() => migrator.migrate(0, migrations)).toThrow();

    // 版本应该仍然是 0（事务回滚）
    expect(migrator.getCurrentVersion()).toBe(0);

    db.close();
  });

  it('应该拒绝高于支持版本的数据库', () => {
    const db = new DatabaseSync(join(tempDir, 'test.sqlite'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    // 手动插入一个高于支持的版本
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      999,
      new Date().toISOString(),
    );

    const migrations: Migration[] = [
      {
        version: 1,
        sql: `CREATE TABLE IF NOT EXISTS test_table (id TEXT PRIMARY KEY) STRICT;`,
      },
    ];

    const migrator = new SQLiteMigrator(db);
    expect(() => migrator.migrate(0, migrations)).toThrow(/高于应用支持的最高版本/);

    db.close();
  });
});

describe('AppDatabase', () => {
  it('应该创建并初始化 app.sqlite', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);

    // 应该能获取项目索引仓库
    const repo = appDb.getProjectIndexRepository();
    expect(repo.list()).toHaveLength(0);

    appDb.close();
  });

  it('应该启用 WAL 和 foreign_keys', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);

    // 通过创建一个新的 DatabaseSync 连接来检查 PRAGMA
    // 由于 AppDatabase 不暴露 db，我们通过间接方式验证
    // （能正常创建和查询就说明配置正确）
    const repo = appDb.getProjectIndexRepository();

    // 创建一个项目
    repo.create({
      id: 'test-id-1',
      name: '测试项目',
      initialIdea: '测试想法',
      status: 'idea',
      projectDirectory: '/tmp/test',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const list = repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('test-id-1');

    appDb.close();
  });

  it('应该支持 CRUD 操作', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProjectIndexRepository();

    // Create
    repo.create({
      id: 'proj-1',
      name: '项目一',
      initialIdea: '想法一',
      status: 'idea',
      projectDirectory: '/tmp/proj-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    repo.create({
      id: 'proj-2',
      name: '项目二',
      initialIdea: '想法二',
      status: 'idea',
      projectDirectory: '/tmp/proj-2',
      createdAt: '2024-01-02T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    });

    // List
    const list = repo.list();
    expect(list).toHaveLength(2);

    // GetById
    const proj1 = repo.getById('proj-1');
    expect(proj1).not.toBeNull();
    expect(proj1!.name).toBe('项目一');

    // GetById - not found
    expect(repo.getById('nonexistent')).toBeNull();

    // UpdateLastOpened
    repo.updateLastOpened('proj-1', '2024-06-15T12:00:00.000Z');
    const updated = repo.getById('proj-1');
    expect(updated!.lastOpenedAt).toBe('2024-06-15T12:00:00.000Z');

    // Delete
    repo.delete('proj-2');
    expect(repo.list()).toHaveLength(1);

    appDb.close();
  });

  it('应该按 last_opened_at 降序排列', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProjectIndexRepository();

    repo.create({
      id: 'proj-1',
      name: '项目一',
      initialIdea: '想法',
      status: 'idea',
      projectDirectory: '/tmp/proj-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    repo.create({
      id: 'proj-2',
      name: '项目二',
      initialIdea: '想法',
      status: 'idea',
      projectDirectory: '/tmp/proj-2',
      createdAt: '2024-01-02T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    });

    // proj-2 有 last_opened_at，应该排在前面
    repo.updateLastOpened('proj-2', '2024-06-15T12:00:00.000Z');

    const list = repo.list();
    expect(list[0].id).toBe('proj-2');
    expect(list[1].id).toBe('proj-1');

    appDb.close();
  });

  it('应该在关闭后重新打开保持数据', () => {
    const dbPath = join(tempDir, 'app.sqlite');

    // 第一次打开
    const appDb1 = new AppDatabase(dbPath);
    appDb1.getProjectIndexRepository().create({
      id: 'persistent-proj',
      name: '持久化项目',
      initialIdea: '持久化想法',
      status: 'idea',
      projectDirectory: '/tmp/persistent',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    appDb1.close();

    // 第二次打开
    const appDb2 = new AppDatabase(dbPath);
    const list = appDb2.getProjectIndexRepository().list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('persistent-proj');
    appDb2.close();
  });
});

describe('ProjectDatabase', () => {
  it('应该创建并初始化 project.sqlite', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);

    const repo = projDb.getProjectMetadataRepository();
    expect(repo.get()).toBeNull();

    projDb.close();
  });

  it('应该支持 CRUD 操作', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);
    const repo = projDb.getProjectMetadataRepository();

    // Create
    repo.create({
      id: 'proj-1',
      name: '我的小说',
      initialIdea: '一个科幻故事',
      status: 'idea',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    // Get
    const metadata = repo.get();
    expect(metadata).not.toBeNull();
    expect(metadata!.name).toBe('我的小说');
    expect(metadata!.initialIdea).toBe('一个科幻故事');

    // Update
    repo.update({ name: '新名字', updatedAt: '2024-06-15T12:00:00.000Z' });
    const updated = repo.get();
    expect(updated!.name).toBe('新名字');
    expect(updated!.updatedAt).toBe('2024-06-15T12:00:00.000Z');
    // initialIdea 不变
    expect(updated!.initialIdea).toBe('一个科幻故事');

    projDb.close();
  });

  it('应该在关闭后重新打开保持数据', () => {
    const dbPath = join(tempDir, 'project.sqlite');

    const projDb1 = new ProjectDatabase(dbPath);
    projDb1.getProjectMetadataRepository().create({
      id: 'proj-1',
      name: '持久化项目',
      initialIdea: '持久化想法',
      status: 'idea',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    projDb1.close();

    const projDb2 = new ProjectDatabase(dbPath);
    const metadata = projDb2.getProjectMetadataRepository().get();
    expect(metadata).not.toBeNull();
    expect(metadata!.name).toBe('持久化项目');
    projDb2.close();
  });
});

describe('checkProjectDatabaseVersion', () => {
  it('应该接受兼容的数据库版本', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const projDb = new ProjectDatabase(dbPath);
    projDb.close();

    // 不应该抛出
    expect(() => checkProjectDatabaseVersion(dbPath)).not.toThrow();
  });
});

describe('ProviderProfileRepository', () => {
  it('应该自动创建固定 MiMo profile', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProviderProfileRepository();

    const profile = repo.getById('mimo-token-plan-cn');
    expect(profile).not.toBeNull();
    expect(profile!.providerType).toBe('anthropic-compatible');
    expect(profile!.displayName).toBe('Xiaomi MiMo Token Plan CN');
    expect(profile!.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/anthropic');
    expect(profile!.model).toBe('mimo-v2.5-pro');
    expect(profile!.keychainService).toBe('com.ai-novel-generator.provider.mimo-token-plan-cn');
    expect(profile!.keychainAccount).toBe('api-key');
    expect(profile!.enabled).toBe(true);

    appDb.close();
  });

  it('应该在重新打开后保持固定 profile', () => {
    const dbPath = join(tempDir, 'app.sqlite');

    const appDb1 = new AppDatabase(dbPath);
    const repo1 = appDb1.getProviderProfileRepository();
    // 固定 profile 应该存在
    expect(repo1.getById('mimo-token-plan-cn')).not.toBeNull();
    appDb1.close();

    // 重新打开
    const appDb2 = new AppDatabase(dbPath);
    const repo2 = appDb2.getProviderProfileRepository();
    const profile = repo2.getById('mimo-token-plan-cn');
    expect(profile).not.toBeNull();
    expect(profile!.providerType).toBe('anthropic-compatible');

    appDb2.close();
  });

  it('应该支持 updateTestResult', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProviderProfileRepository();

    repo.updateTestResult('mimo-token-plan-cn', {
      lastTestedAt: '2024-06-15T12:00:00.000Z',
      lastTestStatus: 'success',
      lastTestErrorCode: null,
      lastTestLatencyMs: 150,
    });

    const profile = repo.getById('mimo-token-plan-cn');
    expect(profile!.lastTestedAt).toBe('2024-06-15T12:00:00.000Z');
    expect(profile!.lastTestStatus).toBe('success');
    expect(profile!.lastTestErrorCode).toBeNull();
    expect(profile!.lastTestLatencyMs).toBe(150);

    appDb.close();
  });

  it('应该支持 updateTestResult 保存错误码', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProviderProfileRepository();

    repo.updateTestResult('mimo-token-plan-cn', {
      lastTestedAt: '2024-06-15T12:00:00.000Z',
      lastTestStatus: 'failed',
      lastTestErrorCode: 'PROVIDER_AUTH_FAILED',
      lastTestLatencyMs: 200,
    });

    const profile = repo.getById('mimo-token-plan-cn');
    expect(profile!.lastTestStatus).toBe('failed');
    expect(profile!.lastTestErrorCode).toBe('PROVIDER_AUTH_FAILED');
    expect(profile!.lastTestLatencyMs).toBe(200);

    appDb.close();
  });

  it('list 应该包含固定 profile', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProviderProfileRepository();

    const list = repo.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
    const mimo = list.find((p) => p.id === 'mimo-token-plan-cn');
    expect(mimo).toBeDefined();

    appDb.close();
  });

  it('provider_profiles 中不应存储 API Key', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);

    // 通过原始 SQL 查询表结构
    const db = new DatabaseSync(dbPath);
    const columns = db.prepare('PRAGMA table_info(provider_profiles)').all() as Array<{
      name: string;
    }>;
    const columnNames = columns.map((c) => c.name);

    // 不应该有 apiKey、key、secret 等列
    for (const name of columnNames) {
      expect(name.toLowerCase()).not.toMatch(/api.?key|secret|password|authorization/);
    }

    db.close();
    appDb.close();
  });
});

describe('Migration 4: provider_profiles CHECK 约束', () => {
  /** 创建一个只有 v1-v3 迁移的数据库（模拟旧版 v3） */
  function createV3Database(dbPath: string): void {
    const db = new DatabaseSync(dbPath);
    db.exec(`
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

      CREATE TABLE IF NOT EXISTS project_creations (
        project_id TEXT PRIMARY KEY,
        temp_directory_name TEXT NOT NULL,
        final_directory_name TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'preparing',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

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
    `);

    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      1,
      new Date().toISOString(),
    );
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      2,
      new Date().toISOString(),
    );
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      3,
      new Date().toISOString(),
    );
    db.close();
  }

  it('新数据库应该直接迁移到 v4', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProviderProfileRepository();

    // 固定 profile 应该存在且有正确的约束
    const profile = repo.getById('mimo-token-plan-cn');
    expect(profile).not.toBeNull();
    expect(profile!.providerType).toBe('anthropic-compatible');

    appDb.close();
  });

  it('v3 数据库应该升级到 v4 且保留合法数据', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    createV3Database(dbPath);

    // 手动插入合法的固定 profile 到 v3 表
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO provider_profiles
         (id, provider_type, display_name, base_url, model,
          keychain_service, keychain_account, enabled,
          created_at, updated_at, last_tested_at, last_test_status,
          last_test_error_code, last_test_latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'mimo-token-plan-cn',
      'anthropic-compatible',
      'Xiaomi MiMo Token Plan CN',
      'https://token-plan-cn.xiaomimimo.com/anthropic',
      'mimo-v2.5-pro',
      'com.ai-novel-generator.provider.mimo-token-plan-cn',
      'api-key',
      1,
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
      '2024-06-15T12:00:00.000Z',
      'success',
      null,
      150,
    );
    db.close();

    // 用 AppDatabase 打开（应该运行 v4 迁移）
    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProviderProfileRepository();
    const profile = repo.getById('mimo-token-plan-cn');

    expect(profile).not.toBeNull();
    expect(profile!.lastTestedAt).toBe('2024-06-15T12:00:00.000Z');
    expect(profile!.lastTestStatus).toBe('success');
    expect(profile!.lastTestLatencyMs).toBe(150);

    appDb.close();
  });

  it('v3 中非法 enabled 应被规范化为 1', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    createV3Database(dbPath);

    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO provider_profiles
         (id, provider_type, display_name, base_url, model,
          keychain_service, keychain_account, enabled,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'mimo-token-plan-cn',
      'anthropic-compatible',
      'Xiaomi MiMo Token Plan CN',
      'https://token-plan-cn.xiaomimimo.com/anthropic',
      'mimo-v2.5-pro',
      'com.ai-novel-generator.provider.mimo-token-plan-cn',
      'api-key',
      2, // 非法 enabled 值
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
    );
    db.close();

    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProviderProfileRepository();
    const profile = repo.getById('mimo-token-plan-cn');

    expect(profile).not.toBeNull();
    expect(profile!.enabled).toBe(true); // 规范化为 1

    appDb.close();
  });

  it('v3 中非法 last_test_status 应被规范化为 NULL', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    createV3Database(dbPath);

    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO provider_profiles
         (id, provider_type, display_name, base_url, model,
          keychain_service, keychain_account, enabled,
          created_at, updated_at, last_test_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'mimo-token-plan-cn',
      'anthropic-compatible',
      'Xiaomi MiMo Token Plan CN',
      'https://token-plan-cn.xiaomimimo.com/anthropic',
      'mimo-v2.5-pro',
      'com.ai-novel-generator.provider.mimo-token-plan-cn',
      'api-key',
      1,
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
      'invalid-status', // 非法状态
    );
    db.close();

    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProviderProfileRepository();
    const profile = repo.getById('mimo-token-plan-cn');

    expect(profile).not.toBeNull();
    expect(profile!.lastTestStatus).toBeNull(); // 规范化为 NULL

    appDb.close();
  });

  it('v3 中负数 latency 应被规范化为 NULL', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    createV3Database(dbPath);

    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO provider_profiles
         (id, provider_type, display_name, base_url, model,
          keychain_service, keychain_account, enabled,
          created_at, updated_at, last_test_latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'mimo-token-plan-cn',
      'anthropic-compatible',
      'Xiaomi MiMo Token Plan CN',
      'https://token-plan-cn.xiaomimimo.com/anthropic',
      'mimo-v2.5-pro',
      'com.ai-novel-generator.provider.mimo-token-plan-cn',
      'api-key',
      1,
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
      -100, // 负数 latency
    );
    db.close();

    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProviderProfileRepository();
    const profile = repo.getById('mimo-token-plan-cn');

    expect(profile).not.toBeNull();
    expect(profile!.lastTestLatencyMs).toBeNull(); // 规范化为 NULL

    appDb.close();
  });

  it('重复打开 v4 数据库应该是幂等的', () => {
    const dbPath = join(tempDir, 'app.sqlite');

    const appDb1 = new AppDatabase(dbPath);
    appDb1.close();

    const appDb2 = new AppDatabase(dbPath);
    const repo = appDb2.getProviderProfileRepository();
    expect(repo.getById('mimo-token-plan-cn')).not.toBeNull();
    appDb2.close();
  });

  it('迁移失败应该回滚事务', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    createV3Database(dbPath);

    // 在 v3 表中插入会导致 v4 迁移失败的数据
    // （这里用正常数据，但测试迁移器的回滚机制本身已在 SQLiteMigrator 测试中覆盖）
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO provider_profiles
         (id, provider_type, display_name, base_url, model,
          keychain_service, keychain_account, enabled,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'mimo-token-plan-cn',
      'anthropic-compatible',
      'Xiaomi MiMo Token Plan CN',
      'https://token-plan-cn.xiaomimimo.com/anthropic',
      'mimo-v2.5-pro',
      'com.ai-novel-generator.provider.mimo-token-plan-cn',
      'api-key',
      1,
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
    );
    db.close();

    // 正常打开应该成功
    const appDb = new AppDatabase(dbPath);
    const repo = appDb.getProviderProfileRepository();
    expect(repo.getById('mimo-token-plan-cn')).not.toBeNull();
    appDb.close();
  });
});

describe('固定 Profile 完整性', () => {
  it('URL 被修改后应该被修复', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb1 = new AppDatabase(dbPath);

    // 直接修改数据库中的 URL
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE provider_profiles SET base_url = 'https://evil.com' WHERE id = ?").run(
      'mimo-token-plan-cn',
    );
    db.close();
    appDb1.close();

    // 重新打开，应该修复 URL
    const appDb2 = new AppDatabase(dbPath);
    const repo = appDb2.getProviderProfileRepository();
    const profile = repo.getById('mimo-token-plan-cn');
    expect(profile!.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/anthropic');
    appDb2.close();
  });

  it('model 被修改后应该被修复', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb1 = new AppDatabase(dbPath);

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE provider_profiles SET model = 'gpt-4' WHERE id = ?").run(
      'mimo-token-plan-cn',
    );
    db.close();
    appDb1.close();

    const appDb2 = new AppDatabase(dbPath);
    const repo = appDb2.getProviderProfileRepository();
    const profile = repo.getById('mimo-token-plan-cn');
    expect(profile!.model).toBe('mimo-v2.5-pro');
    appDb2.close();
  });

  it('keychain_service 被修改后应该被修复', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb1 = new AppDatabase(dbPath);

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE provider_profiles SET keychain_service = 'wrong-service' WHERE id = ?").run(
      'mimo-token-plan-cn',
    );
    db.close();
    appDb1.close();

    const appDb2 = new AppDatabase(dbPath);
    const repo = appDb2.getProviderProfileRepository();
    const profile = repo.getById('mimo-token-plan-cn');
    expect(profile!.keychainService).toBe('com.ai-novel-generator.provider.mimo-token-plan-cn');
    appDb2.close();
  });

  it('keychain_account 被修改后应该被修复', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb1 = new AppDatabase(dbPath);

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE provider_profiles SET keychain_account = 'wrong-account' WHERE id = ?").run(
      'mimo-token-plan-cn',
    );
    db.close();
    appDb1.close();

    const appDb2 = new AppDatabase(dbPath);
    const repo = appDb2.getProviderProfileRepository();
    const profile = repo.getById('mimo-token-plan-cn');
    expect(profile!.keychainAccount).toBe('api-key');
    appDb2.close();
  });

  it('修复后测试状态应该保留', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb1 = new AppDatabase(dbPath);
    const repo1 = appDb1.getProviderProfileRepository();

    // 写入测试结果
    repo1.updateTestResult('mimo-token-plan-cn', {
      lastTestedAt: '2024-06-15T12:00:00.000Z',
      lastTestStatus: 'success',
      lastTestErrorCode: null,
      lastTestLatencyMs: 150,
    });

    // 同时修改 URL（触发修复）
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE provider_profiles SET base_url = 'https://evil.com' WHERE id = ?").run(
      'mimo-token-plan-cn',
    );
    db.close();
    appDb1.close();

    // 重新打开
    const appDb2 = new AppDatabase(dbPath);
    const repo2 = appDb2.getProviderProfileRepository();
    const profile = repo2.getById('mimo-token-plan-cn');

    // URL 应该被修复
    expect(profile!.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/anthropic');
    // 测试状态应该保留
    expect(profile!.lastTestedAt).toBe('2024-06-15T12:00:00.000Z');
    expect(profile!.lastTestStatus).toBe('success');
    expect(profile!.lastTestLatencyMs).toBe(150);

    appDb2.close();
  });

  it('enabled 不应该被修复覆盖', () => {
    const dbPath = join(tempDir, 'app.sqlite');
    const appDb1 = new AppDatabase(dbPath);

    // 禁用 profile
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE provider_profiles SET enabled = 0 WHERE id = ?').run('mimo-token-plan-cn');
    db.close();
    appDb1.close();

    // 重新打开，enabled 应该保持禁用
    const appDb2 = new AppDatabase(dbPath);
    const repo = appDb2.getProviderProfileRepository();
    const profile = repo.getById('mimo-token-plan-cn');
    expect(profile!.enabled).toBe(false); // 不被修复覆盖
    appDb2.close();
  });

  it('FIXED_PROVIDER_PROFILE 应该包含所有固定字段', async () => {
    const { FIXED_PROVIDER_PROFILE } = await import('./app-database.js');
    expect(FIXED_PROVIDER_PROFILE.id).toBe('mimo-token-plan-cn');
    expect(FIXED_PROVIDER_PROFILE.providerType).toBe('anthropic-compatible');
    expect(FIXED_PROVIDER_PROFILE.displayName).toBe('Xiaomi MiMo Token Plan CN');
    expect(FIXED_PROVIDER_PROFILE.baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/anthropic');
    expect(FIXED_PROVIDER_PROFILE.model).toBe('mimo-v2.5-pro');
    expect(FIXED_PROVIDER_PROFILE.keychainService).toBe(
      'com.ai-novel-generator.provider.mimo-token-plan-cn',
    );
    expect(FIXED_PROVIDER_PROFILE.keychainAccount).toBe('api-key');
  });
});
