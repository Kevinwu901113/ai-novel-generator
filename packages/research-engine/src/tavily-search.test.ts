/**
 * TavilySearchProvider 测试（B5/D7）：请求形状、鉴权头、解析、安全过滤、错误映射。
 * fake fetchImpl，确定性、无网络。TAVILY_LIVE 门控的真调用测试见
 * tavily-live.gated.test.ts。
 */

import { describe, it, expect, vi } from 'vitest';
import { createTavilySearchProvider } from './tavily-search.js';

function tavilyOk(results: unknown): Response {
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createTavilySearchProvider', () => {
  it('请求形状：POST /search + Bearer 鉴权 + max_results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tavilyOk([]));
    const port = createTavilySearchProvider({
      apiKey: 'tv-key-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await port.search({ query: '晚清 邮政 制度', maxResults: 3 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tv-key-1');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.query).toBe('晚清 邮政 制度');
    expect(body.max_results).toBe(3);
  });

  it('解析结果：字段映射 + 不安全 URL 过滤 + maxResults 截断', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      tavilyOk([
        {
          url: 'https://a.example/1',
          title: 'A',
          content: 'ca',
          published_date: '2024-01-01',
          score: 0.87,
        },
        { url: 'http://127.0.0.1/evil', title: 'X', content: 'cx' },
        { url: 'file:///etc/passwd', title: 'Y', content: 'cy' },
        { url: 'https://b.example/2', title: '', content: 42 },
        { url: 'https://c.example/3', title: 'C', content: 'cc' },
      ]),
    );
    const port = createTavilySearchProvider({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const results = await port.search({ query: 'q', maxResults: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      url: 'https://a.example/1',
      title: 'A',
      snippet: 'ca',
      publishedAt: '2024-01-01',
      relevanceScore: 0.87,
    });
    // 空 title 回退 URL；非字符串 content 置空
    expect(results[1]).toEqual({
      url: 'https://b.example/2',
      title: 'https://b.example/2',
      snippet: '',
      publishedAt: null,
      relevanceScore: null,
    });
  });

  it('非 2xx → 抛错且不回显响应体', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"secret":"echo"}', { status: 401 }));
    const port = createTavilySearchProvider({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(port.search({ query: 'q', maxResults: 1 })).rejects.toThrow(/HTTP 401/);
    await expect(port.search({ query: 'q', maxResults: 1 })).rejects.not.toThrow(/echo/);
  });
});
