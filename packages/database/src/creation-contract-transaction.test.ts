/**
 * 创作契约事务适配器单元测试。
 *
 * 覆盖：成功提交、回调抛错回滚、嵌套事务拒绝、返回值透传、
 * BEGIN/COMMIT/ROLLBACK 故障注入、Promise/thenable 回调拒绝。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  AppError,
  ContractNestedTransactionError,
  ContractTransactionBusyError,
  ContractTransactionError,
  ContractAsyncTransactionCallbackError,
} from '@ai-novel/application';
import { CreationContractTransactionPortImpl } from './creation-contract-transaction.js';
import { ProjectDatabase } from './project-database.js';

// ── 可控 fake DatabaseSync ─────────────────────────────────────

const BUSY_MESSAGE = '创作契约正在被其他操作修改，请重试';
const NESTED_MESSAGE = '检测到嵌套创作契约事务';
const TX_FAILED_MESSAGE = '创作契约事务执行失败';
const ASYNC_CALLBACK_MESSAGE = '创作契约事务回调必须同步执行';

function sqliteError(message: string, errcode: number | null): Error & { errcode?: number } {
  const err = new Error(message) as Error & { errcode?: number };
  if (errcode !== null) err.errcode = errcode;
  return err;
}

class FakeDatabaseSync {
  execCalls: string[] = [];
  beginError: { message: string; errcode: number | null } | null = null;
  commitError: { message: string; errcode: number | null } | null = null;
  rollbackError: { message: string; errcode: number | null } | null = null;

  exec(sql: string): void {
    this.execCalls.push(sql);
    if (sql === 'BEGIN IMMEDIATE' && this.beginError)
      throw sqliteError(this.beginError.message, this.beginError.errcode);
    if (sql === 'COMMIT' && this.commitError)
      throw sqliteError(this.commitError.message, this.commitError.errcode);
    if (sql === 'ROLLBACK' && this.rollbackError)
      throw sqliteError(this.rollbackError.message, this.rollbackError.errcode);
  }

  asDatabaseSync(): DatabaseSync {
    return this as unknown as DatabaseSync;
  }
}

function expectSafeContractError(
  e: unknown,
  expectedClass: new (...args: never[]) => Error,
  expectedCode: string,
  expectedMessage: string,
): void {
  expect(e).toBeInstanceOf(expectedClass);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe(expectedCode);
  expect((e as Error).message).toBe(expectedMessage);
  // 安全断言：public message 不含 SQLite 实现细节
  expect((e as Error).message).not.toContain('SQLITE_BUSY');
  expect((e as Error).message).not.toContain('SQLITE_LOCKED');
  expect((e as Error).message).not.toContain('database is locked');
  expect((e as Error).message).not.toContain('BEGIN IMMEDIATE');
}

describe('CreationContractTransactionPortImpl', () => {
  let dir: string;
  let db: ProjectDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-tx-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    db.database
      .prepare(
        `INSERT INTO project_metadata (id, name, initial_idea, status, created_at, updated_at)
         VALUES ('p1', 'Test', 'idea', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('commits successfully and returns callback value', () => {
    const port = new CreationContractTransactionPortImpl(db.database);
    const result = port.runInTransaction((repos) => {
      return repos.projectExistsReadPort.exists('p1') ? 42 : 0;
    });
    expect(result).toBe(42);
  });

  it('rolls back on callback throw and remains usable', () => {
    const port = new CreationContractTransactionPortImpl(db.database);

    try {
      port.runInTransaction(() => {
        throw new Error('test error');
      });
      expect.unreachable('callback throw should propagate');
    } catch (e) {
      // 非 AppError 回调错误被转换为安全基础设施错误，原始错误保存在 cause
      expectSafeContractError(e, ContractTransactionError, 'INTERNAL_ERROR', TX_FAILED_MESSAGE);
      expect(((e as AppError).cause as Error).message).toBe('test error');
    }

    const result = port.runInTransaction((repos) => repos.projectExistsReadPort.exists('p1'));
    expect(result).toBe(true);
  });

  it('rejects nested transactions with fixed message', () => {
    const port = new CreationContractTransactionPortImpl(db.database);

    try {
      port.runInTransaction(() => {
        port.runInTransaction(() => {
          // nested
        });
      });
      expect.unreachable('nested transaction should be rejected');
    } catch (e) {
      expectSafeContractError(e, ContractNestedTransactionError, 'INTERNAL_ERROR', NESTED_MESSAGE);
    }
  });

  it('nested rejection does not corrupt outer state', () => {
    const port = new CreationContractTransactionPortImpl(db.database);

    try {
      port.runInTransaction(() => {
        port.runInTransaction(() => {
          throw new Error('inner error');
        });
      });
    } catch {
      // expected
    }

    const result = port.runInTransaction((repos) => repos.projectExistsReadPort.exists('p1'));
    expect(result).toBe(true);
  });

  it('passes through callback return value', () => {
    const port = new CreationContractTransactionPortImpl(db.database);
    const value = { foo: 'bar', count: 42 };
    const result = port.runInTransaction(() => value);
    expect(result).toEqual(value);
  });

  it('allows sequential transactions after success', () => {
    const port = new CreationContractTransactionPortImpl(db.database);

    const r1 = port.runInTransaction((repos) => repos.projectExistsReadPort.exists('p1'));
    const r2 = port.runInTransaction((repos) => repos.projectExistsReadPort.exists('p1'));

    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });

  // ── 异步回调保护 ─────────────────────────────────────────────

  it('rejects Promise-returning callback and rolls back its writes', () => {
    const port = new CreationContractTransactionPortImpl(db.database);

    expect(() =>
      port.runInTransaction(() => {
        db.database
          .prepare(
            `INSERT INTO project_metadata (id, name, initial_idea, status, created_at, updated_at)
             VALUES ('p2', 'Should Rollback', 'idea', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
          )
          .run();
        return Promise.resolve(42);
      }),
    ).toThrow(ContractAsyncTransactionCallbackError);

    // 回调已执行的写入未提交（rollback）
    const row = db.database.prepare('SELECT 1 FROM project_metadata WHERE id = ?').get('p2');
    expect(row).toBeUndefined();

    // adapter 仍可用
    const result = port.runInTransaction((repos) => repos.projectExistsReadPort.exists('p1'));
    expect(result).toBe(true);
  });

  it('rejects thenable-returning callback (non-Promise)', () => {
    const port = new CreationContractTransactionPortImpl(db.database);
    const thenable = { then: () => undefined };

    try {
      port.runInTransaction(() => thenable);
      expect.unreachable('thenable callback should be rejected');
    } catch (e) {
      expectSafeContractError(
        e,
        ContractAsyncTransactionCallbackError,
        'INTERNAL_ERROR',
        ASYNC_CALLBACK_MESSAGE,
      );
    }
  });
});

// ── 故障注入 ────────────────────────────────────────────────────

describe('CreationContractTransactionPortImpl fault injection', () => {
  it('BEGIN busy → ContractTransactionBusyError, callback not executed, flag restored', () => {
    const fake = new FakeDatabaseSync();
    fake.beginError = { message: 'database is locked', errcode: 5 }; // SQLITE_BUSY
    const port = new CreationContractTransactionPortImpl(fake.asDatabaseSync());

    let callbackRan = false;
    try {
      port.runInTransaction(() => {
        callbackRan = true;
        return 1;
      });
      expect.unreachable('BEGIN busy should throw');
    } catch (e) {
      expectSafeContractError(
        e,
        ContractTransactionBusyError,
        'CONTRACT_VERSION_CONFLICT',
        BUSY_MESSAGE,
      );
      // 内部诊断保留在 cause
      expect((e as AppError).cause).toBeDefined();
    }
    expect(callbackRan).toBe(false);
    expect(fake.execCalls).toEqual(['BEGIN IMMEDIATE']);
    // inTransaction 已恢复：下一次事务不再抛嵌套错误
    fake.beginError = null;
    const result = port.runInTransaction(() => 7);
    expect(result).toBe(7);
  });

  it('BEGIN non-busy error → ContractTransactionError (not misclassified), flag restored', () => {
    const fake = new FakeDatabaseSync();
    fake.beginError = { message: 'unable to open database file', errcode: 14 }; // SQLITE_CANTOPEN
    const port = new CreationContractTransactionPortImpl(fake.asDatabaseSync());

    let callbackRan = false;
    try {
      port.runInTransaction(() => {
        callbackRan = true;
        return 1;
      });
      expect.unreachable('BEGIN failure should throw');
    } catch (e) {
      expectSafeContractError(e, ContractTransactionError, 'INTERNAL_ERROR', TX_FAILED_MESSAGE);
      expect((e as AppError).code).not.toBe('CONTRACT_VERSION_CONFLICT');
    }
    expect(callbackRan).toBe(false);

    fake.beginError = null;
    const result = port.runInTransaction(() => 7);
    expect(result).toBe(7);
  });

  it('BEGIN non-node:sqlite busy error (message-only fallback) → ContractTransactionBusyError', () => {
    const fake = new FakeDatabaseSync();
    fake.beginError = { message: 'SQLITE_BUSY: database is locked', errcode: null }; // 无 errcode → message fallback
    const port = new CreationContractTransactionPortImpl(fake.asDatabaseSync());

    try {
      port.runInTransaction(() => 1);
      expect.unreachable('BEGIN busy should throw');
    } catch (e) {
      expectSafeContractError(
        e,
        ContractTransactionBusyError,
        'CONTRACT_VERSION_CONFLICT',
        BUSY_MESSAGE,
      );
    }
  });

  it('COMMIT busy → busy error, ROLLBACK attempted, callback result not returned', () => {
    const fake = new FakeDatabaseSync();
    fake.commitError = { message: 'database is locked', errcode: 5 };
    const port = new CreationContractTransactionPortImpl(fake.asDatabaseSync());

    try {
      port.runInTransaction(() => 42);
      expect.unreachable('COMMIT busy should throw');
    } catch (e) {
      expectSafeContractError(
        e,
        ContractTransactionBusyError,
        'CONTRACT_VERSION_CONFLICT',
        BUSY_MESSAGE,
      );
    }
    // COMMIT 失败后尝试 ROLLBACK
    expect(fake.execCalls).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']);

    fake.commitError = null;
    const result = port.runInTransaction(() => 42);
    expect(result).toBe(42);
  });

  it('COMMIT non-busy error → safe infrastructure error, ROLLBACK attempted, cause preserved', () => {
    const fake = new FakeDatabaseSync();
    fake.commitError = { message: 'disk I/O error', errcode: 10 }; // SQLITE_IOERR
    const port = new CreationContractTransactionPortImpl(fake.asDatabaseSync());

    try {
      port.runInTransaction(() => 42);
      expect.unreachable('COMMIT failure should throw');
    } catch (e) {
      expectSafeContractError(e, ContractTransactionError, 'INTERNAL_ERROR', TX_FAILED_MESSAGE);
      expect(((e as AppError).cause as Error).message).toBe('disk I/O error');
    }
    expect(fake.execCalls).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']);
  });

  it('ROLLBACK failure on callback throw does not override original error', () => {
    const fake = new FakeDatabaseSync();
    fake.rollbackError = { message: 'database is locked', errcode: 5 };
    const port = new CreationContractTransactionPortImpl(fake.asDatabaseSync());

    try {
      port.runInTransaction(() => {
        throw new Error('original callback error');
      });
      expect.unreachable('callback throw should propagate');
    } catch (e) {
      // 原始错误（cause）是 callback 错误，不是 ROLLBACK 的 busy 错误
      expectSafeContractError(e, ContractTransactionError, 'INTERNAL_ERROR', TX_FAILED_MESSAGE);
      expect(((e as AppError).cause as Error).message).toBe('original callback error');
    }
    expect(fake.execCalls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);

    // 下一次事务行为明确：rollback 故障恢复后仍可正常执行
    fake.rollbackError = null;
    const result = port.runInTransaction(() => 3);
    expect(result).toBe(3);
  });

  it('ROLLBACK failure on COMMIT failure does not override COMMIT error', () => {
    const fake = new FakeDatabaseSync();
    fake.commitError = { message: 'database is locked', errcode: 5 };
    fake.rollbackError = { message: 'rollback exploded', errcode: 1 };
    const port = new CreationContractTransactionPortImpl(fake.asDatabaseSync());

    try {
      port.runInTransaction(() => 1);
      expect.unreachable('COMMIT failure should throw');
    } catch (e) {
      expectSafeContractError(
        e,
        ContractTransactionBusyError,
        'CONTRACT_VERSION_CONFLICT',
        BUSY_MESSAGE,
      );
      // cause 是 COMMIT 的 busy 错误，不是 rollback 错误
      expect(((e as AppError).cause as Error).message).toBe('database is locked');
    }
    expect(fake.execCalls).toEqual(['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK']);
  });

  it('nested transaction message contains no SQLite implementation details', () => {
    const port = new CreationContractTransactionPortImpl(new FakeDatabaseSync().asDatabaseSync());

    try {
      port.runInTransaction(() => {
        port.runInTransaction(() => 1);
      });
      expect.unreachable('nested transaction should be rejected');
    } catch (e) {
      expect((e as Error).message).toBe(NESTED_MESSAGE);
      expect((e as Error).message).not.toContain('BEGIN IMMEDIATE');
      expect((e as Error).message).not.toContain('SQLite');
    }
  });

  it('UNIQUE constraint error from repository is converted to safe infrastructure error', () => {
    const fake = new FakeDatabaseSync();
    const port = new CreationContractTransactionPortImpl(fake.asDatabaseSync());

    try {
      port.runInTransaction(() => {
        throw sqliteError('UNIQUE constraint failed: creation_contract_versions.id', 1555);
      });
      expect.unreachable('constraint error should propagate');
    } catch (e) {
      expectSafeContractError(e, ContractTransactionError, 'INTERNAL_ERROR', TX_FAILED_MESSAGE);
      // 原始 SQLite 细节在 cause，不在 public message
      expect(((e as AppError).cause as Error).message).toContain('UNIQUE constraint failed');
      expect((e as Error).message).not.toContain('UNIQUE');
      expect((e as Error).message).not.toContain('creation_contract_versions');
    }
    expect(fake.execCalls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });
});
