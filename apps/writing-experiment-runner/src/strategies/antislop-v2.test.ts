/**
 * antislop-v2 策略测试（fake invoke，永不触网）。
 *
 * 覆盖：
 * - v2 固定参数与 promptVersion；
 * - v2 与 baseline / v1 的 promptHash 均不同（同一 case、同参数）；
 * - v2 system prompt 包含 docs/development/ai-writing-quality.md §4 的反 AI 味规则；
 * - 检测器有命中 → 两次调用，第二趟 prompt 包含第一趟命中的具体词组；
 * - 检测器零命中 → 一次调用，modelCallCount=1；
 * - 第二趟失败 → 整个 case 失败（不静默退回初稿）；
 * - runner 策略注册表：三个 id 均可解析，未知 id 列出所有可用 id。
 */

import { describe, it, expect } from 'vitest';
import {
  fixedClock,
  getBaselineSuite,
  type WritingGenerationExperimentInput,
} from '@ai-novel/writing-evaluation';
import { ModelGatewayWritingCandidateGenerator } from '../generator/model-gateway-writing-candidate-generator.js';
import { PROVIDER_REGISTRY } from '../providers.js';
import { createQueuedInvoke, errorOutput, okOutput } from '../test-util.js';
import { buildBaselineOneShotPrompt, computePromptHash } from './baseline-one-shot-v1.js';
import {
  ANTISLOP_V2_STRATEGY,
  ANTISLOP_V2_STYLE_RULES,
  buildAntislopV2Prompt,
} from './antislop-v2.js';
import { listStrategyIds, resolveStrategy, STRATEGY_REGISTRY } from './strategy-registry.js';

const PROVIDER = PROVIDER_REGISTRY['mimo-token-plan-cn'];

function inputForCase(caseId: string): WritingGenerationExperimentInput {
  const suite = getBaselineSuite();
  const c = suite.cases.find((x) => x.caseId === caseId);
  if (!c) throw new Error(`case ${caseId} 不存在`);
  return {
    suiteId: suite.suiteId,
    caseId,
    sceneBrief: c.sceneBrief,
    contract: c.contract,
    constraints: c.constraints,
  };
}

function v2Generator(outputs: readonly ReturnType<typeof okOutput>[]): {
  invoke: ReturnType<typeof createQueuedInvoke>;
  generate: () => ReturnType<ModelGatewayWritingCandidateGenerator['generateCase']>;
} {
  const invoke = createQueuedInvoke(outputs);
  const gen = new ModelGatewayWritingCandidateGenerator(
    {
      invoke,
      clock: fixedClock('2026-08-02T00:00:00.000Z'),
      idGenerator: () => 'tok-antislop-v2',
    },
    resolveStrategy('antislop-v2'),
  );
  return {
    invoke,
    generate: () =>
      gen.generateCase(inputForCase('restrained-reunion'), {
        provider: PROVIDER,
        apiKey: 'sk-dummy',
        temperature: ANTISLOP_V2_STRATEGY.defaultTemperature,
        maxTokens: ANTISLOP_V2_STRATEGY.defaultMaxTokens,
      }),
  };
}

describe('antislop-v2 固定参数', () => {
  it('strategy / version / promptVersion / 默认参数锁定', () => {
    expect(ANTISLOP_V2_STRATEGY).toMatchObject({
      strategyId: 'antislop-v2',
      strategyVersion: '1',
      promptVersion: 'antislop-v2.p1',
      defaultTemperature: 0.7,
      defaultMaxTokens: 8192,
      concurrency: 1,
      retries: 0,
    });
    expect(ANTISLOP_V2_STRATEGY.promptVersion).not.toBe('baseline-one-shot-v1.p1');
    expect(ANTISLOP_V2_STRATEGY.promptVersion).not.toBe('antislop-v1.p1');
  });
});

describe('antislop-v2 prompt 与 baseline / v1 分离', () => {
  it('同一 case 下 v2 promptHash 与 baseline、v1 都不同', () => {
    const input = inputForCase('restrained-reunion');
    const baselinePrompt = buildBaselineOneShotPrompt(input);
    const v1Prompt = resolveStrategy('antislop-v1').buildPrompt(input);
    const v2Prompt = buildAntislopV2Prompt(input);

    expect(computePromptHash(v2Prompt)).not.toBe(computePromptHash(baselinePrompt));
    expect(computePromptHash(v2Prompt)).not.toBe(computePromptHash(v1Prompt));
    // v1 是“只有检测器、没有 prompt 规则”的消融臂，因此第一趟仍与 baseline 相同。
    expect(computePromptHash(v1Prompt)).toBe(computePromptHash(baselinePrompt));
    expect(v2Prompt.user).toBe(baselinePrompt.user);
  });

  it('v2 system prompt 原样包含 §4 反 AI 味规则', () => {
    const { system } = buildAntislopV2Prompt(inputForCase('restrained-reunion'));

    expect(system).toContain(ANTISLOP_V2_STYLE_RULES);
    expect(system).toContain('要求具体动作、对白和感官事实');
    expect(system).toContain('限制连续使用“像/仿佛/似乎”');
    expect(system).toContain('禁止清单式环境陈列');
    expect(system).toContain('禁止模板化微表情');
    expect(system).toContain('禁止空泛套话');
    expect(system).toContain('禁止模糊拐杖词');
    expect(system).toContain('禁止否定式排比');
    expect(system).toContain('禁止强行三段式');
    expect(system).toContain('禁止解释比喻');
    expect(system).toContain('禁止结尾强行升华');
  });
});

describe('antislop-v2 两趟生成', () => {
  it('检测器有命中 → 两次调用，第二趟 prompt 包含第一趟命中的具体词组', async () => {
    const { invoke, generate } = v2Generator([
      okOutput('她仿佛听见远处有人喊她。雨落了下来。'),
      okOutput('她好像听见远处有人喊她。雨落了下来。'),
    ]);
    const result = await generate();

    expect(result.status).toBe('SUCCEEDED');
    expect(result.audit.modelCallCount).toBe(2);
    expect(invoke.calls).toHaveLength(2);
    expect(invoke.calls[0].systemPrompt).toContain('清单式');
    expect(invoke.calls[0].systemPrompt).toContain('升华');
    expect(invoke.calls[1].prompt).toContain('她仿佛听见远处有人喊她');
    expect(invoke.calls[1].prompt).toContain('【检测到的问题】');
    expect(invoke.calls[1].prompt).toContain('不要重写整段');
    expect(invoke.calls[1].prompt).toContain('不要补字数');
    expect(result.candidate?.strategyId).toBe('antislop-v2');
    expect(result.candidate?.promptVersion).toBe('antislop-v2.p1');
  });

  it('检测器零命中 → 只调用一次，modelCallCount=1，直接返回初稿', async () => {
    const firstDraft = '深夜站台，雨落了下来。';
    const { invoke, generate } = v2Generator([okOutput(firstDraft)]);
    const result = await generate();

    expect(result.status).toBe('SUCCEEDED');
    expect(result.audit.modelCallCount).toBe(1);
    expect(invoke.calls).toHaveLength(1);
    expect(result.candidate?.text).toBe(firstDraft);
  });

  it('第二趟失败 → 整个 case 失败，不静默退回初稿', async () => {
    const { invoke, generate } = v2Generator([
      okOutput('她仿佛听见远处有人喊她。'),
      errorOutput('PROVIDER_TIMEOUT'),
    ]);
    const result = await generate();

    expect(result.status).toBe('FAILED');
    expect(result.candidate).toBeNull();
    expect(result.audit.modelCallCount).toBe(2);
    expect(result.audit.safeErrorCode).toBe('PROVIDER_TIMEOUT');
    expect(invoke.calls).toHaveLength(2);
  });
});

describe('antislop-v2 注册表接入', () => {
  it('三个 id 都能选中并带出各自的 strategyId/promptVersion', () => {
    const baseline = resolveStrategy('baseline-one-shot-v1');
    const antislopV1 = resolveStrategy('antislop-v1');
    const antislopV2 = resolveStrategy('antislop-v2');

    expect(baseline.strategyId).toBe('baseline-one-shot-v1');
    expect(baseline.promptVersion).toBe('baseline-one-shot-v1.p1');
    expect(antislopV1.strategyId).toBe('antislop-v1');
    expect(antislopV1.promptVersion).toBe('antislop-v1.p1');
    expect(antislopV2.strategyId).toBe('antislop-v2');
    expect(antislopV2.promptVersion).toBe('antislop-v2.p1');
    expect(STRATEGY_REGISTRY['antislop-v2']).toBeDefined();
  });

  it('未知 id 报错且信息里列出所有可用 id', () => {
    expect(listStrategyIds()).toEqual(['baseline-one-shot-v1', 'antislop-v1', 'antislop-v2']);
    expect(() => resolveStrategy('unknown-v9')).toThrow(
      /未知 strategy "unknown-v9"；可用: baseline-one-shot-v1, antislop-v1, antislop-v2/,
    );
  });
});
