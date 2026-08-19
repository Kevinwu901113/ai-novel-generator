/**
 * 故事图谱 RPC 处理器（D14 / B22）。
 *
 * B22 只有一个命令：`storyGraph.rebuild` —— 清空该项目全部 extracted 图记录
 * （origin='user' 覆盖层保留）后按章节顺序逐章排队重抽（D-B22-6）。
 * 没有 UI 入口，验收用命令直接驱动；进度经任务中心既有任务列表可见。
 */

import { AppError, rebuildStoryGraph } from '@ai-novel/application';
import type {
  Clock,
  IdGenerator,
  RebuildStoryGraphDeps,
  TaskRepositoryPort,
} from '@ai-novel/application';
import { isValidRebuildStoryGraphInput } from '@ai-novel/contracts';
import type { RebuildStoryGraphResultDto } from '@ai-novel/contracts';
import type { ProjectDatabase } from '@ai-novel/database';

export interface StoryGraphHandlerContext {
  getProjectDb(projectId: string): ProjectDatabase;
  /** 由 worker 注入：dedupe 冲突要映射成 TaskDedupeConflictError */
  getTaskRepo(projDb: ProjectDatabase): TaskRepositoryPort;
  idGenerator: IdGenerator;
  clock: Clock;
  /** 入队后立刻尝试开跑（串行由 pump 内部判定，D-B22-2）；缺省则等下一次触发 */
  pumpExtract?(projectId: string): void;
}

function rebuildDeps(
  ctx: StoryGraphHandlerContext,
  projDb: ProjectDatabase,
): RebuildStoryGraphDeps {
  return {
    manuscriptRepo: projDb.getManuscriptRepository(),
    chapterRepo: projDb.getChapterRepository(),
    chapterVersionRepo: projDb.getChapterVersionRepository(),
    extractionRepo: projDb.getStoryExtractionRepository(),
    taskRepo: ctx.getTaskRepo(projDb),
    graphRepo: projDb.getStoryGraphRepository(),
    idGenerator: ctx.idGenerator,
    clock: ctx.clock,
    transaction: <T>(fn: () => T) => projDb.transaction(fn),
  };
}

export function rebuildProjectStoryGraph(
  ctx: StoryGraphHandlerContext,
  projectId: string,
): RebuildStoryGraphResultDto {
  const projDb = ctx.getProjectDb(projectId);
  let result;
  try {
    result = rebuildStoryGraph(rebuildDeps(ctx, projDb), { projectId });
  } finally {
    projDb.close();
  }
  // 泵在连接关闭之后：runner 会开自己的连接，串行判定也在那一侧
  ctx.pumpExtract?.(projectId);
  return {
    clearedStates: result.cleared.states,
    clearedThreads: result.cleared.threads,
    clearedEntities: result.cleared.entities,
    clearedExtractions: result.cleared.extractions,
    enqueuedChapters: result.enqueued.length,
    skippedChapters: result.skippedChapters,
  };
}

export function dispatchStoryGraphCommand(
  command: string,
  payload: unknown,
  ctx: StoryGraphHandlerContext,
): unknown {
  switch (command) {
    case 'storyGraph.rebuild': {
      if (!isValidRebuildStoryGraphInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 storyGraph.rebuild 输入');
      }
      return rebuildProjectStoryGraph(ctx, payload.projectId);
    }
    default:
      throw new AppError('VALIDATION_ERROR', `未知故事图谱命令: ${command}`);
  }
}
