/**
 * 故事图谱抽取后台 runner（D14 / B22，D-B22-2）。
 *
 * 与 grill-plan-runner 一样是 runner kernel 的薄封装，多一层**串行调度**：
 * 同一项目至多一个 STORY_GRAPH_EXTRACT 在跑，且永远挑章节序最小的 PENDING 开跑。
 * 前情登记表是逐章递进的指代消解锚——乱序抽取会让后面的章看不到前面的实体，
 * 图的质量直接退化，所以串行不是性能取舍而是正确性要求。
 *
 * 接力方式：kernel 在结算并关闭 DB 之后回调 onSettled，这里再泵一次。
 */

import type { ProjectDatabase } from '@ai-novel/database';
import type {
  TaskData,
  TaskRepositoryPort,
  StoryGraphChapterQueryDeps,
} from '@ai-novel/application';
import { listStoryGraphChapterSlots, parseStoryGraphExtractPayload } from '@ai-novel/application';
import { executeStoryGraphExtract, type StoryGraphExtractEngineDeps } from '@ai-novel/task-engine';
import {
  settleRunnerFailure,
  scheduleRunnerRun,
  type RunnerKernelDeps,
  type RunnerScheduleResult,
  type SettleMessages,
  type SettlementOutcome,
} from './runner-kernel.js';

// ── 依赖 ──────────────────────────────────────────────────────────

export type StoryGraphRunnerDeps = RunnerKernelDeps<StoryGraphExtractEngineDeps>;

export interface StoryGraphPumpDeps extends StoryGraphRunnerDeps {
  /** 章节顺序查询（决定"章节序最小"的那一条） */
  getChapterQueryDeps(projDb: ProjectDatabase): StoryGraphChapterQueryDeps;
}

const STORY_GRAPH_MESSAGES: SettleMessages = {
  settleErrorCode: 'TASK_EXECUTION_FAILED',
  settleErrorMessage: '故事图谱抽取任务执行失败',
  settleInvocationError: '模型调用因任务异常而未完成',
};

// ── Settlement ────────────────────────────────────────────────────

export function settleStoryGraphRunnerFailure(
  deps: StoryGraphRunnerDeps,
  projDb: ProjectDatabase,
  taskId: string,
): SettlementOutcome {
  return settleRunnerFailure(deps, projDb, taskId, STORY_GRAPH_MESSAGES);
}

// ── 串行调度 ──────────────────────────────────────────────────────

export type StoryGraphPumpResult =
  | { readonly started: true; readonly taskId: string }
  | {
      readonly started: false;
      readonly reason: 'BUSY' | 'EMPTY' | 'OPEN_FAILED' | 'READ_FAILED' | 'SCHEDULE_FAILED';
    };

export interface StoryGraphPumpOptions {
  /**
   * 本轮不再挑这个任务。
   *
   * 接力时排除刚跑完的那条：settlement 万一没能把它推出 PENDING
   * （UNRESOLVED），不排除就会原地反复重跑同一个任务。
   */
  readonly excludeTaskId?: string;
}

function pendingExtractTasks(
  taskRepo: TaskRepositoryPort,
  projectId: string,
): ReadonlyArray<TaskData> {
  return taskRepo
    .listByStatus('PENDING')
    .filter((t) => t.projectId === projectId && t.taskType === 'STORY_GRAPH_EXTRACT');
}

function hasRunningExtract(taskRepo: TaskRepositoryPort, projectId: string): boolean {
  return taskRepo
    .listByStatus('RUNNING')
    .some((t) => t.projectId === projectId && t.taskType === 'STORY_GRAPH_EXTRACT');
}

/** 选出该跑的下一条：章节序升序，章节定位不到的排最后，同序按创建时间 */
function pickNextTask(
  projDb: ProjectDatabase,
  deps: StoryGraphPumpDeps,
  projectId: string,
  candidates: ReadonlyArray<TaskData>,
): TaskData | null {
  const slots = listStoryGraphChapterSlots(deps.getChapterQueryDeps(projDb), projectId);
  const numberByChapter = new Map(slots.map((s) => [s.chapterId, s.chapterNumber]));
  const ranked = candidates
    .map((task) => {
      const payload = parseStoryGraphExtractPayload(task.payloadJson);
      const chapterNumber =
        payload === null
          ? Number.MAX_SAFE_INTEGER
          : (numberByChapter.get(payload.chapterId) ?? Number.MAX_SAFE_INTEGER);
      return { task, chapterNumber };
    })
    .sort((a, b) => {
      if (a.chapterNumber !== b.chapterNumber) return a.chapterNumber - b.chapterNumber;
      if (a.task.createdAt !== b.task.createdAt) {
        return a.task.createdAt < b.task.createdAt ? -1 : 1;
      }
      return a.task.id < b.task.id ? -1 : 1;
    });
  return ranked.length > 0 ? ranked[0].task : null;
}

/**
 * 串行泵：项目里没有 RUNNING 的抽取任务时，挑章节序最小的 PENDING 开跑。
 *
 * 触发点（提交/保存/回填/启动恢复）一律只调用本函数，不直接调度具体任务——
 * "至多一个在跑"的判定必须只有一处。
 */
export function pumpStoryGraphExtract(
  deps: StoryGraphPumpDeps,
  projectId: string,
  options: StoryGraphPumpOptions = {},
): StoryGraphPumpResult {
  let projDb: ProjectDatabase;
  try {
    projDb = deps.openDb(projectId);
  } catch {
    return { started: false, reason: 'OPEN_FAILED' };
  }

  let next: TaskData | null = null;
  try {
    const taskRepo = deps.getTaskRepo(projDb);
    if (hasRunningExtract(taskRepo, projectId)) return { started: false, reason: 'BUSY' };
    const candidates = pendingExtractTasks(taskRepo, projectId).filter(
      (t) => t.id !== options.excludeTaskId,
    );
    if (candidates.length === 0) return { started: false, reason: 'EMPTY' };
    next = pickNextTask(projDb, deps, projectId, candidates);
  } catch {
    return { started: false, reason: 'READ_FAILED' };
  } finally {
    try {
      projDb.close();
    } catch {
      // 关闭失败不影响调度判定
    }
  }
  if (!next) return { started: false, reason: 'EMPTY' };

  const taskId = next.id;
  const scheduled: RunnerScheduleResult = scheduleRunnerRun(
    deps,
    projectId,
    taskId,
    executeStoryGraphExtract,
    STORY_GRAPH_MESSAGES,
    () => {
      pumpStoryGraphExtract(deps, projectId, { excludeTaskId: taskId });
    },
  );
  if (!scheduled.scheduled) return { started: false, reason: 'SCHEDULE_FAILED' };
  return { started: true, taskId };
}

// ── 启动恢复 ──────────────────────────────────────────────────────

export interface StoryGraphRecoveryDeps {
  listProjectDbs(): Array<{ projectId: string; projDb: ProjectDatabase }>;
  getTaskRepo(projDb: ProjectDatabase): TaskRepositoryPort;
  pump(projectId: string): StoryGraphPumpResult;
}

/**
 * 启动恢复：每个有 PENDING 抽取任务的项目泵一次即可——后续接力由 onSettled 负责。
 *
 * projectId 取自 task.projectId（目录名只是打开 DB 的线索，不是权威 id）。
 */
export function recoverPendingStoryGraphExtracts(deps: StoryGraphRecoveryDeps): void {
  let entries: Array<{ projectId: string; projDb: ProjectDatabase }>;
  try {
    entries = deps.listProjectDbs();
  } catch {
    return;
  }

  const projectIds = new Set<string>();
  for (const { projDb } of entries) {
    try {
      for (const task of deps.getTaskRepo(projDb).listByStatus('PENDING')) {
        if (task.taskType === 'STORY_GRAPH_EXTRACT') projectIds.add(task.projectId);
      }
    } catch {
      // 无法读取此项目数据库，留待下次恢复
    } finally {
      try {
        projDb.close();
      } catch {
        // ignore
      }
    }
  }

  for (const projectId of projectIds) {
    try {
      deps.pump(projectId);
    } catch {
      // 单个项目恢复失败不阻断其他项目
    }
  }
}
