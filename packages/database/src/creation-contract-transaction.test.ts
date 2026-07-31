/**
 * 创作契约事务适配器单元测试。
 *
 * 覆盖：成功提交、回调抛错回滚、嵌套事务拒绝、返回值透传。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { ContractNestedTransactionError } from '@ai-novel/application';
import { CreationContractTransactionPortImpl } from './creation-contract-transaction.js';
import { ProjectDatabase } from './project-database.js';

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

    expect(() =>
      port.runInTransaction(() => {
        throw new Error('test error');
      }),
    ).toThrow('test error');

    const result = port.runInTransaction((repos) => repos.projectExistsReadPort.exists('p1'));
    expect(result).toBe(true);
  });

  it('rejects nested transactions', () => {
    const port = new CreationContractTransactionPortImpl(db.database);

    expect(() =>
      port.runInTransaction(() => {
        port.runInTransaction(() => {
          // nested
        });
      }),
    ).toThrow(ContractNestedTransactionError);
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
});
