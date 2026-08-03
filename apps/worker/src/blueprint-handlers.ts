/**
 * StoryBlueprint RPC 处理器（GE-5）。
 *
 * blueprint.generate —— 生成并持久化 StoryBlueprint（GE-5 为确定性模板/人工输入基座；
 *   真实 AI 生成（prompt blueprint-generate-v1）接入为后续）；
 * blueprint.accept —— 用户显式接受（BLUEPRINT_USER_GATE accept → PROJECT_READY）；
 * blueprint.listChapters —— 列出蓝图章节（供"从蓝图章节创建 ChapterGenerationRun"入口）。
 */

import { AppError } from '@ai-novel/application';
import { acceptBlueprint, generateBlueprint, listBlueprintChapters } from '@ai-novel/application';
import type { BlueprintChapter, BlueprintCharacter, BlueprintPlotline } from '@ai-novel/domain';
import type { ProjectDatabase } from '@ai-novel/database';

export interface BlueprintHandlerContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: { generate(): string };
  clock: { now(): string };
}

function buildDeps(projDb: ProjectDatabase, ctx: BlueprintHandlerContext) {
  return {
    idGenerator: ctx.idGenerator,
    clock: ctx.clock,
    blueprintRepo: projDb.getStoryBlueprintRepository(),
  };
}

function assertStringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', `非法 ${key} 输入`);
  }
  return value;
}

function assertChapters(value: unknown): ReadonlyArray<BlueprintChapter> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (c): c is BlueprintChapter =>
      c !== null &&
      typeof c === 'object' &&
      typeof (c as BlueprintChapter).id === 'string' &&
      typeof (c as BlueprintChapter).title === 'string',
  );
}

function assertCharacters(value: unknown): ReadonlyArray<BlueprintCharacter> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (c): c is BlueprintCharacter =>
      c !== null && typeof c === 'object' && typeof (c as BlueprintCharacter).name === 'string',
  );
}

function assertPlotlines(value: unknown): ReadonlyArray<BlueprintPlotline> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (c): c is BlueprintPlotline =>
      c !== null && typeof c === 'object' && typeof (c as BlueprintPlotline).name === 'string',
  );
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
    case 'blueprint.generate': {
      const projectId = assertStringField(obj, 'projectId');
      const premise = assertStringField(obj, 'premise');
      const world = assertStringField(obj, 'world');
      const projDb = ctx.getProjectDb(projectId);
      try {
        return generateBlueprint(buildDeps(projDb, ctx), {
          projectId,
          premise,
          world,
          conflict: typeof obj.conflict === 'string' ? obj.conflict : '',
          ending: typeof obj.ending === 'string' ? obj.ending : '',
          relationships: Array.isArray(obj.relationships) ? (obj.relationships as string[]) : [],
          characters: assertCharacters(obj.characters),
          plotlines: assertPlotlines(obj.plotlines),
          chapters: assertChapters(obj.chapters),
        });
      } finally {
        projDb.close();
      }
    }
    case 'blueprint.accept': {
      const projectId = assertStringField(obj, 'projectId');
      const blueprintId = assertStringField(obj, 'blueprintId');
      const projDb = ctx.getProjectDb(projectId);
      try {
        return acceptBlueprint(
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
