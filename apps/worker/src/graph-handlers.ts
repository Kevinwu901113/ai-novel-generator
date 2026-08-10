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
  applyHumanDecision as applyHumanDecisionService,
  createChapterRun as createChapterRunService,
  createProjectRun as createProjectRunService,
  getRunProgress as getRunProgressService,
  listRuns as listRunsService,
} from '@ai-novel/application';
import type {
  ApplyHumanDecisionInputDto,
  GraphProgressProjectionDto,
  GraphRunSummaryDto,
} from '@ai-novel/contracts';
import {
  isValidApplyHumanDecisionInput,
  isValidCreateChapterRunInput,
  isValidCreateProjectRunInput,
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
  /**
   * D-B3-1 live drive：run 创建 / 人工决策落地后异步驱动一次 NodeRunner
   * （fire-and-forget；实现自行吞错，权威兜底仍是启动恢复）。
   */
  driveAfter?: (projectId: string, runId: string) => void;
}

function graphOf(deps: GraphRunDeps, graphId: string): AnyIdeaToNovelGraphV1 {
  if (graphId === IDEA_TO_NOVEL_PROJECT_GRAPH_ID) return deps.projectGraph;
  if (graphId === CHAPTER_GENERATION_GRAPH_ID) return deps.chapterGraph;
  throw new AppError('GRAPH_RUN_VALIDATION_ERROR', `未知 graphId: ${graphId}`);
}

function buildDeps(ctx: GraphHandlerContext, projDb: ProjectDatabase): GraphRunDeps {
  return {
    idGenerator: ctx.idGenerator,
    clock: ctx.clock,
    hashPayload: (payload: string) => sha256Hex(payload),
    tx: projDb.getGraphRunTransaction(),
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
  };
}

/**
 * TD-023：与 grill handlers 相同的连接纪律——每条命令打开 ProjectDatabase，
 * 结束（含抛错）在 finally 关闭；连接不逃逸出本次分发（driveAfter 自开自关）。
 */
function withGraphDeps<T>(
  ctx: GraphHandlerContext,
  projectId: string,
  fn: (deps: GraphRunDeps) => T,
): T {
  const projDb = ctx.getProjectDb(projectId);
  try {
    return fn(buildDeps(ctx, projDb));
  } finally {
    projDb.close();
  }
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
      const { runId, progress } = withGraphDeps(ctx, payload.projectId, (deps) => {
        const result = createProjectRunService(deps, {
          projectId: payload.projectId,
          idempotencyKey: payload.idempotencyKey,
        });
        return { runId: result.run.workflowRunId, progress: toProgressDto(deps, result.run) };
      });
      // D-B3-1：创建后立即驱动（IDEA_CAPTURE 起步）；进度经 getRunProgress 轮询可见
      ctx.driveAfter?.(payload.projectId, runId);
      return progress;
    }
    case 'graph.createChapterRun': {
      if (!isValidCreateChapterRunInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.createChapterRun 输入');
      }
      return withGraphDeps(ctx, payload.projectId, (deps) => {
        const result = createChapterRunService(deps, {
          projectId: payload.projectId,
          creationSpecVersionId: payload.creationSpecVersionId,
          researchBundleId: payload.researchBundleId,
          storyBlueprintId: payload.storyBlueprintId,
          blueprintChapterId: payload.blueprintChapterId,
          idempotencyKey: payload.idempotencyKey,
        });
        return toProgressDto(deps, result.run);
      });
    }
    case 'graph.getRunProgress': {
      if (!isValidGetRunProgressInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.getRunProgress 输入');
      }
      return withGraphDeps(ctx, payload.projectId, (deps) => {
        const state = getRunProgressService(deps, {
          projectId: payload.projectId,
          runId: payload.runId,
        });
        return toProgressDto(deps, state);
      });
    }
    // RW-1 公共安全边界：advanceNode / failNode / requestHumanDecision 已从 RPC 面移除。
    // 非人工节点推进只能是 Worker 内部 NodeRunner + NodeSettlementService 的可信能力。
    case 'graph.applyHumanDecision': {
      if (!isValidApplyHumanDecisionInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.applyHumanDecision 输入');
      }
      const { runId, progress } = withGraphDeps(ctx, payload.projectId, (deps) => {
        const dto = payload as ApplyHumanDecisionInputDto;
        const { projectId: _projectId, ...rest } = dto;
        const result = applyHumanDecisionService(
          deps,
          rest as Parameters<typeof applyHumanDecisionService>[1],
        );
        return { runId: result.run.workflowRunId, progress: toProgressDto(deps, result.run) };
      });
      // D-B3-1：人工决策落地后立即驱动后续节点（answer→SPEC_EXTRACT 回环等）
      ctx.driveAfter?.(payload.projectId, runId);
      return progress;
    }
    case 'graph.listRuns': {
      if (!isValidListRunsInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 graph.listRuns 输入');
      }
      return withGraphDeps(ctx, payload.projectId, (deps) => {
        const runs = listRunsService(deps, { projectId: payload.projectId });
        return runs.map((r) => toSummaryDto(r.kind, r.state));
      });
    }
    default:
      throw new AppError('VALIDATION_ERROR', `未知命令: ${command}`);
  }
}
