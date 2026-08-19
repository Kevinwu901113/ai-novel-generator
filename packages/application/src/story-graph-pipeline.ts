/**
 * 故事图谱抽取管线的应用层用例（D14 / B22 工单二）。
 *
 * - 章节定位：图上的"第几章"= 稿件章节按 position 排序后的下标（自 1 起）。
 *   `chapters.position` 是稀疏 rank（2048/3072/…）不是章号，绝不能直接当序号；
 *   蓝图下标也不行——用户手工新增的章节没有蓝图绑定。
 * - 入队 + 防抖（D-B22-3）：同章同 content_hash 的活跃任务直接跳过；不同 hash 的
 *   PENDING 标记 STALE 后重新入队；RUNNING 的不动（它锚定的是旧 hash，读取端自然判 stale）。
 * - 回填重建（D-B22-6）：清空 extracted 层（user 覆盖层保留）后按章节顺序逐章入队。
 */

import type { Clock, IdGenerator, TaskData, TaskRepositoryPort } from './types.js';
import type {
  ChapterRepositoryPort,
  ChapterVersionRepositoryPort,
  ManuscriptRepositoryPort,
} from './manuscript-types.js';
import type {
  StoryExtractionRepositoryPort,
  StoryGraphClearExtractedResult,
  StoryGraphRepositoryPort,
} from './story-graph-types.js';

// ── 任务 payload ──────────────────────────────────────────────────

/** STORY_GRAPH_EXTRACT 的 payload（sourceVersionId/hash 是防抖与失效判据） */
export interface StoryGraphExtractPayload {
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly sourceContentHash: string;
}

/** 解析任务 payload；结构不符返回 null（调用方按"无法判定"处理，不猜） */
export function parseStoryGraphExtractPayload(
  payloadJson: string,
): StoryGraphExtractPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.chapterId !== 'string' ||
    typeof obj.sourceVersionId !== 'string' ||
    typeof obj.sourceContentHash !== 'string' ||
    obj.chapterId.length === 0 ||
    obj.sourceVersionId.length === 0 ||
    obj.sourceContentHash.length === 0
  ) {
    return null;
  }
  return {
    chapterId: obj.chapterId,
    sourceVersionId: obj.sourceVersionId,
    sourceContentHash: obj.sourceContentHash,
  };
}

// ── 章节定位 ──────────────────────────────────────────────────────

export interface StoryGraphChapterQueryDeps {
  readonly manuscriptRepo: ManuscriptRepositoryPort;
  readonly chapterRepo: ChapterRepositoryPort;
  readonly chapterVersionRepo: ChapterVersionRepositoryPort;
}

/** 章节在稿件中的位置与当前权威版本指针 */
export interface StoryGraphChapterSlot {
  readonly chapterId: string;
  /** 稿件顺序下标（自 1 起），即图上的章节戳 */
  readonly chapterNumber: number;
  readonly status: 'active' | 'archived';
  readonly currentVersionId: string | null;
}

/** 抽取目标：章节戳 + 当下权威版本正文 */
export interface StoryGraphChapterTarget {
  readonly chapterId: string;
  readonly chapterNumber: number;
  readonly versionId: string;
  readonly contentHash: string;
  readonly title: string;
  readonly content: string;
}

/**
 * 全项目章节顺序。
 *
 * 含 archived 章节：章节戳一旦写进状态边就不该因为归档而整体位移
 * （append-only 的记录不会回头改章号）。归档章不参与抽取，只占号。
 */
export function listStoryGraphChapterSlots(
  deps: StoryGraphChapterQueryDeps,
  projectId: string,
): ReadonlyArray<StoryGraphChapterSlot> {
  const manuscript = deps.manuscriptRepo.getActiveByProject(projectId);
  if (!manuscript) return [];
  return deps.chapterRepo.listByManuscript(projectId, manuscript.id).map((chapter, index) => ({
    chapterId: chapter.id,
    chapterNumber: index + 1,
    status: chapter.status,
    currentVersionId: chapter.currentVersionId,
  }));
}

/**
 * 定位某章的抽取目标：章节戳 + **当下**权威版本（chapter_versions current）。
 *
 * 绝不取候选：候选还没被用户接受，抽进图里就是污染（D-B22-4）。
 * 章节不存在 / 还没有任何版本 / 指针悬空都返回 null。
 */
export function resolveStoryGraphChapterTarget(
  deps: StoryGraphChapterQueryDeps,
  projectId: string,
  chapterId: string,
): StoryGraphChapterTarget | null {
  const slot = listStoryGraphChapterSlots(deps, projectId).find((s) => s.chapterId === chapterId);
  if (!slot || slot.currentVersionId === null) return null;
  const version = deps.chapterVersionRepo.getById(projectId, chapterId, slot.currentVersionId);
  if (!version) return null;
  return {
    chapterId,
    chapterNumber: slot.chapterNumber,
    versionId: version.id,
    contentHash: version.contentHash,
    title: version.title,
    content: version.content,
  };
}

// ── 入队 + 防抖（D-B22-3）─────────────────────────────────────────

export interface EnqueueStoryGraphExtractDeps extends StoryGraphChapterQueryDeps {
  readonly taskRepo: TaskRepositoryPort;
  readonly extractionRepo: StoryExtractionRepositoryPort;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly transaction: <T>(fn: () => T) => T;
}

export interface EnqueueStoryGraphExtractInput {
  readonly projectId: string;
  readonly chapterId: string;
}

export type EnqueueStoryGraphExtractResult =
  | {
      readonly enqueued: true;
      readonly taskId: string;
      readonly chapterNumber: number;
      /** 被本次入队顶掉的旧 PENDING 任务（不同 hash） */
      readonly supersededTaskIds: ReadonlyArray<string>;
    }
  | {
      readonly enqueued: false;
      readonly reason: 'NO_AUTHORITATIVE_VERSION' | 'ALREADY_QUEUED' | 'ALREADY_EXTRACTED';
    };

/** 该章尚未终结的抽取任务（PENDING/RUNNING），按创建时间升序 */
function activeExtractTasks(
  taskRepo: TaskRepositoryPort,
  projectId: string,
  chapterId: string,
): ReadonlyArray<{ readonly task: TaskData; readonly payload: StoryGraphExtractPayload | null }> {
  const active = [...taskRepo.listByStatus('PENDING'), ...taskRepo.listByStatus('RUNNING')];
  return active
    .filter((t) => t.projectId === projectId && t.taskType === 'STORY_GRAPH_EXTRACT')
    .map((task) => ({ task, payload: parseStoryGraphExtractPayload(task.payloadJson) }))
    .filter((entry) => entry.payload !== null && entry.payload.chapterId === chapterId);
}

/**
 * 为某章排队一次图抽取（防抖见 D-B22-3）。
 *
 * - 该章最近一次成功抽取就是这份 hash → 跳过（MANUSCRIPT_COMMIT 是 replayable 的，
 *   重放同一次提交不该再烧一次模型调用；账本就是这个判据的锚）；
 * - 同 hash 已有 PENDING/RUNNING → 跳过（RUNNING 同 hash 再排一次纯属浪费，
 *   且会撞 dedupe 部分唯一索引）；
 * - 不同 hash 的 PENDING → 标记 STALE（内容已经变了，跑它没有意义），再入队新的；
 * - RUNNING 的一律不动：它的结果锚定旧 hash，读取端据此判 stale。
 */
export function enqueueStoryGraphExtract(
  deps: EnqueueStoryGraphExtractDeps,
  input: EnqueueStoryGraphExtractInput,
): EnqueueStoryGraphExtractResult {
  const target = resolveStoryGraphChapterTarget(deps, input.projectId, input.chapterId);
  if (!target) return { enqueued: false, reason: 'NO_AUTHORITATIVE_VERSION' };

  const latest = deps.extractionRepo.getLatestByChapter(input.projectId, input.chapterId);
  if (latest && latest.status === 'succeeded' && latest.sourceContentHash === target.contentHash) {
    return { enqueued: false, reason: 'ALREADY_EXTRACTED' };
  }

  const active = activeExtractTasks(deps.taskRepo, input.projectId, input.chapterId);
  if (active.some((entry) => entry.payload!.sourceContentHash === target.contentHash)) {
    return { enqueued: false, reason: 'ALREADY_QUEUED' };
  }

  const stalePendingIds = active
    .filter((entry) => entry.task.status === 'PENDING')
    .map((entry) => entry.task.id);

  const taskId = deps.idGenerator.generate();
  const payload: StoryGraphExtractPayload = {
    chapterId: input.chapterId,
    sourceVersionId: target.versionId,
    sourceContentHash: target.contentHash,
  };

  const superseded: string[] = [];
  deps.transaction(() => {
    for (const id of stalePendingIds) {
      // markStale 是这里唯一合适的既有原语：内容变了，旧任务是"已过期"而非"被用户取消"
      if (deps.taskRepo.markStale(id, ['PENDING'])) superseded.push(id);
    }
    deps.taskRepo.create({
      id: taskId,
      projectId: input.projectId,
      taskType: 'STORY_GRAPH_EXTRACT',
      inputVersionJson: JSON.stringify({ chapterNumber: target.chapterNumber }),
      payloadJson: JSON.stringify(payload),
      dedupeKey: `story_graph_extract:${input.chapterId}:${target.contentHash}`,
    });
  });

  return {
    enqueued: true,
    taskId,
    chapterNumber: target.chapterNumber,
    supersededTaskIds: superseded,
  };
}

// ── 回填重建（D-B22-6）────────────────────────────────────────────

export interface RebuildStoryGraphDeps extends EnqueueStoryGraphExtractDeps {
  readonly graphRepo: StoryGraphRepositoryPort;
}

export interface RebuildStoryGraphResult {
  readonly cleared: StoryGraphClearExtractedResult;
  readonly enqueued: ReadonlyArray<{ readonly chapterId: string; readonly taskId: string }>;
  /** 没有权威版本（空章节）而跳过的章节数 */
  readonly skippedChapters: number;
}

/**
 * 重建整个项目的故事图谱：清空 extracted 层后按章节顺序逐章入队。
 *
 * 清空与入队不放在同一事务里：入队要覆盖的是"逐章一个任务"，
 * 中途失败也不该把已清空的图回滚成半新半旧——重跑本命令即可收敛。
 * 归档章节只占章号不抽取（不属于成书内容）。
 */
export function rebuildStoryGraph(
  deps: RebuildStoryGraphDeps,
  input: { readonly projectId: string },
): RebuildStoryGraphResult {
  const cleared = deps.graphRepo.clearExtracted(input.projectId);
  const enqueued: Array<{ chapterId: string; taskId: string }> = [];
  let skippedChapters = 0;

  for (const slot of listStoryGraphChapterSlots(deps, input.projectId)) {
    if (slot.status !== 'active' || slot.currentVersionId === null) continue;
    const result = enqueueStoryGraphExtract(deps, {
      projectId: input.projectId,
      chapterId: slot.chapterId,
    });
    if (result.enqueued) enqueued.push({ chapterId: slot.chapterId, taskId: result.taskId });
    else skippedChapters += 1;
  }

  return { cleared, enqueued, skippedChapters };
}
