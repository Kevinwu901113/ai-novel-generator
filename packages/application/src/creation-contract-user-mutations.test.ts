/**
 * 创作契约 User Update / Lock / Unlock 应用层 fake-port 测试。
 *
 * 使用 fake transaction port（带快照回滚语义）+ fake 仓库，
 * 验证 Application port 边界独立安全：
 *   - Update 的 ChangeSet / lock / provenance / no-op / atomicity
 *   - Lock 的 lockable-absent-field 语义 / symmetric overlap / event
 *   - Unlock 的精确解锁 / event
 *
 * 关键断言：error class、error.code、safe message、事务副作用（回滚）。
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  validateCreationContractSections,
  canonicalSerializeContractSections,
  canonicalSerializeLockedFieldPaths,
  canonicalSerializeContractSnapshot,
  canonicalSerializeContractFieldValue,
  codePointCompare,
  createCharacterKey,
  type CreationContractSections,
  type ContractPatchOperation,
  type ContractVersionCreatedBy,
} from '@ai-novel/domain';
import {
  updateCreationContractByUser,
  lockCreationContractField,
  unlockCreationContractField,
} from './creation-contract-user-mutations.js';
import {
  collectAllFieldPaths,
  type CreationContractMutationDeps,
} from './creation-contract-mutations.js';
import type {
  CreationContractTransactionRepositories,
  CreationContractProposalRepositoryPort,
  CreationContractVersionRepositoryPort,
  CreationContractCurrentRepositoryPort,
  CreationContractLockEventRepositoryPort,
  CreationContractVersionData,
  CreationContractCurrentData,
  CreationContractLockEventData,
  LockCreationContractFieldInput,
  UnlockCreationContractFieldInput,
  ProjectExistsReadPort,
  GrillSessionVersionReadPort,
} from './creation-contract-types.js';
import {
  AppError,
  ValidationError,
  ContractVersionConflictError,
  ContractLockConflictError,
  ContractValidationError,
  ContractDataCorruptionError,
} from './errors.js';

// ── 测试工具 ─────────────────────────────────────────────────

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function makeSections(overrides?: Record<string, unknown>): CreationContractSections {
  return validateCreationContractSections({
    premise: 'A story about a hero',
    genre: ['fantasy'],
    tone: ['epic'],
    targetAudience: 'adults',
    narrativePov: 'THIRD_LIMITED',
    tense: 'PAST',
    protagonist: { characterKey: 'hero', name: 'Hero' },
    structure: 'Three act structure',
    ...overrides,
  });
}

const SECTIONS_WITH_ALICE: CreationContractSections = makeSections({
  supportingCharacters: [{ characterKey: 'alice', name: 'Alice' }],
});

function makeProvenanceJson(
  sections: CreationContractSections,
  overrides?: Map<string, Partial<Record<string, unknown>>>,
): string {
  const paths = collectAllFieldPaths(sections).sort(codePointCompare);
  return JSON.stringify(
    paths.map((p) => ({
      sectionKey: p,
      source: 'DEFAULT',
      grillAnswerIds: [],
      grillProposalIds: [],
      aiTaskId: null,
      modelInvocationId: null,
      sourceProposalId: null,
      previousFieldHash: null,
      rationale: null,
      ...overrides?.get(p),
    })),
  );
}

function makeVersionData(
  overrides?: Partial<CreationContractVersionData> & {
    sections?: CreationContractSections;
    lockedFieldPaths?: readonly string[];
    provenanceJson?: string;
  },
): CreationContractVersionData {
  const sections = overrides?.sections ?? makeSections();
  const lockedFieldPaths = overrides?.lockedFieldPaths ?? [];
  const sectionsJson = overrides?.sectionsJson ?? canonicalSerializeContractSections(sections);
  const lockedFieldPathsJson =
    overrides?.lockedFieldPathsJson ?? canonicalSerializeLockedFieldPaths([...lockedFieldPaths]);
  const provenanceJson = overrides?.provenanceJson ?? makeProvenanceJson(sections);
  const contractSnapshotHash =
    overrides?.contractSnapshotHash ??
    sha256Hex(
      canonicalSerializeContractSnapshot({
        sections,
        lockedFieldPaths,
        schemaVersion: 1,
      }),
    );
  return {
    id: overrides?.id ?? 'v1',
    projectId: 'p1',
    version: overrides?.version ?? 1,
    schemaVersion: 1,
    sourceProposalId: overrides?.sourceProposalId ?? null,
    basedOnGrillSessionId: overrides?.basedOnGrillSessionId ?? null,
    basedOnGrillSessionVersion: overrides?.basedOnGrillSessionVersion ?? null,
    sectionsJson,
    lockedFieldPathsJson,
    contractSnapshotHash,
    provenanceJson,
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: overrides?.createdBy ?? ('user' as ContractVersionCreatedBy),
  };
}

interface FakeState {
  versions: Map<string, CreationContractVersionData>;
  current: CreationContractCurrentData | null;
  lockEvents: CreationContractLockEventData[];
  createdVersionIds: string[];
  proposalStatus: string | null;
  projectExists: boolean;
}

/**
 * 既是事务端口又是事务内仓库集合。
 * runInTransaction 在回调抛错时快照回滚，模拟真实事务适配器的回滚语义。
 */
class FakeTransactionRepos implements CreationContractTransactionRepositories {
  versions = new Map<string, CreationContractVersionData>();
  current: CreationContractCurrentData | null = null;
  lockEvents: CreationContractLockEventData[] = [];
  createdVersionIds: string[] = [];
  callbackEntered = false;
  projectExists = true;
  proposalStatus: string | null = 'PROPOSED';
  /** 模拟 current pointer CAS 失败（乐观并发写冲突） */
  casUpdateFails = false;

  readonly proposalRepo: CreationContractProposalRepositoryPort = {
    create: () => {},
    getById: () => null,
    listByProject: () => [],
    listByGrillSession: () => [],
    transitionStatus: () => false,
    transitionStatusWithHash: () => false,
    supersedeAllProposed: () => 0,
  };

  readonly versionRepo: CreationContractVersionRepositoryPort = {
    create: (data) => {
      this.versions.set(data.id, data);
      this.createdVersionIds.push(data.id);
    },
    getById: (_p, id) => this.versions.get(id) ?? null,
    getByVersion: (_p, version) =>
      [...this.versions.values()].find((v) => v.version === version) ?? null,
    listSummaries: (projectId) =>
      [...this.versions.values()].filter((v) => v.projectId === projectId),
    resolveVersionId: () => null,
  };

  readonly currentRepo: CreationContractCurrentRepositoryPort = {
    get: () => this.current,
    insertFirst: (projectId, versionId, now) => {
      this.current = { projectId, currentVersionId: versionId, updatedAt: now };
      return true;
    },
    casUpdate: (projectId, expected, versionId, now) => {
      if (this.casUpdateFails) return false;
      if (!this.current || this.current.currentVersionId !== expected) return false;
      this.current = { projectId, currentVersionId: versionId, updatedAt: now };
      return true;
    },
  };

  readonly lockEventRepo: CreationContractLockEventRepositoryPort = {
    append: (data) => {
      this.lockEvents.push(data);
    },
    listByVersionId: () => [],
    listByProject: () => this.lockEvents,
  };

  readonly grillSessionVersionReadPort: GrillSessionVersionReadPort = {
    getVersion: () => 1,
  };
  readonly projectExistsReadPort: ProjectExistsReadPort = {
    exists: () => this.projectExists,
  };

  runInTransaction<T>(operation: (repos: CreationContractTransactionRepositories) => T): T {
    this.callbackEntered = true;
    const snapshot: FakeState = {
      versions: new Map(this.versions),
      current: this.current,
      lockEvents: [...this.lockEvents],
      createdVersionIds: [...this.createdVersionIds],
      proposalStatus: this.proposalStatus,
      projectExists: this.projectExists,
    };
    try {
      return operation(this);
    } catch (e) {
      this.versions = snapshot.versions;
      this.current = snapshot.current;
      this.lockEvents = snapshot.lockEvents;
      this.createdVersionIds = snapshot.createdVersionIds;
      this.proposalStatus = snapshot.proposalStatus;
      this.projectExists = snapshot.projectExists;
      throw e;
    }
  }
}

function makeDeps(fake: FakeTransactionRepos): CreationContractMutationDeps {
  return { transactionPort: fake, sha256Port: { digestUtf8: sha256Hex } };
}

function seedCurrent(
  fake: FakeTransactionRepos,
  versionOverrides?: Parameters<typeof makeVersionData>[0],
): void {
  fake.versions.set('v1', makeVersionData(versionOverrides));
  fake.current = {
    projectId: 'p1',
    currentVersionId: 'v1',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

// ── 错误断言 ─────────────────────────────────────────────────

function expectValidationError(e: unknown): void {
  expect(e).toBeInstanceOf(ContractValidationError);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe('CONTRACT_VALIDATION_FAILED');
  expect((e as Error).message).toBe('创作契约内容验证失败');
}

function expectVersionConflict(e: unknown): void {
  expect(e).toBeInstanceOf(ContractVersionConflictError);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe('CONTRACT_VERSION_CONFLICT');
  expect((e as Error).message).toBe('创作契约版本已变化，请刷新后重试');
}

function expectLockConflict(e: unknown): void {
  expect(e).toBeInstanceOf(ContractLockConflictError);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe('CONTRACT_LOCK_CONFLICT');
  expect((e as Error).message).toBe('操作与受保护的契约字段冲突');
}

function expectCorruptionError(e: unknown): void {
  expect(e).toBeInstanceOf(ContractDataCorruptionError);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe('INTERNAL_ERROR');
  expect((e as Error).message).toBe('创作契约数据完整性异常');
}

function expectNoSideEffects(fake: FakeTransactionRepos): void {
  expect(fake.createdVersionIds).toEqual([]);
  expect(fake.versions.has('v2')).toBe(false);
  expect(fake.current?.currentVersionId).toBe('v1');
  expect(fake.lockEvents).toEqual([]);
}

// ── UpdateCreationContractByUser ─────────────────────────────

describe('updateCreationContractByUser', () => {
  it('performs a successful scalar update and creates a new user version', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    const result = updateCreationContractByUser(makeDeps(fake), {
      projectId: 'p1',
      expectedContractVersion: 1,
      operations: [{ kind: 'set-scalar', path: '/premise', value: 'A story about a dragon' }],
      now: '2026-01-02T00:00:00Z',
      newVersionId: 'v2',
    });

    expect(result.version).toBe(2);
    expect(result.createdBy).toBe('user');
    expect(result.sourceProposalId).toBeNull();
    expect(result.sections.premise).toBe('A story about a dragon');
    expect(result.lockedFieldPaths).toEqual([]);
    expect(fake.current?.currentVersionId).toBe('v2');
    expect(fake.versions.get('v2')?.version).toBe(2);
    expect(fake.versions.get('v2')?.createdBy).toBe('user');
  });

  it('performs a successful structured update (set-structured /targetLength)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    const result = updateCreationContractByUser(makeDeps(fake), {
      projectId: 'p1',
      expectedContractVersion: 1,
      operations: [
        { kind: 'set-structured', path: '/targetLength', value: { unit: 'words', value: 50000 } },
      ],
      now: '2026-01-02T00:00:00Z',
      newVersionId: 'v2',
    });

    expect(result.sections.targetLength).toEqual({ unit: 'words', value: 50000 });
    expect(fake.current?.currentVersionId).toBe('v2');
  });

  it('performs a successful entity upsert (upsert-supporting-character)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    const result = updateCreationContractByUser(makeDeps(fake), {
      projectId: 'p1',
      expectedContractVersion: 1,
      operations: [
        {
          kind: 'upsert-supporting-character',
          target: createCharacterKey('alice'),
          value: { characterKey: createCharacterKey('alice'), name: 'Alice' },
        },
      ],
      now: '2026-01-02T00:00:00Z',
      newVersionId: 'v2',
    });

    expect(result.sections.supportingCharacters).toEqual([
      { characterKey: 'alice', name: 'Alice' },
    ]);
  });

  it('performs a successful remove (remove-field /structure)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    const result = updateCreationContractByUser(makeDeps(fake), {
      projectId: 'p1',
      expectedContractVersion: 1,
      operations: [{ kind: 'remove-field', path: '/structure' }],
      now: '2026-01-02T00:00:00Z',
      newVersionId: 'v2',
    });

    expect(result.sections.structure).toBeUndefined();
  });

  it('rejects empty operations before entering the transaction', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('empty operations should throw');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as AppError).code).toBe('VALIDATION_ERROR');
    expect(fake.callbackEntered).toBe(false);
  });

  it('rejects semantic no-op (identical sections) with CONTRACT_VALIDATION_FAILED', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'A story about a hero' }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('no-op should throw');
    } catch (e) {
      error = e;
    }

    expectValidationError(error);
    expectNoSideEffects(fake);
  });

  it('rejects runtime parser failure before the transaction', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [
          { kind: 'bogus', path: '/premise', value: 1 },
        ] as unknown as ContractPatchOperation[],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('invalid operation should throw');
    } catch (e) {
      error = e;
    }

    expectValidationError(error);
    expect(fake.callbackEntered).toBe(false);
  });

  it('rejects stable protagonist key modification', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [
          {
            kind: 'upsert-protagonist',
            value: { characterKey: createCharacterKey('other'), name: 'Other' },
          },
        ],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('stable key change should throw');
    } catch (e) {
      error = e;
    }

    expectValidationError(error);
    expectNoSideEffects(fake);
  });

  it('rejects reference integrity violation (remove character still referenced)', () => {
    const fake = new FakeTransactionRepos();
    const sections = makeSections({
      supportingCharacters: [{ characterKey: 'alice', name: 'Alice' }],
      relationships: [
        {
          relationshipKey: 'rel1',
          fromCharacterKey: 'hero',
          toCharacterKey: 'alice',
          type: 'friend',
        },
      ],
    });
    seedCurrent(fake, { sections });

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'remove-character', target: createCharacterKey('alice') }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('dangling relationship should throw');
    } catch (e) {
      error = e;
    }

    expectValidationError(error);
    expectNoSideEffects(fake);
  });

  it('rejects lock exact conflict (op writes locked path)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { lockedFieldPaths: ['/premise'] });

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('locked path write should throw');
    } catch (e) {
      error = e;
    }

    expectLockConflict(error);
    expectNoSideEffects(fake);
  });

  it('rejects lock ancestor conflict (op writes ancestor of locked child)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { lockedFieldPaths: ['/protagonist/name'] });

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [
          {
            kind: 'upsert-protagonist',
            value: { characterKey: createCharacterKey('hero'), name: 'Hero v2' },
          },
        ],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('ancestor write should throw');
    } catch (e) {
      error = e;
    }

    expectLockConflict(error);
    expectNoSideEffects(fake);
  });

  it('rejects lock descendant conflict (op writes descendant of locked parent)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { lockedFieldPaths: ['/protagonist'] });

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/protagonist/name', value: 'Hero v2' }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('descendant write should throw');
    } catch (e) {
      error = e;
    }

    expectLockConflict(error);
    expectNoSideEffects(fake);
  });

  it('rejects stale expected version with CONTRACT_VERSION_CONFLICT', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { version: 3 });

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 2,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('stale version should throw');
    } catch (e) {
      error = e;
    }

    expectVersionConflict(error);
    expectNoSideEffects(fake);
  });

  it('rolls back the version create when current pointer CAS fails', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);
    fake.casUpdateFails = true;

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('CAS failure should throw');
    } catch (e) {
      error = e;
    }

    expectVersionConflict(error);
    // version v2 已被回滚，current 仍指向 v1
    expect(fake.createdVersionIds).toEqual([]);
    expect(fake.versions.has('v2')).toBe(false);
    expect(fake.current?.currentVersionId).toBe('v1');
    expect(fake.lockEvents).toEqual([]);
  });

  it('rejects no-current-contract with CONTRACT_VERSION_CONFLICT', () => {
    const fake = new FakeTransactionRepos();

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('missing current should throw');
    } catch (e) {
      error = e;
    }

    expectVersionConflict(error);
    // 无 current：没有任何写入
    expect(fake.createdVersionIds).toEqual([]);
    expect(fake.versions.size).toBe(0);
    expect(fake.current).toBeNull();
    expect(fake.lockEvents).toEqual([]);
  });

  it('throws INTERNAL_ERROR for corrupt current sections', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, {
      sectionsJson: '{not valid json',
      contractSnapshotHash: 'a'.repeat(64),
    });

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('corrupt sections should throw');
    } catch (e) {
      error = e;
    }

    expectCorruptionError(error);
    expectNoSideEffects(fake);
  });

  it('throws INTERNAL_ERROR for corrupt lockedFieldPaths', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, {
      lockedFieldPathsJson: '["/nope/deep/deep"]',
    });

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('corrupt locks should throw');
    } catch (e) {
      error = e;
    }

    expectCorruptionError(error);
    expectNoSideEffects(fake);
  });

  it('throws INTERNAL_ERROR for corrupt provenance', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, {
      provenanceJson: JSON.stringify([{ sectionKey: '/premise', source: 'BOGUS' }]),
    });

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('corrupt provenance should throw');
    } catch (e) {
      error = e;
    }

    expectCorruptionError(error);
    expectNoSideEffects(fake);
  });

  it('throws INTERNAL_ERROR for snapshot hash mismatch (corrupt current version)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, {
      contractSnapshotHash: 'b'.repeat(64), // 与真实重算不一致
    });

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('hash mismatch should throw');
    } catch (e) {
      error = e;
    }

    expectCorruptionError(error);
    expectNoSideEffects(fake);
  });

  it('throws INTERNAL_ERROR when Sha256Port returns invalid output (no side effects)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);
    // loader 对 current snapshot 返回合法 hash；其他输入（previousFieldHash/snapshot）返回非法值
    const currentSnapshot = canonicalSerializeContractSnapshot({
      sections: makeSections(),
      lockedFieldPaths: [],
      schemaVersion: 1,
    });
    const real = sha256Hex(currentSnapshot);
    const deps = {
      transactionPort: fake,
      sha256Port: {
        digestUtf8: (input: string) => (input === currentSnapshot ? real : 'not-a-hash'),
      },
    };

    let error: unknown;
    try {
      updateCreationContractByUser(deps, {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
        now: '2026-01-02T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('invalid sha output should throw');
    } catch (e) {
      error = e;
    }

    expectCorruptionError(error);
    expectNoSideEffects(fake);
  });

  it('generates USER_EDIT provenance with previousFieldHash from authoritative current value', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    const result = updateCreationContractByUser(makeDeps(fake), {
      projectId: 'p1',
      expectedContractVersion: 1,
      operations: [{ kind: 'set-scalar', path: '/premise', value: 'A story about a dragon' }],
      now: '2026-01-02T00:00:00Z',
      newVersionId: 'v2',
    });

    const premiseEntry = result.provenance.find((p) => p.sectionKey === '/premise');
    expect(premiseEntry?.source).toBe('USER_EDIT');
    expect(premiseEntry?.previousFieldHash).toBe(
      sha256Hex(canonicalSerializeContractFieldValue('A story about a hero')),
    );
    expect(premiseEntry?.rationale).toBeNull();
    // 未被编辑的字段不伪造为 USER_EDIT
    const genreEntry = result.provenance.find((p) => p.sectionKey === '/genre');
    expect(genreEntry?.source).toBe('PREVIOUS_VERSION');
  });

  it('carries forward PREVIOUS_VERSION provenance evidence for unchanged fields', () => {
    const fake = new FakeTransactionRepos();
    const provenanceOverrides = new Map<string, Partial<Record<string, unknown>>>();
    provenanceOverrides.set('/genre', {
      source: 'AI_PROPOSAL',
      grillAnswerIds: ['ans1'],
      grillProposalIds: ['gp1'],
      aiTaskId: 'task1',
      modelInvocationId: 'inv1',
      sourceProposalId: 'prop1',
    });
    seedCurrent(fake, { provenanceJson: makeProvenanceJson(makeSections(), provenanceOverrides) });

    const result = updateCreationContractByUser(makeDeps(fake), {
      projectId: 'p1',
      expectedContractVersion: 1,
      operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
      now: '2026-01-02T00:00:00Z',
      newVersionId: 'v2',
    });

    const genreEntry = result.provenance.find((p) => p.sectionKey === '/genre');
    expect(genreEntry?.source).toBe('PREVIOUS_VERSION');
    expect(genreEntry?.grillAnswerIds).toEqual(['ans1']);
    expect(genreEntry?.grillProposalIds).toEqual(['gp1']);
    expect(genreEntry?.aiTaskId).toBe('task1');
    expect(genreEntry?.modelInvocationId).toBe('inv1');
    expect(genreEntry?.sourceProposalId).toBe('prop1');
    expect(genreEntry?.previousFieldHash).toBeNull();
  });

  it('generates new-field USER_EDIT provenance with null previous hash and no fake AI evidence', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake); // protagonist 无 role

    const result = updateCreationContractByUser(makeDeps(fake), {
      projectId: 'p1',
      expectedContractVersion: 1,
      operations: [{ kind: 'set-scalar', path: '/protagonist/role', value: 'Chosen One' }],
      now: '2026-01-02T00:00:00Z',
      newVersionId: 'v2',
    });

    const roleEntry = result.provenance.find((p) => p.sectionKey === '/protagonist/role');
    expect(roleEntry?.source).toBe('USER_EDIT');
    expect(roleEntry?.previousFieldHash).toBeNull();
    expect(roleEntry?.sourceProposalId).toBeNull();
    expect(roleEntry?.aiTaskId).toBeNull();
    expect(roleEntry?.modelInvocationId).toBeNull();
    expect(roleEntry?.grillAnswerIds).toEqual([]);
    expect(roleEntry?.grillProposalIds).toEqual([]);
  });

  it('produces identical provenance JSON regardless of operation input order', () => {
    function runUpdate(operations: ContractPatchOperation[], versionId: string): string {
      const fake = new FakeTransactionRepos();
      seedCurrent(fake);
      const result = updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations,
        now: '2026-01-02T00:00:00Z',
        newVersionId: versionId,
      });
      return JSON.stringify(result.provenance);
    }

    const opA: ContractPatchOperation = {
      kind: 'set-scalar',
      path: '/premise',
      value: 'new premise',
    };
    const opB: ContractPatchOperation = {
      kind: 'set-scalar',
      path: '/targetAudience',
      value: 'young adults',
    };

    expect(runUpdate([opA, opB], 'v2')).toBe(runUpdate([opB, opA], 'v2'));
  });

  it('does not modify proposal or current DB on success (update never touches proposals)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    const result = updateCreationContractByUser(makeDeps(fake), {
      projectId: 'p1',
      expectedContractVersion: 1,
      operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
      now: '2026-01-02T00:00:00Z',
      newVersionId: 'v2',
    });

    expect(result.version).toBe(2);
    // proposal 保持原样（fake 中从未被读取或修改）
    expect(fake.proposalStatus).toBe('PROPOSED');
    // current pointer 更新到新版本，旧版本历史仍在
    expect(fake.current?.currentVersionId).toBe('v2');
    expect(fake.versions.has('v1')).toBe(true);
  });
});

// ── LockCreationContractField ────────────────────────────────

describe('lockCreationContractField', () => {
  const lockInput = (
    overrides?: Partial<LockCreationContractFieldInput>,
  ): LockCreationContractFieldInput => ({
    projectId: 'p1',
    expectedContractVersion: 1,
    fieldPath: '/premise',
    now: '2026-01-02T00:00:00Z',
    newVersionId: 'v2',
    lockEventId: 'le1',
    ...overrides,
  });

  it('locks an existing scalar field, creates version with createdBy=lock and LOCK event', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    const result = lockCreationContractField(makeDeps(fake), lockInput());

    expect(result.version).toBe(2);
    expect(result.createdBy).toBe('lock');
    expect(result.lockedFieldPaths).toEqual(['/premise']);
    expect(fake.current?.currentVersionId).toBe('v2');
    expect(fake.lockEvents).toHaveLength(1);
    expect(fake.lockEvents[0]).toMatchObject({
      id: 'le1',
      projectId: 'p1',
      fieldPath: '/premise',
      action: 'LOCK',
      versionId: 'v2',
      createdAt: '2026-01-02T00:00:00Z',
      createdBy: 'user',
    });
  });

  it('locks an absent fixed optional top-level section (/themes)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake); // 无 themes

    const result = lockCreationContractField(makeDeps(fake), lockInput({ fieldPath: '/themes' }));

    expect(result.lockedFieldPaths).toEqual(['/themes']);
    expect(fake.lockEvents[0]?.fieldPath).toBe('/themes');
  });

  it('locks an absent protagonist optional child (/protagonist/role)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake); // protagonist 无 role

    const result = lockCreationContractField(
      makeDeps(fake),
      lockInput({ fieldPath: '/protagonist/role' }) as Parameters<
        typeof lockCreationContractField
      >[1],
    );

    expect(result.lockedFieldPaths).toEqual(['/protagonist/role']);
  });

  it('locks an absent optional child of an existing collection entity', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { sections: SECTIONS_WITH_ALICE }); // alice 存在、role 缺失

    const result = lockCreationContractField(
      makeDeps(fake),
      lockInput({ fieldPath: '/supportingCharacters/alice/role' }) as Parameters<
        typeof lockCreationContractField
      >[1],
    );

    expect(result.lockedFieldPaths).toEqual(['/supportingCharacters/alice/role']);
  });

  it('rejects locking a descendant of a missing entity', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake); // 无 alice

    let error: unknown;
    try {
      lockCreationContractField(
        makeDeps(fake),
        lockInput({ fieldPath: '/supportingCharacters/alice/role' }) as Parameters<
          typeof lockCreationContractField
        >[1],
      );
      expect.unreachable('missing entity descendant should throw');
    } catch (e) {
      error = e;
    }

    expectValidationError(error);
    expectNoSideEffects(fake);
  });

  it('rejects locking a child of a missing structured parent (/targetLength/value)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake); // 无 targetLength

    let error: unknown;
    try {
      lockCreationContractField(
        makeDeps(fake),
        lockInput({ fieldPath: '/targetLength/value' }) as Parameters<
          typeof lockCreationContractField
        >[1],
      );
      expect.unreachable('missing structured parent child should throw');
    } catch (e) {
      error = e;
    }

    expectValidationError(error);
    expectNoSideEffects(fake);
  });

  it('rejects an exact duplicate lock with CONTRACT_LOCK_CONFLICT', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { lockedFieldPaths: ['/premise'] });

    let error: unknown;
    try {
      lockCreationContractField(makeDeps(fake), lockInput());
      expect.unreachable('duplicate lock should throw');
    } catch (e) {
      error = e;
    }

    expectLockConflict(error);
    expectNoSideEffects(fake);
  });

  it('rejects parent overlap (lock parent of existing lock)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { lockedFieldPaths: ['/protagonist/name'] });

    let error: unknown;
    try {
      lockCreationContractField(makeDeps(fake), lockInput({ fieldPath: '/protagonist' }));
      expect.unreachable('parent overlap should throw');
    } catch (e) {
      error = e;
    }

    expectLockConflict(error);
    expectNoSideEffects(fake);
  });

  it('rejects child overlap (lock child of existing lock)', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { lockedFieldPaths: ['/protagonist'] });

    let error: unknown;
    try {
      lockCreationContractField(
        makeDeps(fake),
        lockInput({ fieldPath: '/protagonist/name' }) as Parameters<
          typeof lockCreationContractField
        >[1],
      );
      expect.unreachable('child overlap should throw');
    } catch (e) {
      error = e;
    }

    expectLockConflict(error);
    expectNoSideEffects(fake);
  });

  it('rejects a non-canonical path', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    let error: unknown;
    try {
      lockCreationContractField(makeDeps(fake), lockInput({ fieldPath: '/Premise' }));
      expect.unreachable('non-canonical path should throw');
    } catch (e) {
      error = e;
    }

    expectValidationError(error);
    expectNoSideEffects(fake);
  });

  it('rejects an unknown path', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    let error: unknown;
    try {
      lockCreationContractField(makeDeps(fake), lockInput({ fieldPath: '/nonexistent' }));
      expect.unreachable('unknown path should throw');
    } catch (e) {
      error = e;
    }

    expectValidationError(error);
    expectNoSideEffects(fake);
  });

  it('keeps sections and provenance byte-identical and changes snapshot hash', () => {
    const fake = new FakeTransactionRepos();
    const base = makeVersionData();
    seedCurrent(fake, {}); // 与 base 相同的默认 sections/locks

    const result = lockCreationContractField(makeDeps(fake), lockInput());

    const newVersion = fake.versions.get('v2')!;
    expect(newVersion.sectionsJson).toBe(base.sectionsJson);
    expect(newVersion.provenanceJson).toBe(base.provenanceJson);
    expect(newVersion.contractSnapshotHash).not.toBe(base.contractSnapshotHash);
    expect(result.contractSnapshotHash).not.toBe(base.contractSnapshotHash);
  });

  it('rejects stale expected version with CONTRACT_VERSION_CONFLICT', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { version: 3 });

    let error: unknown;
    try {
      lockCreationContractField(
        makeDeps(fake),
        lockInput({ expectedContractVersion: 2 }) as Parameters<
          typeof lockCreationContractField
        >[1],
      );
      expect.unreachable('stale version should throw');
    } catch (e) {
      error = e;
    }

    expectVersionConflict(error);
    expectNoSideEffects(fake);
  });
});

// ── UnlockCreationContractField ──────────────────────────────

describe('unlockCreationContractField', () => {
  const unlockInput = (
    overrides?: Partial<UnlockCreationContractFieldInput>,
  ): UnlockCreationContractFieldInput => ({
    projectId: 'p1',
    expectedContractVersion: 1,
    fieldPath: '/premise',
    now: '2026-01-02T00:00:00Z',
    newVersionId: 'v2',
    lockEventId: 'le1',
    ...overrides,
  });

  it('unlocks an exact path, creating version with createdBy=unlock and UNLOCK event', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { lockedFieldPaths: ['/premise'] });

    const result = unlockCreationContractField(makeDeps(fake), unlockInput());

    expect(result.version).toBe(2);
    expect(result.createdBy).toBe('unlock');
    expect(result.lockedFieldPaths).toEqual([]);
    expect(fake.current?.currentVersionId).toBe('v2');
    expect(fake.lockEvents).toHaveLength(1);
    expect(fake.lockEvents[0]).toMatchObject({
      id: 'le1',
      projectId: 'p1',
      fieldPath: '/premise',
      action: 'UNLOCK',
      versionId: 'v2',
      createdAt: '2026-01-02T00:00:00Z',
      createdBy: 'user',
    });
  });

  it('rejects unlock of a path that is not locked', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    let error: unknown;
    try {
      unlockCreationContractField(makeDeps(fake), unlockInput());
      expect.unreachable('not locked should throw');
    } catch (e) {
      error = e;
    }

    expectLockConflict(error);
    expectNoSideEffects(fake);
  });

  it('rejects parent path as substitute for exact unlock', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { lockedFieldPaths: ['/protagonist/name'] });

    let error: unknown;
    try {
      unlockCreationContractField(
        makeDeps(fake),
        unlockInput({ fieldPath: '/protagonist' }) as Parameters<
          typeof unlockCreationContractField
        >[1],
      );
      expect.unreachable('parent path should throw');
    } catch (e) {
      error = e;
    }

    expectLockConflict(error);
    expectNoSideEffects(fake);
  });

  it('rejects child path as substitute for exact unlock', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { lockedFieldPaths: ['/protagonist'] });

    let error: unknown;
    try {
      unlockCreationContractField(
        makeDeps(fake),
        unlockInput({ fieldPath: '/protagonist/name' }) as Parameters<
          typeof unlockCreationContractField
        >[1],
      );
      expect.unreachable('child path should throw');
    } catch (e) {
      error = e;
    }

    expectLockConflict(error);
    expectNoSideEffects(fake);
  });

  it('clears the last lock to []', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { lockedFieldPaths: ['/premise'] });

    const result = unlockCreationContractField(makeDeps(fake), unlockInput());

    expect(result.lockedFieldPaths).toEqual([]);
    expect(fake.versions.get('v2')?.lockedFieldPathsJson).toBe('[]');
  });

  it('keeps sections and provenance byte-identical and changes snapshot hash', () => {
    const fake = new FakeTransactionRepos();
    const base = makeVersionData({ lockedFieldPaths: ['/premise'] });
    seedCurrent(fake, { lockedFieldPaths: ['/premise'] });

    const result = unlockCreationContractField(makeDeps(fake), unlockInput());

    const newVersion = fake.versions.get('v2')!;
    expect(newVersion.sectionsJson).toBe(base.sectionsJson);
    expect(newVersion.provenanceJson).toBe(base.provenanceJson);
    expect(newVersion.contractSnapshotHash).not.toBe(base.contractSnapshotHash);
    expect(result.contractSnapshotHash).not.toBe(base.contractSnapshotHash);
  });

  it('rejects stale expected version with CONTRACT_VERSION_CONFLICT', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake, { version: 3, lockedFieldPaths: ['/premise'] });

    let error: unknown;
    try {
      unlockCreationContractField(
        makeDeps(fake),
        unlockInput({ expectedContractVersion: 2 }) as Parameters<
          typeof unlockCreationContractField
        >[1],
      );
      expect.unreachable('stale version should throw');
    } catch (e) {
      error = e;
    }

    expectVersionConflict(error);
    expectNoSideEffects(fake);
  });
});

// ── 共用输入验证 ─────────────────────────────────────────────

describe('user mutation input validation', () => {
  it('rejects lock input when newVersionId equals lockEventId', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    let error: unknown;
    try {
      lockCreationContractField(makeDeps(fake), {
        ...lockInputStub(),
        newVersionId: 'le1',
        lockEventId: 'le1',
      });
      expect.unreachable('same ids should throw');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as AppError).code).toBe('VALIDATION_ERROR');
    expect(fake.callbackEntered).toBe(false);
  });

  it('rejects invalid now timestamp before entering transaction', () => {
    const fake = new FakeTransactionRepos();
    seedCurrent(fake);

    let error: unknown;
    try {
      updateCreationContractByUser(makeDeps(fake), {
        projectId: 'p1',
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'changed' }],
        now: '2026-02-29T00:00:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('invalid timestamp should throw');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as AppError).code).toBe('VALIDATION_ERROR');
    expect(fake.callbackEntered).toBe(false);
  });
});

function lockInputStub(): LockCreationContractFieldInput {
  return {
    projectId: 'p1',
    expectedContractVersion: 1,
    fieldPath: '/premise',
    now: '2026-01-02T00:00:00Z',
    newVersionId: 'v2',
    lockEventId: 'le1',
  };
}
