/**
 * @ai-novel/writing-experiment-runner
 *
 * 真实生成实验 Runner 的程序化 API（CLI 在 cli.ts / cli-run.ts）。
 * 库代码不 import node:child_process / fetch / 产品数据库 / Electron；
 * Keychain 只经 @ai-novel/secret-store。
 */

export {
  runExperiment,
  type AbortState,
  type RunnerDeps,
  type RunOptions,
  type RunOutcome,
} from './runner.js';
export { parseCliArgs, runCli, type CliDeps, type ParsedCli } from './cli.js';
export {
  PROVIDER_REGISTRY,
  DEFAULT_PROVIDER_ID,
  resolveProvider,
  listProviderIds,
  type ProviderEntry,
} from './providers.js';
export {
  BASELINE_ONE_SHOT_STRATEGY,
  buildBaselineOneShotPrompt,
  computePromptHash,
  type BuiltPrompt,
} from './strategies/baseline-one-shot-v1.js';
export {
  ANTISLOP_V1_STRATEGY,
  buildAntislopRevisionPrompt,
  collectAntislopEvidence,
  type AntislopEvidence,
} from './strategies/antislop-v1.js';
export {
  ANTISLOP_V2_STRATEGY,
  ANTISLOP_V2_STYLE_RULES,
  buildAntislopV2Prompt,
} from './strategies/antislop-v2.js';
export {
  STRATEGY_REGISTRY,
  listStrategyIds,
  resolveStrategy,
  type StrategyDefinition,
} from './strategies/strategy-registry.js';
export {
  ModelGatewayWritingCandidateGenerator,
  validateModelText,
  type ExperimentCaseGeneratorPort,
  type ExperimentCaseResult,
  type ExperimentCaseAudit,
  type GenerateCaseParams,
} from './generator/model-gateway-writing-candidate-generator.js';
export { preflightPublish, publishDirectory, stagingPathFor, backupPathFor } from './publish.js';
export { buildDryRunPreview, type DryRunPreview, type DryRunCasePreview } from './dry-run.js';
export {
  readSourceSuite,
  buildOutputSuite,
  mergeOutputSuites,
  parseOutputSuiteId,
  outputSuiteHash,
  type SourceSuiteRef,
  type OutputSuiteIdParts,
  type MergedSuiteCandidateOrigin,
  type MergeOutputSuitesResult,
} from './suite-io.js';
export {
  serializeManifest,
  computeManifestSelfHash,
  satisfiesQ1Invariant,
  outputSuiteInvariant,
  evaluateBlindExistInvariant,
  EXPERIMENT_SCHEMA_VERSION,
  TOOL_VERSION,
  type ExperimentManifestV1,
  type ExperimentRunStatus,
  type SelectionMode,
  type CaseStatus,
  type ManifestCaseEntry,
  type ManifestAggregate,
  type ManifestArtifactHashes,
  type ManifestUsage,
} from './manifest.js';
export {
  CliUsageError,
  ExperimentError,
  safeErrorMessage,
  safeErrorMessageForCode,
  safeDisplayPath,
  PROVIDER_ERROR_MESSAGES,
  LIVE_BLOCKED_KEY_NOT_CONFIGURED,
  LIVE_OPT_IN_REQUIRED,
} from './safe-error.js';
