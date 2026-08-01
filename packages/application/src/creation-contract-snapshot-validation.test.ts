/**
 * 共享权威 snapshot validator 单元测试。
 *
 * 直接覆盖 validateAuthoritativeContractVersionSnapshot 的 14 项验证，
 * 与 Request / Task Engine / Update/Lock/Unlock 三条消费路径共用同一实现。
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalSerializeContractSections,
  canonicalSerializeContractSnapshot,
  validateCreationContractSections,
  codePointCompare,
  type CreationContractSections,
} from '@ai-novel/domain';
import {
  validateAuthoritativeContractVersionSnapshot,
  assertValidExistingLockSet,
} from './creation-contract-snapshot-validation.js';
import { ContractDataCorruptionError, ContractSchemaUnsupportedError } from './errors.js';
import { collectAllFieldPaths } from './creation-contract-mutations.js';
import type {
  CreationContractCurrentData,
  CreationContractVersionData,
} from './creation-contract-types.js';

const NOW = '2026-01-01T00:00:00.000Z';

function realSha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function makeSections(overrides: Record<string, unknown> = {}): CreationContractSections {
  return validateCreationContractSections({
    premise: 'A story',
    genre: ['sci-fi'],
    tone: ['dark'],
    targetAudience: 'adults',
    narrativePov: 'FIRST',
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

function makeVersion(
  overrides: Partial<CreationContractVersionData> = {},
): CreationContractVersionData {
  const sections = makeSections();
  const lockedFieldPaths: readonly string[] =
    overrides.lockedFieldPathsJson === undefined
      ? []
      : (JSON.parse(overrides.lockedFieldPathsJson) as string[]);
  return {
    id: 'v1',
    projectId: 'p1',
    version: 1,
    schemaVersion: 1,
    sourceProposalId: 'prop1',
    basedOnGrillSessionId: 'gs1',
    basedOnGrillSessionVersion: 1,
    sectionsJson: overrides.sectionsJson ?? canonicalSerializeContractSections(sections),
    lockedFieldPathsJson: overrides.lockedFieldPathsJson ?? '[]',
    contractSnapshotHash:
      overrides.contractSnapshotHash ??
      realSha256(
        canonicalSerializeContractSnapshot({ sections, lockedFieldPaths, schemaVersion: 1 }),
      ),
    provenanceJson: overrides.provenanceJson ?? makeCanonicalProvenanceJson(sections),
    createdAt: NOW,
    createdBy: 'ai-proposal-accepted',
    ...overrides,
  };
}

function makeCurrent(
  overrides: Partial<CreationContractCurrentData> = {},
): CreationContractCurrentData {
  return {
    projectId: 'p1',
    currentVersionId: 'v1',
    updatedAt: NOW,
    ...overrides,
  };
}

function run(input: {
  current?: CreationContractCurrentData | null;
  version?: CreationContractVersionData | null;
  requestedProjectId?: string;
}): ReturnType<typeof validateAuthoritativeContractVersionSnapshot> {
  return validateAuthoritativeContractVersionSnapshot({
    requestedProjectId: input.requestedProjectId ?? 'p1',
    current: input.current === undefined ? makeCurrent() : input.current,
    version: input.version === undefined ? makeVersion() : input.version,
    sha256Port: { digestUtf8: realSha256 },
    context: 'test',
  });
}

describe('validateAuthoritativeContractVersionSnapshot', () => {
  it('有效快照：hasCurrent=true，返回解析后的 sections/locks/provenance', () => {
    const result = run({});
    expect(result.hasCurrent).toBe(true);
    expect(result.currentVersionId).toBe('v1');
    expect(result.sections).not.toBeNull();
    expect(result.lockedFieldPaths).toEqual([]);
    expect(result.provenance.length).toBeGreaterThan(0);
  });

  it('current 为 null（首次契约）：hasCurrent=false，version 必须为 null', () => {
    const result = run({ current: null, version: null });
    expect(result.hasCurrent).toBe(false);
    expect(result.version).toBeNull();
    expect(result.sections).toBeNull();
  });

  it('current 为 null 但提供了 version → 数据损坏', () => {
    expect(() => run({ current: null, version: makeVersion() })).toThrow(
      ContractDataCorruptionError,
    );
  });

  it('current.projectId 与请求项目不一致 → 数据损坏', () => {
    expect(() => run({ current: makeCurrent({ projectId: 'other' }) })).toThrow(
      ContractDataCorruptionError,
    );
  });

  it('current 存在但 version 缺失 → 数据损坏', () => {
    expect(() => run({ version: null })).toThrow(ContractDataCorruptionError);
  });

  it('version.projectId 与请求项目不一致 → 数据损坏', () => {
    expect(() => run({ version: makeVersion({ projectId: 'other' }) })).toThrow(
      ContractDataCorruptionError,
    );
  });

  it('version.id 与 current.currentVersionId 不一致 → 数据损坏', () => {
    expect(() => run({ version: makeVersion({ id: 'v2' }) })).toThrow(ContractDataCorruptionError);
  });

  it('version 非正安全整数 → 数据损坏', () => {
    expect(() => run({ version: makeVersion({ version: 0 }) })).toThrow(
      ContractDataCorruptionError,
    );
    expect(() => run({ version: makeVersion({ version: 1.5 }) })).toThrow(
      ContractDataCorruptionError,
    );
  });

  it('schemaVersion 不支持 → ContractSchemaUnsupportedError', () => {
    expect(() => run({ version: makeVersion({ schemaVersion: 99 }) })).toThrow(
      ContractSchemaUnsupportedError,
    );
  });

  it('createdBy 非法 → 数据损坏', () => {
    expect(() => run({ version: makeVersion({ createdBy: 'hacker' as never }) })).toThrow(
      ContractDataCorruptionError,
    );
  });

  it('sectionsJson 非 canonical bytes → 数据损坏', () => {
    const raw = canonicalSerializeContractSections(makeSections()).replace('{', '{ ');
    expect(() => run({ version: makeVersion({ sectionsJson: raw }) })).toThrow(
      ContractDataCorruptionError,
    );
  });

  it('lockedFieldPathsJson 非 canonical bytes → 数据损坏', () => {
    expect(() =>
      run({ version: makeVersion({ lockedFieldPathsJson: '["/premise", "/genre"]' }) }),
    ).toThrow(ContractDataCorruptionError);
  });

  it('provenanceJson 损坏 → 数据损坏', () => {
    expect(() => run({ version: makeVersion({ provenanceJson: 'not-json' }) })).toThrow(
      ContractDataCorruptionError,
    );
  });

  it('basedOnGrill partial-null → 数据损坏', () => {
    expect(() =>
      run({ version: makeVersion({ basedOnGrillSessionId: null, basedOnGrillSessionVersion: 1 }) }),
    ).toThrow(ContractDataCorruptionError);
  });

  it('basedOnGrill 非空 id 为空字符串 → 数据损坏', () => {
    expect(() =>
      run({ version: makeVersion({ basedOnGrillSessionId: '  ', basedOnGrillSessionVersion: 1 }) }),
    ).toThrow(ContractDataCorruptionError);
  });

  it('contractSnapshotHash 非 lowercase SHA-256 → 数据损坏', () => {
    expect(() => run({ version: makeVersion({ contractSnapshotHash: 'ZZZ' }) })).toThrow(
      ContractDataCorruptionError,
    );
  });

  it('重算 hash 与存储 hash 不一致 → 数据损坏', () => {
    expect(() => run({ version: makeVersion({ contractSnapshotHash: 'b'.repeat(64) }) })).toThrow(
      ContractDataCorruptionError,
    );
  });

  it('active locks：未排序 → 数据损坏', () => {
    expect(() =>
      run({ version: makeVersion({ lockedFieldPathsJson: '["/tense","/premise"]' }) }),
    ).toThrow(ContractDataCorruptionError);
  });

  it('active locks：引用不存在的实体 → 数据损坏', () => {
    expect(() =>
      run({
        version: makeVersion({ lockedFieldPathsJson: '["/supportingCharacters/nope/name"]' }),
      }),
    ).toThrow(ContractDataCorruptionError);
  });

  it('active locks：absent optional child（contentBoundaries 缺失时的子路径）→ 数据损坏', () => {
    // /contentBoundaries/rating 语法合法，但 sections 未定义 contentBoundaries
    // （absent optional），validateNewLockPath 拒绝 → 数据损坏。
    expect(() =>
      run({ version: makeVersion({ lockedFieldPathsJson: '["/contentBoundaries/rating"]' }) }),
    ).toThrow(ContractDataCorruptionError);
  });

  it('assertValidExistingLockSet：重复路径 → 数据损坏', () => {
    const sections = makeSections();
    expect(() => assertValidExistingLockSet(['/premise', '/premise'], sections)).toThrow(
      ContractDataCorruptionError,
    );
  });

  it('assertValidExistingLockSet：对称重叠 → 数据损坏', () => {
    const sections = makeSections({
      protagonist: { characterKey: 'hero', name: 'Hero', role: '主角' },
    });
    expect(() =>
      assertValidExistingLockSet(['/protagonist', '/protagonist/name'], sections),
    ).toThrow(ContractDataCorruptionError);
  });
});
