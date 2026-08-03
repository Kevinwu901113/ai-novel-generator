/**
 * StoryBlueprint 应用层（GE-5）。
 *
 * - StoryBlueprintRepositoryPort：版本化蓝图持久化端口；
 * - generateBlueprint：确定性生成并持久化 StoryBlueprint（GE-5 为模板/人工输入基座，
 *   真实 AI 生成（prompt blueprint-generate-v1）接入为后续）；
 * - acceptBlueprint：用户显式接受（BLUEPRINT_USER_GATE accept 后 PROJECT_READY）。
 *
 * 只有已接受 CreationSpec + ResearchBundle（或明确 no-research）才能形成 PROJECT_READY
 * —— 由 Graph 强制（BLUEPRINT_GENERATE 产出 storyBlueprint artifact，BLUEPRINT_USER_GATE 显式接受）。
 */

import type {
  BlueprintChapter,
  BlueprintCharacter,
  BlueprintPlotline,
  StoryBlueprint,
} from '@ai-novel/domain';
import { createStoryBlueprint } from '@ai-novel/domain';
import type { Clock, IdGenerator } from './types.js';

export interface StoryBlueprintRepositoryPort {
  save(blueprint: StoryBlueprint, accepted: boolean, updatedAt: string): void;
  getById(
    projectId: string,
    blueprintId: string,
  ): { readonly blueprint: StoryBlueprint; readonly accepted: boolean } | null;
  listByProject(projectId: string): ReadonlyArray<StoryBlueprint>;
  markAccepted(projectId: string, blueprintId: string): boolean;
}

export interface BlueprintDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly blueprintRepo: StoryBlueprintRepositoryPort;
}

export interface GenerateBlueprintInput {
  readonly projectId: string;
  readonly premise: string;
  readonly characters: ReadonlyArray<BlueprintCharacter>;
  readonly relationships: ReadonlyArray<string>;
  readonly world: string;
  readonly conflict: string;
  readonly ending: string;
  readonly plotlines: ReadonlyArray<BlueprintPlotline>;
  readonly chapters: ReadonlyArray<BlueprintChapter>;
}

/** 生成并持久化 StoryBlueprint（版本 = 当前项目蓝图数量 + 1） */
export function generateBlueprint(
  deps: BlueprintDeps,
  input: GenerateBlueprintInput,
): StoryBlueprint {
  const version = deps.blueprintRepo.listByProject(input.projectId).length + 1;
  const blueprint = createStoryBlueprint({
    id: deps.idGenerator.generate(),
    projectId: input.projectId,
    version,
    premise: input.premise,
    characters: input.characters,
    relationships: input.relationships,
    world: input.world,
    conflict: input.conflict,
    ending: input.ending,
    plotlines: input.plotlines,
    chapters: input.chapters,
    createdAt: deps.clock.now(),
  });
  deps.blueprintRepo.save(blueprint, false, deps.clock.now());
  return blueprint;
}

export function getBlueprint(
  deps: { readonly blueprintRepo: StoryBlueprintRepositoryPort },
  input: { readonly projectId: string; readonly blueprintId: string },
): StoryBlueprint | null {
  return deps.blueprintRepo.getById(input.projectId, input.blueprintId)?.blueprint ?? null;
}

/** 用户显式接受蓝图（BLUEPRINT_USER_GATE accept） */
export function acceptBlueprint(
  deps: { readonly blueprintRepo: StoryBlueprintRepositoryPort },
  input: { readonly projectId: string; readonly blueprintId: string },
): boolean {
  return deps.blueprintRepo.markAccepted(input.projectId, input.blueprintId);
}

/** 列出蓝图章节（供"从蓝图章节创建 ChapterGenerationRun"入口） */
export function listBlueprintChapters(
  deps: { readonly blueprintRepo: StoryBlueprintRepositoryPort },
  input: { readonly projectId: string; readonly blueprintId: string },
): ReadonlyArray<BlueprintChapter> {
  return deps.blueprintRepo.getById(input.projectId, input.blueprintId)?.blueprint.chapters ?? [];
}
