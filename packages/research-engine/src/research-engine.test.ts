/**
 * research-engine 测试（GE-4）。
 *
 * - 安全边界：协议白名单 / credentials 拒绝 / localhost/private/link-local 拒绝；
 * - 深度判断：none/light/deep；
 * - 编排：搜索 + 抓取 + 事实笔记 + 来源绑定；失败跳过；none 不调研。
 */

import { describe, it, expect } from 'vitest';
import {
  validateResearchTargetUrl,
  isSafeSourceUrl,
  determineResearchDepth,
  orchestrateResearch,
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

  it('isSafeSourceUrl 对非法 URL 返回 false', () => {
    expect(isSafeSourceUrl('https://example.com')).toBe(true);
    expect(isSafeSourceUrl('http://127.0.0.1/')).toBe(false);
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
          { url: 'https://example.com/a', title: 'A', snippet: 'snippet-a', publishedAt: null },
          { url: 'http://127.0.0.1/blocked', title: 'blocked', snippet: '', publishedAt: null },
          { url: 'https://example.com/b', title: 'B', snippet: 'snippet-b', publishedAt: null },
        ].slice(0, input.maxResults) as SearchResult[];
      },
    };
    const fetch: WebFetchPort = {
      async fetch(input) {
        if (input.url.includes('blocked')) throw new Error('blocked');
        return {
          url: input.url,
          title: input.url.includes('/a') ? 'A' : 'B',
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
    const { deps } = fakeDeps();
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
      questions: ['q'],
    });
    // 仍有来源（example.com 成功），blocked 被跳过
    expect(bundle.questions[0].sources.every((s) => s.url.includes('example.com'))).toBe(true);
  });
});
