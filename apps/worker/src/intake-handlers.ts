/**
 * Idea Intake RPC 处理器（GE-3）。
 *
 * intake.createIntakeSession      —— 把 initial_idea 播种进 intake 会话目标
 * intake.getActiveIntakeSession   —— 读取当前 intake 会话
 * intake.propagateSpecInvalidation —— CreationSpec 更新后按 Graph 规则失效下游
 *
 * 复用 grill 适配器 + GraphRunService；用户侧不暴露 session/proposal/字段锁。
 */

import { AppError, type IdeaIntakeDeps } from '@ai-novel/application';
import {
  createIntakeSessionFromIdea,
  getActiveIntakeSession,
  propagateCreationSpecInvalidation,
} from '@ai-novel/application';
import { CHAPTER_GENERATION_GRAPH_V1, IDEA_TO_NOVEL_PROJECT_GRAPH_V1 } from '@ai-novel/domain';
import { sha256Hex } from '@ai-novel/task-engine';
import type { ProjectDatabase } from '@ai-novel/database';
import { buildGrillSessionDeps, type GrillHandlerContext } from './grill-handlers.js';

function buildIntakeDeps(projDb: ProjectDatabase, ctx: GrillHandlerContext): IdeaIntakeDeps {
  return {
    grillDeps: buildGrillSessionDeps(projDb, ctx),
    graphDeps: {
      idGenerator: ctx.idGenerator,
      clock: ctx.clock,
      hashPayload: (payload: string) => sha256Hex(payload),
      tx: projDb.getGraphRunTransaction(),
      projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
      chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
    },
  };
}

function assertStringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', `非法 ${key} 输入`);
  }
  return value;
}

export function dispatchIntakeCommand(
  command: string,
  payload: unknown,
  ctx: GrillHandlerContext,
): unknown {
  if (payload === null || typeof payload !== 'object') {
    throw new AppError('VALIDATION_ERROR', '非法 intake 输入');
  }
  const obj = payload as Record<string, unknown>;

  switch (command) {
    case 'intake.createIntakeSession': {
      const projectId = assertStringField(obj, 'projectId');
      const initialIdea = assertStringField(obj, 'initialIdea');
      const projDb = ctx.getProjectDb(projectId);
      try {
        return createIntakeSessionFromIdea(buildIntakeDeps(projDb, ctx), {
          projectId,
          initialIdea,
        });
      } finally {
        projDb.close();
      }
    }
    case 'intake.getActiveIntakeSession': {
      const projectId = assertStringField(obj, 'projectId');
      const projDb = ctx.getProjectDb(projectId);
      try {
        return getActiveIntakeSession(buildIntakeDeps(projDb, ctx), { projectId });
      } finally {
        projDb.close();
      }
    }
    case 'intake.propagateSpecInvalidation': {
      const projectId = assertStringField(obj, 'projectId');
      const creationSpecVersionId = assertStringField(obj, 'creationSpecVersionId');
      const projDb = ctx.getProjectDb(projectId);
      try {
        return propagateCreationSpecInvalidation(buildIntakeDeps(projDb, ctx), {
          projectId,
          creationSpecVersionId,
        });
      } finally {
        projDb.close();
      }
    }
    default:
      throw new AppError('VALIDATION_ERROR', `未知命令: ${command}`);
  }
}
