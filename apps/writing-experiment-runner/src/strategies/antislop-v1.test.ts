/**
 * antislop-v1 策略测试（fake invoke，永不触网）。
 *
 * 覆盖：
 * - 检测器有命中 → 两次调用，第二趟 prompt 包含第一趟命中的具体词组；
 * - 检测器零命中 → 一次调用，modelCallCount=1；
 * - 第二趟失败 → 整个 case 失败（不静默退回初稿）；
 * - runner 策略注册表：两个 id 均可解析，未知 id 列出所有可用 id。
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
import { ANTISLOP_V1_STRATEGY } from './antislop-v1.js';
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

function antislopGenerator(outputs: readonly ReturnType<typeof okOutput>[]): {
  invoke: ReturnType<typeof createQueuedInvoke>;
  generate: () => ReturnType<ModelGatewayWritingCandidateGenerator['generateCase']>;
} {
  const invoke = createQueuedInvoke(outputs);
  const gen = new ModelGatewayWritingCandidateGenerator(
    {
      invoke,
      clock: fixedClock('2026-08-02T00:00:00.000Z'),
      idGenerator: () => 'tok-antislop',
    },
    resolveStrategy('antislop-v1'),
  );
  return {
    invoke,
    generate: () =>
      gen.generateCase(inputForCase('restrained-reunion'), {
        provider: PROVIDER,
        apiKey: 'sk-dummy',
        temperature: ANTISLOP_V1_STRATEGY.defaultTemperature,
        maxTokens: ANTISLOP_V1_STRATEGY.defaultMaxTokens,
      }),
  };
}

describe('antislop-v1 固定参数', () => {
  it('strategy / version / promptVersion / 默认参数与 baseline 区分', () => {
    expect(ANTISLOP_V1_STRATEGY).toMatchObject({
      strategyId: 'antislop-v1',
      strategyVersion: '1',
      promptVersion: 'antislop-v1.p1',
      defaultTemperature: 0.7,
      defaultMaxTokens: 8192,
      concurrency: 1,
      retries: 0,
    });
    expect(ANTISLOP_V1_STRATEGY.promptVersion).not.toBe('baseline-one-shot-v1.p1');
  });
});

describe('antislop-v1 两趟生成', () => {
  it('检测器有命中 → 两次调用，第二趟 prompt 包含第一趟命中的具体词组', async () => {
    const { invoke, generate } = antislopGenerator([
      okOutput('她仿佛听见远处有人喊她。雨落了下来。'),
      okOutput('她好像听见远处有人喊她。雨落了下来。'),
    ]);
    const result = await generate();

    expect(result.status).toBe('SUCCEEDED');
    expect(result.audit.modelCallCount).toBe(2);
    expect(invoke.calls).toHaveLength(2);
    // 不是只断言调用次数：第二趟 prompt 必须由具体证据驱动。
    expect(invoke.calls[1].prompt).toContain('她仿佛听见远处有人喊她');
    expect(invoke.calls[1].prompt).toContain('仿佛');
    expect(invoke.calls[1].prompt).toContain('【检测到的问题】');
    expect(invoke.calls[1].prompt).toContain('不要重写整段');
    expect(invoke.calls[1].prompt).toContain('不要补字数');
    expect(result.candidate?.strategyId).toBe('antislop-v1');
    expect(result.candidate?.promptVersion).toBe('antislop-v1.p1');
  });

  it('检测器零命中 → 只调用一次，modelCallCount=1，直接返回初稿', async () => {
    const firstDraft = '深夜站台，雨落了下来。';
    const { invoke, generate } = antislopGenerator([okOutput(firstDraft)]);
    const result = await generate();

    expect(result.status).toBe('SUCCEEDED');
    expect(result.audit.modelCallCount).toBe(1);
    expect(invoke.calls).toHaveLength(1);
    expect(result.candidate?.text).toBe(firstDraft);
  });

  it('第二趟失败 → 整个 case 失败，不静默退回初稿', async () => {
    const { invoke, generate } = antislopGenerator([
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

describe('runner 策略注册表', () => {
  it('两个 id 都能选中并带出各自的 strategyId/promptVersion', () => {
    const baseline = resolveStrategy('baseline-one-shot-v1');
    const antislop = resolveStrategy('antislop-v1');
    expect(baseline.strategyId).toBe('baseline-one-shot-v1');
    expect(baseline.promptVersion).toBe('baseline-one-shot-v1.p1');
    expect(antislop.strategyId).toBe('antislop-v1');
    expect(antislop.promptVersion).toBe('antislop-v1.p1');
    expect(STRATEGY_REGISTRY['baseline-one-shot-v1']).toBeDefined();
    expect(STRATEGY_REGISTRY['antislop-v1']).toBeDefined();
  });

  it('未知 id 报错且信息里列出所有可用 id', () => {
    expect(listStrategyIds()).toContain('baseline-one-shot-v1');
    expect(listStrategyIds()).toContain('antislop-v1');
    expect(() => resolveStrategy('unknown-v9')).toThrow(
      /未知 strategy "unknown-v9"；可用: baseline-one-shot-v1, antislop-v1/,
    );
  });
});
