/**
 * Model Gateway 测试。
 *
 * 使用 mock fetch 测试各种场景。
 * 不访问真实 API，不使用真实 API Key。
 */

import { describe, it, expect, vi } from 'vitest';
import { testConnection, type ModelGatewayDeps, type ConnectionTestInput } from './index.js';

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
