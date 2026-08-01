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
import { hasSubstantiveContent, normalizeText, sha256Hex } from '@ai-novel/writing-evaluation';
import type { ModelInvocationInput, ModelInvocationOutput } from '@ai-novel/model-gateway';
import type { ProviderEntry } from '../providers.js';
import {
  BASELINE_ONE_SHOT_STRATEGY,
  buildBaselineOneShotPrompt,
} from '../strategies/baseline-one-shot-v1.js';

export interface ExperimentCaseAudit {
  readonly promptHash: string;
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

export class ModelGatewayWritingCandidateGenerator implements ExperimentCaseGeneratorPort {
  constructor(private readonly deps: ModelGatewayGeneratorDeps) {}

  async generateCase(
    input: WritingGenerationExperimentInput,
    params: GenerateCaseParams,
  ): Promise<ExperimentCaseResult> {
    const prompt = buildBaselineOneShotPrompt(input);
    const promptHash = sha256Hex(`${prompt.system}\n\n${prompt.user}`);

    const output = await this.deps.invoke({
      baseUrl: params.provider.baseUrl,
      model: params.provider.modelId,
      apiKey: params.apiKey,
      prompt: prompt.user,
      systemPrompt: prompt.system,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
    });

    const audit: ExperimentCaseAudit = {
      promptHash,
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

    const candidate: WritingCandidateV1 = {
      candidateId: `${BASELINE_ONE_SHOT_STRATEGY.strategyId}.${input.caseId}.${this.deps.idGenerator()}`,
      strategyId: BASELINE_ONE_SHOT_STRATEGY.strategyId,
      modelId: params.provider.modelId,
      promptVersion: BASELINE_ONE_SHOT_STRATEGY.promptVersion,
      generationParameters: {
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        seed: null,
      },
      text: validated.text,
    };

    return { caseId: input.caseId, status: 'SUCCEEDED', candidate, audit };
  }
}
