/**
 * Manifest 组装 / 序列化 / 不变量测试。
 */

import { describe, it, expect } from 'vitest';
import {
  computeManifestSelfHash,
  evaluateBlindExistInvariant,
  outputSuiteInvariant,
  satisfiesQ1Invariant,
  serializeManifest,
  EXPERIMENT_SCHEMA_VERSION,
  TOOL_VERSION,
  type ExperimentManifestV1,
} from './manifest.js';

function baseManifest(overrides: Partial<ExperimentManifestV1> = {}): ExperimentManifestV1 {
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId: 'exp-1',
    toolVersion: TOOL_VERSION,
    command: 'run',
    strategy: {
      strategyId: 'baseline-one-shot-v1',
      strategyVersion: '1',
      promptVersion: 'baseline-one-shot-v1.p1',
    },
    provider: { providerId: 'mimo-token-plan-cn', modelId: 'mimo-v2.5-pro' },
    generationParameters: { temperature: 0.7, maxTokens: 1024, seed: 'seed' },
    sourceSuite: { suiteId: 'gq1-baseline-v1', suiteHash: 'a'.repeat(64) },
    outputSuite: {
      suiteId: 'gq1-baseline-v1--baseline-one-shot-v1--exp-1',
      suiteHash: 'b'.repeat(64),
    },
    selectionMode: 'FULL_SELECTION',
    selectedCaseIds: ['case-1'],
    satisfiesQ1: true,
    timing: { startedAt: '2026-08-02T00:00:00.000Z', completedAt: '2026-08-02T00:00:05.000Z' },
    runStatus: 'COMPLETE',
    cases: [],
    aggregate: {
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalLatencyMs: 10,
      caseCount: 1,
      selectedCount: 1,
      succeededCount: 1,
      failedCount: 0,
    },
    artifactHashes: {
      caseResultsPrivate: 'c'.repeat(64),
      candidatesPrivate: 'd'.repeat(64),
      evaluationReport: 'e'.repeat(64),
      evaluationReportMarkdown: 'f'.repeat(64),
      blindPacket: 'g'.repeat(64),
      blindMappingPrivate: 'h'.repeat(64),
      logsSafe: 'i'.repeat(64),
      manifestPrivate: 'j'.repeat(64),
    },
    repository: { commit: null },
    warnings: [],
    ...overrides,
  };
}

describe('manifest serialization', () => {
  it('同一数据序列化 byte-stable', () => {
    const a = serializeManifest(baseManifest());
    const b = serializeManifest(baseManifest());
    expect(a).toBe(b);
  });

  it('manifest 自身 hash 排除 artifactHashes（避免循环），是 lowercase sha256', () => {
    const { artifactHashes: _ah, ...base } = baseManifest();
    const hash = computeManifestSelfHash(base as ExperimentManifestV1);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('序列化不包含 secret / raw error 字段名之外的内容', () => {
    const serialized = serializeManifest(baseManifest());
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer');
  });
});

describe('manifest invariants', () => {
  it('satisfiesQ1 ⟺ FULL_SELECTION && COMPLETE', () => {
    expect(satisfiesQ1Invariant(baseManifest())).toBe(true);
    expect(
      satisfiesQ1Invariant(
        baseManifest({
          satisfiesQ1: false,
          runStatus: 'PARTIAL_SELECTION_SUCCEEDED',
          selectionMode: 'PARTIAL_SELECTION',
        }),
      ),
    ).toBe(true);
    expect(satisfiesQ1Invariant(baseManifest({ satisfiesQ1: false, runStatus: 'COMPLETE' }))).toBe(
      false,
    );
  });

  it('outputSuite 非 null ⟺ COMPLETE && FULL_SELECTION', () => {
    expect(outputSuiteInvariant(baseManifest())).toBe(true);
    expect(
      outputSuiteInvariant(baseManifest({ outputSuite: null, runStatus: 'PARTIAL_FAILURE' })),
    ).toBe(true);
    expect(outputSuiteInvariant(baseManifest({ outputSuite: null, runStatus: 'COMPLETE' }))).toBe(
      false,
    );
  });

  it('evaluate/blind 存在 ⟺ run && COMPLETE && FULL_SELECTION', () => {
    expect(evaluateBlindExistInvariant(baseManifest(), true)).toBe(true);
    expect(evaluateBlindExistInvariant(baseManifest({ command: 'generate' }), false)).toBe(true);
    expect(
      evaluateBlindExistInvariant(
        baseManifest({
          runStatus: 'PARTIAL_SELECTION_SUCCEEDED',
          selectionMode: 'PARTIAL_SELECTION',
          satisfiesQ1: false,
          outputSuite: null,
        }),
        false,
      ),
    ).toBe(true);
  });
});
