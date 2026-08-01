/**
 * Model Gateway adapter 测试。
 *
 * 全部 fake invoke，永不触网。
 * 覆盖：成功输出 / 空 / 零宽 / fence / 前缀说明 / timeout / rate limit /
 * network / usage / providerRequestId / raw error 不持久化 / candidateId 唯一。
 */

import { describe, it, expect } from 'vitest';
import {
  getBaselineSuite,
  type WritingGenerationExperimentInput,
} from '@ai-novel/writing-evaluation';
import {
  ModelGatewayWritingCandidateGenerator,
  validateModelText,
} from './model-gateway-writing-candidate-generator.js';
import { PROVIDER_REGISTRY } from '../providers.js';
import { createQueuedInvoke, errorOutput, okOutput } from '../test-util.js';
import { fixedClock } from '@ai-novel/writing-evaluation';

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

describe('validateModelText 结构层验证', () => {
  it('接受正常中文正文', () => {
    expect(validateModelText('深夜站台，雨落了下来。')).toEqual({
      ok: true,
      text: '深夜站台，雨落了下来。',
    });
  });
  it('拒绝空字符串 / 纯空白', () => {
    expect(validateModelText('').ok).toBe(false);
    expect(validateModelText('   \n  ').ok).toBe(false);
  });
  it('拒绝纯标点 / 零宽字符', () => {
    expect(validateModelText('。。。！！？？').ok).toBe(false);
    expect(validateModelText('​​​').ok).toBe(false);
  });
  it('拒绝 markdown code fence', () => {
    expect(validateModelText('```\n正文\n```').ok).toBe(false);
    expect(validateModelText('正文中间 ``` 围栏').ok).toBe(false);
  });
  it('拒绝明显前缀说明', () => {
    expect(validateModelText('以下是正文：夜里……').ok).toBe(false);
    expect(validateModelText('正文如下，请查收：……').ok).toBe(false);
  });
  it('接受长度略偏 / 质量偏差（交给评测测量）', () => {
    expect(validateModelText('站台').ok).toBe(true); // 长度略偏不拒绝
    expect(validateModelText('空气仿佛凝固，他有些尴尬。').ok).toBe(true); // 禁短语不在此拒绝
  });
  it('拒绝非字符串 provider 输出', () => {
    expect(validateModelText(123 as unknown as string).ok).toBe(false);
    expect(validateModelText(null as unknown as string).ok).toBe(false);
  });
});

describe('ModelGatewayWritingCandidateGenerator', () => {
  it('成功输出组装 candidate + audit（usage / providerRequestId / finishReason）', async () => {
    const invoke = createQueuedInvoke([
      okOutput('深夜站台，雨落了下来。', {
        providerRequestId: 'req-abc',
        finishReason: 'end_turn',
      }),
    ]);
    const gen = new ModelGatewayWritingCandidateGenerator({
      invoke,
      clock: fixedClock('2026-08-02T00:00:00.000Z'),
      idGenerator: () => 'tok-1',
    });
    const result = await gen.generateCase(inputForCase('restrained-reunion'), {
      provider: PROVIDER,
      apiKey: 'sk-dummy',
      temperature: 0.7,
      maxTokens: 1024,
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(result.candidate?.candidateId).toBe('baseline-one-shot-v1.restrained-reunion.tok-1');
    expect(result.candidate?.modelId).toBe('mimo-v2.5-pro');
    expect(result.candidate?.promptVersion).toBe('baseline-one-shot-v1.p1');
    expect(result.candidate?.generationParameters).toEqual({
      temperature: 0.7,
      maxTokens: 1024,
      seed: null,
    });
    expect(result.audit.providerRequestId).toBe('req-abc');
    expect(result.audit.finishReason).toBe('end_turn');
    expect(result.audit.usage.inputTokens).toBe(100);
    expect(result.audit.usage.outputTokens).toBe(50);
    expect(result.audit.safeErrorCode).toBeNull();
    expect(result.audit.promptHash).toMatch(/^[0-9a-f]{64}$/);
    // invoke 收到正确 baseUrl / model / key（key 不进入 audit）
    expect(invoke.calls[0].baseUrl).toBe(PROVIDER.baseUrl);
    expect(invoke.calls[0].model).toBe(PROVIDER.modelId);
    expect(invoke.calls[0].apiKey).toBe('sk-dummy');
    expect(JSON.stringify(result.audit)).not.toContain('sk-dummy');
  });

  it('candidateId 使用注入 idGenerator，保持唯一', async () => {
    let n = 0;
    const gen = new ModelGatewayWritingCandidateGenerator({
      invoke: createQueuedInvoke([okOutput('正文A'), okOutput('正文B')]),
      clock: fixedClock('2026-08-02T00:00:00.000Z'),
      idGenerator: () => `tok-${(n += 1)}`,
    });
    const a = await gen.generateCase(inputForCase('restrained-reunion'), {
      provider: PROVIDER,
      apiKey: 'k',
      temperature: 0.7,
      maxTokens: 1024,
    });
    const b = await gen.generateCase(inputForCase('suspense-corridor'), {
      provider: PROVIDER,
      apiKey: 'k',
      temperature: 0.7,
      maxTokens: 1024,
    });
    expect(a.candidate?.candidateId).not.toBe(b.candidate?.candidateId);
  });

  it('provider timeout / rate limit / network → case FAILED + 对应安全码，raw error 不持久化', async () => {
    const cases: Array<[string, string]> = [
      ['PROVIDER_TIMEOUT', 'PROVIDER_TIMEOUT'],
      ['PROVIDER_RATE_LIMITED', 'PROVIDER_RATE_LIMITED'],
      ['NETWORK_UNAVAILABLE', 'NETWORK_UNAVAILABLE'],
      ['PROVIDER_AUTH_FAILED', 'PROVIDER_AUTH_FAILED'],
      ['PROVIDER_CONNECTION_FAILED', 'PROVIDER_CONNECTION_FAILED'],
      ['PROVIDER_RESPONSE_INVALID', 'PROVIDER_RESPONSE_INVALID'],
    ];
    for (const [code, expected] of cases) {
      const gen = new ModelGatewayWritingCandidateGenerator({
        invoke: createQueuedInvoke([errorOutput(code)]),
        clock: fixedClock('2026-08-02T00:00:00.000Z'),
        idGenerator: () => 'tok',
      });
      const result = await gen.generateCase(inputForCase('restrained-reunion'), {
        provider: PROVIDER,
        apiKey: 'k',
        temperature: 0.7,
        maxTokens: 1024,
      });
      expect(result.status).toBe('FAILED');
      expect(result.audit.safeErrorCode).toBe(expected);
      // raw provider error message 绝不进入 audit
      expect(JSON.stringify(result.audit)).not.toContain('RAW provider error message');
    }
  });

  it('结构层不合格（空文本）→ MODEL_RESPONSE_INVALID', async () => {
    const gen = new ModelGatewayWritingCandidateGenerator({
      invoke: createQueuedInvoke([okOutput('')]),
      clock: fixedClock('2026-08-02T00:00:00.000Z'),
      idGenerator: () => 'tok',
    });
    const result = await gen.generateCase(inputForCase('restrained-reunion'), {
      provider: PROVIDER,
      apiKey: 'k',
      temperature: 0.7,
      maxTokens: 1024,
    });
    expect(result.status).toBe('FAILED');
    expect(result.audit.safeErrorCode).toBe('MODEL_RESPONSE_INVALID');
    expect(result.candidate).toBeNull();
  });
});
