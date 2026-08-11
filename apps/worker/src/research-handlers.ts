/**
 * Web Research RPC 处理器（GE-4/B6）。
 *
 * - research.execute —— 按深度/问题计划执行搜索 + 抓取，生成并持久化 ResearchBundle；
 * - research.getResearchState —— 读最新 project run 的调研态投影（D-B6-3）；
 * - research.getBundle / research.listBundles —— 读 ResearchBundle（repo 现成）；
 * - research.setSourceExclusion / research.listSourceExclusions —— project 级来源
 *   排除（D-B6-2，migration v15）；新增排除（excluded=true）时 url 必须通过
 *   isSafeSourceUrl 校验，取消排除（excluded=false）不受此约束（复查随行修复：
 *   否则日后收紧安全规则会导致历史已排除 URL 永久无法取消排除）。
 *
 * research.execute 默认使用确定性 fake provider（不联网）；真实外部搜索 provider
 * 接入为后续步骤。V1 安全边界（validateResearchTargetUrl）在 orchestrator 内强制执行。
 *
 * 新增五个只读/排除通道不复用 research.execute 的 fake provider ctx 装配——
 * 它们不发起搜索/抓取，只读 run state 与 repo。
 */

import { AppError, executeResearch, getResearchBundle } from '@ai-novel/application';
import type {
  FetchedDocument,
  ResearchBundle,
  ResearchDepth,
  SearchResult,
  WebFetchPort,
  WebSearchPort,
} from '@ai-novel/research-engine';
import { isSafeSourceUrl } from '@ai-novel/research-engine';
import type { ProjectDatabase } from '@ai-novel/database';
import type { IdeaToNovelProjectRunState } from '@ai-novel/domain';
import { RESEARCH_DECISION, RESEARCH_ESCALATION, RESEARCH_VALIDATE } from '@ai-novel/domain';
import type { ResearchBundleDto, ResearchStateDto } from '@ai-novel/contracts';

export interface ResearchHandlerContext {
  getProjectDb(projectId: string): ProjectDatabase;
  /**
   * 搜索 / 抓取 provider（research.execute 专用；GE-4 默认 fake，真实 provider 接入点）。
   * 只读/排除通道（getResearchState / getBundle / listBundles / setSourceExclusion /
   * listSourceExclusions）不发起搜索或抓取，可省略——调用方不必为它们装配 provider。
   */
  search?: WebSearchPort;
  fetch?: WebFetchPort;
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
  if (!ctx.search || !ctx.fetch) {
    throw new AppError('VALIDATION_ERROR', 'research.execute 缺少搜索/抓取 provider');
  }
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

/** ResearchBundle（research-engine 权威类型）→ ResearchBundleDto（跨进程投影） */
function toResearchBundleDto(bundle: ResearchBundle): ResearchBundleDto {
  return {
    id: bundle.id,
    projectId: bundle.projectId,
    version: bundle.version,
    depth: bundle.depth,
    questions: bundle.questions,
    factNotes: bundle.factNotes,
    conclusion: bundle.conclusion,
    createdAt: bundle.createdAt,
    basedOnBundleId: bundle.basedOnBundleId ?? null,
  };
}

/** 无 project run 时的调研态（全 null / false / 0） */
const EMPTY_RESEARCH_STATE: ResearchStateDto = {
  runId: null,
  researchDecision: null,
  researchValid: null,
  bundleRef: null,
  bundleInvalidated: false,
  escalationActive: false,
  researchRetryUsed: 0,
};

/**
 * 最新 project run 的调研态投影（D-B6-3）。
 *
 * 与 renderer 侧 `latestProjectRun`（intake-logic.ts）同一排序规则：
 * listRuns 无排序保证，按 createdAt、workflowRunId 稳定排序取最新。
 * 只读，不经 GraphRunDeps/transition——直接读 GraphRunTransactionPort 的
 * graphRunRepo.listByProject。
 */
function computeResearchState(projDb: ProjectDatabase, projectId: string): ResearchStateDto {
  const records = projDb
    .getGraphRunTransaction()
    .runInTransaction((repos) => repos.graphRunRepo.listByProject(projectId));
  const projectRecords = records.filter((r) => r.kind === 'project');
  if (projectRecords.length === 0) return EMPTY_RESEARCH_STATE;

  const sorted = [...projectRecords].sort((a, b) => {
    if (a.state.createdAt !== b.state.createdAt) {
      return a.state.createdAt < b.state.createdAt ? -1 : 1;
    }
    return a.state.workflowRunId < b.state.workflowRunId ? -1 : 1;
  });
  const latest = sorted[sorted.length - 1].state as IdeaToNovelProjectRunState;

  const decisionOutcome = latest.nodeOutcomes[RESEARCH_DECISION];
  const validOutcome = latest.nodeOutcomes[RESEARCH_VALIDATE];
  const bundleArtifact = latest.artifacts.researchBundle;

  return {
    runId: latest.workflowRunId,
    researchDecision:
      decisionOutcome?.condition === 'research_decision' ? decisionOutcome.value : null,
    researchValid: validOutcome?.condition === 'research_valid' ? validOutcome.value : null,
    bundleRef: bundleArtifact?.kind === 'researchBundle' ? bundleArtifact.artifactId : null,
    // 失效不清空 artifacts 槽位（applyArtifactChange 只追加 invalidatedArtifacts），
    // 因此旧 ref 仍在——必须单独告知 UI，否则作废资料包会被当作现行展示
    bundleInvalidated: latest.invalidatedArtifacts.some((ref) => ref.kind === 'researchBundle'),
    escalationActive: latest.nodeStatuses[RESEARCH_ESCALATION] === 'waiting_for_human',
    researchRetryUsed: latest.attemptBudget.researchRetry ?? 0,
  };
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
    case 'research.getResearchState': {
      const projectId = assertStringField(obj, 'projectId');
      const projDb = ctx.getProjectDb(projectId);
      try {
        return computeResearchState(projDb, projectId);
      } finally {
        projDb.close();
      }
    }
    case 'research.getBundle': {
      const projectId = assertStringField(obj, 'projectId');
      const bundleId = assertStringField(obj, 'bundleId');
      const projDb = ctx.getProjectDb(projectId);
      try {
        const bundle = getResearchBundle(
          { researchRepo: projDb.getResearchBundleRepository() },
          { projectId, bundleId },
        );
        return bundle ? toResearchBundleDto(bundle) : null;
      } finally {
        projDb.close();
      }
    }
    case 'research.listBundles': {
      const projectId = assertStringField(obj, 'projectId');
      const projDb = ctx.getProjectDb(projectId);
      try {
        return projDb
          .getResearchBundleRepository()
          .listByProject(projectId)
          .map(toResearchBundleDto);
      } finally {
        projDb.close();
      }
    }
    case 'research.setSourceExclusion': {
      const projectId = assertStringField(obj, 'projectId');
      const url = assertStringField(obj, 'url');
      if (typeof obj.excluded !== 'boolean') {
        throw new AppError('VALIDATION_ERROR', '非法 excluded 输入');
      }
      const excluded = obj.excluded;
      // 复查随行修复：只在新增排除（excluded=true）时校验 URL 安全性。
      // 取消排除（excluded=false）不应受 isSafeSourceUrl 约束——否则日后收紧
      // 校验规则会导致历史上（在旧规则下）已合法排除的 URL 再也无法取消排除，
      // 用户会被永久卡在一条早已存在于本地 DB 的记录上。
      if (excluded && !isSafeSourceUrl(url)) {
        throw new AppError('VALIDATION_ERROR', `非法或不安全的来源 URL: ${url}`);
      }
      const projDb = ctx.getProjectDb(projectId);
      try {
        const repo = projDb.getResearchSourceExclusionRepository();
        repo.setExclusion(projectId, url, excluded);
        return repo.listByProject(projectId);
      } finally {
        projDb.close();
      }
    }
    case 'research.listSourceExclusions': {
      const projectId = assertStringField(obj, 'projectId');
      const projDb = ctx.getProjectDb(projectId);
      try {
        return projDb.getResearchSourceExclusionRepository().listByProject(projectId);
      } finally {
        projDb.close();
      }
    }
    default:
      throw new AppError('VALIDATION_ERROR', `未知命令: ${command}`);
  }
}
