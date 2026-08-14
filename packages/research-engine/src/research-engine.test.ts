/**
 * research-engine 测试（GE-4）。
 *
 * - 安全边界：协议白名单 / credentials 拒绝 / localhost/private/link-local 拒绝；
 * - 深度判断：none/light/deep；
 * - 编排：搜索 + 抓取 + 事实笔记 + 来源绑定；失败跳过；none 不调研。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  validateResearchTargetUrl,
  isSafeSourceUrl,
  determineResearchDepth,
  orchestrateResearch,
  isSearchResultRelevant,
  type ResearchInput,
  type WebFetchPort,
  type WebSearchPort,
  type FetchedDocument,
  type SearchResult,
} from './index.js';

describe('security boundary', () => {
  it('接受 http/https', () => {
    expect(validateResearchTargetUrl('https://example.com/page')).toBe('https://example.com/page');
    expect(validateResearchTargetUrl('http://example.com/')).toBe('http://example.com/');
  });

  it('拒绝非 http/https 协议', () => {
    expect(() => validateResearchTargetUrl('javascript:alert(1)')).toThrow();
    expect(() => validateResearchTargetUrl('ftp://example.com')).toThrow();
    expect(() => validateResearchTargetUrl('file:///etc/passwd')).toThrow();
  });

  it('拒绝 credentials', () => {
    expect(() => validateResearchTargetUrl('https://user:pass@example.com/')).toThrow();
  });

  it('拒绝 localhost / private / link-local', () => {
    expect(() => validateResearchTargetUrl('https://localhost/x')).toThrow();
    expect(() => validateResearchTargetUrl('http://127.0.0.1/')).toThrow();
    expect(() => validateResearchTargetUrl('http://10.0.0.5/')).toThrow();
    expect(() => validateResearchTargetUrl('http://192.168.1.1/')).toThrow();
    expect(() => validateResearchTargetUrl('http://169.254.169.254/latest/meta-data/')).toThrow();
    expect(() => validateResearchTargetUrl('https://foo.local/x')).toThrow();
    expect(() => validateResearchTargetUrl('https://foo.internal/x')).toThrow();
  });

  it('拒绝内嵌私网 IPv4 的 IPv6 字面量与 IPv4 组播/保留段（B5 复查 B-1）', () => {
    // WHATWG URL 会把 [::ffff:127.0.0.1] 归一化为十六进制 [::ffff:7f00:1]
    expect(() => validateResearchTargetUrl('http://[::ffff:127.0.0.1]/')).toThrow();
    expect(() =>
      validateResearchTargetUrl('http://[::ffff:169.254.169.254]/latest/meta-data/'),
    ).toThrow();
    expect(() => validateResearchTargetUrl('http://[::7f00:1]/')).toThrow();
    expect(() => validateResearchTargetUrl('http://[64:ff9b::7f00:1]/')).toThrow();
    expect(() => validateResearchTargetUrl('http://[2002:7f00:1::]/')).toThrow();
    expect(() => validateResearchTargetUrl('http://[fe80::1]/')).toThrow();
    expect(() => validateResearchTargetUrl('http://224.0.0.1/')).toThrow();
    expect(() => validateResearchTargetUrl('http://255.255.255.255/')).toThrow();
  });

  it('isSafeSourceUrl 对非法 URL 返回 false', () => {
    expect(isSafeSourceUrl('https://example.com')).toBe(true);
    expect(isSafeSourceUrl('http://127.0.0.1/')).toBe(false);
    expect(isSafeSourceUrl('http://[::ffff:7f00:1]/')).toBe(false);
    expect(isSafeSourceUrl('http://[2607:f8b0::1]/')).toBe(true);
    expect(isSafeSourceUrl('not-a-url')).toBe(false);
  });
});

describe('depth decision', () => {
  const base: ResearchInput = {
    projectId: 'p1',
    idea: '一个侦探故事',
    creationSpecSummary: '',
    requiresFactuality: false,
    questions: [],
  };

  it('无现实依赖 + 不要求真实性 → none', () => {
    expect(determineResearchDepth(base)).toBe('none');
  });

  it('要求真实性 → light', () => {
    expect(determineResearchDepth({ ...base, requiresFactuality: true })).toBe('light');
  });

  it('涉及历史/时代 → deep', () => {
    expect(determineResearchDepth({ ...base, idea: '晚清上海滩的谍战故事' })).toBe('deep');
  });
});

describe('orchestrateResearch', () => {
  function fakeDeps() {
    const search: WebSearchPort = {
      async search(input) {
        return [
          {
            url: 'https://example.com/a',
            title: '晚清租界格局 A',
            snippet: '晚清租界格局摘要-a',
            publishedAt: null,
          },
          { url: 'http://127.0.0.1/blocked', title: 'blocked', snippet: '', publishedAt: null },
          {
            url: 'https://example.com/b',
            title: '租界行政区划 B',
            snippet: '当时租界行政区划摘要-b',
            publishedAt: null,
          },
        ].slice(0, input.maxResults) as SearchResult[];
      },
    };
    const fetch: WebFetchPort = {
      async fetch(input) {
        if (input.url.includes('blocked')) throw new Error('blocked');
        return {
          url: input.url,
          title: input.url.includes('/a') ? '晚清租界格局 A' : '租界行政区划 B',
          extractedText: `正文 ${input.url}`,
          fetchedAt: '2026-08-04T00:00:00.000Z',
        } as FetchedDocument;
      },
    };
    let n = 0;
    return {
      search,
      fetch,
      deps: {
        search,
        fetch,
        idGenerator: { generate: () => `id-${++n}` },
        clock: { now: () => '2026-08-04T00:00:00.000Z' },
      },
    };
  }

  it('light 调研：搜索 + 抓取 + 事实笔记 + 来源绑定', async () => {
    const { deps, search } = fakeDeps();
    const searchSpy = vi.spyOn(search, 'search');
    const bundle = await orchestrateResearch(deps, {
      projectId: 'p1',
      depth: 'light',
      idea: '晚清上海滩',
      questions: ['当时的租界格局是什么？'],
    });
    expect(bundle.depth).toBe('light');
    expect(bundle.questions).toHaveLength(1);
    // 127.0.0.1 被安全边界拒绝；只保留 example.com 来源
    expect(bundle.questions[0].sources.length).toBeGreaterThan(0);
    expect(bundle.factNotes.length).toBeGreaterThan(0);
    expect(bundle.factNotes[0].sourceUrls[0]).toContain('example.com');
    expect(bundle.factNotes[0].text).toBe(
      '【晚清租界格局 A】晚清租界格局摘要-a\n【租界行政区划 B】当时租界行政区划摘要-b',
    );
    expect(bundle.questions[0].sources[0].excerpt).toBe('晚清租界格局摘要-a');
    expect(bundle.factNotes[0].text).not.toContain('正文');
    expect(searchSpy).toHaveBeenCalledWith({
      query: '当时的租界格局是什么？',
      maxResults: 3,
    });
    expect(bundle.conclusion).toContain('1 个调研问题，其中 1 个获得来源');
  });

  it('搜索摘要为空时才回退到已抓取正文，并压平网页空白', async () => {
    const search: WebSearchPort = {
      async search() {
        return [
          {
            url: 'https://example.com/a',
            title: '网页正文来源 A',
            snippet: '  ',
            publishedAt: null,
          },
        ];
      },
    };
    const fetch: WebFetchPort = {
      async fetch(input) {
        return {
          url: input.url,
          title: '网页标题',
          extractedText: '正文第一段\n\n   正文第二段',
          fetchedAt: '2026-08-04T00:00:00.000Z',
        };
      },
    };
    const bundle = await orchestrateResearch(
      {
        search,
        fetch,
        idGenerator: { generate: () => crypto.randomUUID() },
        clock: { now: () => '2026-08-04T00:00:00.000Z' },
      },
      { projectId: 'p1', depth: 'light', idea: '不会拼进查询', questions: ['网页正文内容'] },
    );

    expect(bundle.questions[0].sources[0].excerpt).toBe('正文第一段 正文第二段');
    expect(bundle.factNotes[0].text).toBe('【网页正文来源 A】正文第一段 正文第二段');
  });

  it('none 调研：不搜索、不抓取', async () => {
    const { deps, search } = fakeDeps();
    const bundle = await orchestrateResearch(deps, {
      projectId: 'p1',
      depth: 'none',
      idea: '一个故事',
      questions: ['x'],
    });
    expect(bundle.depth).toBe('none');
    expect(bundle.questions).toHaveLength(0);
    expect(bundle.factNotes).toHaveLength(0);
    void search;
  });

  it('抓取失败 → 该来源跳过，不阻断整体', async () => {
    const { deps } = fakeDeps();
    const bundle = await orchestrateResearch(deps, {
      projectId: 'p1',
      depth: 'deep',
      idea: 'x',
      questions: ['当时的租界格局是什么？'],
    });
    // 仍有来源（example.com 成功），blocked 被跳过
    expect(bundle.questions[0].sources.every((s) => s.url.includes('example.com'))).toBe(true);
  });

  it('明显偏题来源在抓取前被过滤；相关来源仍进入事实笔记并在结论中披露过滤数', async () => {
    const search: WebSearchPort = {
      async search() {
        return [
          {
            url: 'https://news.example/bbc-boat',
            title: '男子刷新全球最长独木舟旅程纪录',
            snippet: '一名探险家在海外完成长距离水上旅行。',
            publishedAt: null,
            relevanceScore: 0.12,
          },
          {
            url: 'https://history.example/yangtze-shipping',
            title: '民国长江航运与轮船业',
            snippet: '民国时期长江轮船、码头与主要航线资料。',
            publishedAt: null,
            relevanceScore: 0.72,
          },
        ];
      },
    };
    const fetch: WebFetchPort = {
      fetch: vi.fn(async (input) => ({
        url: input.url,
        title: '页面',
        extractedText: '正文',
        fetchedAt: '2026-08-04T00:00:00.000Z',
      })),
    };

    const bundle = await orchestrateResearch(
      {
        search,
        fetch,
        idGenerator: { generate: () => crypto.randomUUID() },
        clock: { now: () => '2026-08-04T00:00:00.000Z' },
      },
      {
        projectId: 'p1',
        depth: 'deep',
        idea: '民国长江信客',
        questions: ['民国时期长江航运有哪些常见船只、码头与航线？'],
      },
    );

    expect(fetch.fetch).toHaveBeenCalledTimes(1);
    expect(fetch.fetch).toHaveBeenCalledWith({
      url: 'https://history.example/yangtze-shipping',
      timeoutMs: 10_000,
    });
    expect(bundle.questions[0].sources.map((source) => source.url)).toEqual([
      'https://history.example/yangtze-shipping',
    ]);
    expect(bundle.conclusion).toContain('已自动过滤 1 个明显偏题结果');
  });
});

describe('search result relevance', () => {
  const question = '民国时期长江航运有哪些常见船只、码头与航线？';

  it('接受标题或摘要与问题有稳定文本重合的结果', () => {
    expect(
      isSearchResultRelevant(question, {
        url: 'https://history.example/yangtze',
        title: '民国长江轮船运输史',
        snippet: '长江码头与航线变迁。',
        publishedAt: null,
      }),
    ).toBe(true);
  });

  it('拒绝低分或标题摘要均偏题的结果，提供商高分不能替代可解释的文本相关性', () => {
    const unrelated = {
      url: 'https://news.example/boat',
      title: '男子刷新全球最长独木舟旅程纪录',
      snippet: '探险家完成海外水上旅行。',
      publishedAt: null,
    };
    expect(isSearchResultRelevant(question, { ...unrelated, relevanceScore: 0.1 })).toBe(false);
    expect(isSearchResultRelevant(question, { ...unrelated, relevanceScore: 0.9 })).toBe(false);
  });
});
