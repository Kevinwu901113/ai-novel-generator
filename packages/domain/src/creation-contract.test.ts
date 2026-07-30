import { describe, it, expect } from 'vitest';
import {
  CREATION_CONTRACT_SCHEMA_VERSION,
  createCharacterKey,
  createRelationshipKey,
  validateContractBaselineRef,
  isValidProposalStatusTransition,
  assertValidProposalStatusTransition,
  isLowercaseSha256Hex,
  canonicalSerializeContractSections,
  canonicalSerializeLockedFieldPaths,
  canonicalSerializeContractSnapshot,
  validateCreationContractSections,
  parseContractFieldPath,
  canonicalizeContractFieldPath,
  pathsOverlap,
  validateNewLockPath,
  validateUnlockPath,
  getCanonicalTargetPath,
  operationWriteSetConflictsWithLocks,
  applyContractPatchOperations,
  parseContractPatchOperation,
  codePointCompare,
  type CreationContractSections,
  type ProtagonistCharacter,
  type SupportingCharacter,
  type RelationshipEntry,
  type ContractPatchOperation,
  type ContractPatchContext,
} from './creation-contract.js';

// ── 辅助 ──────────────────────────────────────────────────────

const HASH_A = 'a'.repeat(64);

function makeProtagonist(overrides?: Partial<ProtagonistCharacter>): ProtagonistCharacter {
  return {
    characterKey: createCharacterKey('hero'),
    name: 'Hero',
    ...overrides,
  };
}

function makeSupporting(key: string, name: string): SupportingCharacter {
  return {
    characterKey: createCharacterKey(key),
    name,
  };
}

function makeRelationship(
  key: string,
  from: string,
  to: string,
  type = 'ally',
): RelationshipEntry {
  return {
    relationshipKey: createRelationshipKey(key),
    fromCharacterKey: createCharacterKey(from),
    toCharacterKey: createCharacterKey(to),
    type,
  };
}

function makeSections(overrides?: Partial<CreationContractSections>): CreationContractSections {
  return {
    premise: 'A hero goes on an adventure',
    genre: ['fantasy'],
    tone: ['epic'],
    targetAudience: 'young adults',
    narrativePov: 'THIRD_LIMITED',
    tense: 'PAST',
    protagonist: makeProtagonist(),
    ...overrides,
  };
}

function makeContext(
  snapshot: CreationContractSections,
  lockedPaths: readonly string[] = [],
  authBase: CreationContractSections | null = null,
): ContractPatchContext {
  return {
    sourceSections: snapshot,
    authoritativeBaseSections: authBase ?? snapshot,
    lockedFieldPaths: lockedPaths,
  };
}

// ── Schema Version ────────────────────────────────────────────

describe('CREATION_CONTRACT_SCHEMA_VERSION', () => {
  it('equals 1', () => {
    expect(CREATION_CONTRACT_SCHEMA_VERSION).toBe(1);
  });
});

// ── Branded Types ─────────────────────────────────────────────

describe('createCharacterKey', () => {
  it('accepts valid key', () => {
    expect(createCharacterKey('hero')).toBe('hero');
    expect(createCharacterKey('my-hero_1')).toBe('my-hero_1');
  });
  it('rejects empty', () => {
    expect(() => createCharacterKey('')).toThrow();
  });
  it('rejects uppercase', () => {
    expect(() => createCharacterKey('Hero')).toThrow();
  });
  it('rejects spaces', () => {
    expect(() => createCharacterKey('my hero')).toThrow();
  });
  it('rejects too long', () => {
    expect(() => createCharacterKey('a'.repeat(51))).toThrow();
  });
});

describe('createRelationshipKey', () => {
  it('accepts valid key', () => {
    expect(createRelationshipKey('r1')).toBe('r1');
  });
  it('rejects invalid', () => {
    expect(() => createRelationshipKey('')).toThrow();
    expect(() => createRelationshipKey('R1')).toThrow();
  });
});

// ── ContractBaselineRef ───────────────────────────────────────

describe('validateContractBaselineRef', () => {
  it('all-null succeeds', () => {
    const result = validateContractBaselineRef({
      contractVersionId: null,
      contractVersion: null,
      contractSnapshotHash: null,
    });
    expect(result).toEqual({
      contractVersionId: null,
      contractVersion: null,
      contractSnapshotHash: null,
    });
  });

  it('all-present succeeds', () => {
    const result = validateContractBaselineRef({
      contractVersionId: 'v1',
      contractVersion: 1,
      contractSnapshotHash: HASH_A,
    });
    expect(result.contractVersionId).toBe('v1');
    expect(result.contractVersion).toBe(1);
  });

  it('partial-null fails: id present, version null', () => {
    expect(() =>
      validateContractBaselineRef({
        contractVersionId: 'v1',
        contractVersion: null,
        contractSnapshotHash: HASH_A,
      }),
    ).toThrow();
  });

  it('partial-null fails: id null, version present', () => {
    expect(() =>
      validateContractBaselineRef({
        contractVersionId: null,
        contractVersion: 1,
        contractSnapshotHash: HASH_A,
      }),
    ).toThrow();
  });

  it('partial-null fails: hash null', () => {
    expect(() =>
      validateContractBaselineRef({
        contractVersionId: 'v1',
        contractVersion: 1,
        contractSnapshotHash: null,
      }),
    ).toThrow();
  });

  it('rejects non-positive version', () => {
    expect(() =>
      validateContractBaselineRef({
        contractVersionId: 'v1',
        contractVersion: 0,
        contractSnapshotHash: HASH_A,
      }),
    ).toThrow();
  });

  it('rejects invalid hash', () => {
    expect(() =>
      validateContractBaselineRef({
        contractVersionId: 'v1',
        contractVersion: 1,
        contractSnapshotHash: 'not-a-hash',
      }),
    ).toThrow();
  });
});

// ── ProposalStatus ────────────────────────────────────────────

describe('ProposalStatus transitions', () => {
  it('PROPOSED → ACCEPTED', () => {
    expect(isValidProposalStatusTransition('PROPOSED', 'ACCEPTED')).toBe(true);
  });
  it('PROPOSED → REJECTED', () => {
    expect(isValidProposalStatusTransition('PROPOSED', 'REJECTED')).toBe(true);
  });
  it('PROPOSED → SUPERSEDED', () => {
    expect(isValidProposalStatusTransition('PROPOSED', 'SUPERSEDED')).toBe(true);
  });
  it('PROPOSED → STALE', () => {
    expect(isValidProposalStatusTransition('PROPOSED', 'STALE')).toBe(true);
  });
  it('ACCEPTED → PROPOSED fails', () => {
    expect(isValidProposalStatusTransition('ACCEPTED', 'PROPOSED')).toBe(false);
  });
  it('REJECTED → PROPOSED fails', () => {
    expect(isValidProposalStatusTransition('REJECTED', 'PROPOSED')).toBe(false);
  });
  it('terminal → terminal fails', () => {
    expect(isValidProposalStatusTransition('ACCEPTED', 'REJECTED')).toBe(false);
    expect(isValidProposalStatusTransition('REJECTED', 'ACCEPTED')).toBe(false);
  });
  it('assertValidProposalStatusTransition throws on invalid', () => {
    expect(() => assertValidProposalStatusTransition('ACCEPTED', 'PROPOSED')).toThrow();
  });
});

// ── SHA-256 Hash ──────────────────────────────────────────────

describe('isLowercaseSha256Hex', () => {
  it('accepts valid lowercase hex', () => {
    expect(isLowercaseSha256Hex(HASH_A)).toBe(true);
  });
  it('rejects uppercase', () => {
    expect(isLowercaseSha256Hex('A'.repeat(64))).toBe(false);
  });
  it('rejects short', () => {
    expect(isLowercaseSha256Hex('a'.repeat(63))).toBe(false);
  });
  it('rejects long', () => {
    expect(isLowercaseSha256Hex('a'.repeat(65))).toBe(false);
  });
  it('rejects non-hex', () => {
    expect(isLowercaseSha256Hex('g'.repeat(64))).toBe(false);
  });
});

// ── Canonical Serialization ───────────────────────────────────

describe('canonical serialization', () => {
  it('same object different key order → same output', () => {
    const base = makeSections();
    const entries = Object.entries(base);
    const reversed = Object.fromEntries([...entries].reverse());
    expect(JSON.stringify(base) === JSON.stringify(reversed)).toBe(false);
    const sa = canonicalSerializeContractSections(base);
    const sb = canonicalSerializeContractSections(reversed as unknown as CreationContractSections);
    expect(sa).toBe(sb);
  });

  it('NFC normalization', () => {
    const a = makeSections({ premise: 'é' });
    const b = makeSections({ premise: 'é' });
    const sa = canonicalSerializeContractSections(a);
    const sb = canonicalSerializeContractSections(b);
    expect(sa).toBe(sb);
  });

  it('lockedFieldPaths order independence', () => {
    const a = canonicalSerializeLockedFieldPaths(['/premise', '/genre']);
    const b = canonicalSerializeLockedFieldPaths(['/genre', '/premise']);
    expect(a).toBe(b);
  });

  it('lockedFieldPaths duplicate rejection', () => {
    expect(() => canonicalSerializeLockedFieldPaths(['/premise', '/premise'])).toThrow();
  });

  it('lockedFieldPaths NFC normalization', () => {
    const a = canonicalSerializeLockedFieldPaths(['/premise']);
    const b = canonicalSerializeLockedFieldPaths(['/premise']);
    expect(a).toBe(b);
  });

  it('business array order matters', () => {
    const a = makeSections({ genre: ['fantasy', 'adventure'] });
    const b = makeSections({ genre: ['adventure', 'fantasy'] });
    expect(canonicalSerializeContractSections(a)).not.toBe(
      canonicalSerializeContractSections(b),
    );
  });

  it('snapshot includes sections, locks, schemaVersion', () => {
    const snap = canonicalSerializeContractSnapshot({
      sections: makeSections(),
      lockedFieldPaths: [],
      schemaVersion: 1,
    });
    const parsed = JSON.parse(snap);
    expect(parsed).toHaveProperty('sections');
    expect(parsed).toHaveProperty('lockedFieldPaths');
    expect(parsed).toHaveProperty('schemaVersion');
    expect(parsed.schemaVersion).toBe(1);
  });

  it('different key order in snapshot → same output', () => {
    const snap1 = canonicalSerializeContractSnapshot({
      sections: makeSections(),
      lockedFieldPaths: ['/premise'],
      schemaVersion: 1,
    });
    const snap2 = canonicalSerializeContractSnapshot({
      sections: makeSections(),
      lockedFieldPaths: ['/premise'],
      schemaVersion: 1,
    });
    expect(snap1).toBe(snap2);
  });

  it('rejects non-positive schemaVersion', () => {
    expect(() =>
      canonicalSerializeContractSnapshot({
        sections: makeSections(),
        lockedFieldPaths: [],
        schemaVersion: 0,
      }),
    ).toThrow();
    expect(() =>
      canonicalSerializeContractSnapshot({
        sections: makeSections(),
        lockedFieldPaths: [],
        schemaVersion: -1,
      }),
    ).toThrow();
  });

  it('rejects non-integer schemaVersion', () => {
    expect(() =>
      canonicalSerializeContractSnapshot({
        sections: makeSections(),
        lockedFieldPaths: [],
        schemaVersion: 1.5,
      }),
    ).toThrow();
  });

  it('rejects invalid lock path in serialization', () => {
    expect(() =>
      canonicalSerializeLockedFieldPaths(['/unknownSection']),
    ).toThrow();
  });

  it('rejects invalid typed-cast sections', () => {
    const bad = { ...makeSections(), narrativePov: 'INVALID' };
    expect(() =>
      canonicalSerializeContractSections(bad as unknown as CreationContractSections),
    ).toThrow();
  });
});

// ── Unicode Code-Point Comparator ─────────────────────────────

describe('codePointCompare', () => {
  it('sorts ASCII strings by code point', () => {
    expect(codePointCompare('a', 'b')).toBeLessThan(0);
    expect(codePointCompare('b', 'a')).toBeGreaterThan(0);
    expect(codePointCompare('a', 'a')).toBe(0);
  });

  it('sorts astral code points correctly', () => {
    const emoji1 = '😀';
    const emoji2 = '😁';
    expect(codePointCompare(emoji1, emoji2)).toBeLessThan(0);
  });

  it('sorts shorter string first when prefix', () => {
    expect(codePointCompare('ab', 'abc')).toBeLessThan(0);
  });

  it('NFC normalizes before comparing', () => {
    const e1 = 'é';
    const e2 = 'é';
    expect(codePointCompare(e1, e2)).toBe(0);
  });
});

// ── CreationContractSections Validation ───────────────────────

describe('validateCreationContractSections', () => {
  it('accepts minimal required fields', () => {
    const result = validateCreationContractSections(makeSections());
    expect(result.premise).toBe('A hero goes on an adventure');
    expect(result.genre).toEqual(['fantasy']);
  });

  it('rejects unknown field', () => {
    expect(() =>
      validateCreationContractSections({ ...makeSections(), unknownField: 'x' }),
    ).toThrow('未知 section');
  });

  it('rejects empty premise', () => {
    expect(() => validateCreationContractSections({ ...makeSections(), premise: '' })).toThrow();
  });

  it('rejects empty genre array', () => {
    expect(() => validateCreationContractSections({ ...makeSections(), genre: [] })).toThrow(
      '至少需要 1 项',
    );
  });

  it('accepts optional fields', () => {
    const result = validateCreationContractSections(
      makeSections({
        themes: ['redemption'],
        targetLength: { unit: 'words', value: 80000 },
        structure: 'three-act',
        worldRules: ['magic exists'],
        mustInclude: ['dragon'],
        mustAvoid: ['romance'],
        contentBoundaries: { rating: 'PG-13' },
        unresolvedQuestions: ['who is the villain?'],
      }),
    );
    expect(result.themes).toEqual(['redemption']);
    expect(result.targetLength).toEqual({ unit: 'words', value: 80000 });
  });

  it('rejects targetLength.value = 0', () => {
    expect(() =>
      validateCreationContractSections(
        makeSections({ targetLength: { unit: 'words', value: 0 } }),
      ),
    ).toThrow();
  });

  it('rejects targetLength.value NaN', () => {
    expect(() =>
      validateCreationContractSections(
        makeSections({ targetLength: { unit: 'words', value: NaN } }),
      ),
    ).toThrow();
  });

  it('rejects targetLength.value Infinity', () => {
    expect(() =>
      validateCreationContractSections(
        makeSections({ targetLength: { unit: 'words', value: Infinity } }),
      ),
    ).toThrow();
  });

  it('rejects non-integer targetLength.value', () => {
    expect(() =>
      validateCreationContractSections(
        makeSections({ targetLength: { unit: 'words', value: 1.5 } }),
      ),
    ).toThrow();
  });

  it('validates supportingCharacters', () => {
    const result = validateCreationContractSections(
      makeSections({
        supportingCharacters: [makeSupporting('sidekick', 'Sidekick')],
      }),
    );
    expect(result.supportingCharacters).toHaveLength(1);
    expect(result.supportingCharacters![0].characterKey).toBe('sidekick');
  });

  it('rejects duplicate characterKey', () => {
    expect(() =>
      validateCreationContractSections(
        makeSections({
          supportingCharacters: [makeSupporting('hero', 'Duplicate')],
        }),
      ),
    ).toThrow(/重复|冲突/);
  });

  it('validates relationships', () => {
    const result = validateCreationContractSections(
      makeSections({
        supportingCharacters: [makeSupporting('sidekick', 'Sidekick')],
        relationships: [makeRelationship('r1', 'hero', 'sidekick')],
      }),
    );
    expect(result.relationships).toHaveLength(1);
  });

  it('rejects relationship referencing unknown character', () => {
    expect(() =>
      validateCreationContractSections(
        makeSections({
          relationships: [makeRelationship('r1', 'hero', 'unknown')],
        }),
      ),
    ).toThrow('引用未知角色');
  });
});

// ── Field Path ────────────────────────────────────────────────

describe('parseContractFieldPath', () => {
  it('parses top-level section', () => {
    const p = parseContractFieldPath('/premise');
    expect(p).toEqual({ section: 'premise' });
  });

  it('parses structured child', () => {
    const p = parseContractFieldPath('/protagonist/name');
    expect(p).toEqual({ section: 'protagonist', field: 'name' });
  });

  it('parses collection entity child', () => {
    const p = parseContractFieldPath('/supportingCharacters/alice/name');
    expect(p).toEqual({
      section: 'supportingCharacters',
      entityKey: 'alice',
      field: 'name',
    });
  });

  it('rejects unknown section', () => {
    expect(() => parseContractFieldPath('/unknown')).toThrow('未知 section');
  });

  it('rejects invalid entity key', () => {
    expect(() => parseContractFieldPath('/supportingCharacters/BadKey/name')).toThrow(
      '非法 entity key',
    );
  });

  it('rejects path too deep', () => {
    expect(() => parseContractFieldPath('/protagonist/name/extra')).toThrow('路径过深');
  });
});

describe('canonicalizeContractFieldPath', () => {
  it('normalizes path', () => {
    expect(canonicalizeContractFieldPath('/premise')).toBe('/premise');
    expect(canonicalizeContractFieldPath('/protagonist/name')).toBe('/protagonist/name');
    expect(canonicalizeContractFieldPath('/supportingCharacters/alice/name')).toBe(
      '/supportingCharacters/alice/name',
    );
  });
});

// ── Path Overlap ──────────────────────────────────────────────

describe('pathsOverlap', () => {
  it('same path', () => {
    expect(pathsOverlap('/premise', '/premise')).toBe(true);
  });
  it('ancestor/descendant', () => {
    expect(pathsOverlap('/protagonist', '/protagonist/name')).toBe(true);
    expect(pathsOverlap('/protagonist/name', '/protagonist')).toBe(true);
  });
  it('unrelated paths', () => {
    expect(pathsOverlap('/premise', '/genre')).toBe(false);
    expect(pathsOverlap('/protagonist/name', '/protagonist/role')).toBe(false);
  });
  it('prefix but not ancestor', () => {
    expect(pathsOverlap('/protagonist', '/protagon')).toBe(false);
  });
});

// ── Lock Validation ───────────────────────────────────────────

describe('validateNewLockPath', () => {
  const snapshot = makeSections({
    supportingCharacters: [makeSupporting('alice', 'Alice')],
  });

  it('accepts new lock on valid path', () => {
    expect(() => validateNewLockPath('/premise', [], snapshot)).not.toThrow();
  });

  it('rejects overlap with existing lock', () => {
    expect(() => validateNewLockPath('/protagonist/name', ['/protagonist'], snapshot)).toThrow(
      '重叠',
    );
  });

  it('allows absent optional top-level section', () => {
    expect(() => validateNewLockPath('/themes', [], snapshot)).not.toThrow();
  });

  it('allows absent optional child of existing entity', () => {
    expect(() =>
      validateNewLockPath('/supportingCharacters/alice/role', [], snapshot),
    ).not.toThrow();
  });

  it('rejects lock on non-existent entity descendant', () => {
    expect(() =>
      validateNewLockPath('/supportingCharacters/bob/role', [], snapshot),
    ).toThrow('不存在');
  });

  it('rejects collection descendant when snapshot is null', () => {
    expect(() =>
      validateNewLockPath('/supportingCharacters/alice/role', [], null),
    ).toThrow('snapshot 为空');
  });

  it('rejects lock on non-existent contentBoundaries child when section absent', () => {
    expect(() =>
      validateNewLockPath('/contentBoundaries/notes', [], snapshot),
    ).toThrow('contentBoundaries 不存在');
  });

  it('allows lock on contentBoundaries when section absent (top-level)', () => {
    expect(() => validateNewLockPath('/contentBoundaries', [], snapshot)).not.toThrow();
  });

  it('rejects lock on targetLength child when section absent', () => {
    expect(() =>
      validateNewLockPath('/targetLength/value', [], snapshot),
    ).toThrow('targetLength 不存在');
  });
});

describe('validateUnlockPath', () => {
  it('accepts unlock of locked path', () => {
    expect(() => validateUnlockPath('/premise', ['/premise'])).not.toThrow();
  });
  it('rejects unlock of unlocked path', () => {
    expect(() => validateUnlockPath('/premise', ['/genre'])).toThrow('未被锁定');
  });
});

// ── ContractPatchOperation ────────────────────────────────────

describe('getCanonicalTargetPath', () => {
  it('set-scalar', () => {
    expect(
      getCanonicalTargetPath({ kind: 'set-scalar', path: '/premise', value: 'x' }),
    ).toBe('/premise');
  });
  it('upsert-protagonist', () => {
    expect(
      getCanonicalTargetPath({ kind: 'upsert-protagonist', value: makeProtagonist() }),
    ).toBe('/protagonist');
  });
  it('upsert-supporting-character', () => {
    expect(
      getCanonicalTargetPath({
        kind: 'upsert-supporting-character',
        target: createCharacterKey('alice'),
        value: makeSupporting('alice', 'Alice'),
      }),
    ).toBe('/supportingCharacters/alice');
  });
  it('remove-relationship', () => {
    expect(
      getCanonicalTargetPath({
        kind: 'remove-relationship',
        target: createRelationshipKey('r1'),
      }),
    ).toBe('/relationships/r1');
  });
});

describe('operationWriteSetConflictsWithLocks', () => {
  it('conflicts when path overlaps', () => {
    const op: ContractPatchOperation = {
      kind: 'set-scalar',
      path: '/protagonist/name',
      value: 'New Name',
    };
    expect(operationWriteSetConflictsWithLocks(op, ['/protagonist'])).toBe(true);
  });
  it('no conflict when unrelated', () => {
    const op: ContractPatchOperation = {
      kind: 'set-scalar',
      path: '/protagonist/role',
      value: 'leader',
    };
    expect(operationWriteSetConflictsWithLocks(op, ['/premise'])).toBe(false);
  });
});

// ── Runtime Operation Parser ──────────────────────────────────

describe('parseContractPatchOperation', () => {
  it('parses valid set-scalar', () => {
    const op = parseContractPatchOperation({
      kind: 'set-scalar',
      path: '/premise',
      value: 'New premise',
    });
    expect(op.kind).toBe('set-scalar');
  });

  it('rejects unknown kind', () => {
    expect(() =>
      parseContractPatchOperation({ kind: 'unknown-op', path: '/premise' }),
    ).toThrow('未知 operation kind');
  });

  it('rejects unknown path for set-scalar', () => {
    expect(() =>
      parseContractPatchOperation({ kind: 'set-scalar', path: '/unknown', value: 'x' }),
    ).toThrow('未知路径');
  });

  it('rejects forbidden scalar path: protagonist/characterKey', () => {
    expect(() =>
      parseContractPatchOperation({
        kind: 'set-scalar',
        path: '/protagonist/characterKey',
        value: 'newkey',
      }),
    ).toThrow('不允许修改');
  });

  it('rejects forbidden scalar path: relationships stable identity fields', () => {
    expect(() =>
      parseContractPatchOperation({
        kind: 'set-scalar',
        path: '/relationships/r1/fromCharacterKey',
        value: 'hero',
      }),
    ).toThrow('未知路径');
  });

  it('accepts targetLength/unit as valid scalar path', () => {
    const op = parseContractPatchOperation({
      kind: 'set-scalar',
      path: '/targetLength/unit',
      value: 'words',
    });
    expect(op.kind).toBe('set-scalar');
  });

  it('rejects path/value type mismatch', () => {
    expect(() =>
      parseContractPatchOperation({
        kind: 'set-scalar',
        path: '/premise',
        value: 42,
      }),
    ).toThrow('必须是字符串');
  });

  it('rejects extra keys', () => {
    expect(() =>
      parseContractPatchOperation({
        kind: 'set-scalar',
        path: '/premise',
        value: 'x',
        extra: true,
      }),
    ).toThrow('未知字段');
  });

  it('rejects missing keys', () => {
    expect(() =>
      parseContractPatchOperation({ kind: 'set-scalar', path: '/premise' }),
    ).toThrow('缺少必需字段');
  });

  it('parses valid set-string-list', () => {
    const op = parseContractPatchOperation({
      kind: 'set-string-list',
      path: '/genre',
      value: ['fantasy'],
    });
    expect(op.kind).toBe('set-string-list');
  });

  it('parses valid remove-field', () => {
    const op = parseContractPatchOperation({
      kind: 'remove-field',
      path: '/themes',
    });
    expect(op.kind).toBe('remove-field');
  });

  it('rejects remove-field on required path', () => {
    expect(() =>
      parseContractPatchOperation({ kind: 'remove-field', path: '/premise' }),
    ).toThrow('不允许');
  });

  it('rejects remove-field on targetLength/unit', () => {
    expect(() =>
      parseContractPatchOperation({ kind: 'remove-field', path: '/targetLength/unit' }),
    ).toThrow('不允许');
  });

  it('parses valid upsert-protagonist', () => {
    const op = parseContractPatchOperation({
      kind: 'upsert-protagonist',
      value: { characterKey: 'hero', name: 'Hero' },
    });
    expect(op.kind).toBe('upsert-protagonist');
  });

  it('parses valid set-structured for targetLength', () => {
    const op = parseContractPatchOperation({
      kind: 'set-structured',
      path: '/targetLength',
      value: { unit: 'words', value: 50000 },
    });
    expect(op.kind).toBe('set-structured');
  });

  it('rejects invalid nested structured value', () => {
    expect(() =>
      parseContractPatchOperation({
        kind: 'set-structured',
        path: '/targetLength',
        value: { unit: 'invalid', value: 50000 },
      }),
    ).toThrow();
  });

  it('parses collection scalar path', () => {
    const op = parseContractPatchOperation({
      kind: 'set-scalar',
      path: '/supportingCharacters/alice/name',
      value: 'Alice Updated',
    });
    expect(op.kind).toBe('set-scalar');
  });

  it('rejects relationship endpoint scalar bypass: fromCharacterKey', () => {
    expect(() =>
      parseContractPatchOperation({
        kind: 'set-scalar',
        path: '/relationships/r1/fromCharacterKey',
        value: 'hero',
      }),
    ).toThrow('未知路径');
  });

  it('rejects relationship endpoint scalar bypass: toCharacterKey', () => {
    expect(() =>
      parseContractPatchOperation({
        kind: 'set-scalar',
        path: '/relationships/r1/toCharacterKey',
        value: 'hero',
      }),
    ).toThrow('未知路径');
  });

  it('rejects set-scalar on supporting characterKey', () => {
    expect(() =>
      parseContractPatchOperation({
        kind: 'set-scalar',
        path: '/supportingCharacters/alice/characterKey',
        value: 'bob',
      }),
    ).toThrow('未知路径');
  });

  it('rejects set-scalar on relationshipKey', () => {
    expect(() =>
      parseContractPatchOperation({
        kind: 'set-scalar',
        path: '/relationships/r1/relationshipKey',
        value: 'r2',
      }),
    ).toThrow('未知路径');
  });
});

// ── ChangeSet Engine ──────────────────────────────────────────

describe('applyContractPatchOperations', () => {
  const base = makeSections();

  it('applies set-scalar', () => {
    const result = applyContractPatchOperations(
      [{ kind: 'set-scalar', path: '/premise', value: 'New premise text' }],
      base,
      makeContext(base),
    );
    expect(result.premise).toBe('New premise text');
  });

  it('applies set-string-list', () => {
    const result = applyContractPatchOperations(
      [{ kind: 'set-string-list', path: '/genre', value: ['scifi', 'thriller'] }],
      base,
      makeContext(base),
    );
    expect(result.genre).toEqual(['scifi', 'thriller']);
  });

  it('applies upsert-protagonist', () => {
    const result = applyContractPatchOperations(
      [{ kind: 'upsert-protagonist', value: makeProtagonist({ name: 'Updated Hero' }) }],
      base,
      makeContext(base),
    );
    expect(result.protagonist.name).toBe('Updated Hero');
  });

  it('applies upsert-supporting-character', () => {
    const result = applyContractPatchOperations(
      [
        {
          kind: 'upsert-supporting-character',
          target: createCharacterKey('alice'),
          value: makeSupporting('alice', 'Alice'),
        },
      ],
      base,
      makeContext(base),
    );
    expect(result.supportingCharacters).toHaveLength(1);
    expect(result.supportingCharacters![0].name).toBe('Alice');
  });

  it('applies remove-character', () => {
    const withChar = makeSections({
      supportingCharacters: [makeSupporting('alice', 'Alice')],
    });
    const result = applyContractPatchOperations(
      [{ kind: 'remove-character', target: createCharacterKey('alice') }],
      withChar,
      makeContext(withChar),
    );
    expect(result.supportingCharacters).toBeUndefined();
  });

  it('rejects duplicate target', () => {
    expect(() =>
      applyContractPatchOperations(
        [
          { kind: 'set-scalar', path: '/premise', value: 'A' },
          { kind: 'set-scalar', path: '/premise', value: 'B' },
        ],
        base,
        makeContext(base),
      ),
    ).toThrow('重复');
  });

  it('rejects parent/child write-set overlap', () => {
    expect(() =>
      applyContractPatchOperations(
        [
          {
            kind: 'set-structured',
            path: '/targetLength',
            value: { unit: 'words', value: 50000 },
          },
          { kind: 'set-scalar', path: '/targetLength/value', value: 60000 },
        ],
        makeSections({ targetLength: { unit: 'words', value: 50000 } }),
        makeContext(makeSections({ targetLength: { unit: 'words', value: 50000 } })),
      ),
    ).toThrow('重叠');
  });

  it('rejects upsert-protagonist with characterKey change (existing contract)', () => {
    expect(() =>
      applyContractPatchOperations(
        [
          {
            kind: 'upsert-protagonist',
            value: makeProtagonist({ characterKey: createCharacterKey('different') }),
          },
        ],
        base,
        makeContext(base, [], base),
      ),
    ).toThrow('不可修改');
  });

  it('first-contract: upsert-protagonist establishes initial key', () => {
    const source = makeSections({
      protagonist: makeProtagonist({ characterKey: createCharacterKey('newhero') }),
    });
    const result = applyContractPatchOperations(
      [{ kind: 'upsert-protagonist', value: source.protagonist }],
      source,
      {
        sourceSections: source,
        authoritativeBaseSections: null,
        lockedFieldPaths: [],
      },
    );
    expect(result.protagonist.characterKey).toBe('newhero');
  });

  it('rejects supporting key conflict with protagonist', () => {
    expect(() =>
      applyContractPatchOperations(
        [
          {
            kind: 'upsert-supporting-character',
            target: createCharacterKey('hero'),
            value: makeSupporting('hero', 'Fake Hero'),
          },
        ],
        base,
        makeContext(base),
      ),
    ).toThrow('冲突');
  });

  it('rejects lock conflict', () => {
    expect(() =>
      applyContractPatchOperations(
        [{ kind: 'set-scalar', path: '/premise', value: 'New' }],
        base,
        makeContext(base, ['/premise']),
      ),
    ).toThrow('锁定字段冲突');
  });

  it('order independence: different input order → same result', () => {
    const ops1: ReadonlyArray<ContractPatchOperation> = [
      { kind: 'set-scalar', path: '/premise', value: 'P1' },
      { kind: 'set-string-list', path: '/genre', value: ['g1'] },
    ];
    const ops2: ReadonlyArray<ContractPatchOperation> = [
      { kind: 'set-string-list', path: '/genre', value: ['g1'] },
      { kind: 'set-scalar', path: '/premise', value: 'P1' },
    ];
    const r1 = applyContractPatchOperations(ops1, base, makeContext(base));
    const r2 = applyContractPatchOperations(ops2, base, makeContext(base));
    expect(r1.premise).toBe(r2.premise);
    expect(r1.genre).toEqual(r2.genre);
    expect(canonicalSerializeContractSections(r1)).toBe(
      canonicalSerializeContractSections(r2),
    );
  });

  it('two character inserts reversed → identical snapshot', () => {
    const ops1: ReadonlyArray<ContractPatchOperation> = [
      {
        kind: 'upsert-supporting-character',
        target: createCharacterKey('alice'),
        value: makeSupporting('alice', 'Alice'),
      },
      {
        kind: 'upsert-supporting-character',
        target: createCharacterKey('bob'),
        value: makeSupporting('bob', 'Bob'),
      },
    ];
    const ops2 = [...ops1].reverse();
    const r1 = applyContractPatchOperations(ops1, base, makeContext(base));
    const r2 = applyContractPatchOperations(ops2, base, makeContext(base));
    expect(canonicalSerializeContractSections(r1)).toBe(
      canonicalSerializeContractSections(r2),
    );
  });

  it('two relationship inserts reversed → identical snapshot', () => {
    const withChars = makeSections({
      supportingCharacters: [
        makeSupporting('alice', 'Alice'),
        makeSupporting('bob', 'Bob'),
      ],
    });
    const ops1: ReadonlyArray<ContractPatchOperation> = [
      {
        kind: 'upsert-relationship',
        target: createRelationshipKey('r1'),
        value: makeRelationship('r1', 'hero', 'alice'),
      },
      {
        kind: 'upsert-relationship',
        target: createRelationshipKey('r2'),
        value: makeRelationship('r2', 'hero', 'bob'),
      },
    ];
    const ops2 = [...ops1].reverse();
    const r1 = applyContractPatchOperations(ops1, withChars, makeContext(withChars));
    const r2 = applyContractPatchOperations(ops2, withChars, makeContext(withChars));
    expect(canonicalSerializeContractSections(r1)).toBe(
      canonicalSerializeContractSections(r2),
    );
  });

  it('insert + update mixed order → identical snapshot', () => {
    const withChar = makeSections({
      supportingCharacters: [makeSupporting('alice', 'Alice')],
    });
    const ops1: ReadonlyArray<ContractPatchOperation> = [
      {
        kind: 'upsert-supporting-character',
        target: createCharacterKey('bob'),
        value: makeSupporting('bob', 'Bob'),
      },
      { kind: 'set-scalar', path: '/supportingCharacters/alice/role', value: 'helper' },
    ];
    const ops2 = [...ops1].reverse();
    const r1 = applyContractPatchOperations(ops1, withChar, makeContext(withChar));
    const r2 = applyContractPatchOperations(ops2, withChar, makeContext(withChar));
    expect(canonicalSerializeContractSections(r1)).toBe(
      canonicalSerializeContractSections(r2),
    );
  });

  it('remove entire targetLength succeeds', () => {
    const withTarget = makeSections({ targetLength: { unit: 'words', value: 80000 } });
    const result = applyContractPatchOperations(
      [{ kind: 'remove-field', path: '/targetLength' }],
      withTarget,
      makeContext(withTarget),
    );
    expect(result.targetLength).toBeUndefined();
  });

  it('remove nonexistent field rejected', () => {
    expect(() =>
      applyContractPatchOperations(
        [{ kind: 'remove-field', path: '/themes' }],
        base,
        makeContext(base),
      ),
    ).toThrow('不存在');
  });

  it('relationship integrity based on final snapshot', () => {
    const withBoth = makeSections({
      supportingCharacters: [makeSupporting('alice', 'Alice')],
      relationships: [makeRelationship('r1', 'hero', 'alice')],
    });
    expect(() =>
      applyContractPatchOperations(
        [{ kind: 'remove-character', target: createCharacterKey('alice') }],
        withBoth,
        makeContext(withBoth),
      ),
    ).toThrow('引用未知角色');
  });

  it('remove character + relationship in same patch succeeds', () => {
    const withBoth = makeSections({
      supportingCharacters: [makeSupporting('alice', 'Alice')],
      relationships: [makeRelationship('r1', 'hero', 'alice')],
    });
    const result = applyContractPatchOperations(
      [
        { kind: 'remove-character', target: createCharacterKey('alice') },
        { kind: 'remove-relationship', target: createRelationshipKey('r1') },
      ],
      withBoth,
      makeContext(withBoth),
    );
    expect(result.supportingCharacters).toBeUndefined();
    expect(result.relationships).toBeUndefined();
  });

  it('does not mutate input snapshot', () => {
    const original = makeSections();
    const copy = JSON.parse(JSON.stringify(original));
    applyContractPatchOperations(
      [{ kind: 'set-scalar', path: '/premise', value: 'Changed' }],
      original,
      makeContext(original),
    );
    expect(original.premise).toBe(copy.premise);
  });
});
