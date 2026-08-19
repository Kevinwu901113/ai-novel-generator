/**
 * invokeEmbedding 测试（B23 / D-B23-3）。
 *
 * 与 invokeModel 同款纪律：永不抛异常、错误归一化成 ErrorCode、
 * 返回值里不出现 API Key 或上游 body。
 */

import { describe, it, expect, vi } from 'vitest';
import { invokeEmbedding } from './index.js';

const API_KEY = 'test-secret-not-a-real-key';

const OPENAI_INPUT = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'text-embedding-3-small',
  apiKey: API_KEY,
  protocol: 'openai-chat' as const,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function capturingFetch(response: Response | (() => Response | Promise<never>)): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn().mockImplementation((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(typeof response === 'function' ? response() : response);
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

function depsWith(fetch: typeof globalThis.fetch) {
  return { fetch, clock: { now: () => '2026-08-19T00:00:00.000Z' } };
}

function successBody(vectors: number[][]): unknown {
  return {
    object: 'list',
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 12, total_tokens: 12 },
  };
}

describe('invokeEmbedding — 协议限定', () => {
  it('anthropic-messages 直接判配置错误，不发请求', async () => {
    const { fetch, calls } = capturingFetch(jsonResponse(successBody([[1, 0]])));
    const result = await invokeEmbedding(depsWith(fetch), {
      ...OPENAI_INPUT,
      protocol: 'anthropic-messages',
      input: ['文本'],
    });

    expect(result.errorCode).toBe('PROVIDER_NOT_CONFIGURED');
    expect(result.embeddings).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(result.errorMessage).toContain('嵌入');
  });

  it('缺省协议（anthropic）同样判配置错误', async () => {
    const { fetch, calls } = capturingFetch(jsonResponse(successBody([[1, 0]])));
    const result = await invokeEmbedding(depsWith(fetch), {
      baseUrl: OPENAI_INPUT.baseUrl,
      model: OPENAI_INPUT.model,
      apiKey: API_KEY,
      input: ['文本'],
    });
    expect(result.errorCode).toBe('PROVIDER_NOT_CONFIGURED');
    expect(calls).toHaveLength(0);
  });

  it('空输入直接返回空结果，不发请求', async () => {
    const { fetch, calls } = capturingFetch(jsonResponse(successBody([])));
    const result = await invokeEmbedding(depsWith(fetch), { ...OPENAI_INPUT, input: [] });
    expect(result.errorCode).toBeNull();
    expect(result.embeddings).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('invokeEmbedding — openai-chat', () => {
  it('成功调用返回向量与 usage，URL 按 baseUrl 自带版本段的约定拼接', async () => {
    const { fetch, calls } = capturingFetch(
      jsonResponse(
        successBody([
          [0.1, 0.2],
          [0.3, 0.4],
        ]),
      ),
    );
    const result = await invokeEmbedding(depsWith(fetch), {
      ...OPENAI_INPUT,
      input: ['第一段', '第二段'],
    });

    expect(result.errorCode).toBeNull();
    expect(result.embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.totalTokens).toBe(12);
    // baseUrl 已含 /v1（与 chat/completions 同一口径），不再写死 /v1
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/embeddings');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: 'text-embedding-3-small',
      input: ['第一段', '第二段'],
    });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    );
  });

  it('baseUrl 尾部斜杠不产生双斜杠', async () => {
    const { fetch, calls } = capturingFetch(jsonResponse(successBody([[1]])));
    await invokeEmbedding(depsWith(fetch), {
      ...OPENAI_INPUT,
      baseUrl: 'https://api.deepseek.com/v1//',
      input: ['x'],
    });
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/embeddings');
  });

  it('按 index 归位（上游乱序返回也不会错位）', async () => {
    const { fetch } = capturingFetch(
      jsonResponse({
        data: [
          { index: 1, embedding: [9, 9] },
          { index: 0, embedding: [1, 1] },
        ],
      }),
    );
    const result = await invokeEmbedding(depsWith(fetch), { ...OPENAI_INPUT, input: ['a', 'b'] });
    expect(result.embeddings).toEqual([
      [1, 1],
      [9, 9],
    ]);
  });

  it.each([
    [401, 'PROVIDER_AUTH_FAILED'],
    [403, 'PROVIDER_ACCESS_DENIED'],
    [404, 'PROVIDER_MODEL_UNAVAILABLE'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [500, 'PROVIDER_CONNECTION_FAILED'],
  ])('HTTP %i 归一化为 %s', async (status, expected) => {
    const { fetch } = capturingFetch(jsonResponse({ error: { message: 'x' } }, status));
    const result = await invokeEmbedding(depsWith(fetch), { ...OPENAI_INPUT, input: ['x'] });
    expect(result.errorCode).toBe(expected);
    expect(result.embeddings).toEqual([]);
  });

  it('网络异常归一化，不抛给调用方', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof globalThis.fetch;
    const result = await invokeEmbedding(depsWith(fetch), { ...OPENAI_INPUT, input: ['x'] });
    expect(result.errorCode).toBe('NETWORK_UNAVAILABLE');
  });

  it.each([
    ['非 JSON 结构', { object: 'list' }],
    ['条数与请求不符', { data: [{ index: 0, embedding: [1] }] }],
    [
      '向量为空',
      {
        data: [
          { index: 0, embedding: [] },
          { index: 1, embedding: [1] },
        ],
      },
    ],
    [
      '向量含非数字',
      {
        data: [
          { index: 0, embedding: ['x'] },
          { index: 1, embedding: [1] },
        ],
      },
    ],
    [
      'index 越界',
      {
        data: [
          { index: 5, embedding: [1] },
          { index: 0, embedding: [1] },
        ],
      },
    ],
  ])('畸形响应 %s 判 PROVIDER_RESPONSE_INVALID', async (_label, body) => {
    const { fetch } = capturingFetch(jsonResponse(body));
    const result = await invokeEmbedding(depsWith(fetch), { ...OPENAI_INPUT, input: ['a', 'b'] });
    expect(result.errorCode).toBe('PROVIDER_RESPONSE_INVALID');
    expect(result.embeddings).toEqual([]);
  });

  it('返回值不泄露 API Key 与上游 body', async () => {
    const { fetch } = capturingFetch(
      jsonResponse({ error: { message: 'secret upstream detail' } }, 500),
    );
    const result = await invokeEmbedding(depsWith(fetch), { ...OPENAI_INPUT, input: ['x'] });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('secret upstream detail');
  });
});
