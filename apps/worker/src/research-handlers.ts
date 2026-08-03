/**
 * Web Research RPC 处理器（GE-4）。
 *
 * research.execute —— 按深度/问题计划执行搜索 + 抓取，生成并持久化 ResearchBundle。
 *
 * 默认使用确定性 fake provider（不联网）；真实外部搜索 provider 接入为后续步骤。
 * V1 安全边界（validateResearchTargetUrl）在 orchestrator 内强制执行。
 */

import { AppError, executeResearch } from '@ai-novel/application';
import type {
  FetchedDocument,
  ResearchDepth,
  SearchResult,
  WebFetchPort,
  WebSearchPort,
} from '@ai-novel/research-engine';
import type { ProjectDatabase } from '@ai-novel/database';

export interface ResearchHandlerContext {
  getProjectDb(projectId: string): ProjectDatabase;
  /** 搜索 provider（GE-4 默认 fake；真实 provider 接入点） */
  search: WebSearchPort;
  fetch: WebFetchPort;
}

/** 确定性 fake provider：不联网，返回稳定来源（用于骨架与离线测试） */
export function createFakeResearchProvider() {
  const search: WebSearchPort = {
    async search(input: { query: string; maxResults: number }) {
      return [
        {
          url: 'https://example.com/fact-1',
          title: '事实 1',
          snippet: `${input.query} 相关事实`,
          publishedAt: null,
        },
      ].slice(0, input.maxResults) as SearchResult[];
    },
  };
  const fetch: WebFetchPort = {
    async fetch(input: { url: string; timeoutMs: number }) {
      return {
        url: input.url,
        title: '事实 1',
        extractedText: `${input.url} 的正文（离线 fake）`,
        fetchedAt: '2026-08-04T00:00:00.000Z',
      } as FetchedDocument;
    },
  };
  return { search, fetch };
}

let counter = 0;

function buildDeps(projDb: ProjectDatabase, ctx: ResearchHandlerContext) {
  return {
    search: ctx.search,
    fetch: ctx.fetch,
    idGenerator: {
      generate: () => {
        counter += 1;
        return `rb-${counter}`;
      },
    },
    clock: { now: () => new Date().toISOString() },
    researchRepo: projDb.getResearchBundleRepository(),
  };
}

function assertStringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', `非法 ${key} 输入`);
  }
  return value;
}

function assertDepth(value: unknown): ResearchDepth {
  if (value === 'none' || value === 'light' || value === 'deep') return value;
  throw new AppError('VALIDATION_ERROR', `非法调研强度: ${String(value)}`);
}

export async function dispatchResearchCommand(
  command: string,
  payload: unknown,
  ctx: ResearchHandlerContext,
): Promise<unknown> {
  if (payload === null || typeof payload !== 'object') {
    throw new AppError('VALIDATION_ERROR', '非法 research 输入');
  }
  const obj = payload as Record<string, unknown>;

  switch (command) {
    case 'research.execute': {
      const projectId = assertStringField(obj, 'projectId');
      const idea = assertStringField(obj, 'idea');
      const depth = assertDepth(obj.depth);
      const rawQuestions = obj.questions;
      const questions =
        Array.isArray(rawQuestions) && rawQuestions.every((q) => typeof q === 'string')
          ? (rawQuestions as string[])
          : [];
      const projDb = ctx.getProjectDb(projectId);
      try {
        return await executeResearch(buildDeps(projDb, ctx), {
          projectId,
          idea,
          depth,
          questions,
        });
      } finally {
        projDb.close();
      }
    }
    default:
      throw new AppError('VALIDATION_ERROR', `未知命令: ${command}`);
  }
}
