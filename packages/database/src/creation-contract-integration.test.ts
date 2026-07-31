import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  canonicalSerializeContractSections,
  canonicalSerializeContractSnapshot,
  validateCreationContractSections,
} from '@ai-novel/domain';
import {
  getCurrentCreationContract,
  listCreationContractVersions,
  getCreationContractProposal,
  listCreationContractProposals,
  ContractDataCorruptionError,
  ContractProposalNotFoundError,
  type CreationContractQueryDeps,
} from '@ai-novel/application';
import { ProjectDatabase } from './project-database.js';
import { sha256Utf8 } from './creation-contract-repositories.js';

function makeSections() {
  return {
    premise: 'A story about integration',
    genre: ['sci-fi'],
    tone: ['dark'],
    targetAudience: 'adults',
    narrativePov: 'FIRST' as const,
    tense: 'PRESENT' as const,
    protagonist: { characterKey: 'protag', name: 'Protagonist' },
  };
}

function makeSectionsJson(): string {
  return canonicalSerializeContractSections(validateCreationContractSections(makeSections()));
}

function makeSectionsHash(): string {
  return sha256Utf8(makeSectionsJson());
}

function makeSnapshotHash(): string {
  const canonical = canonicalSerializeContractSnapshot({
    sections: validateCreationContractSections(makeSections()),
    lockedFieldPaths: [],
    schemaVersion: 1,
  });
  return sha256Utf8(canonical);
}

const VALID_PROV = JSON.stringify([
  {
    sectionKey: '/premise',
    source: 'GRILL_ANSWER',
    grillAnswerIds: ['ans1'],
    grillProposalIds: [],
    aiTaskId: null,
    modelInvocationId: null,
    sourceProposalId: 'prop1',
    previousFieldHash: null,
    rationale: 'from grill',
  },
]);

describe('application/database integration', () => {
  let dir: string;
  let db: ProjectDatabase;
  let deps: CreationContractQueryDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'contract-integ-'));
    db = new ProjectDatabase(join(dir, 'project.sqlite'));
    deps = {
      proposalRepo: db.getCreationContractProposalRepository(),
      versionRepo: db.getCreationContractVersionRepository(),
      currentRepo: db.getCreationContractCurrentRepository(),
    };

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
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('getCurrentCreationContract returns null when no current pointer', () => {
    const result = getCurrentCreationContract(deps, { projectId: 'p1' });
    expect(result).toBeNull();
  });

  it('full lifecycle: proposal → version → current → query', () => {
    deps.proposalRepo.create({
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
    });

    deps.versionRepo.create({
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
      createdBy: 'ai-proposal-accepted',
    });

    expect(deps.currentRepo.insertFirst('p1', 'v1', '2026-01-01T00:00:00Z')).toBe(true);

    const current = getCurrentCreationContract(deps, { projectId: 'p1' });
    expect(current).not.toBeNull();
    expect(current!.id).toBe('v1');
    expect(current!.version).toBe(1);
    expect(current!.sections.premise).toBe('A story about integration');
    expect(current!.sections.genre).toEqual(['sci-fi']);
    expect(current!.sections.protagonist.characterKey).toBe('protag');
    expect(current!.lockedFieldPaths).toEqual([]);
    expect(current!.contractSnapshotHash).toBe(makeSnapshotHash());
    expect(current!.provenance).toHaveLength(1);
    expect(current!.provenance[0].sectionKey).toBe('/premise');
    expect(current!.provenance[0].source).toBe('GRILL_ANSWER');
    expect(current!.provenance[0].grillAnswerIds).toEqual(['ans1']);
    expect(current!.createdBy).toBe('ai-proposal-accepted');

    const versions = listCreationContractVersions(deps, { projectId: 'p1' });
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);

    const proposal = getCreationContractProposal(deps, { projectId: 'p1', proposalId: 'prop1' });
    expect(proposal.id).toBe('prop1');
    expect(proposal.status).toBe('PROPOSED');
    expect(proposal.sections.premise).toBe('A story about integration');

    const proposals = listCreationContractProposals(deps, { projectId: 'p1' });
    expect(proposals).toHaveLength(1);
  });

  it('getCreationContractProposal throws ContractProposalNotFoundError for missing', () => {
    expect(() =>
      getCreationContractProposal(deps, { projectId: 'p1', proposalId: 'nonexistent' }),
    ).toThrow(ContractProposalNotFoundError);
  });

  it('corruption: current pointer to missing version throws ContractDataCorruptionError', () => {
    deps.versionRepo.create({
      id: 'v1',
      projectId: 'p1',
      version: 1,
      schemaVersion: 1,
      sourceProposalId: null,
      basedOnGrillSessionId: null,
      basedOnGrillSessionVersion: null,
      sectionsJson: makeSectionsJson(),
      lockedFieldPathsJson: '[]',
      contractSnapshotHash: makeSnapshotHash(),
      provenanceJson: VALID_PROV,
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'user',
    });
    deps.currentRepo.insertFirst('p1', 'v1', '2026-01-01T00:00:00Z');

    // Simulate corruption: delete version bypassing triggers and FK
    db.database.exec('DROP TRIGGER IF EXISTS trg_cc_versions_no_delete');
    db.database.exec('PRAGMA foreign_keys = OFF');
    db.database.prepare(`DELETE FROM creation_contract_versions WHERE id = 'v1'`).run();
    db.database.exec('PRAGMA foreign_keys = ON');

    expect(() => getCurrentCreationContract(deps, { projectId: 'p1' })).toThrow(
      ContractDataCorruptionError,
    );
  });

  it('corruption: tampered snapshot hash detected on read', () => {
    deps.versionRepo.create({
      id: 'v1',
      projectId: 'p1',
      version: 1,
      schemaVersion: 1,
      sourceProposalId: null,
      basedOnGrillSessionId: null,
      basedOnGrillSessionVersion: null,
      sectionsJson: makeSectionsJson(),
      lockedFieldPathsJson: '[]',
      contractSnapshotHash: makeSnapshotHash(),
      provenanceJson: VALID_PROV,
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'user',
    });

    // Simulate corruption: tamper hash bypassing triggers
    db.database.exec('DROP TRIGGER IF EXISTS trg_cc_versions_no_update');
    db.database
      .prepare(`UPDATE creation_contract_versions SET contract_snapshot_hash = ? WHERE id = 'v1'`)
      .run('f'.repeat(64));

    deps.currentRepo.insertFirst('p1', 'v1', '2026-01-01T00:00:00Z');

    expect(() => getCurrentCreationContract(deps, { projectId: 'p1' })).toThrow(
      ContractDataCorruptionError,
    );
  });
});
