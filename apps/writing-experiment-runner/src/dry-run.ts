/**
 * --dry-run 零费用预览：验证 suite、逐 case 构建 prompt、计算 promptHash 与预估 token。
 * 不调用模型、不写 artifact、无需 WRITING_EXPERIMENT_LIVE。
 */

import {
  codePointLength,
  type WritingGenerationExperimentInput,
} from '@ai-novel/writing-evaluation';
import type { SourceSuiteRef } from './suite-io.js';
import type { ProviderEntry } from './providers.js';
import { computePromptHash } from './strategies/baseline-one-shot-v1.js';
import type { StrategyDefinition } from './strategies/strategy-registry.js';
import type { SelectionMode } from './manifest.js';

export interface DryRunCasePreview {
  readonly caseId: string;
  readonly title: string;
  readonly promptHash: string;
  readonly estimatedTokens: number;
}

export interface DryRunPreview {
  readonly schemaVersion: 1;
  readonly dryRun: true;
  readonly suiteId: string;
  readonly suiteHash: string;
  readonly provider: { readonly providerId: string; readonly modelId: string };
  readonly strategy: {
    readonly strategyId: string;
    readonly strategyVersion: string;
    readonly promptVersion: string;
  };
  readonly generationParameters: { readonly temperature: number; readonly maxTokens: number };
  readonly selectionMode: SelectionMode;
  readonly selectedCaseIds: readonly string[];
  readonly cases: readonly DryRunCasePreview[];
  readonly estimatedTotalTokens: number;
}

export interface DryRunInput {
  readonly source: SourceSuiteRef;
  readonly provider: ProviderEntry;
  readonly strategy: StrategyDefinition;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly selectionMode: SelectionMode;
  readonly selectedCaseIds: readonly string[];
}

/** 粗估 token 数（启发式：2 个 code point ≈ 1 token），仅用于成本预览，不是计费值。 */
function estimateTokens(text: string): number {
  return Math.ceil(codePointLength(text) / 2);
}

export function buildDryRunPreview(input: DryRunInput): DryRunPreview {
  const caseById = new Map(input.source.suite.cases.map((c) => [c.caseId, c]));
  const cases: DryRunCasePreview[] = [];
  let estimatedTotalTokens = 0;

  for (const caseId of input.selectedCaseIds) {
    const c = caseById.get(caseId);
    if (!c) {
      throw new Error(`case "${caseId}" 不存在`);
    }
    const experimentInput: WritingGenerationExperimentInput = {
      suiteId: input.source.suite.suiteId,
      caseId,
      sceneBrief: c.sceneBrief,
      contract: c.contract,
      constraints: c.constraints,
    };
    const prompt = input.strategy.buildPrompt(experimentInput);
    const promptHash = computePromptHash(prompt);
    const estimatedTokens = estimateTokens(prompt.system) + estimateTokens(prompt.user);
    estimatedTotalTokens += estimatedTokens;
    cases.push({ caseId, title: c.title, promptHash, estimatedTokens });
  }

  return {
    schemaVersion: 1,
    dryRun: true,
    suiteId: input.source.suite.suiteId,
    suiteHash: input.source.suiteHash,
    provider: { providerId: input.provider.providerId, modelId: input.provider.modelId },
    strategy: {
      strategyId: input.strategy.strategyId,
      strategyVersion: input.strategy.strategyVersion,
      promptVersion: input.strategy.promptVersion,
    },
    generationParameters: {
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    },
    selectionMode: input.selectionMode,
    selectedCaseIds: input.selectedCaseIds,
    cases,
    estimatedTotalTokens,
  };
}
