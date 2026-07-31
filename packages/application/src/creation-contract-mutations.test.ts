/**
 * 创作契约 Accept/Reject 应用层 fake-port 测试。
 *
 * 使用 fake transaction port（带快照回滚语义）+ fake 仓库，
 * 验证 Application port 边界独立安全：
 *   - previous version provenance 损坏 → ContractDataCorruptionError（固定安全消息）
 *   - 损坏时 proposal CAS 回滚，version/current/lock-events 不变
 *   - now 严格 ISO-8601 验证（拒绝日历溢出、非法分量；非法输入不进入事务）
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  validateCreationContractSections,
  canonicalSerializeContractSections,
  canonicalSerializeContractSnapshot,
  codePointCompare,
  createCharacterKey,
  type CreationContractSections,
  type ContractPatchOperation,
} from '@ai-novel/domain';
import {
  acceptCreationContractProposal,
  rejectCreationContractProposal,
  collectAllFieldPaths,
  type CreationContractMutationDeps,
} from './creation-contract-mutations.js';
import { updateCreationContractByUser } from './creation-contract-user-mutations.js';
import type {
  CreationContractTransactionRepositories,
  AcceptCreationContractProposalInput,
  RejectCreationContractProposalInput,
  CreationContractProposalData,
  CreationContractVersionData,
  CreationContractCurrentData,
  CreationContractLockEventData,
  ProjectExistsReadPort,
  GrillSessionVersionReadPort,
  CreationContractProposalRepositoryPort,
  CreationContractVersionRepositoryPort,
  CreationContractCurrentRepositoryPort,
  CreationContractLockEventRepositoryPort,
} from './creation-contract-types.js';
import { AppError, ContractDataCorruptionError, ValidationError } from './errors.js';
import { parseProvenanceArray, validateIso8601Timestamp } from './creation-contract-validation.js';

// ── 测试数据 ─────────────────────────────────────────────────

const SECTIONS_JSON = canonicalSerializeContractSections(
  validateCreationContractSections({
    premise: 'A story about a hero',
    genre: ['fantasy'],
    tone: ['epic'],
    targetAudience: 'adults',
    narrativePov: 'THIRD_LIMITED',
    tense: 'PAST',
    protagonist: { characterKey: 'hero', name: 'Hero' },
  }),
);
const HASH_A = 'a'.repeat(64);

const VALID_PROVENANCE_ENTRY = {
  sectionKey: '/premise',
  source: 'DEFAULT',
  grillAnswerIds: [],
  grillProposalIds: [],
  aiTaskId: null,
  modelInvocationId: null,
  sourceProposalId: null,
  previousFieldHash: null,
  rationale: null,
};

function makeProposal(
  overrides?: Partial<CreationContractProposalData>,
): CreationContractProposalData {
  return {
    id: 'prop2',
    projectId: 'p1',
    taskId: 'task1',
    invocationId: 'inv1',
    status: 'PROPOSED',
    baseGrillSessionId: 'gs1',
    baseGrillSessionVersion: 1,
    baseContractVersion: 1,
    schemaVersion: 1,
    sectionsJson: SECTIONS_JSON,
    sectionsHash: HASH_A,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makePreviousVersion(provenanceJson: string): CreationContractVersionData {
  return {
    id: 'v1',
    projectId: 'p1',
    version: 1,
    schemaVersion: 1,
    sourceProposalId: 'prop1',
    basedOnGrillSessionId: 'gs1',
    basedOnGrillSessionVersion: 1,
    sectionsJson: SECTIONS_JSON,
    lockedFieldPathsJson: '[]',
    contractSnapshotHash: HASH_A,
    provenanceJson,
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'ai-proposal-accepted',
  };
}

function makeAcceptInput(
  overrides?: Partial<AcceptCreationContractProposalInput>,
): AcceptCreationContractProposalInput {
  return {
    projectId: 'p1',
    proposalId: 'prop2',
    expectedProposalSectionsHash: HASH_A,
    expectedGrillSessionVersion: 1,
    expectedContractVersion: 1,
    operations: [],
    now: '2026-01-02T00:00:00Z',
    newVersionId: 'v2',
    ...overrides,
  };
}

function makeRejectInput(
  overrides?: Partial<RejectCreationContractProposalInput>,
): RejectCreationContractProposalInput {
  return {
    projectId: 'p1',
    proposalId: 'prop2',
    expectedProposalSectionsHash: HASH_A,
    now: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

// ── Fake 事务仓库（快照回滚语义） ─────────────────────────────

interface FakeState {
  proposal: CreationContractProposalData | null;
  versions: Map<string, CreationContractVersionData>;
  current: CreationContractCurrentData | null;
  lockEvents: CreationContractLockEventData[];
  createdVersionIds: string[];
}

/**
 * 既是事务端口又是事务内仓库集合。
 * runInTransaction 在回调抛错时快照回滚，模拟真实事务适配器的回滚语义。
 */
class FakeTransactionRepos implements CreationContractTransactionRepositories {
  proposal: CreationContractProposalData | null = null;
  versions = new Map<string, CreationContractVersionData>();
  current: CreationContractCurrentData | null = null;
  lockEvents: CreationContractLockEventData[] = [];
  createdVersionIds: string[] = [];
  callbackEntered = false;

  readonly projectExistsReadPort: ProjectExistsReadPort = { exists: () => true };
  readonly grillSessionVersionReadPort: GrillSessionVersionReadPort = { getVersion: () => 1 };

  readonly proposalRepo: CreationContractProposalRepositoryPort = {
    create: () => {},
    getById: () => this.proposal,
    listByProject: () => (this.proposal ? [this.proposal] : []),
    listByGrillSession: () => [],
    transitionStatus: () => false,
    transitionStatusWithHash: (_p, _id, expectedStatus, _hash, newStatus, now) => {
      if (!this.proposal || this.proposal.status !== expectedStatus) return false;
      this.proposal = { ...this.proposal, status: newStatus, updatedAt: now };
      return true;
    },
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
    casUpdate: (projectId, _expected, versionId, now) => {
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

  runInTransaction<T>(operation: (repos: CreationContractTransactionRepositories) => T): T {
    this.callbackEntered = true;
    const snapshot: FakeState = {
      proposal: this.proposal,
      versions: new Map(this.versions),
      current: this.current,
      lockEvents: [...this.lockEvents],
      createdVersionIds: [...this.createdVersionIds],
    };
    try {
      return operation(this);
    } catch (e) {
      this.proposal = snapshot.proposal;
      this.versions = snapshot.versions;
      this.current = snapshot.current;
      this.lockEvents = snapshot.lockEvents;
      this.createdVersionIds = snapshot.createdVersionIds;
      throw e;
    }
  }
}

function makeDeps(fake: FakeTransactionRepos): CreationContractMutationDeps {
  return { transactionPort: fake, sha256Port: { digestUtf8: () => HASH_A } };
}

function expectCorruptionError(e: unknown): void {
  expect(e).toBeInstanceOf(ContractDataCorruptionError);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe('INTERNAL_ERROR');
  expect((e as Error).message).toBe('创作契约数据完整性异常');
}

function expectNoSideEffects(fake: FakeTransactionRepos): void {
  // proposal CAS rollback
  expect(fake.proposal?.status).toBe('PROPOSED');
  // version/current/lock-events 不变
  expect(fake.createdVersionIds).toEqual([]);
  expect(fake.versions.has('v2')).toBe(false);
  expect(fake.current?.currentVersionId).toBe('v1');
  expect(fake.lockEvents).toEqual([]);
}

// ── Provenance 损坏（fake ports，不依赖 SQLite 仓库校验） ──────

describe('acceptCreationContractProposal provenance corruption (fake ports)', () => {
  const PROVENANCE_JSON_CASES: ReadonlyArray<{ name: string; provenanceJson: string }> = [
    {
      name: 'invalid source',
      provenanceJson: JSON.stringify([{ ...VALID_PROVENANCE_ENTRY, source: 'BOGUS' }]),
    },
    {
      name: 'missing field',
      provenanceJson: JSON.stringify([{ ...VALID_PROVENANCE_ENTRY, rationale: undefined }]),
    },
    {
      name: 'extra field',
      provenanceJson: JSON.stringify([{ ...VALID_PROVENANCE_ENTRY, bogus: 1 }]),
    },
    {
      name: 'invalid grillAnswerIds item',
      provenanceJson: JSON.stringify([{ ...VALID_PROVENANCE_ENTRY, grillAnswerIds: [42] }]),
    },
    {
      name: 'invalid nullable ID',
      provenanceJson: JSON.stringify([{ ...VALID_PROVENANCE_ENTRY, aiTaskId: 42 }]),
    },
    {
      name: 'invalid previousFieldHash',
      provenanceJson: JSON.stringify([
        { ...VALID_PROVENANCE_ENTRY, previousFieldHash: 'NOT_A_HASH' },
      ]),
    },
    {
      name: 'invalid non-canonical sectionKey',
      provenanceJson: JSON.stringify([{ ...VALID_PROVENANCE_ENTRY, sectionKey: '/premise/extra' }]),
    },
    {
      name: 'unsorted provenance entries',
      // '/genre' < '/premise' by code point；此数组降序 → 非 canonical 排序
      provenanceJson: JSON.stringify([
        VALID_PROVENANCE_ENTRY,
        { ...VALID_PROVENANCE_ENTRY, sectionKey: '/genre' },
      ]),
    },
    {
      name: 'duplicate sectionKey',
      provenanceJson: JSON.stringify([VALID_PROVENANCE_ENTRY, VALID_PROVENANCE_ENTRY]),
    },
  ];

  it.each(PROVENANCE_JSON_CASES.map((c) => [c.name, c.provenanceJson]))(
    'rejects %s with fixed safe message and rolls back side effects',
    (_name, provenanceJson) => {
      const fake = new FakeTransactionRepos();
      fake.proposal = makeProposal();
      fake.versions.set('v1', makePreviousVersion(provenanceJson as string));
      fake.current = { projectId: 'p1', currentVersionId: 'v1', updatedAt: '2026-01-01T00:00:00Z' };

      try {
        acceptCreationContractProposal(makeDeps(fake), makeAcceptInput());
        expect.unreachable('corrupt provenance should throw');
      } catch (e) {
        expectCorruptionError(e);
      }

      expectNoSideEffects(fake);
    },
  );

  it('accepts canonical sorted previous provenance and carries forward', () => {
    const fake = new FakeTransactionRepos();
    fake.proposal = makeProposal();
    // 按 code point 排序的 canonical provenance（'/genre' 在 '/premise' 前）
    fake.versions.set(
      'v1',
      makePreviousVersion(
        JSON.stringify([
          { ...VALID_PROVENANCE_ENTRY, sectionKey: '/genre' },
          VALID_PROVENANCE_ENTRY,
        ]),
      ),
    );
    fake.current = { projectId: 'p1', currentVersionId: 'v1', updatedAt: '2026-01-01T00:00:00Z' };

    const result = acceptCreationContractProposal(makeDeps(fake), makeAcceptInput());
    expect(result.version).toBe(2);
    expect(fake.proposal?.status).toBe('ACCEPTED');
  });
});

// ── ISO-8601 严格时间戳验证 ───────────────────────────────────

const INVALID_TIMESTAMPS = [
  '2026-02-29T00:00:00Z', // 2026 非闰年
  '2026-04-31T00:00:00Z', // 4 月只有 30 天
  '2026-01-01T24:00:00Z', // hour 越界
  '2026-01-01T00:60:00Z', // minute 越界
  '2026-01-01T00:00:60Z', // second 越界
  '2026-01-01T00:00:00+24:00', // offset hour 越界
  '2026-01-01T00:00:00+08:60', // offset minute 越界
  '2026-01-01T00:00:00-12:01', // 负 offset 低于 -12:00 下界
  '2026-01-01T00:00:00-12:59', // 负 offset 低于 -12:00 下界
  '2026-01-01T00:00:00+14:01', // 正 offset 高于 +14:00 上界
];

const VALID_TIMESTAMPS = [
  '2028-02-29T00:00:00Z', // 2028 闰年
  '2026-01-01T23:59:59Z',
  '2026-01-01T12:34:56.123+08:00',
  '2026-01-01T00:00:00-12:00', // 负 offset 下界（含边界）
  '2026-01-01T00:00:00-11:59', // 负 offset 下界内
  '2026-01-01T00:00:00+14:00', // 正 offset 上界（含边界）
  '2026-01-01T00:00:00+13:59', // 正 offset 上界内
];

describe('acceptCreationContractProposal ISO-8601 validation', () => {
  it.each(INVALID_TIMESTAMPS)('rejects %s before entering transaction', (now) => {
    const fake = new FakeTransactionRepos();
    fake.proposal = makeProposal({ baseContractVersion: null });

    let error: unknown;
    try {
      acceptCreationContractProposal(
        makeDeps(fake),
        makeAcceptInput({ now, expectedContractVersion: null }),
      );
      expect.unreachable('invalid timestamp should throw');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VALIDATION_ERROR');
    expect((error as Error).message).toContain('now');
    // 不得进入 transaction callback
    expect(fake.callbackEntered).toBe(false);
  });

  it.each(VALID_TIMESTAMPS)('accepts %s and completes accept', (now) => {
    const fake = new FakeTransactionRepos();
    fake.proposal = makeProposal({ baseContractVersion: null });

    const result = acceptCreationContractProposal(
      makeDeps(fake),
      makeAcceptInput({ now, expectedContractVersion: null }),
    );

    expect(result.version).toBe(1);
    expect(fake.callbackEntered).toBe(true);
    expect(fake.proposal?.status).toBe('ACCEPTED');
    expect(fake.current?.currentVersionId).toBe('v2');
  });
});

describe('rejectCreationContractProposal ISO-8601 validation', () => {
  it.each(INVALID_TIMESTAMPS)('rejects %s before entering transaction', (now) => {
    const fake = new FakeTransactionRepos();
    fake.proposal = makeProposal();

    let error: unknown;
    try {
      rejectCreationContractProposal(makeDeps(fake), makeRejectInput({ now }));
      expect.unreachable('invalid timestamp should throw');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VALIDATION_ERROR');
    expect((error as Error).message).toContain('now');
    expect(fake.callbackEntered).toBe(false);
  });

  it.each(VALID_TIMESTAMPS)('accepts %s and completes reject', (now) => {
    const fake = new FakeTransactionRepos();
    fake.proposal = makeProposal();

    const result = rejectCreationContractProposal(makeDeps(fake), makeRejectInput({ now }));

    expect(result.status).toBe('REJECTED');
    expect(fake.callbackEntered).toBe(true);
    expect(fake.proposal?.status).toBe('REJECTED');
  });
});

// ── 共享 parser 直接单元测试 ───────────────────────────────────

describe('parseProvenanceArray (shared parser)', () => {
  it('parses canonical sorted provenance', () => {
    const result = parseProvenanceArray(
      JSON.stringify([{ ...VALID_PROVENANCE_ENTRY, sectionKey: '/genre' }, VALID_PROVENANCE_ENTRY]),
      'test',
    );
    expect(result).toHaveLength(2);
    expect(result[0].sectionKey).toBe('/genre');
    expect(result[1].sectionKey).toBe('/premise');
  });

  it('accepts empty provenance array', () => {
    expect(parseProvenanceArray('[]', 'test')).toEqual([]);
  });

  it('rejects non-array JSON with ContractDataCorruptionError', () => {
    expect(() => parseProvenanceArray('{}', 'test')).toThrow(ContractDataCorruptionError);
  });

  it('rejects non-canonical key ordering', () => {
    // 反转 key 顺序（JSON key 顺序与 canonical 不一致）
    const reversed = Object.fromEntries(Object.entries({ ...VALID_PROVENANCE_ENTRY }).reverse());
    try {
      parseProvenanceArray(JSON.stringify([reversed]), 'test');
      expect.unreachable('non-canonical key order should throw');
    } catch (e) {
      expectCorruptionError(e);
    }
  });
});

describe('validateIso8601Timestamp (shared strict validator)', () => {
  it.each(INVALID_TIMESTAMPS)('rejects %s', (value) => {
    expect(() => validateIso8601Timestamp(value, 'now')).toThrow(ValidationError);
  });

  it.each(VALID_TIMESTAMPS)('accepts %s', (value) => {
    expect(validateIso8601Timestamp(value, 'now')).toBe(value);
  });
});

// ── Directional provenance write-set（Accept review 回归）──────

describe('acceptCreationContractProposal directional provenance write-set', () => {
  const realSha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

  function makeSections(overrides?: Record<string, unknown>): CreationContractSections {
    return validateCreationContractSections({
      premise: 'A story about a hero',
      genre: ['fantasy'],
      tone: ['epic'],
      targetAudience: 'adults',
      narrativePov: 'THIRD_LIMITED',
      tense: 'PAST',
      protagonist: { characterKey: 'hero', name: 'Hero' },
      ...overrides,
    });
  }

  function makeCanonicalProvenanceJson(sections: CreationContractSections): string {
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
      })),
    );
  }

  function makeBaselineVersion(sections: CreationContractSections): CreationContractVersionData {
    return {
      id: 'v1',
      projectId: 'p1',
      version: 1,
      schemaVersion: 1,
      sourceProposalId: 'prop1',
      basedOnGrillSessionId: 'gs1',
      basedOnGrillSessionVersion: 1,
      sectionsJson: canonicalSerializeContractSections(sections),
      lockedFieldPathsJson: '[]',
      contractSnapshotHash: realSha256(
        canonicalSerializeContractSnapshot({ sections, lockedFieldPaths: [], schemaVersion: 1 }),
      ),
      provenanceJson: makeCanonicalProvenanceJson(sections),
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'ai-proposal-accepted',
    };
  }

  function makeRealDeps(fake: FakeTransactionRepos): CreationContractMutationDeps {
    return { transactionPort: fake, sha256Port: { digestUtf8: realSha256 } };
  }

  function runAcceptProvenance(opts: {
    baselineSections: CreationContractSections;
    proposalSections: CreationContractSections;
    operations: ReadonlyArray<ContractPatchOperation>;
  }): ReturnType<typeof acceptCreationContractProposal> {
    const fake = new FakeTransactionRepos();
    const proposalSectionsJson = canonicalSerializeContractSections(opts.proposalSections);
    fake.versions.set('v1', makeBaselineVersion(opts.baselineSections));
    fake.current = { projectId: 'p1', currentVersionId: 'v1', updatedAt: '2026-01-01T00:00:00Z' };
    fake.proposal = makeProposal({
      sectionsJson: proposalSectionsJson,
      sectionsHash: realSha256(proposalSectionsJson),
    });
    return acceptCreationContractProposal(makeRealDeps(fake), {
      ...makeAcceptInput(),
      expectedProposalSectionsHash: realSha256(proposalSectionsJson),
      operations: opts.operations,
    });
  }

  it('scalar child review does not mark the structured parent as USER_EDIT', () => {
    const sections = makeSections({
      protagonist: { characterKey: 'hero', name: 'Hero', role: 'Chosen' },
    });
    const result = runAcceptProvenance({
      baselineSections: sections,
      proposalSections: sections,
      operations: [{ kind: 'set-scalar', path: '/protagonist/name', value: 'Hero v2' }],
    });
    const entries = new Map(result.provenance.map((p) => [p.sectionKey, p.source]));
    expect(entries.get('/protagonist/name')).toBe('USER_EDIT');
    expect(entries.get('/protagonist')).toBe('PREVIOUS_VERSION');
    expect(entries.get('/protagonist/role')).toBe('PREVIOUS_VERSION');
    expect(entries.get('/protagonist/characterKey')).toBe('PREVIOUS_VERSION');
  });

  it('supporting-character child review does not mark entity or collection parent as USER_EDIT', () => {
    const sections = makeSections({
      supportingCharacters: [{ characterKey: 'alice', name: 'Alice', role: 'Sidekick' }],
    });
    const result = runAcceptProvenance({
      baselineSections: sections,
      proposalSections: sections,
      operations: [
        { kind: 'set-scalar', path: '/supportingCharacters/alice/name', value: 'Alice v2' },
      ],
    });
    const entries = new Map(result.provenance.map((p) => [p.sectionKey, p.source]));
    expect(entries.get('/supportingCharacters/alice/name')).toBe('USER_EDIT');
    expect(entries.get('/supportingCharacters/alice/role')).toBe('PREVIOUS_VERSION');
    expect(entries.get('/supportingCharacters')).toBe('PREVIOUS_VERSION');
  });

  it('set-structured review marks target and descendants as USER_EDIT', () => {
    const sections = makeSections();
    const result = runAcceptProvenance({
      baselineSections: sections,
      proposalSections: sections,
      operations: [
        { kind: 'set-structured', path: '/targetLength', value: { unit: 'words', value: 50000 } },
      ],
    });
    const entries = new Map(result.provenance.map((p) => [p.sectionKey, p.source]));
    expect(entries.get('/targetLength')).toBe('USER_EDIT');
    expect(entries.get('/targetLength/unit')).toBe('USER_EDIT');
    expect(entries.get('/targetLength/value')).toBe('USER_EDIT');
    // 无关 ancestor/sibling 不变
    expect(entries.get('/premise')).toBe('PREVIOUS_VERSION');
  });

  it('upsert-protagonist review marks target and emitted descendants as USER_EDIT', () => {
    const sections = makeSections({
      protagonist: { characterKey: 'hero', name: 'Hero', role: 'Chosen' },
    });
    const result = runAcceptProvenance({
      baselineSections: sections,
      proposalSections: sections,
      operations: [
        {
          kind: 'upsert-protagonist',
          value: { characterKey: createCharacterKey('hero'), name: 'Hero v2', role: 'Chosen' },
        },
      ],
    });
    const entries = new Map(result.provenance.map((p) => [p.sectionKey, p.source]));
    expect(entries.get('/protagonist')).toBe('USER_EDIT');
    expect(entries.get('/protagonist/name')).toBe('USER_EDIT');
    expect(entries.get('/protagonist/role')).toBe('USER_EDIT');
    expect(entries.get('/protagonist/characterKey')).toBe('USER_EDIT');
    expect(entries.get('/premise')).toBe('PREVIOUS_VERSION');
  });

  it('upsert-supporting-character review marks entity descendants, not the collection parent', () => {
    const sections = makeSections({
      supportingCharacters: [{ characterKey: 'alice', name: 'Alice', role: 'Sidekick' }],
    });
    const result = runAcceptProvenance({
      baselineSections: sections,
      proposalSections: sections,
      operations: [
        {
          kind: 'upsert-supporting-character',
          target: createCharacterKey('alice'),
          value: {
            characterKey: createCharacterKey('alice'),
            name: 'Alice v2',
            role: 'Sidekick v2',
          },
        },
      ],
    });
    const entries = new Map(result.provenance.map((p) => [p.sectionKey, p.source]));
    expect(entries.get('/supportingCharacters/alice/name')).toBe('USER_EDIT');
    expect(entries.get('/supportingCharacters/alice/role')).toBe('USER_EDIT');
    // collection parent 不得标为 USER_EDIT；
    // 不断言 entity-container entry（当前 collectAllFieldPaths 不生成该 entry，模型不扩）
    expect(entries.get('/supportingCharacters')).toBe('PREVIOUS_VERSION');
  });

  it('AI_PROPOSAL and USER_EDIT mix without mislabeling the ancestor', () => {
    const baseline = makeSections(); // protagonist {key:'hero', name:'Hero'}，无 role
    const proposal = makeSections({
      protagonist: { characterKey: 'hero', name: 'Hero', role: 'Chosen' },
    }); // AI 改了 role
    const result = runAcceptProvenance({
      baselineSections: baseline,
      proposalSections: proposal,
      operations: [{ kind: 'set-scalar', path: '/protagonist/name', value: 'Hero v2' }],
    });
    const entries = new Map(result.provenance.map((p) => [p.sectionKey, p.source]));
    expect(entries.get('/protagonist/name')).toBe('USER_EDIT');
    expect(entries.get('/protagonist/role')).toBe('AI_PROPOSAL');
    // /protagonist 是 ancestor，不得因 name review 被误标为 USER_EDIT
    expect(entries.get('/protagonist')).toBe('AI_PROPOSAL');
    expect(entries.get('/protagonist/characterKey')).toBe('PREVIOUS_VERSION');
  });

  it('remove review produces no tombstone and does not mark ancestors as USER_EDIT', () => {
    const sections = makeSections({
      protagonist: { characterKey: 'hero', name: 'Hero', role: 'Chosen' },
    });
    const result = runAcceptProvenance({
      baselineSections: sections,
      proposalSections: sections,
      operations: [{ kind: 'remove-field', path: '/protagonist/role' }],
    });
    expect(result.provenance.some((p) => p.sectionKey === '/protagonist/role')).toBe(false);
    const protagonistEntry = result.provenance.find((p) => p.sectionKey === '/protagonist');
    expect(protagonistEntry?.source).toBe('PREVIOUS_VERSION');
  });

  it('identical provenance JSON regardless of review operation input order', () => {
    function run(operations: ReadonlyArray<ContractPatchOperation>): string {
      const sections = makeSections();
      const result = runAcceptProvenance({
        baselineSections: sections,
        proposalSections: sections,
        operations,
      });
      return JSON.stringify(result.provenance);
    }
    const opA: ContractPatchOperation = {
      kind: 'set-scalar',
      path: '/premise',
      value: 'new premise',
    };
    const opB: ContractPatchOperation = {
      kind: 'set-string-list',
      path: '/genre',
      value: ['fantasy', 'romance'],
    };
    expect(run([opA, opB])).toBe(run([opB, opA]));
  });

  it('Accept review and User Update mark the same USER_EDIT paths for the same operation', () => {
    const sections = makeSections({
      protagonist: { characterKey: 'hero', name: 'Hero', role: 'Chosen' },
    });

    const acceptResult = runAcceptProvenance({
      baselineSections: sections,
      proposalSections: sections,
      operations: [{ kind: 'set-scalar', path: '/protagonist/name', value: 'Hero v2' }],
    });
    const acceptUserEdit = acceptResult.provenance
      .filter((p) => p.source === 'USER_EDIT')
      .map((p) => p.sectionKey)
      .sort();

    const updateFake = new FakeTransactionRepos();
    updateFake.versions.set('v1', makeBaselineVersion(sections));
    updateFake.current = {
      projectId: 'p1',
      currentVersionId: 'v1',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const updateResult = updateCreationContractByUser(makeRealDeps(updateFake), {
      projectId: 'p1',
      expectedContractVersion: 1,
      operations: [{ kind: 'set-scalar', path: '/protagonist/name', value: 'Hero v2' }],
      now: '2026-01-02T00:00:00Z',
      newVersionId: 'v2',
    });
    const updateUserEdit = updateResult.provenance
      .filter((p) => p.source === 'USER_EDIT')
      .map((p) => p.sectionKey)
      .sort();

    expect(updateUserEdit).toEqual(acceptUserEdit);
    expect(updateUserEdit).toEqual(['/protagonist/name']);
  });
});
