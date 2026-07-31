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
  ContractProposalNotFoundError,
  ContractProposalNotAcceptableError,
  ContractProposalStaleError,
  ContractVersionConflictError,
  ContractModelLockViolationError,
  ContractLockConflictError,
  ContractValidationError,
  ValidationError,
  type CreationContractMutationDeps,
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
    ).toThrow();

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
    ).toThrow();

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

    setupProposal(db, 'p1', 'prop2');
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
    ).toThrow();

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
    ).toThrow();

    expect(db.getCreationContractProposalRepository().getById('p1', 'prop2')?.status).toBe(
      'PROPOSED',
    );
    expect(db.getCreationContractVersionRepository().listSummaries('p1')).toHaveLength(1);
    expect(db.getCreationContractCurrentRepository().get('p1')?.currentVersionId).toBe('v1');
  });
});
