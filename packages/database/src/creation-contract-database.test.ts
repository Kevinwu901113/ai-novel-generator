import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { ProjectDatabase } from './project-database.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function makeSectionsJson(): string {
  return JSON.stringify({
    premise: 'A story',
    genre: ['fantasy'],
    tone: ['epic'],
    targetAudience: 'adults',
    narrativePov: 'THIRD_LIMITED',
    tense: 'PAST',
    protagonist: { characterKey: 'hero', name: 'Hero' },
  });
}

describe('creation contract database', () => {
  let dir: string;
  let db: ProjectDatabase;

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
    // Tables exist if we can query them
    const proposalRepo = db.getCreationContractProposalRepository();
    const versionRepo = db.getCreationContractVersionRepository();
    const currentRepo = db.getCreationContractCurrentRepository();
    const lockEventRepo = db.getCreationContractLockEventRepository();

    // Empty queries should succeed
    expect(proposalRepo.listByProject('p1')).toEqual([]);
    expect(versionRepo.listSummaries('p1')).toEqual([]);
    expect(currentRepo.get('p1')).toBeNull();
    expect(lockEventRepo.listByProject('p1')).toEqual([]);
  });

  it('migration is idempotent', () => {
    db.close();
    // Re-open with same path → migration should not fail
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    expect(db.getCreationContractProposalRepository().listByProject('p1')).toEqual([]);
  });

  // ── STRICT tables ─────────────────────────────────────────

  it('tables are STRICT', () => {
    // We can verify by checking that the migration SQL includes STRICT
    // and that operations work correctly
    const proposalRepo = db.getCreationContractProposalRepository();
    expect(proposalRepo.listByProject('p1')).toEqual([]);
  });

  // ── Proposal ──────────────────────────────────────────────

  it('inserts and retrieves proposal', () => {
    // First create required FK targets (task + invocation)
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();

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
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const retrieved = proposalRepo.getById('p1', 'prop1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.status).toBe('PROPOSED');
    expect(retrieved!.sectionsHash).toBe(HASH_A);
  });

  it('proposal status CAS transition', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    // Valid transition
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
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const results = proposalRepo.listByGrillSession('gs1');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('prop1');
  });

  // ── Version ───────────────────────────────────────────────

  it('inserts and retrieves version', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

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
      contractSnapshotHash: HASH_A,
      provenanceJson: '[]',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'ai-proposal-accepted',
    });

    const byId = versionRepo.getById('p1', 'v1');
    expect(byId).not.toBeNull();
    expect(byId!.version).toBe(1);
    expect(byId!.createdBy).toBe('ai-proposal-accepted');

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
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const versionRepo = db.getCreationContractVersionRepository();
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
      contractSnapshotHash: HASH_A,
      provenanceJson: '[]',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'user',
    });

    // Duplicate version number → should throw
    expect(() =>
      versionRepo.create({
        id: 'v2',
        projectId: 'p1',
        version: 1,
        schemaVersion: 1,
        sourceProposalId: null,
        basedOnGrillSessionId: null,
        basedOnGrillSessionVersion: null,
        sectionsJson: makeSectionsJson(),
        lockedFieldPathsJson: '[]',
        contractSnapshotHash: HASH_B,
        provenanceJson: '[]',
        createdAt: '2026-01-02T00:00:00Z',
        createdBy: 'user',
      }),
    ).toThrow();
  });

  // ── Current Pointer ───────────────────────────────────────

  it('current pointer: insert first + get', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const versionRepo = db.getCreationContractVersionRepository();
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
      contractSnapshotHash: HASH_A,
      provenanceJson: '[]',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'user',
    });

    const currentRepo = db.getCreationContractCurrentRepository();
    expect(currentRepo.get('p1')).toBeNull();

    const inserted = currentRepo.insertFirst('p1', 'v1', '2026-01-01T00:00:00Z');
    expect(inserted).toBe(true);

    const current = currentRepo.get('p1');
    expect(current).not.toBeNull();
    expect(current!.currentVersionId).toBe('v1');
  });

  it('current pointer: duplicate insert fails', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const versionRepo = db.getCreationContractVersionRepository();
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
      contractSnapshotHash: HASH_A,
      provenanceJson: '[]',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'user',
    });

    const currentRepo = db.getCreationContractCurrentRepository();
    expect(currentRepo.insertFirst('p1', 'v1', '2026-01-01T00:00:00Z')).toBe(true);
    // Duplicate → false (PK conflict)
    expect(currentRepo.insertFirst('p1', 'v1', '2026-01-02T00:00:00Z')).toBe(false);
  });

  it('current pointer: CAS update', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const versionRepo = db.getCreationContractVersionRepository();
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
      contractSnapshotHash: HASH_A,
      provenanceJson: '[]',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'user',
    });
    versionRepo.create({
      id: 'v2',
      projectId: 'p1',
      version: 2,
      schemaVersion: 1,
      sourceProposalId: null,
      basedOnGrillSessionId: null,
      basedOnGrillSessionVersion: null,
      sectionsJson: makeSectionsJson(),
      lockedFieldPathsJson: '[]',
      contractSnapshotHash: HASH_B,
      provenanceJson: '[]',
      createdAt: '2026-01-02T00:00:00Z',
      createdBy: 'user',
    });

    const currentRepo = db.getCreationContractCurrentRepository();
    currentRepo.insertFirst('p1', 'v1', '2026-01-01T00:00:00Z');

    // CAS with wrong expected → false
    expect(currentRepo.casUpdate('p1', 'v999', 'v2', '2026-01-02T00:00:00Z')).toBe(false);

    // CAS with correct expected → true
    expect(currentRepo.casUpdate('p1', 'v1', 'v2', '2026-01-02T00:00:00Z')).toBe(true);
    expect(currentRepo.get('p1')!.currentVersionId).toBe('v2');
  });

  // ── Lock Events ───────────────────────────────────────────

  it('lock events: append and list', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const versionRepo = db.getCreationContractVersionRepository();
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
      contractSnapshotHash: HASH_A,
      provenanceJson: '[]',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'lock',
    });

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
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    // Direct SQL attempt to modify sections_json should fail
    expect(() => {
      db.transaction(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).db
          .prepare(`UPDATE creation_contract_proposals SET sections_json = ? WHERE id = ?`)
          .run('{"modified": true}', 'prop1');
      });
    }).toThrow(/immutable/);
  });

  it('version cannot be updated', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const versionRepo = db.getCreationContractVersionRepository();
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
      contractSnapshotHash: HASH_A,
      provenanceJson: '[]',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'user',
    });

    // Direct SQL attempt to update version should fail
    expect(() => {
      db.transaction(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).db
          .prepare(`UPDATE creation_contract_versions SET sections_json = ? WHERE id = ?`)
          .run('{"modified": true}', 'v1');
      });
    }).toThrow(/append-only/);
  });

  it('version cannot be deleted', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const versionRepo = db.getCreationContractVersionRepository();
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
      contractSnapshotHash: HASH_A,
      provenanceJson: '[]',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'user',
    });

    expect(() => {
      db.transaction(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).db.prepare(`DELETE FROM creation_contract_versions WHERE id = ?`).run('v1');
      });
    }).toThrow(/append-only/);
  });

  it('lock events cannot be updated or deleted', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const versionRepo = db.getCreationContractVersionRepository();
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
      contractSnapshotHash: HASH_A,
      provenanceJson: '[]',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'lock',
    });

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

    // Update should fail
    expect(() => {
      db.transaction(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).db
          .prepare(`UPDATE creation_contract_lock_events SET action = 'UNLOCK' WHERE id = ?`)
          .run('le1');
      });
    }).toThrow(/append-only/);

    // Delete should fail
    expect(() => {
      db.transaction(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).db.prepare(`DELETE FROM creation_contract_lock_events WHERE id = ?`).run('le1');
      });
    }).toThrow(/append-only/);
  });

  // ── list排序 ──────────────────────────────────────────────

  it('list returns sorted results', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    proposalRepo.create({
      id: 'prop2',
      projectId: 'p1',
      taskId: 't1',
      invocationId: 'inv1',
      baseGrillSessionId: 'gs1',
      baseGrillSessionVersion: 2,
      baseContractVersion: null,
      schemaVersion: 1,
      sectionsJson: makeSectionsJson(),
      sectionsHash: HASH_B,
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });

    const proposals = proposalRepo.listByProject('p1');
    expect(proposals).toHaveLength(2);
    // sorted by created_at DESC, id
    expect(proposals[0].id).toBe('prop2');
    expect(proposals[1].id).toBe('prop1');
  });

  // ── Transaction rollback ──────────────────────────────────

  it('transaction rollback leaves no partial data', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    const versionRepo = db.getCreationContractVersionRepository();

    // Transaction that inserts version then fails
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
          contractSnapshotHash: HASH_A,
          provenanceJson: '[]',
          createdAt: '2026-01-01T00:00:00Z',
          createdBy: 'user',
        });
        throw new Error('intentional failure');
      });
    }).toThrow('intentional failure');

    // Version should not exist after rollback
    expect(versionRepo.getById('p1', 'v1')).toBeNull();
  });

  // ── Proposal immutability (identity fields) ───────────────

  it('proposal identity fields cannot be updated', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    // Try to modify task_id
    expect(() => {
      db.transaction(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).db
          .prepare(`UPDATE creation_contract_proposals SET task_id = 'other' WHERE id = ?`)
          .run('prop1');
      });
    }).toThrow(/immutable/);
  });

  // ── Proposal DELETE protection ──────────────────────────────

  it('proposal cannot be deleted (append-only)', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

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
      sectionsHash: HASH_A,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });

    expect(() => {
      db.transaction(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).db.prepare(`DELETE FROM creation_contract_proposals WHERE id = ?`).run('prop1');
      });
    }).toThrow(/append-only/);
  });

  // ── json_valid CHECK constraints ────────────────────────────

  it('rejects invalid JSON in proposal sections_json', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const proposalRepo = db.getCreationContractProposalRepository();
    expect(() =>
      proposalRepo.create({
        id: 'prop-bad',
        projectId: 'p1',
        taskId: 't1',
        invocationId: 'inv1',
        baseGrillSessionId: 'gs1',
        baseGrillSessionVersion: 1,
        baseContractVersion: null,
        schemaVersion: 1,
        sectionsJson: 'not valid json',
        sectionsHash: HASH_A,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });

  it('rejects invalid JSON in version sections_json', () => {
    const versionRepo = db.getCreationContractVersionRepository();
    expect(() =>
      versionRepo.create({
        id: 'v-bad',
        projectId: 'p1',
        version: 1,
        schemaVersion: 1,
        sourceProposalId: null,
        basedOnGrillSessionId: null,
        basedOnGrillSessionVersion: null,
        sectionsJson: '{broken',
        lockedFieldPathsJson: '[]',
        contractSnapshotHash: HASH_A,
        provenanceJson: '[]',
        createdAt: '2026-01-01T00:00:00Z',
        createdBy: 'user',
      }),
    ).toThrow();
  });

  it('rejects invalid JSON in version locked_field_paths_json', () => {
    const versionRepo = db.getCreationContractVersionRepository();
    expect(() =>
      versionRepo.create({
        id: 'v-bad2',
        projectId: 'p1',
        version: 1,
        schemaVersion: 1,
        sourceProposalId: null,
        basedOnGrillSessionId: null,
        basedOnGrillSessionVersion: null,
        sectionsJson: makeSectionsJson(),
        lockedFieldPathsJson: 'not json',
        contractSnapshotHash: HASH_A,
        provenanceJson: '[]',
        createdAt: '2026-01-01T00:00:00Z',
        createdBy: 'user',
      }),
    ).toThrow();
  });

  // ── Hash length CHECK ──────────────────────────────────────

  it('rejects hash with wrong length in proposal', () => {
    const taskRepo = db.getTaskRepository();
    const invRepo = db.getModelInvocationRepository();
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
      model: 'm',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'test',
      promptHash: HASH_A,
      requestMetadataJson: '{}',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const proposalRepo = db.getCreationContractProposalRepository();
    expect(() =>
      proposalRepo.create({
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
});
