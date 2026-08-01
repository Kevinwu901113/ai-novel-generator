import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  canonicalSerializeContractSections,
  canonicalSerializeContractSnapshot,
  validateCreationContractSections,
} from '@ai-novel/domain';
import { AppError, ContractDataCorruptionError } from '@ai-novel/application';
import { ProjectDatabase } from './project-database.js';
import { sha256Utf8 } from './creation-contract-repositories.js';

/**
 * 断言抛出 ContractDataCorruptionError：
 * public message 固定，内部细节在 cause 中。
 */
function expectCorruptionWithDetail(fn: () => void, detailFragment: RegExp): void {
  try {
    fn();
    expect.unreachable('expected ContractDataCorruptionError');
  } catch (e) {
    expect(e).toBeInstanceOf(ContractDataCorruptionError);
    expect((e as AppError).code).toBe('INTERNAL_ERROR');
    expect((e as Error).message).toBe('创作契约数据完整性异常');
    expect((e as AppError).cause).toBeDefined();
    expect(String(((e as AppError).cause as Error).message)).toMatch(detailFragment);
  }
}

function makeSections() {
  return {
    premise: 'A story',
    genre: ['fantasy'],
    tone: ['epic'],
    targetAudience: 'adults',
    narrativePov: 'THIRD_LIMITED' as const,
    tense: 'PAST' as const,
    protagonist: { characterKey: 'hero', name: 'Hero' },
  };
}

function makeSectionsJson(): string {
  return canonicalSerializeContractSections(validateCreationContractSections(makeSections()));
}

function makeSectionsHash(): string {
  return sha256Utf8(makeSectionsJson());
}

function makeSnapshotHash(lockedPaths: string[] = [], schemaVersion = 1): string {
  const canonical = canonicalSerializeContractSnapshot({
    sections: validateCreationContractSections(makeSections()),
    lockedFieldPaths: lockedPaths,
    schemaVersion,
  });
  return sha256Utf8(canonical);
}

function makeHashB(): string {
  return sha256Utf8(
    canonicalSerializeContractSections(
      validateCreationContractSections({ ...makeSections(), premise: 'B story' }),
    ),
  );
}

const VALID_PROV = JSON.stringify([
  {
    sectionKey: '/premise',
    source: 'DEFAULT',
    grillAnswerIds: [],
    grillProposalIds: [],
    aiTaskId: null,
    modelInvocationId: null,
    sourceProposalId: null,
    previousFieldHash: null,
    rationale: null,
  },
]);

describe('creation contract database', () => {
  let dir: string;
  let db: ProjectDatabase;

  function setupFks() {
    const grillSessionRepo = db.getGrillSessionRepository();
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();

    grillSessionRepo.create({
      id: 'gs1',
      projectId: 'p1',
      goal: 'test',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    taskRepo.create({
      id: 't1',
      projectId: 'p1',
      taskType: 'GRILL_QUESTION_PLAN',
      status: 'SUCCEEDED',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    invRepo.create({
      id: 'inv1',
      projectId: 'p1',
      taskId: 't1',
      providerProfileId: 'pp1',
      model: 'test-model',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });
  }

  function createProposal(overrides: Record<string, unknown> = {}) {
    const proposalRepo = db.getCreationContractProposalRepository();
    proposalRepo.create({
      id: 'prop1',
      projectId: 'p1',
      taskId: 't1',
      invocationId: 'inv1',
      baseGrillSessionId: 'gs1',
      baseGrillSessionVersion: 1,
      baseContractVersion: null,
      schemaVersion: 1,
      sectionsJson: makeSectionsJson(),
      sectionsHash: makeSectionsHash(),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      ...overrides,
    });
  }

  function createVersion(overrides: Record<string, unknown> = {}) {
    const versionRepo = db.getCreationContractVersionRepository();
    versionRepo.create({
      id: 'v1',
      projectId: 'p1',
      version: 1,
      schemaVersion: 1,
      sourceProposalId: 'prop1',
      basedOnGrillSessionId: 'gs1',
      basedOnGrillSessionVersion: 1,
      sectionsJson: makeSectionsJson(),
      lockedFieldPathsJson: '[]',
      contractSnapshotHash: makeSnapshotHash(),
      provenanceJson: VALID_PROV,
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'user',
      ...overrides,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-test-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Migration ─────────────────────────────────────────────

  it('migration creates all four tables', () => {
    const proposalRepo = db.getCreationContractProposalRepository();
    const versionRepo = db.getCreationContractVersionRepository();
    const currentRepo = db.getCreationContractCurrentRepository();
    const lockEventRepo = db.getCreationContractLockEventRepository();

    expect(proposalRepo.listByProject('p1')).toEqual([]);
    expect(versionRepo.listSummaries('p1')).toEqual([]);
    expect(currentRepo.get('p1')).toBeNull();
    expect(lockEventRepo.listByProject('p1')).toEqual([]);
  });

  it('migration is idempotent', () => {
    db.close();
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    expect(db.getCreationContractProposalRepository().listByProject('p1')).toEqual([]);
  });

  it('tables are STRICT', () => {
    const rows = db.database
      .prepare(
        `SELECT name, strict FROM pragma_table_list WHERE name LIKE 'creation_contract%' AND type = 'table'`,
      )
      .all() as Array<{ name: string; strict: number }>;
    const tableNames = rows.map((r) => r.name).sort();
    expect(tableNames).toEqual([
      'creation_contract_current',
      'creation_contract_lock_events',
      'creation_contract_proposals',
      'creation_contract_versions',
    ]);
    for (const row of rows) {
      expect(row.strict, `${row.name} should be STRICT`).toBe(1);
    }
  });

  // ── Proposal ──────────────────────────────────────────────

  it('inserts and retrieves proposal', () => {
    setupFks();
    createProposal();

    const retrieved = db.getCreationContractProposalRepository().getById('p1', 'prop1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.status).toBe('PROPOSED');
    expect(retrieved!.sectionsHash).toBe(makeSectionsHash());
  });

  it('proposal status CAS transition', () => {
    setupFks();
    createProposal();

    const proposalRepo = db.getCreationContractProposalRepository();
    expect(
      proposalRepo.transitionStatus('p1', 'prop1', 'PROPOSED', 'ACCEPTED', '2026-01-02T00:00:00Z'),
    ).toBe(true);
    expect(proposalRepo.getById('p1', 'prop1')!.status).toBe('ACCEPTED');

    // Invalid transition (already ACCEPTED)
    expect(
      proposalRepo.transitionStatus('p1', 'prop1', 'PROPOSED', 'REJECTED', '2026-01-03T00:00:00Z'),
    ).toBe(false);
  });

  it('proposal listByGrillSession', () => {
    setupFks();
    createProposal();

    const results = db.getCreationContractProposalRepository().listByGrillSession('gs1');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('prop1');
  });

  // ── Status transition trigger ─────────────────────────────

  it('rejects terminal → PROPOSED transition', () => {
    setupFks();
    createProposal();

    const proposalRepo = db.getCreationContractProposalRepository();
    proposalRepo.transitionStatus('p1', 'prop1', 'PROPOSED', 'ACCEPTED', '2026-01-02T00:00:00Z');

    // ACCEPTED → PROPOSED should fail
    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(
            `UPDATE creation_contract_proposals SET status = 'PROPOSED', updated_at = '2026-01-03T00:00:00Z' WHERE id = ?`,
          )
          .run('prop1');
      });
    }).toThrow(/can only transition from PROPOSED/);
  });

  it('rejects terminal → terminal transition', () => {
    setupFks();
    createProposal();

    const proposalRepo = db.getCreationContractProposalRepository();
    proposalRepo.transitionStatus('p1', 'prop1', 'PROPOSED', 'ACCEPTED', '2026-01-02T00:00:00Z');

    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(
            `UPDATE creation_contract_proposals SET status = 'REJECTED', updated_at = '2026-01-03T00:00:00Z' WHERE id = ?`,
          )
          .run('prop1');
      });
    }).toThrow(/can only transition from PROPOSED/);
  });

  it('rejects same-status update', () => {
    setupFks();
    createProposal();

    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(
            `UPDATE creation_contract_proposals SET status = 'PROPOSED', updated_at = '2026-01-02T00:00:00Z' WHERE id = ?`,
          )
          .run('prop1');
      });
    }).toThrow(/cannot update to same status|updated_at cannot be changed/);
  });

  it('rejects updated_at-only update without status change', () => {
    setupFks();
    createProposal();

    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(
            `UPDATE creation_contract_proposals SET updated_at = '2026-01-02T00:00:00Z' WHERE id = ?`,
          )
          .run('prop1');
      });
    }).toThrow(/updated_at cannot be changed/);
  });

  it('rejects status change without updated_at change', () => {
    setupFks();
    createProposal();

    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(`UPDATE creation_contract_proposals SET status = 'ACCEPTED' WHERE id = ?`)
          .run('prop1');
      });
    }).toThrow(/updated_at must change/);
  });

  // ── Version ───────────────────────────────────────────────

  it('inserts and retrieves version', () => {
    setupFks();
    createProposal();
    createVersion();

    const versionRepo = db.getCreationContractVersionRepository();
    const byId = versionRepo.getById('p1', 'v1');
    expect(byId).not.toBeNull();
    expect(byId!.version).toBe(1);
    expect(byId!.createdBy).toBe('user');

    const byVersion = versionRepo.getByVersion('p1', 1);
    expect(byVersion).not.toBeNull();
    expect(byVersion!.id).toBe('v1');

    const summaries = versionRepo.listSummaries('p1');
    expect(summaries).toHaveLength(1);

    const resolvedId = versionRepo.resolveVersionId('p1', 1);
    expect(resolvedId).toBe('v1');
    expect(versionRepo.resolveVersionId('p1', 999)).toBeNull();
  });

  it('version number unique per project', () => {
    setupFks();
    createProposal();
    createVersion();

    expect(() =>
      db.getCreationContractVersionRepository().create({
        id: 'v2',
        projectId: 'p1',
        version: 1,
        schemaVersion: 1,
        sourceProposalId: null,
        basedOnGrillSessionId: null,
        basedOnGrillSessionVersion: null,
        sectionsJson: makeSectionsJson(),
        lockedFieldPathsJson: '[]',
        contractSnapshotHash: makeHashB(),
        provenanceJson: VALID_PROV,
        createdAt: '2026-01-02T00:00:00Z',
        createdBy: 'user',
      }),
    ).toThrow();
  });

  // ── Current Pointer ───────────────────────────────────────

  it('current pointer: insert first + get', () => {
    setupFks();
    createProposal();
    createVersion();

    const currentRepo = db.getCreationContractCurrentRepository();
    expect(currentRepo.get('p1')).toBeNull();

    expect(currentRepo.insertFirst('p1', 'v1', '2026-01-01T00:00:00Z')).toBe(true);
    const current = currentRepo.get('p1');
    expect(current).not.toBeNull();
    expect(current!.currentVersionId).toBe('v1');
  });

  it('current pointer: duplicate insert fails (pointer uniqueness)', () => {
    setupFks();
    createProposal();
    createVersion();

    const currentRepo = db.getCreationContractCurrentRepository();
    expect(currentRepo.insertFirst('p1', 'v1', '2026-01-01T00:00:00Z')).toBe(true);
    expect(currentRepo.insertFirst('p1', 'v1', '2026-01-02T00:00:00Z')).toBe(false);
  });

  it('current pointer: CAS update', () => {
    setupFks();
    createProposal();
    createVersion();
    createVersion({
      id: 'v2',
      version: 2,
      sourceProposalId: null,
      basedOnGrillSessionId: null,
      basedOnGrillSessionVersion: null,
    });

    const currentRepo = db.getCreationContractCurrentRepository();
    currentRepo.insertFirst('p1', 'v1', '2026-01-01T00:00:00Z');

    expect(currentRepo.casUpdate('p1', 'v999', 'v2', '2026-01-02T00:00:00Z')).toBe(false);
    expect(currentRepo.casUpdate('p1', 'v1', 'v2', '2026-01-02T00:00:00Z')).toBe(true);
    expect(currentRepo.get('p1')!.currentVersionId).toBe('v2');
  });

  // ── Lock Events ───────────────────────────────────────────

  it('lock events: append and list', () => {
    setupFks();
    createProposal();
    createVersion({ createdBy: 'lock' });

    const lockEventRepo = db.getCreationContractLockEventRepository();
    lockEventRepo.append({
      id: 'le1',
      projectId: 'p1',
      fieldPath: '/premise',
      action: 'LOCK',
      versionId: 'v1',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'user',
    });

    const events = lockEventRepo.listByVersionId('p1', 'v1');
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('LOCK');
    expect(events[0].fieldPath).toBe('/premise');
  });

  // ── Immutability Triggers ─────────────────────────────────

  it('proposal sections_json cannot be updated', () => {
    setupFks();
    createProposal();

    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(`UPDATE creation_contract_proposals SET sections_json = ? WHERE id = ?`)
          .run('{"modified": true}', 'prop1');
      });
    }).toThrow(/immutable/);
  });

  it('version cannot be updated', () => {
    setupFks();
    createProposal();
    createVersion();

    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(`UPDATE creation_contract_versions SET sections_json = ? WHERE id = ?`)
          .run('{"modified": true}', 'v1');
      });
    }).toThrow(/append-only/);
  });

  it('version cannot be deleted', () => {
    setupFks();
    createProposal();
    createVersion();

    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(`DELETE FROM creation_contract_versions WHERE id = ?`)
          .run('v1');
      });
    }).toThrow(/append-only/);
  });

  it('lock events cannot be updated or deleted', () => {
    setupFks();
    createProposal();
    createVersion({ createdBy: 'lock' });

    const lockEventRepo = db.getCreationContractLockEventRepository();
    lockEventRepo.append({
      id: 'le1',
      projectId: 'p1',
      fieldPath: '/premise',
      action: 'LOCK',
      versionId: 'v1',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'user',
    });

    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(`UPDATE creation_contract_lock_events SET action = 'UNLOCK' WHERE id = ?`)
          .run('le1');
      });
    }).toThrow(/append-only/);

    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(`DELETE FROM creation_contract_lock_events WHERE id = ?`)
          .run('le1');
      });
    }).toThrow(/append-only/);
  });

  // ── Proposal immutability (identity fields) ───────────────

  it('proposal identity fields cannot be updated', () => {
    setupFks();
    createProposal();

    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(`UPDATE creation_contract_proposals SET task_id = 'other' WHERE id = ?`)
          .run('prop1');
      });
    }).toThrow(/immutable/);
  });

  // ── Proposal DELETE protection ──────────────────────────────

  it('proposal cannot be deleted (append-only)', () => {
    setupFks();
    createProposal();

    expect(() => {
      db.transaction(() => {
        (
          db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }
        ).db
          .prepare(`DELETE FROM creation_contract_proposals WHERE id = ?`)
          .run('prop1');
      });
    }).toThrow(/append-only/);
  });

  // ── json_valid CHECK constraints ────────────────────────────

  it('rejects invalid JSON in proposal sections_json', () => {
    setupFks();

    expect(() =>
      db.getCreationContractProposalRepository().create({
        id: 'prop-bad',
        projectId: 'p1',
        taskId: 't1',
        invocationId: 'inv1',
        baseGrillSessionId: 'gs1',
        baseGrillSessionVersion: 1,
        baseContractVersion: null,
        schemaVersion: 1,
        sectionsJson: 'not valid json',
        sectionsHash: makeSectionsHash(),
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });

  it('rejects invalid JSON in version sections_json', () => {
    expect(() =>
      db.getCreationContractVersionRepository().create({
        id: 'v-bad',
        projectId: 'p1',
        version: 1,
        schemaVersion: 1,
        sourceProposalId: null,
        basedOnGrillSessionId: null,
        basedOnGrillSessionVersion: null,
        sectionsJson: '{broken',
        lockedFieldPathsJson: '[]',
        contractSnapshotHash: makeSnapshotHash(),
        provenanceJson: VALID_PROV,
        createdAt: '2026-01-01T00:00:00Z',
        createdBy: 'user',
      }),
    ).toThrow();
  });

  it('rejects invalid JSON in version locked_field_paths_json', () => {
    expect(() =>
      db.getCreationContractVersionRepository().create({
        id: 'v-bad2',
        projectId: 'p1',
        version: 1,
        schemaVersion: 1,
        sourceProposalId: null,
        basedOnGrillSessionId: null,
        basedOnGrillSessionVersion: null,
        sectionsJson: makeSectionsJson(),
        lockedFieldPathsJson: 'not json',
        contractSnapshotHash: makeSnapshotHash(),
        provenanceJson: VALID_PROV,
        createdAt: '2026-01-01T00:00:00Z',
        createdBy: 'user',
      }),
    ).toThrow();
  });

  // ── Hash length CHECK ──────────────────────────────────────

  it('rejects hash with wrong length in proposal', () => {
    setupFks();

    expect(() =>
      db.getCreationContractProposalRepository().create({
        id: 'prop-bad-hash',
        projectId: 'p1',
        taskId: 't1',
        invocationId: 'inv1',
        baseGrillSessionId: 'gs1',
        baseGrillSessionVersion: 1,
        baseContractVersion: null,
        schemaVersion: 1,
        sectionsJson: makeSectionsJson(),
        sectionsHash: 'too-short',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });

  // ── Null-pair CHECK ────────────────────────────────────────

  it('rejects version with based_on session id but no version', () => {
    setupFks();
    createProposal();

    expectCorruptionWithDetail(
      () =>
        db.getCreationContractVersionRepository().create({
          id: 'v-bad-pair',
          projectId: 'p1',
          version: 2,
          schemaVersion: 1,
          sourceProposalId: null,
          basedOnGrillSessionId: 'gs1',
          basedOnGrillSessionVersion: null,
          sectionsJson: makeSectionsJson(),
          lockedFieldPathsJson: '[]',
          contractSnapshotHash: makeSnapshotHash(),
          provenanceJson: VALID_PROV,
          createdAt: '2026-01-01T00:00:00Z',
          createdBy: 'user',
        }),
      /null-pair/,
    );
  });

  it('rejects version with based_on version but no session id', () => {
    setupFks();
    createProposal();

    expectCorruptionWithDetail(
      () =>
        db.getCreationContractVersionRepository().create({
          id: 'v-bad-pair2',
          projectId: 'p1',
          version: 2,
          schemaVersion: 1,
          sourceProposalId: null,
          basedOnGrillSessionId: null,
          basedOnGrillSessionVersion: 1,
          sectionsJson: makeSectionsJson(),
          lockedFieldPathsJson: '[]',
          contractSnapshotHash: makeSnapshotHash(),
          provenanceJson: VALID_PROV,
          createdAt: '2026-01-01T00:00:00Z',
          createdBy: 'user',
        }),
      /null-pair/,
    );
  });

  // ── Composite FK ───────────────────────────────────────────

  it('rejects proposal with mismatched task invocation FK', () => {
    setupFks();
    // Create a second task
    db.getTaskRepository().create({
      id: 't2',
      projectId: 'p1',
      taskType: 'GRILL_QUESTION_PLAN',
      status: 'SUCCEEDED',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    // inv1 belongs to t1, not t2
    expect(() =>
      db.getCreationContractProposalRepository().create({
        id: 'prop-mismatch',
        projectId: 'p1',
        taskId: 't2',
        invocationId: 'inv1',
        baseGrillSessionId: 'gs1',
        baseGrillSessionVersion: 1,
        baseContractVersion: null,
        schemaVersion: 1,
        sectionsJson: makeSectionsJson(),
        sectionsHash: makeSectionsHash(),
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });

  it('rejects proposal with non-existent grill session', () => {
    setupFks();

    expect(() =>
      db.getCreationContractProposalRepository().create({
        id: 'prop-nosess',
        projectId: 'p1',
        taskId: 't1',
        invocationId: 'inv1',
        baseGrillSessionId: 'nonexistent',
        baseGrillSessionVersion: 1,
        baseContractVersion: null,
        schemaVersion: 1,
        sectionsJson: makeSectionsJson(),
        sectionsHash: makeSectionsHash(),
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });

  // ── Canonical/hash validation on write ─────────────────────

  it('rejects non-canonical sectionsJson on proposal create', () => {
    setupFks();

    // Valid sections but not in canonical form
    const nonCanonical = JSON.stringify({
      protagonist: { characterKey: 'hero', name: 'Hero' },
      premise: 'A story',
      genre: ['fantasy'],
      tone: ['epic'],
      targetAudience: 'adults',
      narrativePov: 'THIRD_LIMITED',
      tense: 'PAST',
    });

    expectCorruptionWithDetail(
      () =>
        db.getCreationContractProposalRepository().create({
          id: 'prop-noncanon',
          projectId: 'p1',
          taskId: 't1',
          invocationId: 'inv1',
          baseGrillSessionId: 'gs1',
          baseGrillSessionVersion: 1,
          baseContractVersion: null,
          schemaVersion: 1,
          sectionsJson: nonCanonical,
          sectionsHash: sha256Utf8(nonCanonical),
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }),
      /canonical/,
    );
  });

  it('rejects hash mismatch on proposal create', () => {
    setupFks();

    expectCorruptionWithDetail(
      () =>
        db.getCreationContractProposalRepository().create({
          id: 'prop-hashmismatch',
          projectId: 'p1',
          taskId: 't1',
          invocationId: 'inv1',
          baseGrillSessionId: 'gs1',
          baseGrillSessionVersion: 1,
          baseContractVersion: null,
          schemaVersion: 1,
          sectionsJson: makeSectionsJson(),
          sectionsHash: 'b'.repeat(64),
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }),
      /mismatch/,
    );
  });

  it('rejects non-lowercase hash on proposal create', () => {
    setupFks();

    expectCorruptionWithDetail(
      () =>
        db.getCreationContractProposalRepository().create({
          id: 'prop-uppercase',
          projectId: 'p1',
          taskId: 't1',
          invocationId: 'inv1',
          baseGrillSessionId: 'gs1',
          baseGrillSessionVersion: 1,
          baseContractVersion: null,
          schemaVersion: 1,
          sectionsJson: makeSectionsJson(),
          sectionsHash: 'A'.repeat(64),
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }),
      /lowercase hex/,
    );
  });

  // ── list排序 ──────────────────────────────────────────────

  it('list returns sorted results', () => {
    setupFks();
    createProposal();
    // task_id / invocation_id 唯一：第二个 proposal 需要独立 task + invocation
    db.getTaskRepository().create({
      id: 't2',
      projectId: 'p1',
      taskType: 'GRILL_QUESTION_PLAN',
      status: 'SUCCEEDED',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    db.getModelInvocationRepository().create({
      id: 'inv2',
      projectId: 'p1',
      taskId: 't2',
      providerProfileId: 'pp1',
      model: 'test-model',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const proposalRepo = db.getCreationContractProposalRepository();
    proposalRepo.create({
      id: 'prop2',
      projectId: 'p1',
      taskId: 't2',
      invocationId: 'inv2',
      baseGrillSessionId: 'gs1',
      baseGrillSessionVersion: 2,
      baseContractVersion: null,
      schemaVersion: 1,
      sectionsJson: makeSectionsJson(),
      sectionsHash: makeSectionsHash(),
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });

    const proposals = proposalRepo.listByProject('p1');
    expect(proposals).toHaveLength(2);
    expect(proposals[0].id).toBe('prop2');
    expect(proposals[1].id).toBe('prop1');
  });

  // ── Transaction rollback ──────────────────────────────────

  it('transaction rollback leaves no partial data', () => {
    setupFks();
    createProposal();

    const versionRepo = db.getCreationContractVersionRepository();

    expect(() => {
      db.transaction(() => {
        versionRepo.create({
          id: 'v1',
          projectId: 'p1',
          version: 1,
          schemaVersion: 1,
          sourceProposalId: 'prop1',
          basedOnGrillSessionId: null,
          basedOnGrillSessionVersion: null,
          sectionsJson: makeSectionsJson(),
          lockedFieldPathsJson: '[]',
          contractSnapshotHash: makeSnapshotHash(),
          provenanceJson: VALID_PROV,
          createdAt: '2026-01-01T00:00:00Z',
          createdBy: 'user',
        });
        throw new Error('intentional failure');
      });
    }).toThrow('intentional failure');

    expect(versionRepo.getById('p1', 'v1')).toBeNull();
  });

  // ── schemaVersion CHECK ────────────────────────────────────

  it('rejects proposal with wrong schemaVersion', () => {
    setupFks();

    expect(() =>
      db.getCreationContractProposalRepository().create({
        id: 'prop-bad-schema',
        projectId: 'p1',
        taskId: 't1',
        invocationId: 'inv1',
        baseGrillSessionId: 'gs1',
        baseGrillSessionVersion: 1,
        baseContractVersion: null,
        schemaVersion: 99,
        sectionsJson: makeSectionsJson(),
        sectionsHash: makeSectionsHash(),
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });

  // ── base_contract_version CHECK ────────────────────────────

  it('rejects proposal with base_contract_version = 0', () => {
    setupFks();

    expect(() =>
      db.getCreationContractProposalRepository().create({
        id: 'prop-bcv',
        projectId: 'p1',
        taskId: 't1',
        invocationId: 'inv1',
        baseGrillSessionId: 'gs1',
        baseGrillSessionVersion: 1,
        baseContractVersion: 0,
        schemaVersion: 1,
        sectionsJson: makeSectionsJson(),
        sectionsHash: makeSectionsHash(),
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });

  // ── supersedeAllProposed ──────────────────────────────────

  it('supersedeAllProposed transitions all PROPOSED to SUPERSEDED', () => {
    setupFks();
    createProposal();
    // task_id / invocation_id 唯一：第二个 proposal 需要独立 task + invocation
    db.getTaskRepository().create({
      id: 't2',
      projectId: 'p1',
      taskType: 'GRILL_QUESTION_PLAN',
      status: 'SUCCEEDED',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    db.getModelInvocationRepository().create({
      id: 'inv2',
      projectId: 'p1',
      taskId: 't2',
      providerProfileId: 'pp1',
      model: 'test-model',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const proposalRepo = db.getCreationContractProposalRepository();
    proposalRepo.create({
      id: 'prop2',
      projectId: 'p1',
      taskId: 't2',
      invocationId: 'inv2',
      baseGrillSessionId: 'gs1',
      baseGrillSessionVersion: 2,
      baseContractVersion: null,
      schemaVersion: 1,
      sectionsJson: makeSectionsJson(),
      sectionsHash: makeSectionsHash(),
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });

    const count = proposalRepo.supersedeAllProposed('p1', '2026-01-03T00:00:00Z');
    expect(count).toBe(2);
    expect(proposalRepo.getById('p1', 'prop1')!.status).toBe('SUPERSEDED');
    expect(proposalRepo.getById('p1', 'prop2')!.status).toBe('SUPERSEDED');
  });

  // ── PRAGMA table_list strict ──────────────────────────────

  it('creation_contract tables are STRICT mode', () => {
    const rows = db.database
      .prepare(
        `SELECT name, strict FROM pragma_table_list WHERE name LIKE 'creation_contract%' AND type = 'table'`,
      )
      .all() as Array<{ name: string; strict: number }>;
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.strict, `${row.name} should be STRICT`).toBe(1);
    }
  });
});
