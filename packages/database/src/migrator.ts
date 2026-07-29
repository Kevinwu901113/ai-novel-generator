/**
 * SQLite 迁移运行器。
 *
 * 使用 node:sqlite 的 DatabaseSync 同步 API。
 * 迁移在事务中运行，已应用的迁移不会重复执行。
 * 数据库版本高于支持版本时拒绝打开。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration, Migrator } from './types.js';

export class SQLiteMigrator implements Migrator {
  constructor(private readonly db: DatabaseSync) {}

  getCurrentVersion(): number {
    // schema_migrations 表不存在时返回 0
    try {
      const row = this.db.prepare('SELECT MAX(version) as v FROM schema_migrations').get() as
        { v: number | null } | undefined;
      return row?.v ?? 0;
    } catch {
      // 表不存在
      return 0;
    }
  }

  migrate(_currentVersion: number, migrations: ReadonlyArray<Migration>): number {
    const dbVersion = this.getCurrentVersion();

    // 数据库版本高于应用支持版本时拒绝
    const maxSupported = Math.max(...migrations.map((m) => m.version), 0);
    if (dbVersion > maxSupported) {
      throw new Error(
        `数据库版本 ${dbVersion} 高于应用支持的最高版本 ${maxSupported}，无法打开。请升级应用。`,
      );
    }

    // 筛选出需要应用的迁移
    const pending = migrations.filter((m) => m.version > dbVersion);
    if (pending.length === 0) return 0;

    // 迁移可能重建被外键引用的表（如放宽 CHECK 约束）。
    // PRAGMA foreign_keys 在事务内无效，必须在 BEGIN 之外关闭，迁移结束后恢复。
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN');
    try {
      for (const migration of pending) {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }

    return pending.length;
  }
}
