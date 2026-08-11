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

import { AppError, getBlueprint, listBlueprintChapters } from '@ai-novel/application';
import type { ProjectDatabase } from '@ai-novel/database';
import type { IdeaToNovelProjectRunState, StoryBlueprint } from '@ai-novel/domain';
import { BLUEPRINT_ESCALATION, BLUEPRINT_USER_GATE } from '@ai-novel/domain';
import type { BlueprintStateDto, StoryBlueprintDto } from '@ai-novel/contracts';

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

/**
 * StoryBlueprint → 公开 DTO 投影（D-B8-1，镜像 B6 的 toResearchBundleDto）。
 *
 * 逐字段显式构造（不 spread domain 对象）。exact-keys 校验器
 * （isValidStoryBlueprintDto）是**测试期守卫**——contracts 侧
 * blueprint-command.test.ts 与本文件的 blueprint-handlers.test.ts 用它锁定本函数
 * 的投影形状，生产代码零调用点。运行时四层（本函数 → IPC → preload.getBlueprint →
 * renderer）都不做该校验：preload 对 getBlueprint 是直接透传
 * （apps/desktop/src/preload/index.ts），没有拦截层。因此 domain 侧若给
 * StoryBlueprint 新增字段，一旦这里改回 spread，多余字段会原样泄漏到 renderer，
 * 不会有任何运行时防线兜底判否——逐字段显式构造这条纪律本身就是唯一防线，不得
 * 改回 spread。
 * accepted 不进本 DTO——它属状态、由 BlueprintStateDto 承载，避免第二事实源。
 */
export function toStoryBlueprintDto(blueprint: StoryBlueprint): StoryBlueprintDto {
  return {
    id: blueprint.id,
    projectId: blueprint.projectId,
    version: blueprint.version,
    premise: blueprint.premise,
    characters: blueprint.characters.map((c) => ({
      name: c.name,
      role: c.role,
      description: c.description,
    })),
    relationships: blueprint.relationships.map((r) => r),
    world: blueprint.world,
    conflict: blueprint.conflict,
    ending: blueprint.ending,
    plotlines: blueprint.plotlines.map((p) => ({ name: p.name, summary: p.summary })),
    chapters: blueprint.chapters.map((c) => ({ id: c.id, title: c.title, goal: c.goal })),
    createdAt: blueprint.createdAt,
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
    case 'blueprint.getBlueprint': {
      const projectId = assertStringField(obj, 'projectId');
      const blueprintId = assertStringField(obj, 'blueprintId');
      const projDb = ctx.getProjectDb(projectId);
      try {
        const blueprint = getBlueprint(
          { blueprintRepo: projDb.getStoryBlueprintRepository() },
          { projectId, blueprintId },
        );
        return blueprint === null ? null : toStoryBlueprintDto(blueprint);
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
