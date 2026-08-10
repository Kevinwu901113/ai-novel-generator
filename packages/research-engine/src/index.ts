/**
 * @ai-novel/research-engine
 *
 * Web Research 端口、安全边界与 ResearchBundle 编排（GE-4）。
 * 产品 1.0 不建设知识图谱、通用 RAG 平台或无限自动搜索。
 */

export type {
  ResearchDepth,
  SearchResult,
  FetchedDocument,
  WebSearchPort,
  WebFetchPort,
  ResearchQuestion,
  ResearchSourceRecord,
  FactNote,
  ResearchBundle,
  ResearchInput,
} from './research-types.js';

export {
  validateResearchTargetUrl,
  isSafeSourceUrl,
  isPrivateResolvedAddress,
} from './security.js';

export { dependsOnRealWorldFacts, determineResearchDepth } from './depth.js';

export { orchestrateResearch } from './orchestrator.js';
export type { ResearchOrchestratorDeps, OrchestrateInput } from './orchestrator.js';

export { createSafeWebFetch } from './safe-web-fetch.js';
export type { SafeWebFetchOptions } from './safe-web-fetch.js';

export { createTavilySearchProvider } from './tavily-search.js';
export type { TavilySearchOptions } from './tavily-search.js';

/** 包已加载（替代原 stub 标记） */
export const RESEARCH_ENGINE_PACKAGE_LOADED = true;
