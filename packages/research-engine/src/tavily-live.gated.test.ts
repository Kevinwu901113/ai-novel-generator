/**
 * Tavily 真实调用 gated 测试（B5/D7）。
 *
 * 默认 skip；本地显式启用：
 *   TAVILY_LIVE=1 TAVILY_API_KEY=tvly-xxx pnpm exec vitest run packages/research-engine/src/tavily-live.gated.test.ts
 *
 * key 只从环境变量读，不落文件；CI 不设置这两个变量，永远 skip。
 */

import { describe, it, expect } from 'vitest';
import { createTavilySearchProvider } from './tavily-search.js';
import { createSafeWebFetch } from './safe-web-fetch.js';

const LIVE = process.env.TAVILY_LIVE === '1' && !!process.env.TAVILY_API_KEY;

describe.skipIf(!LIVE)('Tavily live（gated）', () => {
  it('真实搜索 + SafeWebFetch 抓取首条来源', async () => {
    const search = createTavilySearchProvider({ apiKey: process.env.TAVILY_API_KEY! });
    const results = await search.search({ query: '晚清邮政制度 历史', maxResults: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].url).toMatch(/^https?:\/\//);

    const fetchPort = createSafeWebFetch();
    const doc = await fetchPort.fetch({ url: results[0].url, timeoutMs: 15_000 });
    expect(doc.extractedText.length).toBeGreaterThan(0);
  }, 60_000);
});
