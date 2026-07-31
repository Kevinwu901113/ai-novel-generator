import { describe, it, expect } from 'vitest';
import {
  getCurrentCreationContract,
  listCreationContractVersions,
  getCreationContractProposal,
  listCreationContractProposals,
  type CreationContractQueryDeps,
} from './creation-contract.js';
import type {
  CreationContractProposalRepositoryPort,
  CreationContractVersionRepositoryPort,
  CreationContractCurrentRepositoryPort,
  CreationContractProposalData,
  CreationContractVersionData,
  CreationContractCurrentData,
} from './creation-contract-types.js';
import { ContractProposalNotFoundError, ContractDataCorruptionError } from './errors.js';

// ── Helpers ───────────────────────────────────────────────────

const SECTIONS_JSON = JSON.stringify({
  premise: 'A story about a hero',
  genre: ['fantasy'],
  tone: ['epic'],
  targetAudience: 'adults',
  narrativePov: 'THIRD_LIMITED',
  tense: 'PAST',
  protagonist: { characterKey: 'hero', name: 'Hero' },
});

const HASH_A = 'a'.repeat(64);

function makeProposal(
  overrides?: Partial<CreationContractProposalData>,
): CreationContractProposalData {
  return {
    id: 'prop1',
    projectId: 'p1',
    taskId: 't1',
    invocationId: 'inv1',
    status: 'PROPOSED',
    baseGrillSessionId: 'gs1',
    baseGrillSessionVersion: 1,
    baseContractVersion: null,
    schemaVersion: 1,
    sectionsJson: SECTIONS_JSON,
    sectionsHash: HASH_A,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeVersion(
  overrides?: Partial<CreationContractVersionData>,
): CreationContractVersionData {
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
    provenanceJson: JSON.stringify([
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
    ]),
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'ai-proposal-accepted',
    ...overrides,
  };
}

function makeMockDeps(overrides?: {
  proposals?: CreationContractProposalData[];
  versions?: CreationContractVersionData[];
  current?: CreationContractCurrentData | null;
}): CreationContractQueryDeps {
  const proposals = overrides?.proposals ?? [makeProposal()];
  const versions = overrides?.versions ?? [makeVersion()];
  const current = overrides?.current ?? null;

  const proposalRepo: CreationContractProposalRepositoryPort = {
    create: () => {},
    getById: (projectId: string, id: string) =>
      proposals.find((p) => p.projectId === projectId && p.id === id) ?? null,
    listByProject: (projectId: string) => proposals.filter((p) => p.projectId === projectId),
    listByGrillSession: () => [],
    transitionStatus: () => false,
    transitionStatusWithHash: () => false,
    supersedeAllProposed: () => 0,
  };

  const versionRepo: CreationContractVersionRepositoryPort = {
    create: () => {},
    getById: (projectId: string, id: string) =>
      versions.find((v) => v.projectId === projectId && v.id === id) ?? null,
    getByVersion: (projectId: string, version: number) =>
      versions.find((v) => v.projectId === projectId && v.version === version) ?? null,
    listSummaries: (projectId: string) => versions.filter((v) => v.projectId === projectId),
    resolveVersionId: () => null,
  };

  const currentRepo: CreationContractCurrentRepositoryPort = {
    insertFirst: () => true,
    casUpdate: () => true,
    get: () => current,
  };

  return { proposalRepo, versionRepo, currentRepo };
}

// ── GetCurrentCreationContract ─────────────────────────────────

describe('getCurrentCreationContract', () => {
  it('returns null when no current pointer', () => {
    const deps = makeMockDeps({ current: null });
    expect(getCurrentCreationContract(deps, { projectId: 'p1' })).toBeNull();
  });

  it('returns version data when current exists', () => {
    const deps = makeMockDeps({
      current: { projectId: 'p1', currentVersionId: 'v1', updatedAt: '2026-01-01T00:00:00Z' },
    });
    const result = getCurrentCreationContract(deps, { projectId: 'p1' });
    expect(result).not.toBeNull();
    expect(result!.id).toBe('v1');
    expect(result!.version).toBe(1);
    expect(result!.sections.premise).toBe('A story about a hero');
    expect(result!.sections.genre).toEqual(['fantasy']);
    expect(result!.lockedFieldPaths).toEqual([]);
  });

  it('throws ContractDataCorruptionError when current pointer references missing version', () => {
    const deps = makeMockDeps({
      current: { projectId: 'p1', currentVersionId: 'v999', updatedAt: '2026-01-01T00:00:00Z' },
      versions: [],
    });
    expect(() => getCurrentCreationContract(deps, { projectId: 'p1' })).toThrow(
      ContractDataCorruptionError,
    );
  });
});

// ── ListCreationContractVersions ───────────────────────────────

describe('listCreationContractVersions', () => {
  it('returns empty when no versions', () => {
    const deps = makeMockDeps({ versions: [] });
    expect(listCreationContractVersions(deps, { projectId: 'p1' })).toEqual([]);
  });

  it('returns version summaries', () => {
    const deps = makeMockDeps({
      versions: [
        makeVersion({ id: 'v1', version: 1 }),
        makeVersion({ id: 'v2', version: 2, contractSnapshotHash: 'b'.repeat(64) }),
      ],
    });
    const result = listCreationContractVersions(deps, { projectId: 'p1' });
    expect(result).toHaveLength(2);
    expect(result[0].version).toBe(1);
    expect(result[1].version).toBe(2);
  });
});

// ── GetCreationContractProposal ────────────────────────────────

describe('getCreationContractProposal', () => {
  it('returns proposal when found', () => {
    const deps = makeMockDeps();
    const result = getCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
    });
    expect(result.id).toBe('prop1');
    expect(result.status).toBe('PROPOSED');
    expect(result.sections.premise).toBe('A story about a hero');
  });

  it('throws when not found', () => {
    const deps = makeMockDeps({ proposals: [] });
    expect(() =>
      getCreationContractProposal(deps, { projectId: 'p1', proposalId: 'nonexistent' }),
    ).toThrow(ContractProposalNotFoundError);
  });

  it('returns typed sections without prompt', () => {
    const deps = makeMockDeps();
    const result = getCreationContractProposal(deps, {
      projectId: 'p1',
      proposalId: 'prop1',
    });
    // Should have typed sections
    expect(result.sections.protagonist.characterKey).toBe('hero');
    expect(result.sections.protagonist.name).toBe('Hero');
    // Should NOT have raw JSON
    expect(result).not.toHaveProperty('sectionsJson');
    expect(result).not.toHaveProperty('prompt');
  });
});

// ── ListCreationContractProposals ──────────────────────────────

describe('listCreationContractProposals', () => {
  it('returns empty when no proposals', () => {
    const deps = makeMockDeps({ proposals: [] });
    expect(listCreationContractProposals(deps, { projectId: 'p1' })).toEqual([]);
  });

  it('returns all proposals', () => {
    const deps = makeMockDeps({
      proposals: [
        makeProposal({ id: 'prop1', createdAt: '2026-01-01T00:00:00Z' }),
        makeProposal({ id: 'prop2', createdAt: '2026-01-02T00:00:00Z' }),
      ],
    });
    const result = listCreationContractProposals(deps, { projectId: 'p1' });
    expect(result).toHaveLength(2);
  });

  it('deterministic ordering', () => {
    const deps = makeMockDeps({
      proposals: [
        makeProposal({ id: 'prop2', createdAt: '2026-01-02T00:00:00Z' }),
        makeProposal({ id: 'prop1', createdAt: '2026-01-01T00:00:00Z' }),
      ],
    });
    const result = listCreationContractProposals(deps, { projectId: 'p1' });
    // Mock returns in insertion order; real repo sorts by created_at DESC
    expect(result[0].id).toBe('prop2');
    expect(result[1].id).toBe('prop1');
  });
});
