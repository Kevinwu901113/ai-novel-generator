/**
 * Graph Run RPC 处理器（GE-1）。
 *
 * 严格 payload 验证 → 打开 ProjectDatabase → 构造 GraphRunTransactionPort →
 * 注入 IdGenerator/Clock/hashPayload → 调用 Application GraphRunService use cases →
 * DTO mapping → 安全错误映射。
 *
 * 硬不变量：GraphRunService 是唯一写入口；任何状态变化经 Domain transition + CAS 原子持久化。
 */

import type { Clock, IdGenerator } from '@ai-novel/application';
import {
  AppError,
  advanceNode as advanceNodeService,
  applyHumanDecision as applyHumanDecisionService,
  createChapterRun as createChapterRunService,
  createProjectRun as createProjectRunService,
  failNode as failNodeService,
  getRunProgress as getRunProgressService,
  listRuns as listRunsService,
  requestHumanDecision as requestHumanDecisionService,
} from '@ai-novel/application';
import type {
  ApplyHumanDecisionInputDto,
  GraphProgressProjectionDto,
  GraphRunSummaryDto,
} from '@ai-novel/contracts';
import {
  isValidAdvanceNodeInput,
  isValidApplyHumanDecisionInput,
  isValidCreateChapterRunInput,
  isValidCreateProjectRunInput,
  isValidFailNodeInput,
  isValidGetRunProgressInput,
  isValidListRunsInput,
} from '@ai-novel/contracts';
import type { AnyIdeaToNovelGraphV1, AnyIdeaToNovelRunState } from '@ai-novel/domain';
import {
  CHAPTER_GENERATION_GRAPH_ID,
  CHAPTER_GENERATION_GRAPH_V1,
  IDEA_TO_NOVEL_PROJECT_GRAPH_ID,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  possibleNextNodes,
  workflowStageForNodeId,
} from '@ai-novel/domain';
import type { ProjectDatabase } from '@ai-novel/database';
import { sha256Hex } from '@ai-novel/task-engine';
import type { GraphRunDeps } from '@ai-novel/application';

/** Graph handler 依赖注入上下文 */
export interface GraphHandlerContext {
  getProjectDb: (projectId: string) => ProjectDatabase;
  idGenerator: IdGenerator;
  clock: Clock;
}

function graphOf(deps: GraphRunDeps, graphId: string): AnyIdeaToNovelGraphV1 {
  if (graphId === IDEA_TO_NOVEL_PROJECT_GRAPH_ID) return deps.projectGraph;
  if (graphId === CHAPTER_GENERATION_GRAPH_ID) return deps.chapterGraph;
  throw new AppError('GRAPH_RUN_VALIDATION_ERROR', `未知 graphId: ${graphId}`);
}

function buildDeps(ctx: GraphHandlerContext, projectId: string): GraphRunDeps {
  const projDb = ctx.getProjectDb(projectId);
  return {
    idGenerator: ctx.idGenerator,
    clock: ctx.clock,
    hashPayload: (payload: string) => sha256Hex(payload),
    tx: projDb.getGraphRunTransaction(),
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
  };
}

/** 构建 run 进度投影（Renderer 不自己推导下一节点；WorkflowStage 只是派生标签） */
function toProgressDto(
  deps: GraphRunDeps,
  state: AnyIdeaToNovelRunState,
): GraphProgressProjectionDto {
  const graph = graphOf(deps, state.graphId);
  const activeNodes = graph.nodes
    .filter(
      (n) =>
        state.nodeStatuses[n.id] === 'active' || state.nodeStatuses[n.id] === 'waiting_for_human',
    )
    .map((n) => ({
      nodeId: n.id,
      stage: workflowStageForNodeId(n.id) ?? 'idea',
      status: state.nodeStatuses[n.id],
    }));
  const possible = new Set<string>();
  for (const n of graph.nodes) {
    if (state.nodeStatuses[n.id] === 'active' || state.nodeStatuses[n.id] === 'waiting_for_human') {
      for (const next of possibleNextNodes(graph, n.id)) possible.add(next);
    }
  }
  return { activeNodes, possibleNextNodes: [...possible] };
}

function toSummaryDto(
  kind: 'project' | 'chapter',
  state: AnyIdeaToNovelRunState,
): GraphRunSummaryDto {
  return {
    runId: state.workflowRunId,
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    kind,
    terminalStatus: state.terminalStatus,
    createdAt: state.createdAt,
  };
}

export function dispatchGraphCommand(
  command: string,
  payload: unknown,
  ctx: GraphHandlerContext,
): unknown {
  switch (command) {
    case 'graph.createProjectRun': {
      if (!isValidCreateProjectRunInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.createProjectRun 输入');
      }
      const deps = buildDeps(ctx, payload.projectId);
      const result = createProjectRunService(deps, {
        projectId: payload.projectId,
        idempotencyKey: payload.idempotencyKey,
      });
      return toProgressDto(deps, result.run);
    }
    case 'graph.createChapterRun': {
      if (!isValidCreateChapterRunInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.createChapterRun 输入');
      }
      const deps = buildDeps(ctx, payload.projectId);
      const result = createChapterRunService(deps, {
        projectId: payload.projectId,
        creationSpecVersionId: payload.creationSpecVersionId,
        researchBundleId: payload.researchBundleId,
        storyBlueprintId: payload.storyBlueprintId,
        blueprintChapterId: payload.blueprintChapterId,
        idempotencyKey: payload.idempotencyKey,
      });
      return toProgressDto(deps, result.run);
    }
    case 'graph.getRunProgress': {
      if (!isValidGetRunProgressInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.getRunProgress 输入');
      }
      const deps = buildDeps(ctx, payload.projectId);
      const state = getRunProgressService(deps, {
        projectId: payload.projectId,
        runId: payload.runId,
      });
      return toProgressDto(deps, state);
    }
    case 'graph.advanceNode': {
      if (!isValidAdvanceNodeInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.advanceNode 输入');
      }
      const deps = buildDeps(ctx, payload.projectId);
      const result = advanceNodeService(deps, {
        projectId: payload.projectId,
        runId: payload.runId,
        nodeId: payload.nodeId,
        outcome: payload.outcome,
        artifactRef: payload.artifactRef,
        idempotencyKey: payload.idempotencyKey,
      });
      return toProgressDto(deps, result.run);
    }
    case 'graph.failNode': {
      if (!isValidFailNodeInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.failNode 输入');
      }
      const deps = buildDeps(ctx, payload.projectId);
      const result = failNodeService(deps, {
        projectId: payload.projectId,
        runId: payload.runId,
        nodeId: payload.nodeId,
        idempotencyKey: payload.idempotencyKey,
      });
      return toProgressDto(deps, result.run);
    }
    case 'graph.requestHumanDecision': {
      if (!isValidFailNodeInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.requestHumanDecision 输入');
      }
      const deps = buildDeps(ctx, payload.projectId);
      const result = requestHumanDecisionService(deps, {
        projectId: payload.projectId,
        runId: payload.runId,
        nodeId: payload.nodeId,
        idempotencyKey: payload.idempotencyKey,
      });
      return toProgressDto(deps, result.run);
    }
    case 'graph.applyHumanDecision': {
      if (!isValidApplyHumanDecisionInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.applyHumanDecision 输入');
      }
      const deps = buildDeps(ctx, payload.projectId);
      const dto = payload as ApplyHumanDecisionInputDto;
      const { projectId: _projectId, ...rest } = dto;
      const result = applyHumanDecisionService(
        deps,
        rest as Parameters<typeof applyHumanDecisionService>[1],
      );
      return toProgressDto(deps, result.run);
    }
    case 'graph.listRuns': {
      if (!isValidListRunsInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.listRuns 输入');
      }
      const deps = buildDeps(ctx, payload.projectId);
      const runs = listRunsService(deps, { projectId: payload.projectId });
      return runs.map((r) => toSummaryDto(r.kind, r.state));
    }
    default:
      throw new AppError('VALIDATION_ERROR', `未知命令: ${command}`);
  }
}
