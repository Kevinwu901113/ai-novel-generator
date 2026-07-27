/**
 * Model Gateway 测试。
 *
 * 使用 mock fetch 测试各种场景。
 * 不访问真实 API，不使用真实 API Key。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  testConnection,
  invokeModel,
  type ModelGatewayDeps,
  type ConnectionTestInput,
  type ModelInvocationInput,
} from './index.js';

// ── Mock 工厂 ─────────────────────────────────────────────────────

function createMockFetch(response: Response | (() => Response)): typeof globalThis.fetch {
  const fn = typeof response === 'function' ? response : () => response;
  return vi.fn().mockImplementation(fn) as unknown as typeof globalThis.fetch;
}

function createMockClock(time = '2024-06-15T12:00:00.000Z'): { now(): string } {
  return { now: () => time };
}

function createDeps(fetchOverride?: typeof globalThis.fetch): ModelGatewayDeps {
  return {
    fetch: fetchOverride ?? createMockFetch(new Response(null, { status: 500 })),
    clock: createMockClock(),
  };
}

const validInput: ConnectionTestInput = {
  baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  model: 'mimo-v2.5-pro',
  apiKey: 'test-secret-not-a-real-key',
};

function makeSuccessResponse(text = 'OK'): Response {
  return new Response(
    JSON.stringify({
      id: 'msg-001',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeThinkingAndTextResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg-002',
      content: [
        { type: 'thinking', thinking: 'Let me think...' },
        { type: 'text', text: 'OK' },
      ],
      stop_reason: 'end_turn',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeOnlyThinkingResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg-003',
      content: [{ type: 'thinking', thinking: 'Let me think...' }],
      stop_reason: 'end_turn',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeErrorResponse(status: number, body = ''): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('testConnection', () => {
  it('应该成功测试连接', async () => {
    const deps = createDeps(createMockFetch(makeSuccessResponse()));
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
  });

  it('应该接受包含 thinking + text 的响应', async () => {
    const deps = createDeps(createMockFetch(makeThinkingAndTextResponse()));
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(true);
    expect(result.errorCode).toBeNull();
  });

  it('应该拒绝只有 thinking 无 text 的响应', async () => {
    const deps = createDeps(createMockFetch(makeOnlyThinkingResponse()));
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_RESPONSE_INVALID');
  });

  it('应该映射 401 为 PROVIDER_AUTH_FAILED', async () => {
    const deps = createDeps(createMockFetch(makeErrorResponse(401, '{"error":"unauthorized"}')));
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_AUTH_FAILED');
  });

  it('应该映射 403 为 PROVIDER_ACCESS_DENIED', async () => {
    const deps = createDeps(createMockFetch(makeErrorResponse(403, '{"error":"forbidden"}')));
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_ACCESS_DENIED');
  });

  it('应该映射 404 为 PROVIDER_MODEL_UNAVAILABLE', async () => {
    const deps = createDeps(createMockFetch(makeErrorResponse(404, '{"error":"not found"}')));
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_MODEL_UNAVAILABLE');
  });

  it('应该映射 429 为 PROVIDER_RATE_LIMITED', async () => {
    const deps = createDeps(createMockFetch(makeErrorResponse(429, '{"error":"rate limited"}')));
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_RATE_LIMITED');
  });

  it('应该映射 500 为 PROVIDER_CONNECTION_FAILED', async () => {
    const deps = createDeps(createMockFetch(makeErrorResponse(500, '{"error":"internal"}')));
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_CONNECTION_FAILED');
  });

  it('应该处理超时 (AbortError)', async () => {
    const abortFetch = vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof globalThis.fetch;

    const deps = createDeps(abortFetch);
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_TIMEOUT');
  });

  it('应该处理网络失败', async () => {
    const networkFetch = vi.fn().mockImplementation(() => {
      return Promise.reject(new TypeError('fetch failed'));
    }) as unknown as typeof globalThis.fetch;

    const deps = createDeps(networkFetch);
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('NETWORK_UNAVAILABLE');
  });

  it('应该处理非 JSON 响应', async () => {
    const nonJsonFetch = createMockFetch(
      new Response('not json at all', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const deps = createDeps(nonJsonFetch);
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_RESPONSE_INVALID');
  });

  it('应该处理 JSON 结构不合法', async () => {
    const badStructureFetch = createMockFetch(
      new Response(JSON.stringify({ foo: 'bar' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const deps = createDeps(badStructureFetch);
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_RESPONSE_INVALID');
  });

  it('应该处理 content 为空数组', async () => {
    const emptyContentFetch = createMockFetch(
      new Response(JSON.stringify({ id: 'msg-001', content: [], stop_reason: 'end_turn' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const deps = createDeps(emptyContentFetch);
    const result = await testConnection(deps, validInput);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_RESPONSE_INVALID');
  });

  it('应该使用正确的 URL 和 model', async () => {
    const mockFetch = createMockFetch(makeSuccessResponse());
    const deps = createDeps(mockFetch);
    await testConnection(deps, validInput);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages');

    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('mimo-v2.5-pro');
    expect(body.max_tokens).toBe(32);
    expect(body.messages).toEqual([{ role: 'user', content: '只回复 OK' }]);
  });

  it('应该使用 api-key header', async () => {
    const mockFetch = createMockFetch(makeSuccessResponse());
    const deps = createDeps(mockFetch);
    await testConnection(deps, validInput);

    const [, options] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = options.headers as Record<string, string>;
    expect(headers['api-key']).toBe('test-secret-not-a-real-key');
    expect(headers['content-type']).toBe('application/json');
  });

  it('错误中不应包含 API Key', async () => {
    const deps = createDeps(createMockFetch(makeErrorResponse(401, '{"error":"unauthorized"}')));
    const result = await testConnection(deps, validInput);

    // errorMessage 不应包含 key
    expect(result.errorMessage).not.toContain('test-secret-not-a-real-key');
  });

  it('错误消息不应包含上游 body 内容', async () => {
    const sensitiveBody = '{"error":"Invalid key: sk-abcdefghijklmnopqrstuvwxyz123456"}';
    const deps = createDeps(createMockFetch(makeErrorResponse(401, sensitiveBody)));
    const result = await testConnection(deps, validInput);

    // errorMessage 应该是固定消息，不包含上游 body
    expect(result.errorMessage).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(result.errorMessage).not.toContain('Invalid key');
    expect(result.errorMessage).toBe('API Key 认证失败');
  });

  it('错误消息应该是固定的用户可理解消息', async () => {
    const cases: Array<[number, string]> = [
      [401, 'API Key 认证失败'],
      [403, '访问被拒绝'],
      [404, '模型不可用'],
      [429, '请求频率超限'],
      [500, '连接失败'],
    ];

    for (const [status, expectedMessage] of cases) {
      const deps = createDeps(createMockFetch(makeErrorResponse(status, '{"error":"detail"}')));
      const result = await testConnection(deps, validInput);
      expect(result.errorMessage).toBe(expectedMessage);
    }
  });

  it('应该去掉 baseUrl 末尾的斜杠', async () => {
    const mockFetch = createMockFetch(makeSuccessResponse());
    const deps = createDeps(mockFetch);
    await testConnection(deps, {
      ...validInput,
      baseUrl: 'https://example.com/anthropic/',
    });

    const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://example.com/anthropic/v1/messages');
  });

  it('应该记录延迟时间', async () => {
    const deps = createDeps(createMockFetch(makeSuccessResponse()));
    const result = await testConnection(deps, validInput);

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.latencyMs).toBe('number');
  });
});

// ── invokeModel 测试 ──────────────────────────────────────────────

const invocationInput: ModelInvocationInput = {
  baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
  model: 'mimo-v2.5-pro',
  apiKey: 'test-secret-not-a-real-key',
  prompt: '你好',
};

function makeInvocationSuccessResponse(text = '你好！有什么可以帮助你的吗？'): Response {
  return new Response(
    JSON.stringify({
      id: 'msg-100',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeInvocationSuccessWithCacheResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg-101',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeInvocationSuccessNoUsageResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg-102',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeInvocationThinkingResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg-103',
      content: [
        { type: 'thinking', thinking: '让我想想...' },
        { type: 'text', text: '好的' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 15 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('invokeModel', () => {
  it('应该成功调用并返回文本', async () => {
    const deps = createDeps(createMockFetch(makeInvocationSuccessResponse()));
    const result = await invokeModel(deps, invocationInput);

    expect(result.text).toBe('你好！有什么可以帮助你的吗？');
    expect(result.errorCode).toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.providerRequestId).toBe('msg-100');
    expect(result.finishReason).toBe('end_turn');
  });

  it('应该返回完整的 usage 信息', async () => {
    const deps = createDeps(createMockFetch(makeInvocationSuccessResponse()));
    const result = await invokeModel(deps, invocationInput);

    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(20);
    expect(result.usage.totalTokens).toBe(30);
  });

  it('应该处理 cache tokens', async () => {
    const deps = createDeps(createMockFetch(makeInvocationSuccessWithCacheResponse()));
    const result = await invokeModel(deps, invocationInput);

    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.cacheReadTokens).toBe(100);
    expect(result.usage.cacheWriteTokens).toBe(50);
    expect(result.usage.totalTokens).toBe(15);
  });

  it('usage 缺失时应该返回 null', async () => {
    const deps = createDeps(createMockFetch(makeInvocationSuccessNoUsageResponse()));
    const result = await invokeModel(deps, invocationInput);

    expect(result.usage.inputTokens).toBeNull();
    expect(result.usage.outputTokens).toBeNull();
    expect(result.usage.cacheReadTokens).toBeNull();
    expect(result.usage.cacheWriteTokens).toBeNull();
    expect(result.usage.totalTokens).toBeNull();
  });

  it('应该处理 thinking + text 响应', async () => {
    const deps = createDeps(createMockFetch(makeInvocationThinkingResponse()));
    const result = await invokeModel(deps, invocationInput);

    expect(result.text).toBe('好的');
    expect(result.errorCode).toBeNull();
  });

  it('应该映射 401 为 PROVIDER_AUTH_FAILED', async () => {
    const deps = createDeps(createMockFetch(makeErrorResponse(401)));
    const result = await invokeModel(deps, invocationInput);

    expect(result.errorCode).toBe('PROVIDER_AUTH_FAILED');
    expect(result.text).toBe('');
  });

  it('应该映射 429 为 PROVIDER_RATE_LIMITED', async () => {
    const deps = createDeps(createMockFetch(makeErrorResponse(429)));
    const result = await invokeModel(deps, invocationInput);

    expect(result.errorCode).toBe('PROVIDER_RATE_LIMITED');
  });

  it('应该映射 500 为 PROVIDER_CONNECTION_FAILED', async () => {
    const deps = createDeps(createMockFetch(makeErrorResponse(500)));
    const result = await invokeModel(deps, invocationInput);

    expect(result.errorCode).toBe('PROVIDER_CONNECTION_FAILED');
  });

  it('应该处理超时', async () => {
    const abortFetch = vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof globalThis.fetch;

    const deps = createDeps(abortFetch);
    const result = await invokeModel(deps, invocationInput);

    expect(result.errorCode).toBe('PROVIDER_TIMEOUT');
    expect(result.text).toBe('');
  });

  it('应该处理网络失败', async () => {
    const networkFetch = vi.fn().mockImplementation(() => {
      return Promise.reject(new TypeError('fetch failed'));
    }) as unknown as typeof globalThis.fetch;

    const deps = createDeps(networkFetch);
    const result = await invokeModel(deps, invocationInput);

    expect(result.errorCode).toBe('NETWORK_UNAVAILABLE');
  });

  it('应该处理非 JSON 响应', async () => {
    const nonJsonFetch = createMockFetch(
      new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const deps = createDeps(nonJsonFetch);
    const result = await invokeModel(deps, invocationInput);

    expect(result.errorCode).toBe('PROVIDER_RESPONSE_INVALID');
  });

  it('应该处理空 content', async () => {
    const emptyFetch = createMockFetch(
      new Response(JSON.stringify({ id: 'msg-001', content: [], stop_reason: 'end_turn' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const deps = createDeps(emptyFetch);
    const result = await invokeModel(deps, invocationInput);

    expect(result.errorCode).toBe('PROVIDER_RESPONSE_INVALID');
  });

  it('错误中不应包含 API Key', async () => {
    const deps = createDeps(createMockFetch(makeErrorResponse(401)));
    const result = await invokeModel(deps, invocationInput);

    expect(result.errorMessage).not.toContain('test-secret-not-a-real-key');
  });

  it('错误中不应包含 prompt', async () => {
    const deps = createDeps(createMockFetch(makeErrorResponse(401)));
    const result = await invokeModel(deps, { ...invocationInput, prompt: '非常机密的提示词' });

    expect(result.errorMessage).not.toContain('非常机密的提示词');
  });

  it('错误消息不应包含上游 body', async () => {
    const sensitiveBody = '{"error":"Invalid key: sk-abcdefghijklmnopqrstuvwxyz123456"}';
    const deps = createDeps(createMockFetch(makeErrorResponse(401, sensitiveBody)));
    const result = await invokeModel(deps, invocationInput);

    expect(result.errorMessage).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(result.errorMessage).toBe('API Key 认证失败');
  });

  it('应该使用正确的 URL', async () => {
    const mockFetch = createMockFetch(makeInvocationSuccessResponse());
    const deps = createDeps(mockFetch);
    await invokeModel(deps, invocationInput);

    const [url] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages');
  });

  it('应该发送正确的请求体', async () => {
    const mockFetch = createMockFetch(makeInvocationSuccessResponse());
    const deps = createDeps(mockFetch);
    await invokeModel(deps, { ...invocationInput, prompt: '测试提示词', maxTokens: 100 });

    const [, options] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('mimo-v2.5-pro');
    expect(body.max_tokens).toBe(100);
    expect(body.messages).toEqual([{ role: 'user', content: '测试提示词' }]);
  });

  it('应该支持 systemPrompt', async () => {
    const mockFetch = createMockFetch(makeInvocationSuccessResponse());
    const deps = createDeps(mockFetch);
    await invokeModel(deps, { ...invocationInput, systemPrompt: '你是助手' });

    const [, options] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.system).toBe('你是助手');
  });

  it('应该支持 temperature', async () => {
    const mockFetch = createMockFetch(makeInvocationSuccessResponse());
    const deps = createDeps(mockFetch);
    await invokeModel(deps, { ...invocationInput, temperature: 0.7 });

    const [, options] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(options.body as string);
    expect(body.temperature).toBe(0.7);
  });
});
