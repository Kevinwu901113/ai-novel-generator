/**
 * Model Gateway → Writing Candidate 适配器。
 *
 * 实现 Runner 内部 richer port（ExperimentCaseGeneratorPort），返回 candidate + audit。
 * 不修改 @ai-novel/writing-evaluation 的 WritingCandidateGeneratorPort。
 * 生产 invoke 由 CLI 接线，且受 WRITING_EXPERIMENT_LIVE=1 gate 守护；测试注入 fake invoke，永不触网。
 *
 * 安全：provider raw errorMessage / 完整 prompt / candidate 全文不进入 audit；
 * 结构层不合格输出（空 / 无实质 / fence / 明显前缀）映射为固定安全码 MODEL_RESPONSE_INVALID。
 */

import type {
  Clock,
  WritingCandidateV1,
  WritingGenerationExperimentInput,
} from '@ai-novel/writing-evaluation';
import { hasSubstantiveContent, normalizeText } from '@ai-novel/writing-evaluation';
import type { ModelInvocationInput, ModelInvocationOutput } from '@ai-novel/model-gateway';
import type { ProviderEntry } from '../providers.js';
import {
  BASELINE_ONE_SHOT_STRATEGY,
  computePromptHash,
  type BuiltPrompt,
} from '../strategies/baseline-one-shot-v1.js';
import { ANTISLOP_STRATEGY_ID } from '../strategies/antislop-v1.js';
import { ANTISLOP_V2_STRATEGY_ID } from '../strategies/antislop-v2.js';
import {
  buildAntislopRevisionPrompt,
  collectAntislopEvidence,
} from '../strategies/antislop-shared.js';
import { resolveStrategy, type StrategyDefinition } from '../strategies/strategy-registry.js';

const ANTISLOP_STRATEGY_IDS: ReadonlySet<string> = new Set([
  ANTISLOP_STRATEGY_ID,
  ANTISLOP_V2_STRATEGY_ID,
]);

export interface ExperimentCaseAudit {
  readonly promptHash: string;
  readonly modelCallCount: number;
  readonly finishReason: string | null;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadTokens: number | null;
    readonly cacheWriteTokens: number | null;
    readonly totalTokens: number | null;
  };
  readonly latencyMs: number;
  readonly providerRequestId: string | null;
  readonly safeErrorCode: string | null;
}

export interface ExperimentCaseResult {
  readonly caseId: string;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly candidate: WritingCandidateV1 | null;
  readonly audit: ExperimentCaseAudit;
}

export interface GenerateCaseParams {
  readonly provider: ProviderEntry;
  readonly apiKey: string;
  readonly temperature: number;
  readonly maxTokens: number;
}

export interface ExperimentCaseGeneratorPort {
  generateCase(
    input: WritingGenerationExperimentInput,
    params: GenerateCaseParams,
  ): Promise<ExperimentCaseResult>;
}

export interface ModelGatewayGeneratorDeps {
  readonly invoke: (input: ModelInvocationInput) => Promise<ModelInvocationOutput>;
  readonly clock: Clock;
  readonly idGenerator: () => string;
}

/** 明显“说明性”前缀：正文不应以这些开头。 */
const META_PREFIXES = [
  '以下是正文',
  '以下是',
  '正文如下',
  '内容如下',
  '以下为正文',
  '下面是正文',
  '如下是正文',
  '下面给出正文',
  '好的，',
  '好的：',
  '好的：\n',
];

function hasObviousMetaPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  return META_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export type ModelTextValidation =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly safeErrorCode: 'MODEL_RESPONSE_INVALID' };

/**
 * 结构层输出验证。质量层（长度略偏 / required phrase 未满足 / dialogue ratio 偏离 /
 * 文学质量）一律不在此预过滤，交给 Evaluation Lab 测量。
 */
export function validateModelText(text: unknown): ModelTextValidation {
  if (typeof text !== 'string') {
    return { ok: false, safeErrorCode: 'MODEL_RESPONSE_INVALID' };
  }
  const normalized = normalizeText(text);
  if (normalized.length === 0) {
    return { ok: false, safeErrorCode: 'MODEL_RESPONSE_INVALID' };
  }
  if (!hasSubstantiveContent(normalized)) {
    return { ok: false, safeErrorCode: 'MODEL_RESPONSE_INVALID' };
  }
  if (text.includes('```')) {
    return { ok: false, safeErrorCode: 'MODEL_RESPONSE_INVALID' };
  }
  if (hasObviousMetaPrefix(normalized)) {
    return { ok: false, safeErrorCode: 'MODEL_RESPONSE_INVALID' };
  }
  return { ok: true, text: normalized };
}

type Usage = ExperimentCaseAudit['usage'];

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

function mergeUsage(first: Usage, second: Usage): Usage {
  return {
    inputTokens: addNullable(first.inputTokens, second.inputTokens),
    outputTokens: addNullable(first.outputTokens, second.outputTokens),
    cacheReadTokens: addNullable(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: addNullable(first.cacheWriteTokens, second.cacheWriteTokens),
    totalTokens: addNullable(first.totalTokens, second.totalTokens),
  };
}

export class ModelGatewayWritingCandidateGenerator implements ExperimentCaseGeneratorPort {
  constructor(
    private readonly deps: ModelGatewayGeneratorDeps,
    private readonly strategy: StrategyDefinition = resolveStrategy(
      BASELINE_ONE_SHOT_STRATEGY.strategyId,
    ),
  ) {}

  async generateCase(
    input: WritingGenerationExperimentInput,
    params: GenerateCaseParams,
  ): Promise<ExperimentCaseResult> {
    const prompt = this.strategy.buildPrompt(input);
    if (ANTISLOP_STRATEGY_IDS.has(this.strategy.strategyId)) {
      return this.generateAntislopCase(input, params, prompt);
    }
    return this.generateSinglePassCase(input, params, prompt);
  }

  private async invokePrompt(
    params: GenerateCaseParams,
    prompt: BuiltPrompt,
  ): Promise<ModelInvocationOutput> {
    return this.deps.invoke({
      baseUrl: params.provider.baseUrl,
      model: params.provider.modelId,
      apiKey: params.apiKey,
      prompt: prompt.user,
      systemPrompt: prompt.system,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
    });
  }

  private auditFromOutput(
    output: ModelInvocationOutput,
    promptHash: string,
    modelCallCount: number,
  ): ExperimentCaseAudit {
    return {
      promptHash,
      modelCallCount,
      finishReason: output.finishReason,
      usage: {
        inputTokens: output.usage.inputTokens,
        outputTokens: output.usage.outputTokens,
        cacheReadTokens: output.usage.cacheReadTokens,
        cacheWriteTokens: output.usage.cacheWriteTokens,
        totalTokens: output.usage.totalTokens,
      },
      latencyMs: output.latencyMs,
      providerRequestId: output.providerRequestId,
      safeErrorCode: output.errorCode,
    };
  }

  private buildCandidate(
    input: WritingGenerationExperimentInput,
    params: GenerateCaseParams,
    text: string,
  ): WritingCandidateV1 {
    return {
      candidateId: `${this.strategy.strategyId}.${input.caseId}.${this.deps.idGenerator()}`,
      strategyId: this.strategy.strategyId,
      modelId: params.provider.modelId,
      promptVersion: this.strategy.promptVersion,
      generationParameters: {
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        seed: null,
      },
      text,
    };
  }

  private async generateSinglePassCase(
    input: WritingGenerationExperimentInput,
    params: GenerateCaseParams,
    prompt: BuiltPrompt,
  ): Promise<ExperimentCaseResult> {
    const output = await this.invokePrompt(params, prompt);
    const audit = this.auditFromOutput(output, computePromptHash(prompt), 1);

    if (output.errorCode !== null) {
      return { caseId: input.caseId, status: 'FAILED', candidate: null, audit };
    }

    const validated = validateModelText(output.text);
    if (!validated.ok) {
      return {
        caseId: input.caseId,
        status: 'FAILED',
        candidate: null,
        audit: { ...audit, safeErrorCode: validated.safeErrorCode },
      };
    }

    return {
      caseId: input.caseId,
      status: 'SUCCEEDED',
      candidate: this.buildCandidate(input, params, validated.text),
      audit,
    };
  }

  private async generateAntislopCase(
    input: WritingGenerationExperimentInput,
    params: GenerateCaseParams,
    firstPassPrompt: BuiltPrompt,
  ): Promise<ExperimentCaseResult> {
    const firstOutput = await this.invokePrompt(params, firstPassPrompt);
    const firstAudit = this.auditFromOutput(firstOutput, computePromptHash(firstPassPrompt), 1);

    if (firstOutput.errorCode !== null) {
      return { caseId: input.caseId, status: 'FAILED', candidate: null, audit: firstAudit };
    }

    const firstValidated = validateModelText(firstOutput.text);
    if (!firstValidated.ok) {
      return {
        caseId: input.caseId,
        status: 'FAILED',
        candidate: null,
        audit: { ...firstAudit, safeErrorCode: firstValidated.safeErrorCode },
      };
    }

    const evidence = collectAntislopEvidence(firstValidated.text);
    if (evidence.length === 0) {
      return {
        caseId: input.caseId,
        status: 'SUCCEEDED',
        candidate: this.buildCandidate(input, params, firstValidated.text),
        audit: firstAudit,
      };
    }

    const revisionPrompt = buildAntislopRevisionPrompt(firstValidated.text, evidence);
    const secondOutput = await this.invokePrompt(params, revisionPrompt);
    const secondAudit = this.auditFromOutput(secondOutput, computePromptHash(revisionPrompt), 1);

    const audit: ExperimentCaseAudit = {
      promptHash: secondAudit.promptHash,
      modelCallCount: 2,
      finishReason: secondAudit.finishReason,
      usage: mergeUsage(firstAudit.usage, secondAudit.usage),
      latencyMs: firstAudit.latencyMs + secondAudit.latencyMs,
      providerRequestId: secondAudit.providerRequestId,
      safeErrorCode: secondAudit.safeErrorCode,
    };

    if (secondOutput.errorCode !== null) {
      return { caseId: input.caseId, status: 'FAILED', candidate: null, audit };
    }

    const secondValidated = validateModelText(secondOutput.text);
    if (!secondValidated.ok) {
      return {
        caseId: input.caseId,
        status: 'FAILED',
        candidate: null,
        audit: { ...audit, safeErrorCode: secondValidated.safeErrorCode },
      };
    }

    return {
      caseId: input.caseId,
      status: 'SUCCEEDED',
      candidate: this.buildCandidate(input, params, secondValidated.text),
      audit,
    };
  }
}
