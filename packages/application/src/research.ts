/**
 * Web Research 应用层（GE-4）。
 *
 * - ResearchBundleRepositoryPort：ResearchBundle 持久化端口；
 * - executeResearch：编排（搜索 + 抓取 + 事实笔记）并持久化 ResearchBundle。
 *
 * 使用注入的 WebSearchPort / WebFetchPort；产品 1.0 不建知识图谱/通用 RAG/无限自动搜索。
 */

import type {
  ResearchBundle,
  ResearchDepth,
  WebFetchPort,
  WebSearchPort,
} from '@ai-novel/research-engine';
import { orchestrateResearch } from '@ai-novel/research-engine';
import type { Clock, IdGenerator } from './types.js';

export interface ResearchBundleRepositoryPort {
  save(bundle: ResearchBundle, updatedAt: string): void;
  getById(projectId: string, bundleId: string): ResearchBundle | null;
  listByProject(projectId: string): ReadonlyArray<ResearchBundle>;
}

export interface ExecuteResearchDeps {
  readonly search: WebSearchPort;
  readonly fetch: WebFetchPort;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly researchRepo: ResearchBundleRepositoryPort;
}

export interface ExecuteResearchInput {
  readonly projectId: string;
  readonly idea: string;
  readonly depth: ResearchDepth;
  readonly questions: ReadonlyArray<string>;
}

export async function executeResearch(
  deps: ExecuteResearchDeps,
  input: ExecuteResearchInput,
): Promise<ResearchBundle> {
  const bundle = await orchestrateResearch(deps, {
    projectId: input.projectId,
    depth: input.depth,
    idea: input.idea,
    questions: input.questions,
  });
  deps.researchRepo.save(bundle, deps.clock.now());
  return bundle;
}

export function getResearchBundle(
  deps: { readonly researchRepo: ResearchBundleRepositoryPort },
  input: { readonly projectId: string; readonly bundleId: string },
): ResearchBundle | null {
  return deps.researchRepo.getById(input.projectId, input.bundleId);
}
