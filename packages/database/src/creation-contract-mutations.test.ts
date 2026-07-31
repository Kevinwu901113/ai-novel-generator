/**
 * 创作契约 Accept/Reject 用例集成测试。
 *
 * 使用真实 SQLite 数据库，不使用 mock。
 * 覆盖：原子性、并发、CAS、错误映射。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  canonicalSerializeContractSections,
  canonicalSerializeContractSnapshot,
  validateCreationContractSections,
  type CreationContractSections,
  type ContractPatchOperation,
} from '@ai-novel/domain';
import {
  acceptCreationContractProposal,
  rejectCreationContractProposal,
  AppError,
  ContractProposalNotFoundError,
  ContractProposalNotAcceptableError,
  ContractProposalStaleError,
  ContractVersionConflictError,
  ContractModelLockViolationError,
  ContractLockConflictError,
  ContractSchemaUnsupportedError,
  ContractDataCorruptionError,
  ContractValidationError,
  ContractTransactionBusyError,
  ContractTransactionError,
  ValidationError,
  type CreationContractMutationDeps,
  type CreationContractTransactionRepositories,
  type CreationContractProposalData,
} from '@ai-novel/application';
import { ProjectDatabase } from './project-database.js';
import { CreationContractTransactionPortImpl } from './creation-contract-transaction.js';
import { sha256Utf8 } from './creation-contract-repositories.js';

// ── 测试辅助 ──────────────────────────────────────────────────

function makeSections(overrides?: Partial<CreationContractSections>): CreationContractSections {
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

function makeSectionsHash(sections?: CreationContractSections): string {
  return sha256Utf8(makeSectionsJson(sections));
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

function setupProject(db: ProjectDatabase, projectId: string) {
  // Create project metadata
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

  // Create grill session
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
  overrides?: {
    status?: string;
    sectionsHash?: string;
    baseGrillSessionVersion?: number;
    baseContractVersion?: number | null;
    sections?: CreationContractSections;
  },
) {
  const sections = overrides?.sections ?? makeSections();
  const sectionsJson = makeSectionsJson(sections);
  const sectionsHash = overrides?.sectionsHash ?? makeSectionsHash(sections);

  // Create task
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

  // Create invocation
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

  // If setting a non-PROPOSED status, first insert as PROPOSED then transition
  const status = overrides?.status ?? 'PROPOSED';

  db.getCreationContractProposalRepository().create({
    id: proposalId,
    projectId,
    taskId: `task-${proposalId}`,
    invocationId: `inv-${proposalId}`,
    baseGrillSessionId: `gs-${projectId}`,
    baseGrillSessionVersion: overrides?.baseGrillSessionVersion ?? 1,
    baseContractVersion: overrides?.baseContractVersion ?? null,
    schemaVersion: 1,
    sectionsJson,
    sectionsHash,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });

  if (status !== 'PROPOSED') {
    // Use raw SQL to set terminal status (bypassing trigger for test setup)
    db.database.exec('DROP TRIGGER IF EXISTS trg_cc_proposals_status_transition');
    db.database.exec('DROP TRIGGER IF EXISTS trg_cc_proposals_immutable_updated_at');
    db.database
      .prepare(
        `UPDATE creation_contract_proposals
         SET status = ?, updated_at = '2026-01-01T00:01:00Z'
         WHERE project_id = ? AND id = ?`,
      )
      .run(status, projectId, proposalId);
    // Re-create triggers
    db.database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_cc_proposals_status_transition
      BEFORE UPDATE OF status ON creation_contract_proposals
      BEGIN
        SELECT RAISE(ABORT, 'updated_at must change when status changes')
        WHERE NEW.updated_at = OLD.updated_at;
        SELECT RAISE(ABORT, 'can only transition from PROPOSED')
        WHERE OLD.status != 'PROPOSED';
        SELECT RAISE(ABORT, 'cannot update to same status')
        WHERE NEW.status = OLD.status;
      END;
    `);
    db.database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_cc_proposals_immutable_updated_at
      BEFORE UPDATE OF updated_at ON creation_contract_proposals
      WHEN NEW.status = OLD.status
      BEGIN
        SELECT RAISE(ABORT, 'updated_at cannot be changed without status change');
      END;
    `);
  }
}

// ── 测试套件 ──────────────────────────────────────────────────

describe('acceptCreationContractProposal', () => {
  let dir: string;
  let db: ProjectDatabase;
  let deps: CreationContractMutationDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-accept-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    const txPort = new CreationContractTransactionPortImpl(db.database);
    deps = { transactionPort: txPort, sha256Port: { digestUtf8: sha256Utf8 } };
    setupProject(db, 'p1');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts first proposal successfully', () => {
    setupProposal(db, 'p1', 'prop1');

    const result = acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    expect(result.id).toBe('v1');
    expect(result.version).toBe(1);
    expect(result.createdBy).toBe('ai-proposal-accepted');
    expect(result.sourceProposalId).toBe('prop1');
    expect(result.sections.premise).toBe('A story about testing');
    expect(result.lockedFieldPaths).toEqual([]);
    expect(result.contractSnapshotHash).toBe(makeSnapshotHash());
    expect(result.provenance.length).toBeGreaterThan(0);

    // Verify proposal status changed
    const proposal = db.getCreationContractProposalRepository().getById('p1', 'prop1');
    expect(proposal?.status).toBe('ACCEPTED');

    // Verify current pointer
    const current = db.getCreationContractCurrentRepository().get('p1');
    expect(current?.currentVersionId).toBe('v1');
  });

  it('accepts proposal with operations', () => {
    setupProposal(db, 'p1', 'prop1');

    const operations: ContractPatchOperation[] = [
      { kind: 'set-scalar', path: '/premise', value: 'Updated premise' },
    ];

    const result = acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations,
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    expect(result.sections.premise).toBe('Updated premise');
  });

  it('accepts subsequent version', () => {
    // First acceptance
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    // Second proposal
    setupProposal(db, 'p1', 'prop2', { baseContractVersion: 1 });
    const result = acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop2',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: 1,
      operations: [],
      now: '2026-01-01T00:03:00Z',
      newVersionId: 'v2',
    });

    expect(result.version).toBe(2);

    // Verify current pointer updated
    const current = db.getCreationContractCurrentRepository().get('p1');
    expect(current?.currentVersionId).toBe('v2');
  });

  it('throws ValidationError for empty projectId', () => {
    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: '',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:00:00Z',
        newVersionId: 'v1',
      }),
    ).toThrow(ValidationError);
  });

  it('throws ContractProposalNotFoundError for missing proposal', () => {
    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'nonexistent',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:00:00Z',
        newVersionId: 'v1',
      }),
    ).toThrow(ContractProposalNotFoundError);
  });

  it('throws ContractProposalNotAcceptableError for non-PROPOSED status', () => {
    setupProposal(db, 'p1', 'prop1', { status: 'ACCEPTED' });

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:00:00Z',
        newVersionId: 'v1',
      }),
    ).toThrow(ContractProposalNotAcceptableError);
  });

  it('throws ContractProposalStaleError for hash mismatch', () => {
    setupProposal(db, 'p1', 'prop1');

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: 'f'.repeat(64),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:00:00Z',
        newVersionId: 'v1',
      }),
    ).toThrow(ContractProposalStaleError);
  });

  it('throws ContractProposalStaleError for grill version mismatch', () => {
    setupProposal(db, 'p1', 'prop1');

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 999,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:00:00Z',
        newVersionId: 'v1',
      }),
    ).toThrow(ContractProposalStaleError);
  });

  it('throws ContractVersionConflictError when expectedContractVersion mismatch', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    setupProposal(db, 'p1', 'prop2');
    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 999,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      }),
    ).toThrow(ContractVersionConflictError);
  });

  it('atomicity: invalid operations do not change proposal status or create version', () => {
    setupProposal(db, 'p1', 'prop1');

    const badOperations: ContractPatchOperation[] = [
      { kind: 'set-scalar', path: '/premise', value: '' }, // empty string invalid
    ];

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: badOperations,
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      }),
    ).toThrow(ContractValidationError);

    // Verify no side effects
    const proposal = db.getCreationContractProposalRepository().getById('p1', 'prop1');
    expect(proposal?.status).toBe('PROPOSED');

    const versions = db.getCreationContractVersionRepository().listSummaries('p1');
    expect(versions).toHaveLength(0);

    const current = db.getCreationContractCurrentRepository().get('p1');
    expect(current).toBeNull();
  });

  it('atomicity: lock conflict does not create version or change status', () => {
    // First accept to create a version with locks
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    // Tamper the version to have locked field paths
    db.database.exec('DROP TRIGGER IF EXISTS trg_cc_versions_no_update');
    db.database
      .prepare(
        `UPDATE creation_contract_versions
         SET locked_field_paths_json = '["/premise"]',
             contract_snapshot_hash = ?
         WHERE id = 'v1'`,
      )
      .run(makeSnapshotHash(makeSections(), ['/premise']));
    db.database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_cc_versions_no_update
      BEFORE UPDATE ON creation_contract_versions
      BEGIN
        SELECT RAISE(ABORT, 'creation_contract_versions is append-only');
      END;
    `);

    // Now try to accept a proposal that would modify /premise
    // The proposal has baseContractVersion=null (first contract), but we have version 1
    // We need to setup proposal with baseContractVersion=1
    setupProposal(db, 'p1', 'prop2', { baseContractVersion: 1 });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2');
    expect(prop2).not.toBeNull();

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2!.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'Conflicting change' }],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      }),
    ).toThrow(ContractLockConflictError);

    // Verify no side effects
    const proposal = db.getCreationContractProposalRepository().getById('p1', 'prop2');
    expect(proposal?.status).toBe('PROPOSED');

    const versions = db.getCreationContractVersionRepository().listSummaries('p1');
    expect(versions).toHaveLength(1); // only v1
  });

  it('concurrent first accept: only one succeeds', () => {
    setupProposal(db, 'p1', 'prop1a');
    setupProposal(db, 'p1', 'prop1b');

    const hashA = db.getCreationContractProposalRepository().getById('p1', 'prop1a')!.sectionsHash;
    const hashB = db.getCreationContractProposalRepository().getById('p1', 'prop1b')!.sectionsHash;

    // First should succeed
    const result1 = acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1a',
      expectedProposalSectionsHash: hashA,
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1a',
    });
    expect(result1.version).toBe(1);

    // Second with same expectedContractVersion=null should fail
    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1b',
        expectedProposalSectionsHash: hashB,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1b',
      }),
    ).toThrow(ContractVersionConflictError);

    // Verify only one version exists
    const versions = db.getCreationContractVersionRepository().listSummaries('p1');
    expect(versions).toHaveLength(1);

    // Verify current pointer
    const current = db.getCreationContractCurrentRepository().get('p1');
    expect(current?.currentVersionId).toBe('v1a');
  });

  it('concurrent accept with same expected version: only one succeeds', () => {
    // First version
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    // Two proposals for version 2
    setupProposal(db, 'p1', 'prop2a', { baseContractVersion: 1 });
    setupProposal(db, 'p1', 'prop2b', { baseContractVersion: 1 });

    const hash2a = db.getCreationContractProposalRepository().getById('p1', 'prop2a')!.sectionsHash;
    const hash2b = db.getCreationContractProposalRepository().getById('p1', 'prop2b')!.sectionsHash;

    // First succeeds
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop2a',
      expectedProposalSectionsHash: hash2a,
      expectedGrillSessionVersion: 1,
      expectedContractVersion: 1,
      operations: [],
      now: '2026-01-01T00:03:00Z',
      newVersionId: 'v2a',
    });

    // Second fails
    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2b',
        expectedProposalSectionsHash: hash2b,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2b',
      }),
    ).toThrow(ContractVersionConflictError);

    // No orphan version
    const versions = db.getCreationContractVersionRepository().listSummaries('p1');
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.id).sort()).toEqual(['v1', 'v2a']);
  });

  it('accept then reject same proposal: only one succeeds', () => {
    setupProposal(db, 'p1', 'prop1');
    const hash = db.getCreationContractProposalRepository().getById('p1', 'prop1')!.sectionsHash;

    // Accept first
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: hash,
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    // Reject should fail (already ACCEPTED)
    expect(() =>
      rejectCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: hash,
        now: '2026-01-01T00:03:00Z',
      }),
    ).toThrow(ContractProposalNotAcceptableError);

    // Proposal still ACCEPTED
    const proposal = db.getCreationContractProposalRepository().getById('p1', 'prop1');
    expect(proposal?.status).toBe('ACCEPTED');
  });
});

describe('rejectCreationContractProposal', () => {
  let dir: string;
  let db: ProjectDatabase;
  let deps: CreationContractMutationDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-reject-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    const txPort = new CreationContractTransactionPortImpl(db.database);
    deps = { transactionPort: txPort, sha256Port: { digestUtf8: sha256Utf8 } };
    setupProject(db, 'p1');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects proposal successfully', () => {
    setupProposal(db, 'p1', 'prop1');

    const result = rejectCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      now: '2026-01-01T00:02:00Z',
    });

    expect(result.status).toBe('REJECTED');
    expect(result.updatedAt).toBe('2026-01-01T00:02:00Z');

    // Verify proposal status
    const proposal = db.getCreationContractProposalRepository().getById('p1', 'prop1');
    expect(proposal?.status).toBe('REJECTED');

    // Verify no version created
    const versions = db.getCreationContractVersionRepository().listSummaries('p1');
    expect(versions).toHaveLength(0);

    // Verify no current pointer
    const current = db.getCreationContractCurrentRepository().get('p1');
    expect(current).toBeNull();
  });

  it('throws ContractProposalNotFoundError for missing proposal', () => {
    expect(() =>
      rejectCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'nonexistent',
        expectedProposalSectionsHash: makeSectionsHash(),
        now: '2026-01-01T00:00:00Z',
      }),
    ).toThrow(ContractProposalNotFoundError);
  });

  it('throws ContractProposalNotAcceptableError for terminal status', () => {
    setupProposal(db, 'p1', 'prop1', { status: 'REJECTED' });

    expect(() =>
      rejectCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        now: '2026-01-01T00:00:00Z',
      }),
    ).toThrow(ContractProposalNotAcceptableError);
  });

  it('throws ContractProposalStaleError for hash mismatch', () => {
    setupProposal(db, 'p1', 'prop1');

    expect(() =>
      rejectCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: 'f'.repeat(64),
        now: '2026-01-01T00:00:00Z',
      }),
    ).toThrow(ContractProposalStaleError);
  });

  it('duplicate reject returns not-acceptable', () => {
    setupProposal(db, 'p1', 'prop1');

    rejectCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      now: '2026-01-01T00:02:00Z',
    });

    expect(() =>
      rejectCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        now: '2026-01-01T00:03:00Z',
      }),
    ).toThrow(ContractProposalNotAcceptableError);
  });

  it('reject does not create lock events', () => {
    setupProposal(db, 'p1', 'prop1');

    rejectCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      now: '2026-01-01T00:02:00Z',
    });

    const lockEvents = db.getCreationContractLockEventRepository().listByProject('p1');
    expect(lockEvents).toHaveLength(0);
  });
});

describe('concurrent accept/reject', () => {
  let dir: string;
  let db: ProjectDatabase;
  let deps: CreationContractMutationDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-concurrent-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    const txPort = new CreationContractTransactionPortImpl(db.database);
    deps = { transactionPort: txPort, sha256Port: { digestUtf8: sha256Utf8 } };
    setupProject(db, 'p1');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('accept and reject race: only one state transition succeeds', () => {
    setupProposal(db, 'p1', 'prop1');
    const hash = db.getCreationContractProposalRepository().getById('p1', 'prop1')!.sectionsHash;

    // Accept first
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: hash,
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    // Reject should fail (proposal already ACCEPTED)
    expect(() =>
      rejectCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: hash,
        now: '2026-01-01T00:03:00Z',
      }),
    ).toThrow(ContractProposalNotAcceptableError);

    // Verify final state
    const proposal = db.getCreationContractProposalRepository().getById('p1', 'prop1');
    expect(proposal?.status).toBe('ACCEPTED');
    const versions = db.getCreationContractVersionRepository().listSummaries('p1');
    expect(versions).toHaveLength(1);
  });

  it('reject then accept race: accept fails', () => {
    setupProposal(db, 'p1', 'prop1');
    const hash = db.getCreationContractProposalRepository().getById('p1', 'prop1')!.sectionsHash;

    // Reject first
    rejectCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: hash,
      now: '2026-01-01T00:02:00Z',
    });

    // Accept should fail (proposal already REJECTED)
    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: hash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v1',
      }),
    ).toThrow(ContractProposalNotAcceptableError);

    // Verify no version created
    const versions = db.getCreationContractVersionRepository().listSummaries('p1');
    expect(versions).toHaveLength(0);
  });

  it('proposal hash mismatch: stale error', () => {
    setupProposal(db, 'p1', 'prop1');

    // Accept with wrong hash should fail with stale error
    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: 'b'.repeat(64), // wrong hash
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      }),
    ).toThrow(ContractProposalStaleError);

    // Verify no side effects
    const versions = db.getCreationContractVersionRepository().listSummaries('p1');
    expect(versions).toHaveLength(0);

    const proposal = db.getCreationContractProposalRepository().getById('p1', 'prop1');
    expect(proposal?.status).toBe('PROPOSED');
  });

  it('duplicate newVersionId causes rollback', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    setupProposal(db, 'p1', 'prop2', { baseContractVersion: 1 });
    const hash2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!.sectionsHash;

    // Try to use duplicate version ID
    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: hash2,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v1', // duplicate!
      }),
    ).toThrow(ContractTransactionError);

    // Verify proposal still PROPOSED (rollback)
    const proposal = db.getCreationContractProposalRepository().getById('p1', 'prop2');
    expect(proposal?.status).toBe('PROPOSED');

    // Only one version
    const versions = db.getCreationContractVersionRepository().listSummaries('p1');
    expect(versions).toHaveLength(1);
  });

  it('version number conflict: UNIQUE constraint prevents duplicate version number', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    setupProposal(db, 'p1', 'prop2', { baseContractVersion: 1 });
    const hash2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!.sectionsHash;

    // Accept normally — version 2
    const result = acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop2',
      expectedProposalSectionsHash: hash2,
      expectedGrillSessionVersion: 1,
      expectedContractVersion: 1,
      operations: [],
      now: '2026-01-01T00:03:00Z',
      newVersionId: 'v2',
    });

    expect(result.version).toBe(2);
  });
});

// ── 辅助：在已有版本上篡改锁定字段 ──────────────────────────

function tamperWithLocks(db: ProjectDatabase, versionId: string, lockedPaths: string[]) {
  const version = db.getCreationContractVersionRepository().getById('p1', versionId);
  const newSnapshotHash = sha256Utf8(
    canonicalSerializeContractSnapshot({
      sections: validateCreationContractSections(JSON.parse(version!.sectionsJson)),
      lockedFieldPaths: lockedPaths,
      schemaVersion: 1,
    }),
  );

  db.database.exec('DROP TRIGGER IF EXISTS trg_cc_versions_no_update');
  db.database
    .prepare(
      `UPDATE creation_contract_versions
       SET locked_field_paths_json = ?,
           contract_snapshot_hash = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(lockedPaths), newSnapshotHash, versionId);
  db.database.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_cc_versions_no_update
    BEFORE UPDATE ON creation_contract_versions
    BEGIN
      SELECT RAISE(ABORT, 'creation_contract_versions is append-only');
    END;
  `);
}

// ── Lock bypass: proposal source vs locks ──────────────────────

describe('lock bypass: proposal source validation', () => {
  let dir: string;
  let db: ProjectDatabase;
  let deps: CreationContractMutationDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-lock-bypass-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    const txPort = new CreationContractTransactionPortImpl(db.database);
    deps = { transactionPort: txPort, sha256Port: { digestUtf8: sha256Utf8 } };
    setupProject(db, 'p1');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('empty ops + proposal source violates locked scalar → MODEL_LOCK_VIOLATION', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    tamperWithLocks(db, 'v1', ['/premise']);

    const modifiedSections = makeSections({ premise: 'AI changed premise' });
    setupProposal(db, 'p1', 'prop2', {
      baseContractVersion: 1,
      sections: modifiedSections,
    });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      }),
    ).toThrow(ContractModelLockViolationError);
  });

  it('unrelated op + proposal source violates locked scalar → MODEL_LOCK_VIOLATION', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    tamperWithLocks(db, 'v1', ['/premise']);

    const modifiedSections = makeSections({ premise: 'AI changed premise' });
    setupProposal(db, 'p1', 'prop2', {
      baseContractVersion: 1,
      sections: modifiedSections,
    });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/targetAudience', value: 'young adults' }],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      }),
    ).toThrow(ContractModelLockViolationError);
  });

  it('locked absent optional added by proposal → MODEL_LOCK_VIOLATION', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    tamperWithLocks(db, 'v1', ['/themes']);

    const modifiedSections = makeSections({ themes: ['redemption'] });
    setupProposal(db, 'p1', 'prop2', {
      baseContractVersion: 1,
      sections: modifiedSections,
    });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      }),
    ).toThrow(ContractModelLockViolationError);
  });

  it('explicit op on locked path → LOCK_CONFLICT', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    tamperWithLocks(db, 'v1', ['/premise']);

    setupProposal(db, 'p1', 'prop2', { baseContractVersion: 1 });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'User override' }],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      }),
    ).toThrow(ContractLockConflictError);
  });

  it('lock violation has no side effects', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    tamperWithLocks(db, 'v1', ['/premise']);

    const modifiedSections = makeSections({ premise: 'AI changed premise' });
    setupProposal(db, 'p1', 'prop2', {
      baseContractVersion: 1,
      sections: modifiedSections,
    });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      }),
    ).toThrow(ContractModelLockViolationError);

    expect(db.getCreationContractProposalRepository().getById('p1', 'prop2')?.status).toBe(
      'PROPOSED',
    );
    expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
    const current = db.getCreationContractCurrentRepository().get('p1');
    expect(current?.currentVersionId).toBe('v1');
  });
});

// ── Runtime validation ─────────────────────────────────────────

describe('runtime operation parsing', () => {
  let dir: string;
  let db: ProjectDatabase;
  let deps: CreationContractMutationDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-runtime-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    const txPort = new CreationContractTransactionPortImpl(db.database);
    deps = { transactionPort: txPort, sha256Port: { digestUtf8: sha256Utf8 } };
    setupProject(db, 'p1');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('unknown operation kind → ContractValidationError', () => {
    setupProposal(db, 'p1', 'prop1');

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [
          { kind: 'unknown-op', path: '/premise', value: 'x' },
        ] as unknown as ContractPatchOperation[],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      }),
    ).toThrow(ContractValidationError);
  });

  it('invalid ISO-8601 now → ValidationError', () => {
    setupProposal(db, 'p1', 'prop1');

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: 'not-a-timestamp',
        newVersionId: 'v1',
      }),
    ).toThrow(ValidationError);
  });

  it('reject with invalid now → ValidationError', () => {
    setupProposal(db, 'p1', 'prop1');

    expect(() =>
      rejectCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        now: 'Jan 2026',
      }),
    ).toThrow(ValidationError);
  });
});

// ── Provenance correctness ─────────────────────────────────────

describe('provenance correctness', () => {
  let dir: string;
  let db: ProjectDatabase;
  let deps: CreationContractMutationDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-prov-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    const txPort = new CreationContractTransactionPortImpl(db.database);
    deps = { transactionPort: txPort, sha256Port: { digestUtf8: sha256Utf8 } };
    setupProject(db, 'p1');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('first contract: all fields are AI_PROPOSAL', () => {
    setupProposal(db, 'p1', 'prop1');

    const result = acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    expect(result.provenance.length).toBeGreaterThan(0);
    for (const entry of result.provenance) {
      expect(entry.source).toBe('AI_PROPOSAL');
      expect(entry.sourceProposalId).toBe('prop1');
      expect(entry.aiTaskId).toBeTruthy();
    }
  });

  it('scalar USER_EDIT via set-scalar operation', () => {
    setupProposal(db, 'p1', 'prop1');

    const result = acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [{ kind: 'set-scalar', path: '/premise', value: 'User edited premise' }],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    const premiseEntry = result.provenance.find((p) => p.sectionKey === '/premise');
    expect(premiseEntry).toBeDefined();
    expect(premiseEntry!.source).toBe('USER_EDIT');

    const genreEntry = result.provenance.find((p) => p.sectionKey === '/genre');
    expect(genreEntry).toBeDefined();
    expect(genreEntry!.source).toBe('AI_PROPOSAL');
  });

  it('structured parent USER_EDIT propagates to descendants', () => {
    setupProposal(db, 'p1', 'prop1', {
      sections: makeSections({ contentBoundaries: { rating: 'PG' } }),
    });

    const result = acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(
        makeSections({ contentBoundaries: { rating: 'PG' } }),
      ),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [{ kind: 'set-structured', path: '/contentBoundaries', value: { rating: 'R' } }],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    const parentEntry = result.provenance.find((p) => p.sectionKey === '/contentBoundaries');
    expect(parentEntry?.source).toBe('USER_EDIT');

    const childEntry = result.provenance.find((p) => p.sectionKey === '/contentBoundaries/rating');
    expect(childEntry?.source).toBe('USER_EDIT');
  });

  it('unchanged fields are PREVIOUS_VERSION with carried-forward IDs', () => {
    setupProposal(db, 'p1', 'prop1');
    const v1 = acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    setupProposal(db, 'p1', 'prop2', {
      baseContractVersion: 1,
      sections: makeSections({ premise: 'Changed by AI' }),
    });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    const v2 = acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop2',
      expectedProposalSectionsHash: prop2.sectionsHash,
      expectedGrillSessionVersion: 1,
      expectedContractVersion: 1,
      operations: [],
      now: '2026-01-01T00:03:00Z',
      newVersionId: 'v2',
    });

    const premiseEntry = v2.provenance.find((p) => p.sectionKey === '/premise');
    expect(premiseEntry?.source).toBe('AI_PROPOSAL');

    const genreEntry = v2.provenance.find((p) => p.sectionKey === '/genre');
    expect(genreEntry?.source).toBe('PREVIOUS_VERSION');
    expect(genreEntry?.aiTaskId).toBeTruthy();
    expect(genreEntry?.sourceProposalId).toBeTruthy();

    const v1Genre = v1.provenance.find((p) => p.sectionKey === '/genre');
    expect(genreEntry?.aiTaskId).toBe(v1Genre?.aiTaskId);
    expect(genreEntry?.sourceProposalId).toBe(v1Genre?.sourceProposalId);
  });

  it('first contract with operations: USER_EDIT + AI_PROPOSAL mix', () => {
    setupProposal(db, 'p1', 'prop1');

    const result = acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [
        { kind: 'set-scalar', path: '/premise', value: 'User edited' },
        { kind: 'set-string-list', path: '/genre', value: ['fantasy'] },
      ],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    const sources = new Map(result.provenance.map((p) => [p.sectionKey, p.source]));
    expect(sources.get('/premise')).toBe('USER_EDIT');
    expect(sources.get('/genre')).toBe('USER_EDIT');
    expect(sources.get('/tone')).toBe('AI_PROPOSAL');
    expect(sources.get('/protagonist')).toBe('AI_PROPOSAL');
  });
});

// ── Atomicity rollback ─────────────────────────────────────────

describe('atomicity: rollback after proposal CAS', () => {
  let dir: string;
  let db: ProjectDatabase;
  let deps: CreationContractMutationDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-atomic-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    const txPort = new CreationContractTransactionPortImpl(db.database);
    deps = { transactionPort: txPort, sha256Port: { digestUtf8: sha256Utf8 } };
    setupProject(db, 'p1');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lock conflict after CAS: proposal status rolled back', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    tamperWithLocks(db, 'v1', ['/premise']);

    setupProposal(db, 'p1', 'prop2', { baseContractVersion: 1 });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'Override' }],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      }),
    ).toThrow(ContractLockConflictError);

    expect(db.getCreationContractProposalRepository().getById('p1', 'prop2')?.status).toBe(
      'PROPOSED',
    );
    expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
  });

  it('duplicate version ID: full rollback after proposal CAS', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    setupProposal(db, 'p1', 'prop2', { baseContractVersion: 1 });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    expect(() =>
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v1',
      }),
    ).toThrow(ContractTransactionError);

    expect(db.getCreationContractProposalRepository().getById('p1', 'prop2')?.status).toBe(
      'PROPOSED',
    );
    expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
    expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
  });
});

// ── 安全错误消息 ──────────────────────────────────────────────

const SENSITIVE_FRAGMENTS = [
  '/Users/',
  '/home/',
  '.sqlite',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'database is locked',
  'BEGIN IMMEDIATE',
  'creation_contract_',
  'sections_json',
  'provenance_json',
  'UNIQUE constraint',
  'at ',
];

function expectSafeError(
  e: unknown,
  expectedClass: new (...args: never[]) => Error,
  code: string,
  expectedMessage: string,
): void {
  expect(e).toBeInstanceOf(expectedClass);
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe(code);
  expect((e as Error).message).toBe(expectedMessage);
  for (const fragment of SENSITIVE_FRAGMENTS) {
    expect((e as Error).message).not.toContain(fragment);
  }
  // public message 不含堆栈
  expect((e as Error).message).not.toContain('\n');
}

function expectCauseDetail(e: unknown, detailFragment: string): void {
  // 沿 cause 链逐层查找（diagnostic wrapper → 原始 cause）
  let current: unknown = (e as AppError).cause;
  expect(current).toBeDefined();
  for (let depth = 0; depth < 4 && current !== undefined; depth++) {
    if (current instanceof Error) {
      if (current.message.includes(detailFragment)) return;
      current = current.cause;
    } else {
      if (String(current).includes(detailFragment)) return;
      current = undefined;
    }
  }
  expect.unreachable(`cause 链中未找到细节: ${detailFragment}`);
}

describe('safe error messages', () => {
  let dir: string;
  let db: ProjectDatabase;
  let deps: CreationContractMutationDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-safe-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    const txPort = new CreationContractTransactionPortImpl(db.database);
    deps = { transactionPort: txPort, sha256Port: { digestUtf8: sha256Utf8 } };
    setupProject(db, 'p1');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('model lock violation: fixed message, no locked path, cause preserves path', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    tamperWithLocks(db, 'v1', ['/premise']);

    const modifiedSections = makeSections({ premise: 'AI changed premise' });
    setupProposal(db, 'p1', 'prop2', {
      baseContractVersion: 1,
      sections: modifiedSections,
    });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    try {
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('expected ContractModelLockViolationError');
    } catch (e) {
      expectSafeError(
        e,
        ContractModelLockViolationError,
        'CONTRACT_MODEL_LOCK_VIOLATION',
        '模型输出修改了受保护的契约字段',
      );
      expectCauseDetail(e, '/premise');
    }
  });

  it('lock conflict: fixed message, no operation path, cause preserves path', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    tamperWithLocks(db, 'v1', ['/premise']);

    setupProposal(db, 'p1', 'prop2', { baseContractVersion: 1 });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    try {
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'User override' }],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('expected ContractLockConflictError');
    } catch (e) {
      expectSafeError(
        e,
        ContractLockConflictError,
        'CONTRACT_LOCK_CONFLICT',
        '操作与受保护的契约字段冲突',
      );
      expectCauseDetail(e, '/premise');
    }
  });

  it('runtime operation parse failure: fixed message, no index/raw error, cause preserves detail', () => {
    setupProposal(db, 'p1', 'prop1');

    try {
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [{ kind: 'unknown-op', path: '/premise', value: 'x' }] as unknown as ContractPatchOperation[],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      });
      expect.unreachable('expected ContractValidationError');
    } catch (e) {
      expectSafeError(e, ContractValidationError, 'CONTRACT_VALIDATION_FAILED', '创作契约内容验证失败');
      expectCauseDetail(e, 'operation[0] 解析失败');
      expectCauseDetail(e, '未知 operation kind');
    }
  });

  it('operation apply failure: fixed message, no raw validator message in public text', () => {
    setupProposal(db, 'p1', 'prop1');

    try {
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [{ kind: 'set-scalar', path: '/premise', value: '' }],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      });
      expect.unreachable('expected ContractValidationError');
    } catch (e) {
      expectSafeError(e, ContractValidationError, 'CONTRACT_VALIDATION_FAILED', '创作契约内容验证失败');
      expectCauseDetail(e, 'operation 应用失败');
    }
  });

  it('not acceptable: fixed message, no raw status, cause preserves status', () => {
    setupProposal(db, 'p1', 'prop1', { status: 'ACCEPTED' });

    try {
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      });
      expect.unreachable('expected ContractProposalNotAcceptableError');
    } catch (e) {
      expectSafeError(
        e,
        ContractProposalNotAcceptableError,
        'CONTRACT_PROPOSAL_NOT_ACCEPTABLE',
        '创作契约提案当前状态不允许此操作',
      );
      expectCauseDetail(e, 'ACCEPTED');
    }
  });

  it('stale: fixed message, no hash leak, cause preserves detail', () => {
    setupProposal(db, 'p1', 'prop1');

    try {
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: 'f'.repeat(64),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      });
      expect.unreachable('expected ContractProposalStaleError');
    } catch (e) {
      expectSafeError(e, ContractProposalStaleError, 'CONTRACT_PROPOSAL_STALE', '创作契约提案已过期，请重新生成');
      expect((e as Error).message).not.toContain('f'.repeat(64));
      expectCauseDetail(e, 'sectionsHash mismatch');
    }
  });

  it('version conflict: fixed message, no version number, cause preserves detail', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    setupProposal(db, 'p1', 'prop2');
    try {
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 999,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('expected ContractVersionConflictError');
    } catch (e) {
      expectSafeError(e, ContractVersionConflictError, 'CONTRACT_VERSION_CONFLICT', '创作契约版本已变化，请刷新后重试');
      expect((e as Error).message).not.toContain('999');
      expectCauseDetail(e, 'contract version mismatch');
    }
  });

  it('schema unsupported: fixed message, no schemaVersion leak', () => {
    // 真实 DB 有 CHECK (schema_version = 1) 挡住非法行，用 fake transaction port
    // 模拟一个 schemaVersion 不支持的 proposal（不可变约束下该状态只能来自损坏/升级）
    const fakeProposal: CreationContractProposalData = {
      id: 'prop1',
      projectId: 'p1',
      taskId: 'task-prop1',
      invocationId: 'inv-prop1',
      status: 'PROPOSED',
      baseGrillSessionId: 'gs-p1',
      baseGrillSessionVersion: 1,
      baseContractVersion: null,
      schemaVersion: 2,
      sectionsJson: makeSectionsJson(),
      sectionsHash: makeSectionsHash(),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const fakeRepos = {
      projectExistsReadPort: { exists: () => true },
      proposalRepo: { getById: () => fakeProposal },
    } as unknown as CreationContractTransactionRepositories;
    const fakeDeps: CreationContractMutationDeps = {
      transactionPort: { runInTransaction: (op) => op(fakeRepos) },
      sha256Port: { digestUtf8: sha256Utf8 },
    };

    try {
      acceptCreationContractProposal(fakeDeps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      });
      expect.unreachable('expected ContractSchemaUnsupportedError');
    } catch (e) {
      expectSafeError(e, ContractSchemaUnsupportedError, 'CONTRACT_SCHEMA_UNSUPPORTED', '创作契约 schema 版本不受支持');
      expect((e as Error).message).not.toContain('2');
      expectCauseDetail(e, 'schemaVersion 2');
    }
  });

  it('data corruption: fixed message, no SQL/column/absolute path, cause preserves detail', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    // 篡改权威版本 sections_json 使其非 canonical（模拟损坏）
    db.database.exec('DROP TRIGGER IF EXISTS trg_cc_versions_no_update');
    db.database
      .prepare(`UPDATE creation_contract_versions SET sections_json = ? WHERE id = 'v1'`)
      .run(JSON.stringify({ premise: 'not canonical ordering' }));
    db.database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_cc_versions_no_update
      BEFORE UPDATE ON creation_contract_versions
      BEGIN
        SELECT RAISE(ABORT, 'creation_contract_versions is append-only');
      END;
    `);

    setupProposal(db, 'p1', 'prop2', { baseContractVersion: 1 });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    try {
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('expected ContractDataCorruptionError');
    } catch (e) {
      expectSafeError(e, ContractDataCorruptionError, 'INTERNAL_ERROR', '创作契约数据完整性异常');
      expectCauseDetail(e, 'sections_json');
    }
  });

  it('proposal not found keeps project-convention proposalId in public message', () => {
    try {
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'missing-prop',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      });
      expect.unreachable('expected ContractProposalNotFoundError');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractProposalNotFoundError);
      expect((e as AppError).code).toBe('CONTRACT_PROPOSAL_NOT_FOUND');
      expect((e as Error).message).toBe('创作契约提案 missing-prop 不存在');
    }
  });
});

// ── 真实双连接并发 ────────────────────────────────────────────

describe('real two-connection contention', () => {
  let dir: string;
  let dbA: ProjectDatabase;
  let dbB: ProjectDatabase;
  let depsA: CreationContractMutationDeps;
  let depsB: CreationContractMutationDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-2conn-'));
    const path = join(dir, 'project.sqlite');
    dbA = new ProjectDatabase(path);
    dbB = new ProjectDatabase(path);
    // B 的 busy_timeout 设为 0：BEGIN IMMEDIATE 立即失败，不等待 5s
    dbB.database.exec('PRAGMA busy_timeout = 0');
    depsA = {
      transactionPort: new CreationContractTransactionPortImpl(dbA.database),
      sha256Port: { digestUtf8: sha256Utf8 },
    };
    depsB = {
      transactionPort: new CreationContractTransactionPortImpl(dbB.database),
      sha256Port: { digestUtf8: sha256Utf8 },
    };
    setupProject(dbA, 'p1');
  });

  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
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

  it('B BEGIN IMMEDIATE busy while A holds write lock: stable busy error, no side effects, no auto retry', () => {
    setupProposal(dbA, 'p1', 'prop1');
    holdWriteLock(dbA, 'holder-1');

    try {
      acceptCreationContractProposal(depsB, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      });
      expect.unreachable('B should fail with busy');
    } catch (e) {
      expectBusyConflict(e);
    }

    // B 无任何副作用：proposal 未 CAS、无 version、无 pointer
    expect(dbA.getCreationContractProposalRepository().getById('p1', 'prop1')?.status).toBe(
      'PROPOSED',
    );
    expect(dbA.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(0);
    expect(dbA.getCreationContractCurrentRepository().get('p1')).toBeNull();

    // A 释放后 B 手动重试成功（adapter 不自动 retry，单次调用立即失败）
    dbA.database.exec('COMMIT');
    const result = acceptCreationContractProposal(depsB, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:03:00Z',
      newVersionId: 'v1',
    });
    expect(result.version).toBe(1);
  });

  it('first contract contention: both based on expectedContractVersion=null, only one version 1', () => {
    setupProposal(dbA, 'p1', 'propA');
    setupProposal(dbA, 'p1', 'propB');
    const hashA = dbA.getCreationContractProposalRepository().getById('p1', 'propA')!.sectionsHash;
    const hashB = dbA.getCreationContractProposalRepository().getById('p1', 'propB')!.sectionsHash;

    holdWriteLock(dbA, 'holder-2');
    try {
      acceptCreationContractProposal(depsB, {
        projectId: 'p1',
        proposalId: 'propB',
        expectedProposalSectionsHash: hashB,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1b',
      });
      expect.unreachable('B should fail with busy');
    } catch (e) {
      expectBusyConflict(e);
    }
    // B 失败期间没有错误提交任何状态
    expect(dbA.getCreationContractProposalRepository().getById('p1', 'propB')?.status).toBe(
      'PROPOSED',
    );
    dbA.database.exec('COMMIT');

    // A 成功创建 version 1
    const r = acceptCreationContractProposal(depsA, {
      projectId: 'p1',
      proposalId: 'propA',
      expectedProposalSectionsHash: hashA,
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:03:00Z',
      newVersionId: 'v1a',
    });
    expect(r.version).toBe(1);

    // B 重试（仍基于 null）→ 稳定 precondition conflict（非 busy）
    try {
      acceptCreationContractProposal(depsB, {
        projectId: 'p1',
        proposalId: 'propB',
        expectedProposalSectionsHash: hashB,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:04:00Z',
        newVersionId: 'v1b',
      });
      expect.unreachable('B should fail with version conflict');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractVersionConflictError);
      expect((e as AppError).code).toBe('CONTRACT_VERSION_CONFLICT');
    }

    // 最终状态：只有一个 version 1，pointer 指向成功版本，无孤立版本
    const versions = dbA.getCreationContractVersionRepository().listSummaries('p1');
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe('v1a');
    expect(versions[0].version).toBe(1);
    expect(dbA.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1a');
    expect(dbA.getCreationContractProposalRepository().getById('p1', 'propB')?.status).toBe(
      'PROPOSED',
    );
  });

  it('existing version contention: both based on version 1, only one version 2', () => {
    setupProposal(dbA, 'p1', 'prop1');
    acceptCreationContractProposal(depsA, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    setupProposal(dbA, 'p1', 'prop2a', { baseContractVersion: 1 });
    setupProposal(dbA, 'p1', 'prop2b', { baseContractVersion: 1 });
    const hash2a = dbA.getCreationContractProposalRepository().getById('p1', 'prop2a')!.sectionsHash;
    const hash2b = dbA.getCreationContractProposalRepository().getById('p1', 'prop2b')!.sectionsHash;

    holdWriteLock(dbA, 'holder-3');
    try {
      acceptCreationContractProposal(depsB, {
        projectId: 'p1',
        proposalId: 'prop2b',
        expectedProposalSectionsHash: hash2b,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2b',
      });
      expect.unreachable('B should fail with busy');
    } catch (e) {
      expectBusyConflict(e);
    }
    expect(dbA.getCreationContractProposalRepository().getById('p1', 'prop2b')?.status).toBe(
      'PROPOSED',
    );
    dbA.database.exec('COMMIT');

    // A 成功创建 version 2
    const r = acceptCreationContractProposal(depsA, {
      projectId: 'p1',
      proposalId: 'prop2a',
      expectedProposalSectionsHash: hash2a,
      expectedGrillSessionVersion: 1,
      expectedContractVersion: 1,
      operations: [],
      now: '2026-01-01T00:04:00Z',
      newVersionId: 'v2a',
    });
    expect(r.version).toBe(2);

    // B 重试（仍基于 version 1）→ 稳定 precondition conflict
    try {
      acceptCreationContractProposal(depsB, {
        projectId: 'p1',
        proposalId: 'prop2b',
        expectedProposalSectionsHash: hash2b,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:05:00Z',
        newVersionId: 'v2b',
      });
      expect.unreachable('B should fail with version conflict');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractVersionConflictError);
    }

    // 不存在两个 version 2、不存在孤立版本
    const versions = dbA.getCreationContractVersionRepository().listSummaries('p1');
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.id).sort()).toEqual(['v1', 'v2a']);
    expect(versions.filter((v) => v.version === 2)).toHaveLength(1);
    expect(dbA.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v2a');
    expect(dbA.getCreationContractProposalRepository().getById('p1', 'prop2b')?.status).toBe(
      'PROPOSED',
    );
  });

  it('accept/reject contention: B reject busy while A holds lock; single status CAS after release', () => {
    setupProposal(dbA, 'p1', 'prop1');
    const hash = dbA.getCreationContractProposalRepository().getById('p1', 'prop1')!.sectionsHash;

    holdWriteLock(dbA, 'holder-4');
    try {
      rejectCreationContractProposal(depsB, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: hash,
        now: '2026-01-01T00:02:00Z',
      });
      expect.unreachable('B reject should fail with busy');
    } catch (e) {
      expectBusyConflict(e);
    }
    // B 失败方无 version/current/lock-event 副作用
    expect(dbA.getCreationContractProposalRepository().getById('p1', 'prop1')?.status).toBe(
      'PROPOSED',
    );
    expect(dbA.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(0);
    expect(dbA.getCreationContractCurrentRepository().get('p1')).toBeNull();
    expect(dbA.getCreationContractLockEventRepository().listByProject('p1')).toHaveLength(0);
    dbA.database.exec('COMMIT');

    // A 接受成功
    const r = acceptCreationContractProposal(depsA, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: hash,
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:03:00Z',
      newVersionId: 'v1',
    });
    expect(r.version).toBe(1);

    // B 重试 reject → 已 ACCEPTED → 稳定 not-acceptable
    try {
      rejectCreationContractProposal(depsB, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: hash,
        now: '2026-01-01T00:04:00Z',
      });
      expect.unreachable('B reject should fail with not-acceptable');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractProposalNotAcceptableError);
      expect((e as AppError).code).toBe('CONTRACT_PROPOSAL_NOT_ACCEPTABLE');
    }

    // 最终状态：proposal ACCEPTED，一个 version，无 lock events
    expect(dbA.getCreationContractProposalRepository().getById('p1', 'prop1')?.status).toBe(
      'ACCEPTED',
    );
    expect(dbA.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
    expect(dbA.getCreationContractLockEventRepository().listByProject('p1')).toHaveLength(0);
  });
});

// ── Sha256Port 输出验证 ───────────────────────────────────────

describe('sha256 port output validation', () => {
  let dir: string;
  let db: ProjectDatabase;
  let txPort: CreationContractTransactionPortImpl;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-sha-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    txPort = new CreationContractTransactionPortImpl(db.database);
    setupProject(db, 'p1');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function expectHashPortRejection(deps: CreationContractMutationDeps, versionId: string): void {
    try {
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: versionId,
      });
      expect.unreachable('invalid sha256 port output should be rejected');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractDataCorruptionError);
      expect((e as AppError).code).toBe('INTERNAL_ERROR');
      expect((e as Error).message).toBe('创作契约数据完整性异常');
      expectCauseDetail(e, 'sha256 port');
    }
    // 失败后完整回滚：proposal CAS 撤销、无 version、无 pointer
    expect(db.getCreationContractProposalRepository().getById('p1', 'prop1')?.status).toBe(
      'PROPOSED',
    );
    expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(0);
    expect(db.getCreationContractCurrentRepository().get('p1')).toBeNull();
  }

  it('adapter returning non-hex snapshot hash fails before version create and rolls back', () => {
    setupProposal(db, 'p1', 'prop1');
    expectHashPortRejection(
      { transactionPort: txPort, sha256Port: { digestUtf8: () => 'not-a-hash' } },
      'v1',
    );
  });

  it('adapter returning uppercase hash fails and rolls back', () => {
    setupProposal(db, 'p1', 'prop1');
    expectHashPortRejection(
      { transactionPort: txPort, sha256Port: { digestUtf8: () => 'A'.repeat(64) } },
      'v1',
    );
  });

  it('adapter returning wrong-length hash fails and rolls back', () => {
    setupProposal(db, 'p1', 'prop1');
    expectHashPortRejection(
      { transactionPort: txPort, sha256Port: { digestUtf8: () => 'ab' } },
      'v1',
    );
  });

  it('adapter returning empty string fails and rolls back', () => {
    setupProposal(db, 'p1', 'prop1');
    expectHashPortRejection(
      { transactionPort: txPort, sha256Port: { digestUtf8: () => '' } },
      'v1',
    );
  });

  it('invalid previousFieldHash adapter output fails and rolls back (USER_EDIT path)', () => {
    setupProposal(db, 'p1', 'prop1');
    // 第一次 digest（previousFieldHash）返回非法值，后续（snapshot hash）正常
    let calls = 0;
    const badDeps: CreationContractMutationDeps = {
      transactionPort: txPort,
      sha256Port: {
        digestUtf8: (input) => {
          calls += 1;
          return calls === 1 ? 'bad-previous-field-hash' : sha256Utf8(input);
        },
      },
    };

    try {
      acceptCreationContractProposal(badDeps, {
        projectId: 'p1',
        proposalId: 'prop1',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: null,
        operations: [{ kind: 'set-scalar', path: '/premise', value: 'User edited premise' }],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v1',
      });
      expect.unreachable('invalid previousFieldHash should be rejected');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractDataCorruptionError);
      expect((e as AppError).code).toBe('INTERNAL_ERROR');
      expectCauseDetail(e, 'previousFieldHash');
    }
    // 完整回滚
    expect(db.getCreationContractProposalRepository().getById('p1', 'prop1')?.status).toBe(
      'PROPOSED',
    );
    expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(0);
    expect(db.getCreationContractCurrentRepository().get('p1')).toBeNull();
  });
});

// ── Provenance 损坏处理 ───────────────────────────────────────

describe('provenance corruption handling', () => {
  let dir: string;
  let db: ProjectDatabase;
  let deps: CreationContractMutationDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-provcorr-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    const txPort = new CreationContractTransactionPortImpl(db.database);
    deps = { transactionPort: txPort, sha256Port: { digestUtf8: sha256Utf8 } };
    setupProject(db, 'p1');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('authoritative version with corrupt provenance_json → ContractDataCorruptionError, no side effects', () => {
    setupProposal(db, 'p1', 'prop1');
    acceptCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
      expectedProposalSectionsHash: makeSectionsHash(),
      expectedGrillSessionVersion: 1,
      expectedContractVersion: null,
      operations: [],
      now: '2026-01-01T00:02:00Z',
      newVersionId: 'v1',
    });

    // 篡改权威版本 provenance_json 为合法 JSON 但结构非法（模拟损坏；
    // 完全非 JSON 的值会被表级 json_valid CHECK 拦截，非 JSON 路径由 fake-port 测试覆盖）
    db.database.exec('DROP TRIGGER IF EXISTS trg_cc_versions_no_update');
    db.database
      .prepare(`UPDATE creation_contract_versions SET provenance_json = '{}' WHERE id = 'v1'`)
      .run();
    db.database.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_cc_versions_no_update
      BEFORE UPDATE ON creation_contract_versions
      BEGIN
        SELECT RAISE(ABORT, 'creation_contract_versions is append-only');
      END;
    `);

    setupProposal(db, 'p1', 'prop2', { baseContractVersion: 1 });
    const prop2 = db.getCreationContractProposalRepository().getById('p1', 'prop2')!;

    try {
      acceptCreationContractProposal(deps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: prop2.sectionsHash,
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:03:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('corrupt provenance should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractDataCorruptionError);
      expect((e as AppError).code).toBe('INTERNAL_ERROR');
      expect((e as Error).message).toBe('创作契约数据完整性异常');
      expectCauseDetail(e, 'provenance');
    }

    // 无副作用（v1 行本身已损坏，用原始 SQL 计数而不是走读取校验路径）
    expect(db.getCreationContractProposalRepository().getById('p1', 'prop2')?.status).toBe(
      'PROPOSED',
    );
    const versionCount = db.database
      .prepare('SELECT COUNT(*) AS n FROM creation_contract_versions WHERE project_id = ?')
      .get('p1') as { n: number };
    expect(versionCount.n).toBe(1);
    expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
  });

  it('use case must not silently degrade corrupt previous provenance to empty (fake port)', () => {
    // 通过 fake transaction port 模拟一个绕过了 repository 校验的损坏 provenance
    const fakeProposal: CreationContractProposalData = {
      id: 'prop2',
      projectId: 'p1',
      taskId: 'task-prop2',
      invocationId: 'inv-prop2',
      status: 'PROPOSED',
      baseGrillSessionId: 'gs-p1',
      baseGrillSessionVersion: 1,
      baseContractVersion: 1,
      schemaVersion: 1,
      sectionsJson: makeSectionsJson(),
      sectionsHash: makeSectionsHash(),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const corruptVersion = {
      id: 'v1',
      projectId: 'p1',
      version: 1,
      schemaVersion: 1,
      sourceProposalId: 'prop1',
      basedOnGrillSessionId: 'gs-p1',
      basedOnGrillSessionVersion: 1,
      sectionsJson: makeSectionsJson(),
      lockedFieldPathsJson: '[]',
      contractSnapshotHash: makeSnapshotHash(),
      provenanceJson: 'corrupt-{',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'ai-proposal-accepted',
    };
    const fakeRepos = {
      projectExistsReadPort: { exists: () => true },
      proposalRepo: { getById: () => fakeProposal, transitionStatusWithHash: () => true },
      versionRepo: { getById: () => corruptVersion },
      currentRepo: { get: () => ({ projectId: 'p1', currentVersionId: 'v1', updatedAt: '2026-01-01T00:00:00Z' }) },
      grillSessionVersionReadPort: { getVersion: () => 1 },
    } as unknown as CreationContractTransactionRepositories;
    const fakeDeps: CreationContractMutationDeps = {
      transactionPort: { runInTransaction: (op) => op(fakeRepos) },
      sha256Port: { digestUtf8: sha256Utf8 },
    };

    try {
      acceptCreationContractProposal(fakeDeps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('corrupt previous provenance must throw, not degrade');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractDataCorruptionError);
      expect((e as AppError).code).toBe('INTERNAL_ERROR');
      expect((e as Error).message).toBe('创作契约数据完整性异常');
      expectCauseDetail(e, 'provenanceJson');
    }
  });

  it('previous provenance entry with invalid source is rejected, not carried forward', () => {
    // fake port：previous provenance 数组结构存在但 entry 非法
    const fakeProposal: CreationContractProposalData = {
      id: 'prop2',
      projectId: 'p1',
      taskId: 'task-prop2',
      invocationId: 'inv-prop2',
      status: 'PROPOSED',
      baseGrillSessionId: 'gs-p1',
      baseGrillSessionVersion: 1,
      baseContractVersion: 1,
      schemaVersion: 1,
      sectionsJson: makeSectionsJson(),
      sectionsHash: makeSectionsHash(),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const corruptVersion = {
      id: 'v1',
      projectId: 'p1',
      version: 1,
      schemaVersion: 1,
      sourceProposalId: 'prop1',
      basedOnGrillSessionId: 'gs-p1',
      basedOnGrillSessionVersion: 1,
      sectionsJson: makeSectionsJson(),
      lockedFieldPathsJson: '[]',
      contractSnapshotHash: makeSnapshotHash(),
      provenanceJson: JSON.stringify([{ sectionKey: 42 }]),
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'ai-proposal-accepted',
    };
    const fakeRepos = {
      projectExistsReadPort: { exists: () => true },
      proposalRepo: { getById: () => fakeProposal, transitionStatusWithHash: () => true },
      versionRepo: { getById: () => corruptVersion },
      currentRepo: { get: () => ({ projectId: 'p1', currentVersionId: 'v1', updatedAt: '2026-01-01T00:00:00Z' }) },
      grillSessionVersionReadPort: { getVersion: () => 1 },
    } as unknown as CreationContractTransactionRepositories;
    const fakeDeps: CreationContractMutationDeps = {
      transactionPort: { runInTransaction: (op) => op(fakeRepos) },
      sha256Port: { digestUtf8: sha256Utf8 },
    };

    try {
      acceptCreationContractProposal(fakeDeps, {
        projectId: 'p1',
        proposalId: 'prop2',
        expectedProposalSectionsHash: makeSectionsHash(),
        expectedGrillSessionVersion: 1,
        expectedContractVersion: 1,
        operations: [],
        now: '2026-01-01T00:02:00Z',
        newVersionId: 'v2',
      });
      expect.unreachable('invalid provenance entry must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ContractDataCorruptionError);
      expect((e as AppError).code).toBe('INTERNAL_ERROR');
      expectCauseDetail(e, 'sectionKey');
    }
  });
});
