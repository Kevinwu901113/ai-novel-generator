/**
 * StoryBlueprint（故事蓝图）—— 产品 1.0 核心对象。
 *
 * 至少包含：核心前提、主角与关键人物、主要关系、世界背景、主要冲突、结局方向、
 * 主要情节线、章节结构与每章目标。
 *
 * 纯类型 + 工厂；无外部依赖。版本化权威对象（BLUEPRINT_GENERATE 产出，
 * BLUEPRINT_USER_GATE 显式接受后才形成 PROJECT_READY）。
 */

/** 蓝图章节（ChapterGenerationRun 的入口单位） */
export interface BlueprintChapter {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
}

export interface BlueprintCharacter {
  readonly name: string;
  readonly role: string;
  readonly description: string;
}

export interface BlueprintPlotline {
  readonly name: string;
  readonly summary: string;
}

/** StoryBlueprint 聚合 */
export interface StoryBlueprint {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly premise: string;
  readonly characters: ReadonlyArray<BlueprintCharacter>;
  readonly relationships: ReadonlyArray<string>;
  readonly world: string;
  readonly conflict: string;
  readonly ending: string;
  readonly plotlines: ReadonlyArray<BlueprintPlotline>;
  readonly chapters: ReadonlyArray<BlueprintChapter>;
  readonly createdAt: string;
}

export interface CreateStoryBlueprintInput {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly premise: string;
  readonly characters: ReadonlyArray<BlueprintCharacter>;
  readonly relationships: ReadonlyArray<string>;
  readonly world: string;
  readonly conflict: string;
  readonly ending: string;
  readonly plotlines: ReadonlyArray<BlueprintPlotline>;
  readonly chapters: ReadonlyArray<BlueprintChapter>;
  readonly createdAt: string;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`StoryBlueprint ${field} 不能为空`);
  }
}

/** 构造并校验 StoryBlueprint */
export function createStoryBlueprint(input: CreateStoryBlueprintInput): StoryBlueprint {
  assertNonEmpty(input.id, 'id');
  assertNonEmpty(input.premise, 'premise');
  assertNonEmpty(input.world, 'world');
  if (input.chapters.length === 0) {
    throw new Error('StoryBlueprint 至少需要一个章节');
  }
  for (const chapter of input.chapters) {
    assertNonEmpty(chapter.id, 'chapter.id');
    assertNonEmpty(chapter.title, 'chapter.title');
  }
  return { ...input };
}
