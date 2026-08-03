/**
 * Web Research 类型与端口（GE-4）。
 *
 * - WebSearchPort / WebFetchPort：外部搜索/抓取的最小端口（可注入 fake 或真实 provider）；
 * - ResearchBundle：必要调研的问题计划、来源、事实笔记与结论（版本化）。
 *
 * 产品 1.0 不建设知识图谱、通用 RAG 平台或无限自动搜索。
 */

/** 调研强度三档 */
export type ResearchDepth = 'none' | 'light' | 'deep';

/** 搜索来源记录 */
export interface SearchResult {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly publishedAt: string | null;
}

/** 抓取到的文档 */
export interface FetchedDocument {
  readonly url: string;
  readonly title: string;
  readonly extractedText: string;
  readonly fetchedAt: string;
}

/** 搜索端口：按 query 返回来源列表 */
export interface WebSearchPort {
  search(input: {
    readonly query: string;
    readonly maxResults: number;
  }): Promise<ReadonlyArray<SearchResult>>;
}

/** 抓取端口：拉取 URL 提取正文 */
export interface WebFetchPort {
  fetch(input: { readonly url: string; readonly timeoutMs: number }): Promise<FetchedDocument>;
}

/** 调研问题（含来源绑定） */
export interface ResearchQuestion {
  readonly id: string;
  readonly text: string;
  readonly sources: ReadonlyArray<ResearchSourceRecord>;
}

/** 来源记录（绑定问题/事实） */
export interface ResearchSourceRecord {
  readonly url: string;
  readonly title: string;
  readonly fetchedAt: string;
  readonly excerpt: string;
}

/** 事实笔记（绑定来源） */
export interface FactNote {
  readonly id: string;
  readonly text: string;
  readonly sourceUrls: ReadonlyArray<string>;
}

/** 权威 ResearchBundle（版本化） */
export interface ResearchBundle {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly depth: ResearchDepth;
  readonly questions: ReadonlyArray<ResearchQuestion>;
  readonly factNotes: ReadonlyArray<FactNote>;
  readonly conclusion: string;
  readonly createdAt: string;
}

/** 调研输入（供深度判断与编排） */
export interface ResearchInput {
  readonly projectId: string;
  readonly idea: string;
  readonly creationSpecSummary: string;
  /** 用户是否要求真实性（决定调研强度） */
  readonly requiresFactuality: boolean;
  /** 调研问题计划（可为空，编排时按需补全） */
  readonly questions: ReadonlyArray<string>;
}
