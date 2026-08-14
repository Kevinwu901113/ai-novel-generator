/**
 * TavilySearchProvider —— 真实 WebSearchPort 实现（B5/D7）。
 *
 * POST https://api.tavily.com/search（Bearer 鉴权）。API key 由调用方（worker）
 * 从 secret-store 槽位读出注入，不进代码/配置/日志；本模块不打印 key。
 * fetchImpl / clock 可注入：确定性单测与 TAVILY_LIVE 门控真调用共用同一实现。
 * 结果 URL 过 isSafeSourceUrl 过滤（安全边界在搜索结果层同样生效）。
 */

import type { SearchResult, WebSearchPort } from './research-types.js';
import { isSafeSourceUrl } from './security.js';

export interface TavilySearchOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

interface TavilyResponseShape {
  readonly results?: ReadonlyArray<{
    readonly url?: unknown;
    readonly title?: unknown;
    readonly content?: unknown;
    readonly published_date?: unknown;
    readonly score?: unknown;
  }>;
}

export function createTavilySearchProvider(options: TavilySearchOptions): WebSearchPort {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? 'https://api.tavily.com';
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    async search(input: { query: string; maxResults: number }): Promise<SearchResult[]> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/search`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            query: input.query,
            max_results: input.maxResults,
            search_depth: 'basic',
            include_answer: false,
            include_raw_content: false,
          }),
        });
        if (!response.ok) {
          // 不回显响应体（可能含请求回声）；状态码足够定位
          throw new Error(`Tavily 搜索失败 HTTP ${response.status}`);
        }
        const data = (await response.json()) as TavilyResponseShape;
        const results = Array.isArray(data.results) ? data.results : [];
        const mapped: SearchResult[] = [];
        for (const r of results) {
          if (typeof r.url !== 'string' || !isSafeSourceUrl(r.url)) continue;
          mapped.push({
            url: r.url,
            title: typeof r.title === 'string' && r.title.length > 0 ? r.title : r.url,
            snippet: typeof r.content === 'string' ? r.content.slice(0, 500) : '',
            publishedAt: typeof r.published_date === 'string' ? r.published_date : null,
            relevanceScore:
              typeof r.score === 'number' &&
              Number.isFinite(r.score) &&
              r.score >= 0 &&
              r.score <= 1
                ? r.score
                : null,
          });
          if (mapped.length >= input.maxResults) break;
        }
        return mapped;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
