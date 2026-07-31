/**
 * 创作契约 User Update / Lock / Unlock 集成测试。
 *
 * 使用真实 SQLite ProjectDatabase，不使用 mock。
 * 覆盖：原子性回滚、双连接并发、完整历史集成、lock-event 仓库加固。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  canonicalSerializeContractSections,
  canonicalSerializeLockedFieldPaths,
  canonicalSerializeContractSnapshot,
  validateCreationContractSections,
  createCharacterKey,
  type CreationContractSections,
  type ContractVersionCreatedBy,
} from '@ai-novel/domain';
import {
  updateCreationContractByUser,
  lockCreationContractField,
  unlockCreationContractField,
  acceptCreationContractProposal,
  AppError,
  ContractVersionConflictError,
  ContractLockConflictError,
  ContractValidationError,
  ContractDataCorruptionError,
  ContractTransactionBusyError,
  ContractTransactionError,
  type CreationContractMutationDeps,
} from '@ai-novel/application';
import { ProjectDatabase } from './project-database.js';
import { CreationContractTransactionPortImpl } from './creation-contract-transaction.js';
import { sha256Utf8 } from './creation-contract-repositories.js';

// ── 测试辅助 ──────────────────────────────────────────────────

function makeSections(overrides?: Record<string, unknown>): CreationContractSections {
  return validateCreationContractSections({
    premise: 'A story about testing',
    genre: ['sci-fi'],
    tone: ['dark'],
    targetAudience: 'adults',
    narrativePov: 'FIRST',
    tense: 'PRESENT',
    protagonist: { characterKey: 'protag', name: 'Hero' },
    ...overrides,
  });
}

function makeSectionsJson(sections?: CreationContractSections): string {
  return canonicalSerializeContractSections(sections ?? makeSections());
}

function makeSnapshotHash(
  sections?: CreationContractSections,
  lockedFieldPaths: string[] = [],
): string {
  const canonical = canonicalSerializeContractSnapshot({
    sections: sections ?? makeSections(),
    lockedFieldPaths,
    schemaVersion: 1,
  });
  return sha256Utf8(canonical);
}

function setupProject(db: ProjectDatabase, projectId: string): void {
  db.database
    .prepare(
      `INSERT INTO project_metadata (id, name, initial_idea, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      'Test Project',
      'Test idea',
      'active',
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
    );
  db.getGrillSessionRepository().create({
    id: `gs-${projectId}`,
    projectId,
    goal: 'test goal',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
}

function setupProposal(
  db: ProjectDatabase,
  projectId: string,
  proposalId: string,
  overrides?: { sections?: CreationContractSections },
): void {
  const sections = overrides?.sections ?? makeSections();
  const sectionsJson = makeSectionsJson(sections);
  const sectionsHash = sha256Utf8(sectionsJson);
  db.getTaskRepository().create({
    id: `task-${proposalId}`,
    projectId,
    taskType: 'GRILL_QUESTION_PLAN',
    status: 'SUCCEEDED',
    inputVersionJson: '{}',
    payloadJson: '{}',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  db.getModelInvocationRepository().create({
    id: `inv-${proposalId}`,
    projectId,
    taskId: `task-${proposalId}`,
    providerProfileId: 'pp1',
    model: 'test-model',
    status: 'SUCCEEDED',
    attemptNumber: 1,
    requestKind: 'test',
    promptHash: 'a'.repeat(64),
    requestMetadataJson: '{}',
    createdAt: '2026-01-01T00:00:00Z',
  });
  db.getCreationContractProposalRepository().create({
    id: proposalId,
    projectId,
    taskId: `task-${proposalId}`,
    invocationId: `inv-${proposalId}`,
    baseGrillSessionId: `gs-${projectId}`,
    baseGrillSessionVersion: 1,
    baseContractVersion: null,
    schemaVersion: 1,
    sectionsJson,
    sectionsHash,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
}

interface InsertVersionInput {
  id: string;
  version: number;
  sections?: CreationContractSections;
  lockedFieldPaths?: string[];
  provenanceJson?: string;
  createdBy?: ContractVersionCreatedBy;
  createdAt?: string;
}

/** 直接插入一个权威版本（当前指针由 insertCurrent 设置） */
function insertVersionDirect(db: ProjectDatabase, input: InsertVersionInput): void {
  const sections = input.sections ?? makeSections();
  const lockedFieldPaths = input.lockedFieldPaths ?? [];
  db.getCreationContractVersionRepository().create({
    id: input.id,
    projectId: 'p1',
    version: input.version,
    schemaVersion: 1,
    sourceProposalId: null,
    basedOnGrillSessionId: null,
    basedOnGrillSessionVersion: null,
    sectionsJson: canonicalSerializeContractSections(sections),
    lockedFieldPathsJson: canonicalSerializeLockedFieldPaths(lockedFieldPaths),
    contractSnapshotHash: makeSnapshotHash(sections, lockedFieldPaths),
    provenanceJson: input.provenanceJson ?? '[]',
    createdAt: input.createdAt ?? '2026-01-01T00:00:00Z',
    createdBy: input.createdBy ?? 'user',
  });
}

function insertCurrent(db: ProjectDatabase, versionId: string, now = '2026-01-01T00:01:00Z'): void {
  db.getCreationContractCurrentRepository().insertFirst('p1', versionId, now);
}

/** 插入版本 v1 并设置 current pointer */
function seedBaseline(db: ProjectDatabase, input: Partial<InsertVersionInput> = {}): void {
  const opts: InsertVersionInput = { id: 'v1', version: 1, ...input };
  insertVersionDirect(db, opts);
  insertCurrent(db, opts.id);
}

function makeDeps(
  db: ProjectDatabase,
  sha256Port?: { digestUtf8: (input: string) => string },
): CreationContractMutationDeps {
  return {
    transactionPort: new CreationContractTransactionPortImpl(db.database),
    sha256Port: sha256Port ?? { digestUtf8: sha256Utf8 },
  };
}

const NOW = '2026-01-02T00:00:00Z';

// ── 测试套件 ──────────────────────────────────────────────────

describe('creation contract user mutations (real SQLite)', () => {
  let dir: string;
  let db: ProjectDatabase;
  let deps: CreationContractMutationDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-user-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    deps = makeDeps(db);
    setupProject(db, 'p1');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('lock event repository hardening', () => {
    it('rejects duplicate event id (project + id unique)', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      const repo = db.getCreationContractLockEventRepository();
      const data = {
        id: 'le1',
        projectId: 'p1',
        fieldPath: '/premise',
        action: 'LOCK' as const,
        versionId: 'v1',
        createdAt: NOW,
        createdBy: 'user',
      };
      repo.append(data);
      expect(() => repo.append(data)).toThrow();
    });

    it('rejects cross-project version reference (FK)', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      const repo = db.getCreationContractLockEventRepository();
      expect(() =>
        repo.append({
          id: 'le1',
          projectId: 'p2',
          fieldPath: '/premise',
          action: 'LOCK',
          versionId: 'v1', // v1 属于 p1
          createdAt: NOW,
          createdBy: 'user',
        }),
      ).toThrow();
    });

    it('rejects invalid action', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      const repo = db.getCreationContractLockEventRepository();
      expect(() =>
        repo.append({
          id: 'le1',
          projectId: 'p1',
          fieldPath: '/premise',
          action: 'TOGGLE' as never,
          versionId: 'v1',
          createdAt: NOW,
          createdBy: 'user',
        }),
      ).toThrow(ContractDataCorruptionError);
    });

    it('rejects invalid / non-canonical field path', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      const repo = db.getCreationContractLockEventRepository();
      expect(() =>
        repo.append({
          id: 'le1',
          projectId: 'p1',
          fieldPath: '/nonexistent/foo/bar/baz',
          action: 'LOCK',
          versionId: 'v1',
          createdAt: NOW,
          createdBy: 'user',
        }),
      ).toThrow(ContractDataCorruptionError);
    });

    it('rejects invalid timestamp', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      const repo = db.getCreationContractLockEventRepository();
      expect(() =>
        repo.append({
          id: 'le1',
          projectId: 'p1',
          fieldPath: '/premise',
          action: 'LOCK',
          versionId: 'v1',
          createdAt: 'not-a-timestamp',
          createdBy: 'user',
        }),
      ).toThrow();
    });

    it('rejects empty createdBy', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      const repo = db.getCreationContractLockEventRepository();
      expect(() =>
        repo.append({
          id: 'le1',
          projectId: 'p1',
          fieldPath: '/premise',
          action: 'LOCK',
          versionId: 'v1',
          createdAt: NOW,
          createdBy: '  ',
        }),
      ).toThrow(ContractDataCorruptionError);
    });

    it('rejects append referencing nonexistent version (FK)', () => {
      const repo = db.getCreationContractLockEventRepository();
      expect(() =>
        repo.append({
          id: 'le1',
          projectId: 'p1',
          fieldPath: '/premise',
          action: 'LOCK',
          versionId: 'nope',
          createdAt: NOW,
          createdBy: 'user',
        }),
      ).toThrow();
    });

    it('lists in stable order (createdAt, then event id code-point)', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      const repo = db.getCreationContractLockEventRepository();
      repo.append({
        id: 'b',
        projectId: 'p1',
        fieldPath: '/premise',
        action: 'LOCK',
        versionId: 'v1',
        createdAt: '2026-01-02T00:00:00Z',
        createdBy: 'user',
      });
      repo.append({
        id: 'a',
        projectId: 'p1',
        fieldPath: '/genre',
        action: 'UNLOCK',
        versionId: 'v1',
        createdAt: '2026-01-02T00:00:00Z',
        createdBy: 'user',
      });
      const events = repo.listByProject('p1');
      expect(events.map((e) => e.id)).toEqual(['a', 'b']);
    });
  });

  describe('lock event read corruption validation', () => {
    /** 直接通过 SQL 插入一行 lock event（绕过 append 验证），模拟损坏行。 */
    function insertRawLockEvent(row: {
      id: string;
      projectId: string;
      fieldPath: string;
      action: string;
      versionId: string;
      createdAt: string;
      createdBy: string;
    }): void {
      db.database
        .prepare(
          `INSERT INTO creation_contract_lock_events
             (id, project_id, field_path, action, version_id, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.projectId,
          row.fieldPath,
          row.action,
          row.versionId,
          row.createdAt,
          row.createdBy,
        );
    }

    /** 断言读路径抛出 ContractDataCorruptionError（INTERNAL_ERROR，fixed safe message）。 */
    function expectReadCorruption(fn: () => unknown): void {
      let error: unknown;
      try {
        fn();
        expect.unreachable('expected ContractDataCorruptionError');
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ContractDataCorruptionError);
      expect((error as AppError).code).toBe('INTERNAL_ERROR');
      expect((error as Error).message).toBe('创作契约数据完整性异常');
    }

    it('throws ContractDataCorruptionError on read for invalid createdAt', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      insertRawLockEvent({
        id: 'le1',
        projectId: 'p1',
        fieldPath: '/premise',
        action: 'LOCK',
        versionId: 'v1',
        createdAt: 'not-a-timestamp',
        createdBy: 'user',
      });
      expectReadCorruption(() => db.getCreationContractLockEventRepository().listByProject('p1'));
    });

    it('throws on read for whitespace createdBy', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      insertRawLockEvent({
        id: 'le1',
        projectId: 'p1',
        fieldPath: '/premise',
        action: 'LOCK',
        versionId: 'v1',
        createdAt: NOW,
        createdBy: '  ',
      });
      expectReadCorruption(() => db.getCreationContractLockEventRepository().listByProject('p1'));
    });

    it('throws on read for non-canonical fieldPath', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      insertRawLockEvent({
        id: 'le1',
        projectId: 'p1',
        fieldPath: '/Premise',
        action: 'LOCK',
        versionId: 'v1',
        createdAt: NOW,
        createdBy: 'user',
      });
      expectReadCorruption(() => db.getCreationContractLockEventRepository().listByProject('p1'));
    });

    it('throws on read for whitespace event id', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      insertRawLockEvent({
        id: '  ',
        projectId: 'p1',
        fieldPath: '/premise',
        action: 'LOCK',
        versionId: 'v1',
        createdAt: NOW,
        createdBy: 'user',
      });
      expectReadCorruption(() => db.getCreationContractLockEventRepository().listByProject('p1'));
    });

    it('throws on read for whitespace versionId (schema allows the raw id)', () => {
      // 直接插入一个 id 为空白字符的 version（schema 允许），再插入引用它的 event
      insertVersionDirect(db, { id: '  ', version: 99 });
      insertRawLockEvent({
        id: 'le1',
        projectId: 'p1',
        fieldPath: '/premise',
        action: 'LOCK',
        versionId: '  ',
        createdAt: NOW,
        createdBy: 'user',
      });
      expectReadCorruption(() => db.getCreationContractLockEventRepository().listByProject('p1'));
    });

    it('returns legal rows normally through both list methods', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      const repo = db.getCreationContractLockEventRepository();
      repo.append({
        id: 'le-a',
        projectId: 'p1',
        fieldPath: '/premise',
        action: 'LOCK',
        versionId: 'v1',
        createdAt: NOW,
        createdBy: 'user',
      });
      repo.append({
        id: 'le-b',
        projectId: 'p1',
        fieldPath: '/genre',
        action: 'UNLOCK',
        versionId: 'v1',
        createdAt: NOW,
        createdBy: 'user',
      });
      expect(repo.listByProject('p1').map((e) => e.id)).toEqual(['le-a', 'le-b']);
      expect(repo.listByVersionId('p1', 'v1').map((e) => e.id)).toEqual(['le-a', 'le-b']);
    });

    it('validates both listByProject and listByVersionId on a corrupt row', () => {
      insertVersionDirect(db, { id: 'v1', version: 1 });
      insertRawLockEvent({
        id: 'le-bad',
        projectId: 'p1',
        fieldPath: '/premise',
        action: 'LOCK',
        versionId: 'v1',
        createdAt: 'garbage',
        createdBy: 'user',
      });
      const repo = db.getCreationContractLockEventRepository();
      expectReadCorruption(() => repo.listByProject('p1'));
      expectReadCorruption(() => repo.listByVersionId('p1', 'v1'));
    });
  });

  describe('updateCreationContractByUser', () => {
    it('updates sections and keeps locks; stale version conflict rolls back', () => {
      seedBaseline(db, { lockedFieldPaths: ['/genre'] });

      const result = updateCreationContractByUser(deps, {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'A new premise' }],
        now: NOW,
        newVersionId: 'v2',
      });
      expect(result.version).toBe(2);
      expect(result.createdBy).toBe('user');
      expect(result.lockedFieldPaths).toEqual(['/genre']);

      // stale retry → CONTRACT_VERSION_CONFLICT，无副作用
      try {
        updateCreationContractByUser(deps, {
          projectId: 'p1',
          expectedContractVersion: 1,
          operations: [{ kind: 'set-scalar', path: '/premise', value: 'again' }],
          now: NOW,
          newVersionId: 'v3',
        });
        expect.unreachable('stale should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractVersionConflictError);
        expect((e as AppError).code).toBe('CONTRACT_VERSION_CONFLICT');
      }
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v2');
      expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(2);
    });
  });

  describe('lockCreationContractField / unlockCreationContractField', () => {
    it('lock then unlock create versions and append audit events', () => {
      seedBaseline(db);

      const lockResult = lockCreationContractField(deps, {
        projectId: 'p1',
        expectedContractVersion: 1,
        fieldPath: '/premise',
        now: NOW,
        newVersionId: 'v2',
        lockEventId: 'le1',
      });
      expect(lockResult.version).toBe(2);
      expect(lockResult.createdBy).toBe('lock');

      const unlockResult = unlockCreationContractField(deps, {
        projectId: 'p1',
        expectedContractVersion: 2,
        fieldPath: '/premise',
        now: '2026-01-03T00:00:00Z',
        newVersionId: 'v3',
        lockEventId: 'le2',
      });
      expect(unlockResult.version).toBe(3);
      expect(unlockResult.createdBy).toBe('unlock');
      expect(unlockResult.lockedFieldPaths).toEqual([]);

      const events = db.getCreationContractLockEventRepository().listByProject('p1');
      expect(events.map((e) => e.action)).toEqual(['LOCK', 'UNLOCK']);
      expect(events[0]?.versionId).toBe('v2');
      expect(events[1]?.versionId).toBe('v3');
    });

    it('lock conflict (duplicate) does not create version or event', () => {
      seedBaseline(db, { lockedFieldPaths: ['/premise'] });

      try {
        lockCreationContractField(deps, {
          projectId: 'p1',
          expectedContractVersion: 1,
          fieldPath: '/premise',
          now: NOW,
          newVersionId: 'v2',
          lockEventId: 'le1',
        });
        expect.unreachable('duplicate lock should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractLockConflictError);
        expect((e as AppError).code).toBe('CONTRACT_LOCK_CONFLICT');
      }
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
      expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
      expect(db.getCreationContractLockEventRepository().listByProject('p1')).toEqual([]);
    });
  });

  describe('rollback atomicity', () => {
    it('update: lock conflict rolls back (no version, pointer, or lock event)', () => {
      seedBaseline(db, { lockedFieldPaths: ['/premise'] });

      try {
        updateCreationContractByUser(deps, {
          projectId: 'p1',
          expectedContractVersion: 1,
          operations: [{ kind: 'set-scalar', path: '/premise', value: 'locked write' }],
          now: NOW,
          newVersionId: 'v2',
        });
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractLockConflictError);
      }
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
      expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
      expect(db.getCreationContractLockEventRepository().listByProject('p1')).toEqual([]);
    });

    it('update: domain validation after reads rolls back (dangling relationship)', () => {
      seedBaseline(db, {
        sections: makeSections({
          supportingCharacters: [{ characterKey: 'alice', name: 'Alice' }],
          relationships: [
            {
              relationshipKey: 'rel1',
              fromCharacterKey: 'protag',
              toCharacterKey: 'alice',
              type: 'friend',
            },
          ],
        }),
      });

      try {
        updateCreationContractByUser(deps, {
          projectId: 'p1',
          expectedContractVersion: 1,
          operations: [{ kind: 'remove-character', target: createCharacterKey('alice') }],
          now: NOW,
          newVersionId: 'v2',
        });
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractValidationError);
      }
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
      expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
    });

    it('update: version duplicate id rolls back', () => {
      seedBaseline(db);
      insertVersionDirect(db, { id: 'v2', version: 3 }); // 占用 id v2

      try {
        updateCreationContractByUser(deps, {
          projectId: 'p1',
          expectedContractVersion: 1,
          operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
          now: NOW,
          newVersionId: 'v2',
        });
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe('INTERNAL_ERROR');
      }
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
      // v1 和占位的 v2 仍在，但更新没有产生第三个版本
      expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(2);
    });

    it('update: version number conflict (UNIQUE project+version) rolls back', () => {
      seedBaseline(db);
      insertVersionDirect(db, { id: 'v9', version: 2 }); // 占用 version 2

      try {
        updateCreationContractByUser(deps, {
          projectId: 'p1',
          expectedContractVersion: 1,
          operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
          now: NOW,
          newVersionId: 'v2',
        });
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe('INTERNAL_ERROR');
      }
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
      expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(2);
    });

    it('update: invalid sha256 output (write-path snapshot) rolls back', () => {
      const sections = makeSections();
      seedBaseline(db, { sections });
      // port：仅对当前 snapshot 输入返回合法 hash，其他输入返回非法值
      const currentSnapshot = canonicalSerializeContractSnapshot({
        sections,
        lockedFieldPaths: [],
        schemaVersion: 1,
      });
      const validHash = sha256Utf8(currentSnapshot);
      const badDeps = makeDeps(db, {
        digestUtf8: (input: string) => (input === currentSnapshot ? validHash : 'not-a-hash'),
      });

      try {
        updateCreationContractByUser(badDeps, {
          projectId: 'p1',
          expectedContractVersion: 1,
          operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
          now: NOW,
          newVersionId: 'v2',
        });
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractDataCorruptionError);
        expect((e as AppError).code).toBe('INTERNAL_ERROR');
      }
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
      expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
    });

    it('lock: event insert failure after version create rolls back everything', () => {
      seedBaseline(db);
      // 预置一个与待写入 lockEventId 冲突的事件（引用 v1）
      db.getCreationContractLockEventRepository().append({
        id: 'le-dupe',
        projectId: 'p1',
        fieldPath: '/genre',
        action: 'LOCK',
        versionId: 'v1',
        createdAt: NOW,
        createdBy: 'user',
      });

      try {
        lockCreationContractField(deps, {
          projectId: 'p1',
          expectedContractVersion: 1,
          fieldPath: '/premise',
          now: NOW,
          newVersionId: 'v2',
          lockEventId: 'le-dupe',
        });
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractTransactionError);
        expect((e as AppError).code).toBe('INTERNAL_ERROR');
      }
      // version v2 与 pointer 更新全部回滚
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
      expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
      expect(
        db
          .getCreationContractLockEventRepository()
          .listByProject('p1')
          .map((e) => e.id),
      ).toEqual(['le-dupe']);
    });

    it('lock: invalid sha256 output for new snapshot rolls back', () => {
      const sections = makeSections();
      seedBaseline(db, { sections });
      const currentSnapshot = canonicalSerializeContractSnapshot({
        sections,
        lockedFieldPaths: [],
        schemaVersion: 1,
      });
      const validHash = sha256Utf8(currentSnapshot);
      const badDeps = makeDeps(db, {
        digestUtf8: (input: string) => (input === currentSnapshot ? validHash : 'not-a-hash'),
      });

      try {
        lockCreationContractField(badDeps, {
          projectId: 'p1',
          expectedContractVersion: 1,
          fieldPath: '/premise',
          now: NOW,
          newVersionId: 'v2',
          lockEventId: 'le1',
        });
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractDataCorruptionError);
        expect((e as AppError).code).toBe('INTERNAL_ERROR');
      }
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
      expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
      expect(db.getCreationContractLockEventRepository().listByProject('p1')).toEqual([]);
    });

    it('unlock: event insert failure rolls back', () => {
      seedBaseline(db, { lockedFieldPaths: ['/premise'] });
      db.getCreationContractLockEventRepository().append({
        id: 'le-dupe',
        projectId: 'p1',
        fieldPath: '/genre',
        action: 'LOCK',
        versionId: 'v1',
        createdAt: NOW,
        createdBy: 'user',
      });

      try {
        unlockCreationContractField(deps, {
          projectId: 'p1',
          expectedContractVersion: 1,
          fieldPath: '/premise',
          now: NOW,
          newVersionId: 'v2',
          lockEventId: 'le-dupe',
        });
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractTransactionError);
      }
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
      expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
      expect(db.getCreationContractVersionRepository().getByVersion('p1', 2)).toBeNull();
    });

    it('current CAS repository returns false on stale expected version id', () => {
      seedBaseline(db);
      insertVersionDirect(db, { id: 'v2', version: 2 });
      const repo = db.getCreationContractCurrentRepository();

      expect(repo.casUpdate('p1', 'stale-id', 'v2', NOW)).toBe(false);
      expect(repo.get('p1')?.currentVersionId).toBe('v1');
      expect(repo.casUpdate('p1', 'v1', 'v2', NOW)).toBe(true);
      expect(repo.get('p1')?.currentVersionId).toBe('v2');
    });
  });

  describe('real two-connection contention', () => {
    let dbA: ProjectDatabase;
    let dbB: ProjectDatabase;
    let depsA: CreationContractMutationDeps;
    let depsB: CreationContractMutationDeps;

    beforeEach(() => {
      const path = join(dir, 'project.sqlite');
      dbA = new ProjectDatabase(path);
      dbB = new ProjectDatabase(path);
      dbB.database.exec('PRAGMA busy_timeout = 0');
      depsA = makeDeps(dbA);
      depsB = makeDeps(dbB);
      // 项目数据由外层 beforeEach 通过同一文件的 db 连接创建，dbA/dbB 可见
    });

    afterEach(() => {
      dbA.close();
      dbB.close();
    });

    function holdWriteLock(db: ProjectDatabase, holderId: string): void {
      db.database.exec('BEGIN IMMEDIATE');
      db.database
        .prepare(
          `INSERT INTO project_metadata (id, name, initial_idea, status, created_at, updated_at)
           VALUES (?, 'holder', 'x', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        )
        .run(holderId);
    }

    function expectBusyConflict(e: unknown): void {
      expect(e).toBeInstanceOf(ContractTransactionBusyError);
      expect((e as AppError).code).toBe('CONTRACT_VERSION_CONFLICT');
      expect((e as Error).message).toBe('创作契约正在被其他操作修改，请重试');
      expect((e as Error).message).not.toContain('SQLITE_BUSY');
      expect((e as Error).message).not.toContain('database is locked');
    }

    it('Update A/B same expected=N: only one N+1, no orphan, loser stable conflict', () => {
      seedBaseline(dbA);

      holdWriteLock(dbA, 'holder-u');
      try {
        updateCreationContractByUser(depsB, {
          projectId: 'p1',
          expectedContractVersion: 1,
          operations: [{ kind: 'set-scalar', path: '/premise', value: 'B wins' }],
          now: NOW,
          newVersionId: 'v2b',
        });
        expect.unreachable('B should fail busy');
      } catch (e) {
        expectBusyConflict(e);
      }
      dbA.database.exec('COMMIT');

      const r = updateCreationContractByUser(depsA, {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'A wins' }],
        now: NOW,
        newVersionId: 'v2a',
      });
      expect(r.version).toBe(2);

      // B 重试仍基于 expected=1 → 稳定 precondition conflict
      try {
        updateCreationContractByUser(depsB, {
          projectId: 'p1',
          expectedContractVersion: 1,
          operations: [{ kind: 'set-scalar', path: '/premise', value: 'B again' }],
          now: NOW,
          newVersionId: 'v2b',
        });
        expect.unreachable('B should fail version conflict');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractVersionConflictError);
      }

      const versions = dbA.getCreationContractVersionRepository().listSummaries('p1');
      expect(versions).toHaveLength(2);
      expect(versions.filter((v) => v.version === 2)).toHaveLength(1);
      expect(versions.filter((v) => v.version === 2)[0]?.id).toBe('v2a');
      expect(dbA.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v2a');
    });

    it('Lock A/B same expected=N: only one N+1, only one event, loser no event', () => {
      seedBaseline(dbA);

      holdWriteLock(dbA, 'holder-l');
      try {
        lockCreationContractField(depsB, {
          projectId: 'p1',
          expectedContractVersion: 1,
          fieldPath: '/premise',
          now: NOW,
          newVersionId: 'v2b',
          lockEventId: 'le-b',
        });
        expect.unreachable('B should fail busy');
      } catch (e) {
        expectBusyConflict(e);
      }
      dbA.database.exec('COMMIT');

      const r = lockCreationContractField(depsA, {
        projectId: 'p1',
        expectedContractVersion: 1,
        fieldPath: '/premise',
        now: NOW,
        newVersionId: 'v2a',
        lockEventId: 'le-a',
      });
      expect(r.version).toBe(2);

      try {
        lockCreationContractField(depsB, {
          projectId: 'p1',
          expectedContractVersion: 1,
          fieldPath: '/premise',
          now: NOW,
          newVersionId: 'v2b',
          lockEventId: 'le-b',
        });
        expect.unreachable('B should fail version conflict');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractVersionConflictError);
      }

      const versions = dbA.getCreationContractVersionRepository().listSummaries('p1');
      expect(versions).toHaveLength(2);
      expect(dbA.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v2a');
      const events = dbA.getCreationContractLockEventRepository().listByProject('p1');
      expect(events).toHaveLength(1);
      expect(events[0]?.id).toBe('le-a');
      expect(events[0]?.versionId).toBe('v2a');
    });

    it('Lock vs Unlock contention: only one succeeds; state consistent', () => {
      seedBaseline(dbA);

      holdWriteLock(dbA, 'holder-lu');
      try {
        unlockCreationContractField(depsB, {
          projectId: 'p1',
          expectedContractVersion: 1,
          fieldPath: '/premise', // 尚不存在 lock
          now: NOW,
          newVersionId: 'v2b',
          lockEventId: 'le-b',
        });
        expect.unreachable('B should fail busy');
      } catch (e) {
        expectBusyConflict(e);
      }
      dbA.database.exec('COMMIT');

      const r = lockCreationContractField(depsA, {
        projectId: 'p1',
        expectedContractVersion: 1,
        fieldPath: '/premise',
        now: NOW,
        newVersionId: 'v2a',
        lockEventId: 'le-a',
      });
      expect(r.version).toBe(2);

      // B 重试基于 expected=1 → 版本已变化，unlock 失败
      try {
        unlockCreationContractField(depsB, {
          projectId: 'p1',
          expectedContractVersion: 1,
          fieldPath: '/premise',
          now: NOW,
          newVersionId: 'v2b',
          lockEventId: 'le-b',
        });
        expect.unreachable('B should fail');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractVersionConflictError);
      }

      // 最终：A 的 lock 版本 + 唯一 LOCK event
      expect(dbA.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v2a');
      const events = dbA.getCreationContractLockEventRepository().listByProject('p1');
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe('LOCK');
      expect(events[0]?.versionId).toBe('v2a');
    });

    it('Update vs Lock contention: only one succeeds; winner lock set matches its version', () => {
      seedBaseline(dbA);

      holdWriteLock(dbA, 'holder-ul');
      try {
        updateCreationContractByUser(depsB, {
          projectId: 'p1',
          expectedContractVersion: 1,
          operations: [{ kind: 'set-scalar', path: '/premise', value: 'B edits locked later' }],
          now: NOW,
          newVersionId: 'v2b',
        });
        expect.unreachable('B should fail busy');
      } catch (e) {
        expectBusyConflict(e);
      }
      dbA.database.exec('COMMIT');

      const r = lockCreationContractField(depsA, {
        projectId: 'p1',
        expectedContractVersion: 1,
        fieldPath: '/premise',
        now: NOW,
        newVersionId: 'v2a',
        lockEventId: 'le-a',
      });
      expect(r.version).toBe(2);

      // B 重试基于 expected=1 → 版本已变化；即使重试成功也会遇到 lock conflict
      try {
        updateCreationContractByUser(depsB, {
          projectId: 'p1',
          expectedContractVersion: 1,
          operations: [{ kind: 'set-scalar', path: '/premise', value: 'B edits' }],
          now: NOW,
          newVersionId: 'v2b',
        });
        expect.unreachable('B should fail');
      } catch (e) {
        expect(e).toBeInstanceOf(ContractVersionConflictError);
      }

      // 最终：A 的 lock 版本，locks=['/premise']，sections 未变
      const current = dbA.getCreationContractCurrentRepository().get('p1')!;
      expect(current.currentVersionId).toBe('v2a');
      const v2a = dbA.getCreationContractVersionRepository().getById('p1', 'v2a')!;
      expect(JSON.parse(v2a.lockedFieldPathsJson)).toEqual(['/premise']);
      // B 的更新没有副作用（无额外版本）
      expect(dbA.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(2);
    });

    it('Connection A holds BEGIN IMMEDIATE: B fails stable CONTRACT_VERSION_CONFLICT, no busy leak, no auto retry', () => {
      seedBaseline(dbA);
      holdWriteLock(dbA, 'holder-busy');

      try {
        updateCreationContractByUser(depsB, {
          projectId: 'p1',
          expectedContractVersion: 1,
          operations: [{ kind: 'set-scalar', path: '/premise', value: 'B' }],
          now: NOW,
          newVersionId: 'v2b',
        });
        expect.unreachable('B should fail busy');
      } catch (e) {
        expectBusyConflict(e);
      }

      // B 无副作用
      expect(dbA.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
      expect(dbA.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');

      // A 释放后 B 手动重试（adapter 不自动 retry）成功
      dbA.database.exec('COMMIT');
      const result = updateCreationContractByUser(depsB, {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'B retried' }],
        now: NOW,
        newVersionId: 'v2b',
      });
      expect(result.version).toBe(2);
    });
  });

  describe('creation contract full history integration', () => {
    it('builds N → Lock N+1 → User Update N+2 → Unlock N+3 with auditable events', () => {
      // 1. Version N=1：sections S, locks []（via accept）
      setupProposal(db, 'p1', 'prop1');
      const accepted = acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: sha256Utf8(makeSectionsJson()),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      });
      expect(accepted.version).toBe(1);
      const v1SectionsJson = makeSectionsJson();
      const v1 = db.getCreationContractVersionRepository().getById('p1', 'v1')!;
      expect(v1.sectionsJson).toBe(v1SectionsJson);
      expect(v1.lockedFieldPathsJson).toBe('[]');
      expect(v1.createdBy).toBe('ai-proposal-accepted');

      // 2. Lock /premise → N+1=2
      const locked = lockCreationContractField(deps, {
        projectId: 'p1',
        expectedContractVersion: 1,
        fieldPath: '/premise',
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
        lockEventId: 'le-lock',
      });
      expect(locked.version).toBe(2);
      const v2 = db.getCreationContractVersionRepository().getById('p1', 'v2')!;
      expect(v2.sectionsJson).toBe(v1.sectionsJson);
      expect(v2.provenanceJson).toBe(v1.provenanceJson);
      expect(JSON.parse(v2.lockedFieldPathsJson)).toEqual(['/premise']);
      expect(v2.createdBy).toBe('lock');

      // 3. User Update 无关字段 /targetAudience → N+2=3
      const updated = updateCreationContractByUser(deps, {
        projectId: 'p1',
        expectedContractVersion: 2,
        operations: [{ kind: 'set-scalar', path: '/targetAudience', value: 'young adults' }],
        now: '2026-01-03T00:00:00Z',
        newVersionId: 'v3',
      });
      expect(updated.version).toBe(3);
      const v3 = db.getCreationContractVersionRepository().getById('p1', 'v3')!;
      expect(JSON.parse(v3.sectionsJson).targetAudience).toBe('young adults');
      expect(JSON.parse(v3.lockedFieldPathsJson)).toEqual(['/premise']);
      expect(v3.createdBy).toBe('user');

      // 4. Unlock /premise → N+3=4
      const unlocked = unlockCreationContractField(deps, {
        projectId: 'p1',
        expectedContractVersion: 3,
        fieldPath: '/premise',
        now: '2026-01-04T00:00:00Z',
        newVersionId: 'v4',
        lockEventId: 'le-unlock',
      });
      expect(unlocked.version).toBe(4);
      const v4 = db.getCreationContractVersionRepository().getById('p1', 'v4')!;
      expect(JSON.parse(v4.lockedFieldPathsJson)).toEqual([]);
      expect(v4.createdBy).toBe('unlock');

      // ── 验证 ──
      const versions = db.getCreationContractVersionRepository().listSummaries('p1');
      expect(versions).toHaveLength(4);

      // 历史版本不可变
      expect(db.getCreationContractVersionRepository().getById('p1', 'v1')!.sectionsJson).toBe(
        v1SectionsJson,
      );
      expect(
        db.getCreationContractVersionRepository().getById('p1', 'v2')!.lockedFieldPathsJson,
      ).toBe('["/premise"]');
      expect(
        db.getCreationContractVersionRepository().getById('p1', 'v3')!.provenanceJson,
      ).not.toBe(v1.provenanceJson);

      // current 指向 N+3
      expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v4');

      // lock event 可审计：LOCK→v2, UNLOCK→v4（User Update 不产生新 event）
      const events = db.getCreationContractLockEventRepository().listByProject('p1');
      expect(events.map((e) => `${e.action}:${e.versionId}`)).toEqual(['LOCK:v2', 'UNLOCK:v4']);

      // active locks 只从 current version 读取
      expect(JSON.parse(v4.lockedFieldPathsJson)).toEqual([]);

      // snapshot hashes 均匹配（重算验证）
      for (const v of [v1, v2, v3, v4]) {
        const parsed = JSON.parse(v.sectionsJson);
        const sections = validateCreationContractSections(parsed);
        const locks = JSON.parse(v.lockedFieldPathsJson) as string[];
        const expected = sha256Utf8(
          canonicalSerializeContractSnapshot({
            sections,
            lockedFieldPaths: locks,
            schemaVersion: v.schemaVersion,
          }),
        );
        expect(v.contractSnapshotHash).toBe(expected);
      }
    });
  });
});
