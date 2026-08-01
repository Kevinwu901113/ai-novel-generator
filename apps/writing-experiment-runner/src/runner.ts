/**
 * generate / run 编排。
 *
 * - generate：选 case → 顺序生成（concurrency=1）→ 写 case-results → 全成功且 FULL_SELECTION 时写 output suite。
 * - run：generate（Q1 模式全 case）+ 仅全部成功时 evaluateSuite → report、generateBlindPacket → packet+mapping。
 *   run 不接收 ratings、不 aggregate（人工评分继续用现有 writing-evaluation CLI）。
 * - 无自动重试；失败不伪装成功。
 * - 生产 invoke 由 CLI 接线并受 WRITING_EXPERIMENT_LIVE=1 守护；测试注入 fake invoke，永不触网。
 */

import {
  canonicalize,
  canonicalSerializeSuite,
  evaluateSuite,
  generateBlindPacket,
  renderMarkdownReport,
  sha256Hex,
  validateBlindPacket,
  validatePrivateMapping,
  type Clock,
  type WritingCandidateV1,
  type WritingEvaluationSuiteV1,
  type WritingGenerationExperimentInput,
} from '@ai-novel/writing-evaluation';
import type { ModelInvocationInput, ModelInvocationOutput } from '@ai-novel/model-gateway';
import {
  BASELINE_ONE_SHOT_STRATEGY,
  BASELINE_STRATEGY_ID,
} from './strategies/baseline-one-shot-v1.js';
import {
  ModelGatewayWritingCandidateGenerator,
  type ExperimentCaseResult,
} from './generator/model-gateway-writing-candidate-generator.js';
import { resolveProvider } from './providers.js';
import { readSourceSuite, buildOutputSuite, outputSuiteHash } from './suite-io.js';
import {
  computeManifestSelfHash,
  serializeManifest,
  EXPERIMENT_SCHEMA_VERSION,
  TOOL_VERSION,
  type ExperimentManifestV1,
  type ExperimentRunStatus,
  type ManifestAggregate,
  type ManifestArtifactHashes,
  type ManifestCaseEntry,
  type SelectionMode,
} from './manifest.js';
import { preflightPublish, publishDirectory, stagingPathFor, backupPathFor } from './publish.js';
import {
  CliUsageError,
  ExperimentError,
  LIVE_BLOCKED_KEY_NOT_CONFIGURED,
  safeErrorMessageForCode,
} from './safe-error.js';
import { buildDryRunPreview, type DryRunPreview } from './dry-run.js';

export interface AbortState {
  aborted: boolean;
}

export interface RunnerDeps {
  readonly clock: Clock;
  readonly idGenerator: () => string;
  readonly readFile: (p: string) => string;
  readonly writeFile: (p: string, content: string) => void;
  readonly exists: (p: string) => boolean;
  readonly mkdir: (p: string) => void;
  readonly renameDir: (from: string, to: string) => void;
  readonly removeDir: (p: string) => void;
  readonly invoke: (input: ModelInvocationInput) => Promise<ModelInvocationOutput>;
  readonly getApiKey: (service: string, account: string) => Promise<string | null>;
  readonly abort: AbortState;
  readonly log: (line: string) => void;
}

export interface RunOptions {
  readonly command: 'generate' | 'run';
  readonly sourceSuitePath: string;
  readonly outputDir: string;
  readonly strategy: string;
  readonly providerId: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly maxCases?: number;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly seed?: string;
  readonly gitCommit: string | null;
}

export interface RunOutcome {
  readonly dryRun: boolean;
  readonly preview?: DryRunPreview;
  readonly command: 'generate' | 'run';
  readonly experimentId: string;
  readonly runStatus: ExperimentRunStatus;
  readonly selectionMode: SelectionMode;
  readonly satisfiesQ1: boolean;
  readonly provider: { readonly providerId: string; readonly modelId: string };
  readonly sourceSuite: { readonly suiteId: string; readonly suiteHash: string };
  readonly outputSuite: { readonly suiteId: string; readonly suiteHash: string } | null;
  readonly selectedCaseIds: readonly string[];
  readonly cases: readonly ManifestCaseEntry[];
  readonly aggregate: ManifestAggregate;
  readonly artifactHashes: ManifestArtifactHashes;
  readonly finalDir: string;
  readonly exitCode: number;
  readonly note?: string;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function computeAggregate(
  entries: readonly ManifestCaseEntry[],
  requestedCount: number,
): ManifestAggregate {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLatencyMs = 0;
  for (const e of entries) {
    totalInputTokens += e.usage.inputTokens ?? 0;
    totalOutputTokens += e.usage.outputTokens ?? 0;
    totalLatencyMs += e.latencyMs ?? 0;
  }
  return {
    totalInputTokens,
    totalOutputTokens,
    totalLatencyMs,
    caseCount: requestedCount,
    selectedCount: entries.length,
    succeededCount: entries.filter((e) => e.status === 'SUCCEEDED').length,
    failedCount: entries.filter((e) => e.status === 'FAILED').length,
  };
}

function toManifestCaseEntry(result: ExperimentCaseResult): ManifestCaseEntry {
  const safeErrorCode = result.audit.safeErrorCode;
  return {
    caseId: result.caseId,
    status: result.status,
    candidateId: result.candidate?.candidateId ?? null,
    promptHash: result.audit.promptHash,
    textHash: result.candidate ? sha256Hex(result.candidate.text) : null,
    finishReason: result.audit.finishReason,
    usage: { ...result.audit.usage },
    latencyMs: result.audit.latencyMs,
    providerRequestId: result.audit.providerRequestId,
    safeErrorCode,
    safeErrorMessage: safeErrorCode !== null ? safeErrorMessageForCode(safeErrorCode) : null,
  };
}

function exitCodeFor(runStatus: ExperimentRunStatus): number {
  switch (runStatus) {
    case 'COMPLETE':
    case 'PARTIAL_SELECTION_SUCCEEDED':
      return 0;
    case 'ABORTED':
      return 130;
    case 'PARTIAL_FAILURE':
    case 'PARTIAL_SELECTION_FAILED':
      return 2;
  }
}

export async function runExperiment(deps: RunnerDeps, options: RunOptions): Promise<RunOutcome> {
  if (options.strategy !== BASELINE_STRATEGY_ID) {
    throw new CliUsageError(`未知 strategy "${options.strategy}"；可用: ${BASELINE_STRATEGY_ID}`);
  }

  // provider 前置拒绝（任何 IO / 网络 / 生成之前）
  const provider = resolveProvider(options.providerId);

  // source suite 校验 + canonical hash
  const source = readSourceSuite(deps.readFile, options.sourceSuitePath);
  const allCaseIds = source.suite.cases.map((c) => c.caseId);

  let selectionMode: SelectionMode;
  let selectedCaseIds: readonly string[];
  if (options.maxCases !== undefined) {
    if (!Number.isSafeInteger(options.maxCases) || options.maxCases < 1) {
      throw new CliUsageError('--max-cases 必须是正整数');
    }
    if (options.maxCases > allCaseIds.length) {
      throw new CliUsageError(`--max-cases ${options.maxCases} 超过用例总数 ${allCaseIds.length}`);
    }
    selectionMode = 'PARTIAL_SELECTION';
    selectedCaseIds = allCaseIds.slice(0, options.maxCases);
  } else {
    selectionMode = 'FULL_SELECTION';
    selectedCaseIds = allCaseIds;
  }

  // --dry-run：零费用预览，不写 artifact、无需 LIVE
  if (options.dryRun) {
    const preview = buildDryRunPreview({
      source,
      provider,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      selectionMode,
      selectedCaseIds,
    });
    return {
      dryRun: true,
      preview,
      command: options.command,
      experimentId: '',
      runStatus: 'COMPLETE',
      selectionMode,
      satisfiesQ1: false,
      provider: { providerId: provider.providerId, modelId: provider.modelId },
      sourceSuite: { suiteId: source.suite.suiteId, suiteHash: source.suiteHash },
      outputSuite: null,
      selectedCaseIds,
      cases: [],
      aggregate: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalLatencyMs: 0,
        caseCount: 0,
        selectedCount: 0,
        succeededCount: 0,
        failedCount: 0,
      },
      artifactHashes: {
        caseResultsPrivate: '',
        candidatesPrivate: null,
        evaluationReport: null,
        evaluationReportMarkdown: null,
        blindPacket: null,
        blindMappingPrivate: null,
        logsSafe: null,
        manifestPrivate: '',
      },
      finalDir: options.outputDir,
      exitCode: 0,
    };
  }

  const experimentId = deps.idGenerator();
  const startedAt = deps.clock.now();
  const finalDir = options.outputDir;
  const runId = deps.idGenerator();
  const stagingDir = stagingPathFor(finalDir, runId);
  const backupDir = backupPathFor(finalDir, runId);

  const publishDeps = {
    exists: deps.exists,
    renameDir: deps.renameDir,
    removeDir: deps.removeDir,
    idGenerator: deps.idGenerator,
  };
  preflightPublish(publishDeps, { finalDir, stagingDir, backupDir, force: options.force });
  deps.mkdir(stagingDir);

  // Keychain 预检：key 缺失则整体停止（LIVE_BLOCKED_KEY_NOT_CONFIGURED），不产生任何模型调用
  const apiKey = await deps.getApiKey(provider.keychainService, provider.keychainAccount);
  if (apiKey === null) {
    throw new ExperimentError(
      'Keychain 中未配置 API Key；请先配置 provider 密钥后重试',
      LIVE_BLOCKED_KEY_NOT_CONFIGURED,
    );
  }

  const generator = new ModelGatewayWritingCandidateGenerator({
    invoke: deps.invoke,
    clock: deps.clock,
    idGenerator: deps.idGenerator,
  });
  const caseById = new Map(source.suite.cases.map((c) => [c.caseId, c]));
  const caseResults: ExperimentCaseResult[] = [];
  let aborted = false;

  for (const caseId of selectedCaseIds) {
    if (deps.abort.aborted) {
      aborted = true;
      break;
    }
    const c = caseById.get(caseId);
    if (!c) {
      throw new ExperimentError(`case "${caseId}" 不存在`);
    }
    const input: WritingGenerationExperimentInput = {
      suiteId: source.suite.suiteId,
      caseId,
      sceneBrief: c.sceneBrief,
      contract: c.contract,
      constraints: c.constraints,
    };
    deps.log(`生成 case "${caseId}" ...`);
    const result = await generator.generateCase(input, {
      provider,
      apiKey,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
    caseResults.push(result);
    const statusLine =
      result.status === 'SUCCEEDED' ? 'SUCCEEDED' : `FAILED (${result.audit.safeErrorCode})`;
    deps.log(`case "${caseId}": ${statusLine}`);
    if (deps.abort.aborted) {
      aborted = true;
    }
  }

  const completedAt = deps.clock.now();
  const caseEntries = caseResults.map(toManifestCaseEntry);
  const aggregate = computeAggregate(caseEntries, selectedCaseIds.length);

  let runStatus: ExperimentRunStatus;
  if (aborted) {
    runStatus = 'ABORTED';
  } else if (aggregate.failedCount === 0) {
    runStatus = selectionMode === 'FULL_SELECTION' ? 'COMPLETE' : 'PARTIAL_SELECTION_SUCCEEDED';
  } else {
    runStatus = selectionMode === 'FULL_SELECTION' ? 'PARTIAL_FAILURE' : 'PARTIAL_SELECTION_FAILED';
  }

  const satisfiesQ1 = selectionMode === 'FULL_SELECTION' && runStatus === 'COMPLETE';

  const candidatesByCase = new Map<string, WritingCandidateV1>();
  for (const r of caseResults) {
    if (r.status === 'SUCCEEDED' && r.candidate !== null) {
      candidatesByCase.set(r.caseId, r.candidate);
    }
  }

  let outputSuite: WritingEvaluationSuiteV1 | null = null;
  if (satisfiesQ1) {
    outputSuite = buildOutputSuite(
      source.suite,
      candidatesByCase,
      experimentId,
      BASELINE_STRATEGY_ID,
    );
  }
  const outputSuiteInfo: { suiteId: string; suiteHash: string } | null = outputSuite
    ? { suiteId: outputSuite.suiteId, suiteHash: outputSuiteHash(outputSuite) }
    : null;

  // ── 组装 artifact 内容（全部先在内存中，最后统一写 staging）──────────

  const caseResultsContent = canonicalJson({
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId,
    cases: caseResults.map((r) => ({
      caseId: r.caseId,
      status: r.status,
      candidateId: r.candidate?.candidateId ?? null,
      promptHash: r.audit.promptHash,
      textHash: r.candidate ? sha256Hex(r.candidate.text) : null,
      finishReason: r.audit.finishReason,
      usage: { ...r.audit.usage },
      latencyMs: r.audit.latencyMs,
      providerRequestId: r.audit.providerRequestId,
      safeErrorCode: r.audit.safeErrorCode,
      safeErrorMessage:
        r.audit.safeErrorCode !== null ? safeErrorMessageForCode(r.audit.safeErrorCode) : null,
      ...(r.candidate !== null ? { candidate: r.candidate } : {}),
    })),
  });

  const logsContent = caseResults
    .map((r) =>
      canonicalJson({
        caseId: r.caseId,
        status: r.status,
        safeErrorCode: r.audit.safeErrorCode,
        promptHash: r.audit.promptHash,
        textHash: r.candidate ? sha256Hex(r.candidate.text) : null,
        latencyMs: r.audit.latencyMs,
        inputTokens: r.audit.usage.inputTokens,
        outputTokens: r.audit.usage.outputTokens,
      }),
    )
    .join('\n');

  let candidatesContent: string | null = null;
  let reportJsonContent: string | null = null;
  let reportMarkdownContent: string | null = null;
  let blindPacketContent: string | null = null;
  let blindMappingContent: string | null = null;

  if (satisfiesQ1 && outputSuite !== null) {
    candidatesContent = canonicalSerializeSuite(outputSuite);

    if (options.command === 'run') {
      const report = evaluateSuite(outputSuite, {
        clock: deps.clock,
        toolVersion: TOOL_VERSION,
      });
      reportJsonContent = JSON.stringify(canonicalize(report));
      reportMarkdownContent = renderMarkdownReport(report);

      if (options.seed === undefined) {
        throw new CliUsageError('run 命令需要 --seed');
      }
      const blind = generateBlindPacket(outputSuite, { seed: options.seed });
      blindPacketContent = JSON.stringify(canonicalize(validateBlindPacket(blind.packet)));
      blindMappingContent = JSON.stringify(
        canonicalize(validatePrivateMapping(blind.mapping, blind.packet)),
      );
    }
  }

  // ── manifest（最后组装，写入前计算自身 hash）───────────────────────

  const note =
    selectionMode === 'PARTIAL_SELECTION'
      ? 'partial-selection smoke/debug run（--max-cases），不满足 Q1'
      : undefined;

  const manifestBase: Omit<ExperimentManifestV1, 'artifactHashes'> = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId,
    toolVersion: TOOL_VERSION,
    command: options.command,
    strategy: {
      strategyId: BASELINE_STRATEGY_ID,
      strategyVersion: BASELINE_ONE_SHOT_STRATEGY.strategyVersion,
      promptVersion: BASELINE_ONE_SHOT_STRATEGY.promptVersion,
    },
    provider: { providerId: provider.providerId, modelId: provider.modelId },
    generationParameters: {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      seed: options.seed ?? null,
    },
    sourceSuite: { suiteId: source.suite.suiteId, suiteHash: source.suiteHash },
    outputSuite: outputSuiteInfo,
    selectionMode,
    selectedCaseIds,
    satisfiesQ1,
    timing: { startedAt, completedAt },
    runStatus,
    cases: caseEntries,
    aggregate,
    repository: { commit: options.gitCommit },
    warnings: [],
    ...(note !== undefined ? { note } : {}),
  };

  const manifestSelfHash = computeManifestSelfHash(manifestBase);
  const artifactHashes: ManifestArtifactHashes = {
    caseResultsPrivate: sha256Hex(caseResultsContent),
    candidatesPrivate: candidatesContent !== null ? sha256Hex(candidatesContent) : null,
    evaluationReport: reportJsonContent !== null ? sha256Hex(reportJsonContent) : null,
    evaluationReportMarkdown:
      reportMarkdownContent !== null ? sha256Hex(reportMarkdownContent) : null,
    blindPacket: blindPacketContent !== null ? sha256Hex(blindPacketContent) : null,
    blindMappingPrivate: blindMappingContent !== null ? sha256Hex(blindMappingContent) : null,
    logsSafe: sha256Hex(logsContent),
    manifestPrivate: manifestSelfHash,
  };
  const manifest: ExperimentManifestV1 = { ...manifestBase, artifactHashes };
  const manifestContent = serializeManifest(manifest);

  // ── 写 staging ─────────────────────────────────────────────────────
  deps.writeFile(`${stagingDir}/case-results.private.json`, caseResultsContent);
  deps.writeFile(`${stagingDir}/logs.safe.jsonl`, logsContent);
  if (candidatesContent !== null) {
    deps.writeFile(`${stagingDir}/candidates.private.json`, candidatesContent);
  }
  if (reportJsonContent !== null) {
    deps.writeFile(`${stagingDir}/evaluation.report.json`, reportJsonContent);
  }
  if (reportMarkdownContent !== null) {
    deps.writeFile(`${stagingDir}/evaluation.report.md`, reportMarkdownContent);
  }
  if (blindPacketContent !== null) {
    deps.writeFile(`${stagingDir}/blind.packet.json`, blindPacketContent);
  }
  if (blindMappingContent !== null) {
    deps.writeFile(`${stagingDir}/blind.mapping.private.json`, blindMappingContent);
  }
  deps.writeFile(`${stagingDir}/manifest.private.json`, manifestContent);

  // ── 目录级原子发布 ────────────────────────────────────────────────
  publishDirectory(publishDeps, { finalDir, stagingDir, backupDir, force: options.force });

  return {
    dryRun: false,
    command: options.command,
    experimentId,
    runStatus,
    selectionMode,
    satisfiesQ1,
    provider: { providerId: provider.providerId, modelId: provider.modelId },
    sourceSuite: { suiteId: source.suite.suiteId, suiteHash: source.suiteHash },
    outputSuite: outputSuiteInfo,
    selectedCaseIds,
    cases: caseEntries,
    aggregate,
    artifactHashes,
    finalDir,
    exitCode: exitCodeFor(runStatus),
    ...(note !== undefined ? { note } : {}),
  };
}
