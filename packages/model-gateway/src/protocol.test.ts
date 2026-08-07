/**
 * 协议适配层测试（B1 / D6）。
 *
 * 覆盖 `openai-chat` 新协议的请求构造与严格解析，以及 `anthropic-messages` 在重构后的
 * 回归（URL / 鉴权头 / 默认协议不变）。使用 mock fetch，不访问真实 API、不使用真实 Key。
 */

import { describe, it, expect, vi } from 'vitest';
import { testConnection, invokeModel, type ModelGatewayDeps } from './index.js';
import { anthropicMessagesAdapter, openAiChatAdapter, adapterFor } from './protocol.js';

// ── 工具 ──────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function depsWith(fetchImpl: typeof globalThis.fetch): ModelGatewayDeps {
  return { fetch: fetchImpl, clock: { now: () => '2026-08-06T00:00:00.000Z' } };
}

function capturingFetch(response: Response | (() => Response)): {
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

const OPENAI_INPUT = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: 'test-secret-not-a-real-key',
  protocol: 'openai-chat' as const,
};

function openAiSuccessBody(content = 'OK'): unknown {
  return {
    id: 'chatcmpl-1',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

// ── 适配器选择 ────────────────────────────────────────────────────

describe('adapterFor', () => {
  it('按协议返回对应适配器', () => {
    expect(adapterFor('anthropic-messages')).toBe(anthropicMessagesAdapter);
    expect(adapterFor('openai-chat')).toBe(openAiChatAdapter);
  });
});

// ── openai-chat 请求构造 ──────────────────────────────────────────

describe('openai-chat 请求构造', () => {
  it('URL 只在 baseUrl 后补 /chat/completions（版本段由用户配置表达）', () => {
    const req = openAiChatAdapter.buildRequest({
      baseUrl: 'https://api.deepseek.com/v1/',
      model: 'deepseek-chat',
      apiKey: 'k',
      prompt: 'hi',
      maxTokens: 16,
    });
    expect(req.url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('使用 Bearer 鉴权头，且显式非流式', () => {
    const req = openAiChatAdapter.buildRequest({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      prompt: 'hi',
      maxTokens: 16,
    });
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(req.headers['content-type']).toBe('application/json');
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens).toBe(16);
  });

  it('systemPrompt 作为首条 system 消息，user 消息在后', () => {
    const req = openAiChatAdapter.buildRequest({
      baseUrl: 'https://api.openai.com/v1',
      model: 'm',
      apiKey: 'k',
      prompt: '正文',
      maxTokens: 16,
      systemPrompt: '系统',
    });
    const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toEqual([
      { role: 'system', content: '系统' },
      { role: 'user', content: '正文' },
    ]);
  });

  it('未提供 temperature 时不写入该字段', () => {
    const req = openAiChatAdapter.buildRequest({
      baseUrl: 'https://api.openai.com/v1',
      model: 'm',
      apiKey: 'k',
      prompt: 'p',
      maxTokens: 16,
    });
    expect(JSON.parse(req.body)).not.toHaveProperty('temperature');
  });
});

// ── openai-chat 严格解析 ──────────────────────────────────────────

describe('openai-chat 响应解析', () => {
  it('解析文本、请求 id、finish_reason 与 usage', () => {
    const parsed = openAiChatAdapter.parse(openAiSuccessBody('你好'));
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe('你好');
    expect(parsed!.providerRequestId).toBe('chatcmpl-1');
    expect(parsed!.finishReason).toBe('stop');
    expect(parsed!.usage.inputTokens).toBe(11);
    expect(parsed!.usage.outputTokens).toBe(7);
    expect(parsed!.usage.totalTokens).toBe(18);
    expect(parsed!.usage.cacheWriteTokens).toBeNull();
  });

  it('DeepSeek 的 prompt_cache_hit_tokens 映射为 cacheReadTokens', () => {
    const parsed = openAiChatAdapter.parse({
      id: 'x',
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, prompt_cache_hit_tokens: 4 },
    });
    expect(parsed!.usage.cacheReadTokens).toBe(4);
  });

  it('OpenAI 的 prompt_tokens_details.cached_tokens 映射为 cacheReadTokens', () => {
    const parsed = openAiChatAdapter.parse({
      id: 'x',
      choices: [{ message: { content: 'OK' } }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    });
    expect(parsed!.usage.cacheReadTokens).toBe(3);
  });

  it('缺失 usage 时 token 一律 null，不自行推断', () => {
    const parsed = openAiChatAdapter.parse({ choices: [{ message: { content: 'OK' } }] });
    expect(parsed!.usage.inputTokens).toBeNull();
    expect(parsed!.usage.outputTokens).toBeNull();
    expect(parsed!.usage.totalTokens).toBeNull();
  });

  it('异常 token 值（负数 / NaN / 字符串）归一为 null', () => {
    const parsed = openAiChatAdapter.parse({
      choices: [{ message: { content: 'OK' } }],
      usage: { prompt_tokens: -1, completion_tokens: Number.NaN, total_tokens: '18' },
    });
    expect(parsed!.usage.inputTokens).toBeNull();
    expect(parsed!.usage.outputTokens).toBeNull();
    expect(parsed!.usage.totalTokens).toBeNull();
  });

  it.each([
    ['非对象', 42],
    ['无 choices', { id: 'x' }],
    ['choices 为空数组', { choices: [] }],
    ['choice 无 message', { choices: [{ finish_reason: 'stop' }] }],
    ['content 为 null（仅 tool_calls）', { choices: [{ message: { content: null } }] }],
    ['content 为空字符串', { choices: [{ message: { content: '' } }] }],
    ['content 非字符串', { choices: [{ message: { content: { a: 1 } } }] }],
  ])('拒绝畸形响应：%s', (_label, body) => {
    expect(openAiChatAdapter.parse(body)).toBeNull();
  });
});

// ── anthropic-messages 回归 ───────────────────────────────────────

describe('anthropic-messages 回归（重构后行为不变）', () => {
  it('URL 补 /v1/messages，鉴权头双发 api-key 与 x-api-key + anthropic-version', () => {
    const req = anthropicMessagesAdapter.buildRequest({
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic/',
      model: 'mimo-v2.5-pro',
      apiKey: 'k',
      prompt: 'hi',
      maxTokens: 32,
    });
    expect(req.url).toBe('https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages');
    expect(req.headers['api-key']).toBe('k');
    expect(req.headers['x-api-key']).toBe('k');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers).not.toHaveProperty('authorization');
  });

  it('拼接多个 text block，忽略 thinking block', () => {
    const parsed = anthropicMessagesAdapter.parse({
      id: 'msg-1',
      content: [
        { type: 'thinking', thinking: '...' },
        { type: 'text', text: '前' },
        { type: 'text', text: '后' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    expect(parsed!.text).toBe('前后');
    expect(parsed!.usage.totalTokens).toBe(7);
  });

  it('只有 thinking 而无 text 时视为非法响应', () => {
    expect(
      anthropicMessagesAdapter.parse({ content: [{ type: 'thinking', thinking: '...' }] }),
    ).toBeNull();
  });
});

// ── 端到端：invokeModel / testConnection 按协议分派 ────────────────

describe('invokeModel — openai-chat', () => {
  it('成功调用返回文本与 usage', async () => {
    const { fetch, calls } = capturingFetch(jsonResponse(openAiSuccessBody('结果')));
    const result = await invokeModel(depsWith(fetch), { ...OPENAI_INPUT, prompt: '写一句话' });

    expect(result.errorCode).toBeNull();
    expect(result.text).toBe('结果');
    expect(result.usage.inputTokens).toBe(11);
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it.each([
    [401, 'PROVIDER_AUTH_FAILED'],
    [403, 'PROVIDER_ACCESS_DENIED'],
    [404, 'PROVIDER_MODEL_UNAVAILABLE'],
    [429, 'PROVIDER_RATE_LIMITED'],
    [500, 'PROVIDER_CONNECTION_FAILED'],
    [400, 'PROVIDER_CONNECTION_FAILED'],
  ])('HTTP %i 归一化为 %s', async (status, expected) => {
    const { fetch } = capturingFetch(jsonResponse({ error: { message: 'x' } }, status));
    const result = await invokeModel(depsWith(fetch), { ...OPENAI_INPUT, prompt: 'p' });
    expect(result.errorCode).toBe(expected);
    expect(result.text).toBe('');
  });

  it('非 JSON 响应归一化为 PROVIDER_RESPONSE_INVALID', async () => {
    const { fetch } = capturingFetch(
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const result = await invokeModel(depsWith(fetch), { ...OPENAI_INPUT, prompt: 'p' });
    expect(result.errorCode).toBe('PROVIDER_RESPONSE_INVALID');
  });

  it('畸形结构归一化为 PROVIDER_RESPONSE_INVALID', async () => {
    const { fetch } = capturingFetch(jsonResponse({ choices: [] }));
    const result = await invokeModel(depsWith(fetch), { ...OPENAI_INPUT, prompt: 'p' });
    expect(result.errorCode).toBe('PROVIDER_RESPONSE_INVALID');
  });

  it('超时归一化为 PROVIDER_TIMEOUT', async () => {
    const abortFetch = vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof globalThis.fetch;
    const result = await invokeModel(depsWith(abortFetch), { ...OPENAI_INPUT, prompt: 'p' });
    expect(result.errorCode).toBe('PROVIDER_TIMEOUT');
  });

  it('网络失败归一化为 NETWORK_UNAVAILABLE', async () => {
    const netFetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.reject(new TypeError('fetch failed')),
      ) as unknown as typeof globalThis.fetch;
    const result = await invokeModel(depsWith(netFetch), { ...OPENAI_INPUT, prompt: 'p' });
    expect(result.errorCode).toBe('NETWORK_UNAVAILABLE');
  });

  it('不把 apiKey 或上游 body 带进返回值', async () => {
    const { fetch } = capturingFetch(jsonResponse({ error: { message: 'sk-leak' } }, 500));
    const result = await invokeModel(depsWith(fetch), { ...OPENAI_INPUT, prompt: 'p' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(OPENAI_INPUT.apiKey);
    expect(serialized).not.toContain('sk-leak');
  });
});

describe('testConnection — 协议分派', () => {
  it('openai-chat 成功', async () => {
    const { fetch, calls } = capturingFetch(jsonResponse(openAiSuccessBody()));
    const result = await testConnection(depsWith(fetch), OPENAI_INPUT);
    expect(result.success).toBe(true);
    expect(result.errorCode).toBeNull();
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-secret-not-a-real-key',
    );
  });

  it('openai-chat 空内容视为失败', async () => {
    const { fetch } = capturingFetch(jsonResponse({ choices: [{ message: { content: '' } }] }));
    const result = await testConnection(depsWith(fetch), OPENAI_INPUT);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_RESPONSE_INVALID');
  });

  it('省略 protocol 时按 anthropic-messages 处理（迁移期兼容）', async () => {
    const { fetch, calls } = capturingFetch(
      jsonResponse({ id: 'm', content: [{ type: 'text', text: 'OK' }] }),
    );
    const result = await testConnection(depsWith(fetch), {
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
      model: 'mimo-v2.5-pro',
      apiKey: 'k',
    });
    expect(result.success).toBe(true);
    expect(calls[0].url).toBe('https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages');
    expect((calls[0].init.headers as Record<string, string>)['api-key']).toBe('k');
  });
});
