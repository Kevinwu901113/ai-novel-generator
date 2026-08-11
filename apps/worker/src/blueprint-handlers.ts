/**
 * StoryBlueprint RPC 处理器（GE-5 / B7）。
 *
 * B7（D-B7-3）：`blueprint.generate` / `blueprint.accept` 两个绕过 Graph 语义的写入口
 * 已从 RPC 分发移除——`graph-handlers.ts` 已确立的纪律"伪造节点完成的通道必须从 RPC
 * 面移除，非人工节点推进只能是 Worker 内部可信能力"同样适用于此：
 * - 生成走 BLUEPRINT_GENERATE task-backed executor（经 graph.createProjectRun /
 *   人工决策驱动，见 blueprint-executors.ts + task-engine/blueprint-generate.ts）；
 * - 接受走 `graph.applyHumanDecision`（gate outcome=accept /
 *   escalation outcome=accept_current），同事务写 storyBlueprintRepo（D-B7-1/2）。
 *
 * 保留：
 * - `blueprint.listChapters` —— 只读，供"从蓝图章节创建 ChapterGenerationRun"入口；
 * - `blueprint.getState` —— 只读蓝图态投影（D-B7-10，镜像 B6 的
 *   research.getResearchState），预埋给 B8 蓝图 UI 与 GE-6 的 createChapterRun。
 */

import { AppError, listBlueprintChapters } from '@ai-novel/application';
import type { ProjectDatabase } from '@ai-novel/database';
import type { IdeaToNovelProjectRunState } from '@ai-novel/domain';
import { BLUEPRINT_ESCALATION, BLUEPRINT_USER_GATE } from '@ai-novel/domain';
import type { BlueprintStateDto } from '@ai-novel/contracts';

export interface BlueprintHandlerContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: { generate(): string };
  clock: { now(): string };
}

function assertStringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', `非法 ${key} 输入`);
  }
  return value;
}

/** 无 project run 时的蓝图态（全 null / false / 0） */
const EMPTY_BLUEPRINT_STATE: BlueprintStateDto = {
  runId: null,
  blueprintRef: null,
  accepted: false,
  blueprintInvalidated: false,
  gateActive: false,
  escalationActive: false,
  rewriteUsed: 0,
};

/**
 * 最新 project run 的蓝图态投影（D-B7-10）。
 *
 * 与 research.getResearchState（research-handlers.ts）同一排序规则：listRuns 无排序
 * 保证，按 createdAt、workflowRunId 稳定排序取最新。只读，不经 GraphRunDeps/transition。
 */
function computeBlueprintState(projDb: ProjectDatabase, projectId: string): BlueprintStateDto {
  const records = projDb
    .getGraphRunTransaction()
    .runInTransaction((repos) => repos.graphRunRepo.listByProject(projectId));
  const projectRecords = records.filter((r) => r.kind === 'project');
  if (projectRecords.length === 0) return EMPTY_BLUEPRINT_STATE;

  const sorted = [...projectRecords].sort((a, b) => {
    if (a.state.createdAt !== b.state.createdAt) {
      return a.state.createdAt < b.state.createdAt ? -1 : 1;
    }
    return a.state.workflowRunId < b.state.workflowRunId ? -1 : 1;
  });
  const latest = sorted[sorted.length - 1].state as IdeaToNovelProjectRunState;

  const blueprintArtifact = latest.artifacts.storyBlueprint;
  const blueprintRef =
    blueprintArtifact?.kind === 'storyBlueprint' ? blueprintArtifact.artifactId : null;
  const accepted = blueprintRef
    ? (projDb.getStoryBlueprintRepository().getById(projectId, blueprintRef)?.accepted ?? false)
    : false;

  return {
    runId: latest.workflowRunId,
    blueprintRef,
    accepted,
    // 失效不清空 artifacts 槽位（applyArtifactChange 只追加 invalidatedArtifacts），
    // 因此旧 ref 仍在——必须单独告知 UI，否则作废蓝图会被当作现行内容展示
    blueprintInvalidated: latest.invalidatedArtifacts.some((ref) => ref.kind === 'storyBlueprint'),
    gateActive: latest.nodeStatuses[BLUEPRINT_USER_GATE] === 'waiting_for_human',
    escalationActive: latest.nodeStatuses[BLUEPRINT_ESCALATION] === 'waiting_for_human',
    rewriteUsed: latest.attemptBudget.blueprintRewrite ?? 0,
  };
}

export function dispatchBlueprintCommand(
  command: string,
  payload: unknown,
  ctx: BlueprintHandlerContext,
): unknown {
  if (payload === null || typeof payload !== 'object') {
    throw new AppError('VALIDATION_ERROR', '非法 blueprint 输入');
  }
  const obj = payload as Record<string, unknown>;

  switch (command) {
    case 'blueprint.getState': {
      const projectId = assertStringField(obj, 'projectId');
      const projDb = ctx.getProjectDb(projectId);
      try {
        return computeBlueprintState(projDb, projectId);
      } finally {
        projDb.close();
      }
    }
    case 'blueprint.listChapters': {
      const projectId = assertStringField(obj, 'projectId');
      const blueprintId = assertStringField(obj, 'blueprintId');
      const projDb = ctx.getProjectDb(projectId);
      try {
        return listBlueprintChapters(
          { blueprintRepo: projDb.getStoryBlueprintRepository() },
          {
            projectId,
            blueprintId,
          },
        );
      } finally {
        projDb.close();
      }
    }
    default:
      throw new AppError('VALIDATION_ERROR', `未知命令: ${command}`);
  }
}
