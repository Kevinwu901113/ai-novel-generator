/**
 * Research Orchestrator（GE-4）。
 *
 * 按调研强度与问题计划执行搜索 + 抓取，生成事实笔记（绑定来源），汇总为 ResearchBundle。
 *
 * - 每个问题搜索 maxResults 条，按安全边界抓取前 N 条；
 * - 抓取失败/超时的来源跳过（失败恢复，不阻断整体）；
 * - 来源错误可被调用方在 bundle 上排除（来源记录保留 url，排除由下游消费时过滤）。
 *
 * 使用注入的 WebSearchPort / WebFetchPort，测试可注入确定性 fake。
 */

import type {
  FactNote,
  FetchedDocument,
  ResearchBundle,
  ResearchDepth,
  ResearchQuestion,
  ResearchSourceRecord,
  SearchResult,
  WebFetchPort,
  WebSearchPort,
} from './research-types.js';
import { isSafeSourceUrl, validateResearchTargetUrl } from './security.js';

export interface ResearchOrchestratorDeps {
  readonly search: WebSearchPort;
  readonly fetch: WebFetchPort;
  readonly idGenerator: { generate(): string };
  readonly clock: { now(): string };
  /** 每个问题最多抓取的来源数（深调研更多） */
  readonly maxFetchPerQuestion?: (depth: ResearchDepth) => number;
}

const DEFAULT_MAX_FETCH: Record<ResearchDepth, number> = { none: 0, light: 2, deep: 4 };

export interface OrchestrateInput {
  readonly projectId: string;
  readonly depth: ResearchDepth;
  readonly questions: ReadonlyArray<string>;
}

function buildQueryForQuestion(question: string, idea: string): string {
  // 拼接想法上下文，提升搜索相关性
  const trimmedIdea = idea.trim();
  return trimmedIdea.length > 0 ? `${question} ${trimmedIdea}` : question;
}

export async function orchestrateResearch(
  deps: ResearchOrchestratorDeps,
  input: OrchestrateInput & { readonly idea: string },
): Promise<ResearchBundle> {
  const maxFetch = deps.maxFetchPerQuestion?.(input.depth) ?? DEFAULT_MAX_FETCH[input.depth];
  const questions: ResearchQuestion[] = [];
  const factNotes: FactNote[] = [];
  const allSources: ResearchSourceRecord[] = [];

  for (const [qi, qText] of input.questions.entries()) {
    if (input.depth === 'none') break;
    let results: ReadonlyArray<SearchResult> = [];
    try {
      results = await deps.search.search({
        query: buildQueryForQuestion(qText, input.idea),
        maxResults: Math.max(3, maxFetch + 1),
      });
    } catch {
      results = []; // 搜索失败 → 该问题无来源，不阻断
    }

    const questionSources: ResearchSourceRecord[] = [];
    const fetched: FetchedDocument[] = [];
    for (const result of results.slice(0, maxFetch)) {
      if (!isSafeSourceUrl(result.url)) continue;
      let doc: FetchedDocument | null = null;
      try {
        const validated = validateResearchTargetUrl(result.url);
        doc = await deps.fetch.fetch({ url: validated, timeoutMs: 10_000 });
      } catch {
        doc = null; // 抓取失败 → 跳过该来源
      }
      if (doc === null) continue;
      fetched.push(doc);
      const record: ResearchSourceRecord = {
        url: doc.url,
        title: doc.title.length > 0 ? doc.title : result.title,
        fetchedAt: doc.fetchedAt,
        excerpt: doc.extractedText.slice(0, 400),
      };
      questionSources.push(record);
      allSources.push(record);
    }

    const noteText = fetched
      .map((d) => d.extractedText.slice(0, 2000))
      .filter((t) => t.length > 0)
      .join('\n');
    if (noteText.length > 0) {
      factNotes.push({
        id: deps.idGenerator.generate(),
        text: noteText,
        sourceUrls: questionSources.map((s) => s.url),
      });
    }

    questions.push({
      id: deps.idGenerator.generate(),
      text: qText,
      sources: questionSources,
    });
    void qi;
  }

  return {
    id: deps.idGenerator.generate(),
    projectId: input.projectId,
    version: 1,
    depth: input.depth,
    questions,
    factNotes,
    conclusion: buildConclusion(factNotes, input.depth),
    createdAt: deps.clock.now(),
  };
}

function buildConclusion(factNotes: ReadonlyArray<FactNote>, depth: ResearchDepth): string {
  if (depth === 'none') return '无需调研：现有输入足够支撑创作。';
  if (factNotes.length === 0) return '未获得可用来源，建议用户人工补充或排除来源。';
  return `基于 ${factNotes.length} 条事实笔记完成调研（来源已绑定，可逐条排除）。`;
}
