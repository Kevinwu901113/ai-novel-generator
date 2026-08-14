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

function compactExcerpt(text: string, maxLength = 500): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

const QUERY_FILLER_PATTERN =
  /什么|哪些|如何|是否|相关|常见|主要|具体|情况|信息|资料|细节|请问|介绍|说明/gu;
const LATIN_STOP_WORDS = new Set(['about', 'what', 'when', 'where', 'which', 'with', 'from']);
const PROVIDER_MIN_RELEVANCE_SCORE = 0.15;

function normalizedSearchText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function ngrams(text: string, size: number): Set<string> {
  const compact = text.replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
  const result = new Set<string>();
  for (let index = 0; index + size <= compact.length; index += 1) {
    result.add(compact.slice(index, index + size));
  }
  return result;
}

/**
 * 搜索服务偶尔会为宽泛问题返回新闻或导航页。要求标题/摘要与问题存在可解释的文本
 * 重合，并把提供商明确给出的低分作为额外拒绝信号；高分本身不能放行文本上完全无关
 * 的结果。宁可让问题进入“来源不足”升级，也不把明显偏题的事实注入蓝图。
 */
export function isSearchResultRelevant(question: string, result: SearchResult): boolean {
  const normalizedQuestion = normalizedSearchText(question).replace(QUERY_FILLER_PATTERN, '');
  const candidate = normalizedSearchText(`${result.title} ${result.snippet}`);
  if (
    typeof result.relevanceScore === 'number' &&
    Number.isFinite(result.relevanceScore) &&
    result.relevanceScore < PROVIDER_MIN_RELEVANCE_SCORE
  ) {
    return false;
  }

  const questionLatin = normalizedQuestion
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 3 && !LATIN_STOP_WORDS.has(token));
  const candidateLatin = new Set(candidate.split(/[^a-z0-9]+/u));
  if (questionLatin.some((token) => candidateLatin.has(token))) return true;

  const candidateBigrams = ngrams(candidate, 2);
  const matchedBigrams = [...ngrams(normalizedQuestion, 2)].filter((gram) =>
    candidateBigrams.has(gram),
  ).length;
  const candidateTrigrams = ngrams(candidate, 3);
  const hasMatchedTrigram = [...ngrams(normalizedQuestion, 3)].some((gram) =>
    candidateTrigrams.has(gram),
  );
  return hasMatchedTrigram || matchedBigrams >= 2;
}

export async function orchestrateResearch(
  deps: ResearchOrchestratorDeps,
  input: OrchestrateInput & { readonly idea: string },
): Promise<ResearchBundle> {
  const maxFetch = deps.maxFetchPerQuestion?.(input.depth) ?? DEFAULT_MAX_FETCH[input.depth];
  const questions: ResearchQuestion[] = [];
  const factNotes: FactNote[] = [];
  const allSources: ResearchSourceRecord[] = [];
  let rejectedSourceCount = 0;

  for (const [qi, qText] of input.questions.entries()) {
    if (input.depth === 'none') break;
    let results: ReadonlyArray<SearchResult> = [];
    try {
      results = await deps.search.search({
        // 问题计划已经包含年代、地域与职业等检索上下文。再拼接整段小说想法会把
        // “不能拆的信”“收信人已死”等剧情词带进查询，真实 Tavily 结果反而偏离
        // 问题主题（例如“信客职业”被检索成“县长群体”）。
        query: qText,
        maxResults: Math.max(3, maxFetch + 1),
      });
    } catch {
      results = []; // 搜索失败 → 该问题无来源，不阻断
    }

    const questionSources: ResearchSourceRecord[] = [];
    const noteFragments: string[] = [];
    for (const result of results) {
      if (questionSources.length >= maxFetch) break;
      if (!isSafeSourceUrl(result.url)) continue;
      if (!isSearchResultRelevant(qText, result)) {
        rejectedSourceCount += 1;
        continue;
      }
      let doc: FetchedDocument | null = null;
      try {
        const validated = validateResearchTargetUrl(result.url);
        doc = await deps.fetch.fetch({ url: validated, timeoutMs: 10_000 });
      } catch {
        doc = null; // 抓取失败 → 跳过该来源
      }
      if (doc === null) continue;
      const title = result.title.trim() || doc.title.trim() || doc.url;
      // Tavily 的 content 是针对查询生成的相关摘要；网页抓取正文开头经常只是导航、
      // Cookie 文案或乱码。优先使用搜索摘要，只有摘要为空时才回退到抓取正文。
      const excerpt = compactExcerpt(result.snippet) || compactExcerpt(doc.extractedText);
      const record: ResearchSourceRecord = {
        url: doc.url,
        title,
        fetchedAt: doc.fetchedAt,
        excerpt,
      };
      questionSources.push(record);
      allSources.push(record);
      if (excerpt.length > 0) noteFragments.push(`【${title}】${excerpt}`);
    }

    const noteText = noteFragments.join('\n');
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
    conclusion: buildConclusion(
      questions,
      factNotes,
      allSources.length,
      rejectedSourceCount,
      input.depth,
    ),
    createdAt: deps.clock.now(),
  };
}

function buildConclusion(
  questions: ReadonlyArray<ResearchQuestion>,
  factNotes: ReadonlyArray<FactNote>,
  sourceCount: number,
  rejectedSourceCount: number,
  depth: ResearchDepth,
): string {
  if (depth === 'none') return '无需调研：现有输入足够支撑创作。';
  if (factNotes.length === 0) return '未获得可用来源，建议用户人工补充或排除来源。';
  const coveredQuestions = questions.filter((question) => question.sources.length > 0).length;
  const rejectionSummary =
    rejectedSourceCount > 0 ? `；已自动过滤 ${rejectedSourceCount} 个明显偏题结果` : '';
  return `已完成 ${questions.length} 个调研问题，其中 ${coveredQuestions} 个获得来源；采集 ${sourceCount} 个可追溯来源，整理为 ${factNotes.length} 组事实笔记${rejectionSummary}。请先排除不可信或不相关来源，再采用蓝图。`;
}
