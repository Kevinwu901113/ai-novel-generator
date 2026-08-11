/**
 * StoryBlueprint 应用层（GE-5）。
 *
 * - StoryBlueprintRepositoryPort：版本化蓝图持久化端口；
 * - getBlueprint / listBlueprintChapters：只读用例（RPC 面保留）。
 *
 * B7（D-B7-3）：原 `generateBlueprint` / `acceptBlueprint` 两个绕过 Graph 语义的写入口
 * 已移除——
 * - 生成走 BLUEPRINT_GENERATE task-backed executor（@ai-novel/task-engine
 *   blueprint-generate.ts），版本号在 executor 最终事务内取 `getMaxVersion(projectId) + 1`
 *   （D-B7-5）；
 * - 接受并入 `applyHumanDecision` 的同一事务（graph-run.ts，D-B7-1/2），blueprintId 取自
 *   Graph 权威状态而非调用方传入，且失效蓝图 fail-closed（D-B7-8）。
 *
 * 只有已接受 CreationSpec + ResearchBundle（或明确 no-research）才能形成 PROJECT_READY
 * —— 由 Graph 强制（BLUEPRINT_GENERATE 产出 storyBlueprint artifact，BLUEPRINT_USER_GATE 显式接受）。
 */

import type { BlueprintChapter, StoryBlueprint } from '@ai-novel/domain';

export interface StoryBlueprintRepositoryPort {
  save(blueprint: StoryBlueprint, accepted: boolean): void;
  getById(
    projectId: string,
    blueprintId: string,
  ): { readonly blueprint: StoryBlueprint; readonly accepted: boolean } | null;
  listByProject(projectId: string): ReadonlyArray<StoryBlueprint>;
  markAccepted(projectId: string, blueprintId: string): boolean;
  /** 该项目现有蓝图的最大版本号；无蓝图时返回 0（D-B7-5） */
  getMaxVersion(projectId: string): number;
}

export function getBlueprint(
  deps: { readonly blueprintRepo: StoryBlueprintRepositoryPort },
  input: { readonly projectId: string; readonly blueprintId: string },
): StoryBlueprint | null {
  return deps.blueprintRepo.getById(input.projectId, input.blueprintId)?.blueprint ?? null;
}

/** 列出蓝图章节（供"从蓝图章节创建 ChapterGenerationRun"入口） */
export function listBlueprintChapters(
  deps: { readonly blueprintRepo: StoryBlueprintRepositoryPort },
  input: { readonly projectId: string; readonly blueprintId: string },
): ReadonlyArray<BlueprintChapter> {
  return deps.blueprintRepo.getById(input.projectId, input.blueprintId)?.blueprint.chapters ?? [];
}
