/**
 * ExperimentManifestV1 组装 / 序列化 / 校验。
 *
 * 序列化使用 writing-evaluation 的 canonicalize（NFC + 稳定 key 顺序），
 * 对已捕获的同一批数据 byte-stable。
 *
 * 绝不记录：API Key / Authorization / provider raw error / 绝对用户路径 /
 * 完整 prompt / candidate 全文 / private mapping。
 */

import { canonicalize, sha256Hex } from '@ai-novel/writing-evaluation';

export const EXPERIMENT_SCHEMA_VERSION = 1;
export const TOOL_VERSION = 'writing-experiment-runner@0.1.0';

export type SelectionMode = 'FULL_SELECTION' | 'PARTIAL_SELECTION';
export type CaseStatus = 'SUCCEEDED' | 'FAILED';
export type ExperimentRunStatus =
  | 'COMPLETE'
  | 'PARTIAL_FAILURE'
  | 'ABORTED'
  | 'PARTIAL_SELECTION_SUCCEEDED'
  | 'PARTIAL_SELECTION_FAILED';

export interface ManifestUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly totalTokens: number | null;
}

export interface ManifestCaseEntry {
  readonly caseId: string;
  readonly status: CaseStatus;
  readonly candidateId: string | null;
  readonly promptHash: string;
  readonly modelCallCount: number;
  readonly textHash: string | null;
  readonly finishReason: string | null;
  readonly usage: ManifestUsage;
  readonly latencyMs: number | null;
  readonly providerRequestId: string | null;
  readonly safeErrorCode: string | null;
  readonly safeErrorMessage: string | null;
}

export interface ManifestAggregate {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalLatencyMs: number;
  readonly caseCount: number;
  readonly selectedCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
}

export interface ManifestArtifactHashes {
  readonly caseResultsPrivate: string;
  readonly candidatesPrivate: string | null;
  readonly evaluationReport: string | null;
  readonly evaluationReportMarkdown: string | null;
  readonly blindPacket: string | null;
  readonly blindMappingPrivate: string | null;
  readonly logsSafe: string | null;
  readonly manifestPrivate: string;
}

export interface ExperimentManifestV1 {
  readonly schemaVersion: 1;
  readonly experimentId: string;
  readonly toolVersion: string;
  readonly command: 'generate' | 'run';
  readonly strategy: {
    readonly strategyId: string;
    readonly strategyVersion: string;
    readonly promptVersion: string;
  };
  readonly provider: { readonly providerId: string; readonly modelId: string };
  readonly generationParameters: {
    readonly temperature: number;
    readonly maxTokens: number;
    readonly seed: string | null;
  };
  readonly sourceSuite: { readonly suiteId: string; readonly suiteHash: string };
  readonly outputSuite: { readonly suiteId: string; readonly suiteHash: string } | null;
  readonly selectionMode: SelectionMode;
  readonly selectedCaseIds: readonly string[];
  readonly satisfiesQ1: boolean;
  readonly timing: { readonly startedAt: string; readonly completedAt: string };
  readonly runStatus: ExperimentRunStatus;
  readonly cases: readonly ManifestCaseEntry[];
  readonly aggregate: ManifestAggregate;
  readonly artifactHashes: ManifestArtifactHashes;
  readonly repository: { readonly commit: string | null };
  readonly warnings: readonly string[];
  readonly note?: string;
}

/** 稳定序列化：canonicalize（NFC + 稳定 key 顺序）后 JSON.stringify。 */
export function serializeManifest(manifest: ExperimentManifestV1): string {
  return JSON.stringify(canonicalize(manifest));
}

/**
 * 计算 manifest 自身 hash（排除 artifactHashes 字段，避免循环依赖）。
 * manifestPrivate = sha256(canonical(manifest 去掉 artifactHashes))。
 */
export function computeManifestSelfHash(
  manifestWithoutArtifactHashes: Omit<ExperimentManifestV1, 'artifactHashes'>,
): string {
  const { artifactHashes: _artifactHashes, ...rest } =
    manifestWithoutArtifactHashes as ExperimentManifestV1;
  return sha256Hex(JSON.stringify(canonicalize(rest)));
}

/** 四组 Q1 布尔不变量（测试断言用）。 */
export function satisfiesQ1Invariant(manifest: ExperimentManifestV1): boolean {
  return (
    (manifest.satisfiesQ1 === true) ===
    (manifest.selectionMode === 'FULL_SELECTION' && manifest.runStatus === 'COMPLETE')
  );
}

export function outputSuiteInvariant(manifest: ExperimentManifestV1): boolean {
  return (
    (manifest.outputSuite === null) ===
    (manifest.runStatus !== 'COMPLETE' || manifest.selectionMode === 'PARTIAL_SELECTION')
  );
}

export function evaluateBlindExistInvariant(
  manifest: ExperimentManifestV1,
  hasEvaluateBlind: boolean,
): boolean {
  return (
    hasEvaluateBlind ===
    (manifest.command === 'run' &&
      manifest.runStatus === 'COMPLETE' &&
      manifest.selectionMode === 'FULL_SELECTION')
  );
}
