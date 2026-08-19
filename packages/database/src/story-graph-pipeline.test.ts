/**
 * 故事图谱入队防抖与回填重建的数据库集成测试（D14 / B22 工单二）。
 *
 * 用真实 SQLite 驱动 application 用例（与 chapter-draft-database.test.ts 同款形态）：
 * - 防抖三分支（D-B22-3）：同 hash 跳过 / 不同 hash 顶掉旧 PENDING / RUNNING 不动；
 * - 账本判据：同一份 hash 已成功抽过就不再排（MANUSCRIPT_COMMIT 可重放）；
 * - 回填重建（D-B22-6）：清空 extracted 层但保留 user 覆盖层，按章节顺序逐章入队。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createChapter,
  createChapterVersion,
  enqueueStoryGraphExtract,
  getOrCreateManuscript,
  listStoryGraphChapterSlots,
  rebuildStoryGraph,
  type EnqueueStoryGraphExtractDeps,
  type RebuildStoryGraphDeps,
} from '@ai-novel/application';
import { ProjectDatabase } from './project-database.js';
import { TaskRepositoryPortAdapter } from './task-repository-port-adapter.js';
import { sha256Utf8 } from './creation-contract-repositories.js';

const NOW = '2026-08-19T00:00:00.000Z';

let dir: string;
let db: ProjectDatabase;
let idCounter = 0;

const clock = { now: () => NOW };
const idGenerator = { generate: () => `id-${++idCounter}` };

function mutationDeps() {
  return {
    transactionPort: db.getManuscriptTransaction(),
    sha256Port: { digestUtf8: (input: string) => sha256Utf8(input) },
  };
}

function enqueueDeps(): EnqueueStoryGraphExtractDeps {
  return {
    manuscriptRepo: db.getManuscriptRepository(),
    chapterRepo: db.getChapterRepository(),
    chapterVersionRepo: db.getChapterVersionRepository(),
    taskRepo: new TaskRepositoryPortAdapter(db.database, () => NOW),
    extractionRepo: db.getStoryExtractionRepository(),
    idGenerator,
    clock,
    transaction: <T>(fn: () => T) => db.transaction(fn),
  };
}

function rebuildDeps(): RebuildStoryGraphDeps {
  return { ...enqueueDeps(), graphRepo: db.getStoryGraphRepository() };
}

function seedChapter(chapterId: string, content: string, versionId: string): void {
  createChapter(mutationDeps(), {
    projectId: 'p1',
    manuscriptId: 'm1',
    insertBeforeChapterId: null,
    now: NOW,
    newChapterId: chapterId,
  });
  createChapterVersion(mutationDeps(), {
    projectId: 'p1',
    chapterId,
    title: chapterId,
    content,
    expectedCurrentVersionId: null,
    now: NOW,
    newVersionId: versionId,
  });
}

function extractTasks(status: 'PENDING' | 'RUNNING' | 'STALE') {
  return db
    .getTaskRepository()
    .listByStatus(status)
    .filter((t) => t.taskType === 'STORY_GRAPH_EXTRACT');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'story-graph-pipeline-'));
  idCounter = 0;
  db = new ProjectDatabase(join(dir, 'project.sqlite'));
  db.getProjectMetadataRepository().create({
    id: 'p1',
    name: '项目一',
    initialIdea: '一个故事',
    status: 'drafting',
    createdAt: NOW,
    updatedAt: NOW,
  });
  getOrCreateManuscript(mutationDeps(), { projectId: 'p1', newManuscriptId: 'm1', now: NOW });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // 测试内已关闭时忽略
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('抽取入队防抖（D-B22-3）', () => {
  it('章节序取稿件顺序下标，不是 chapters.position', () => {
    seedChapter('c1', '第一章正文', 'v1');
    seedChapter('c2', '第二章正文', 'v2');
    const slots = listStoryGraphChapterSlots(enqueueDeps(), 'p1');
    expect(slots.map((s) => s.chapterId)).toEqual(['c1', 'c2']);
    expect(slots.map((s) => s.chapterNumber)).toEqual([1, 2]);
    // position 是稀疏 rank，与章号不是一回事
    expect(db.getChapterRepository().getById('p1', 'c1')?.position).toBeGreaterThan(2);
  });

  it('没有权威版本的章节不入队', () => {
    createChapter(mutationDeps(), {
      projectId: 'p1',
      manuscriptId: 'm1',
      insertBeforeChapterId: null,
      now: NOW,
      newChapterId: 'c-empty',
    });
    expect(
      enqueueStoryGraphExtract(enqueueDeps(), { projectId: 'p1', chapterId: 'c-empty' }),
    ).toEqual({ enqueued: false, reason: 'NO_AUTHORITATIVE_VERSION' });
    expect(extractTasks('PENDING')).toEqual([]);
  });

  it('分支一：同 hash 已有 PENDING → 跳过，不再排第二条', () => {
    seedChapter('c1', '第一章正文', 'v1');
    const first = enqueueStoryGraphExtract(enqueueDeps(), { projectId: 'p1', chapterId: 'c1' });
    expect(first.enqueued).toBe(true);

    expect(enqueueStoryGraphExtract(enqueueDeps(), { projectId: 'p1', chapterId: 'c1' })).toEqual({
      enqueued: false,
      reason: 'ALREADY_QUEUED',
    });
    expect(extractTasks('PENDING')).toHaveLength(1);
  });

  it('分支二：内容变了 → 旧 PENDING 标记 STALE，新任务入队', () => {
    seedChapter('c1', '第一章正文', 'v1');
    const first = enqueueStoryGraphExtract(enqueueDeps(), { projectId: 'p1', chapterId: 'c1' });
    const firstTaskId = (first as { taskId: string }).taskId;

    createChapterVersion(mutationDeps(), {
      projectId: 'p1',
      chapterId: 'c1',
      title: 'c1',
      content: '第一章改过的正文',
      expectedCurrentVersionId: 'v1',
      now: NOW,
      newVersionId: 'v2',
    });

    const second = enqueueStoryGraphExtract(enqueueDeps(), { projectId: 'p1', chapterId: 'c1' });
    if (!second.enqueued) throw new Error(`应当入队，实际 ${second.reason}`);
    expect(second.supersededTaskIds).toEqual([firstTaskId]);
    expect(db.getTaskRepository().getById(firstTaskId)?.status).toBe('STALE');

    const pending = extractTasks('PENDING');
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0].payloadJson).sourceContentHash).toBe(
      sha256Utf8('第一章改过的正文'),
    );
  });

  it('分支三：RUNNING 的任务不动，新内容照样入队', () => {
    seedChapter('c1', '第一章正文', 'v1');
    const first = enqueueStoryGraphExtract(enqueueDeps(), { projectId: 'p1', chapterId: 'c1' });
    const runningId = (first as { taskId: string }).taskId;
    expect(db.getTaskRepository().claimPending(runningId, NOW)).toBe(true);

    createChapterVersion(mutationDeps(), {
      projectId: 'p1',
      chapterId: 'c1',
      title: 'c1',
      content: '第一章改过的正文',
      expectedCurrentVersionId: 'v1',
      now: NOW,
      newVersionId: 'v2',
    });
    const second = enqueueStoryGraphExtract(enqueueDeps(), { projectId: 'p1', chapterId: 'c1' });

    if (!second.enqueued) throw new Error(`应当入队，实际 ${second.reason}`);
    expect(second.supersededTaskIds).toEqual([]);
    // RUNNING 的一条原样在跑（它锚定旧 hash，读取端据此判 stale）
    expect(db.getTaskRepository().getById(runningId)?.status).toBe('RUNNING');
    expect(extractTasks('PENDING')).toHaveLength(1);
  });

  it('账本判据：同一份 hash 已成功抽过就不再排（提交可重放）', () => {
    seedChapter('c1', '第一章正文', 'v1');
    db.getStoryExtractionRepository().register({
      id: 'x1',
      projectId: 'p1',
      chapterId: 'c1',
      sourceVersionId: 'v1',
      sourceContentHash: sha256Utf8('第一章正文'),
      taskId: null,
      status: 'succeeded',
      extractedAt: NOW,
    });

    expect(enqueueStoryGraphExtract(enqueueDeps(), { projectId: 'p1', chapterId: 'c1' })).toEqual({
      enqueued: false,
      reason: 'ALREADY_EXTRACTED',
    });
    expect(extractTasks('PENDING')).toEqual([]);

    // 内容一变，账本就不再挡
    createChapterVersion(mutationDeps(), {
      projectId: 'p1',
      chapterId: 'c1',
      title: 'c1',
      content: '第一章改过的正文',
      expectedCurrentVersionId: 'v1',
      now: NOW,
      newVersionId: 'v2',
    });
    expect(
      enqueueStoryGraphExtract(enqueueDeps(), { projectId: 'p1', chapterId: 'c1' }).enqueued,
    ).toBe(true);
  });
});

describe('回填重建（D-B22-6）', () => {
  it('清空 extracted 层并按章节顺序逐章入队，user 覆盖层原样保留', () => {
    seedChapter('c1', '第一章正文', 'v1');
    seedChapter('c2', '第二章正文', 'v2');

    // 一层自动抽取记录 + 一层用户覆盖记录
    const entityRepo = db.getStoryEntityRepository();
    entityRepo.create({
      id: 'e-auto',
      projectId: 'p1',
      kind: 'character',
      canonicalName: '林三',
      profileSummary: '自动抽的',
      firstChapter: 1,
      origin: 'extracted',
      createdAt: NOW,
    });
    entityRepo.create({
      id: 'e-user',
      projectId: 'p1',
      kind: 'location',
      canonicalName: '青云宗',
      profileSummary: '我手写的设定',
      firstChapter: null,
      origin: 'user',
      createdAt: NOW,
    });
    db.getStoryStateRepository().insert({
      id: 's-auto',
      projectId: 'p1',
      subjectEntityId: 'e-auto',
      predicate: '身份',
      objectEntityId: null,
      objectText: '外门弟子',
      validFromChapter: 1,
      sourceChapterId: 'c1',
      sourceContentHash: sha256Utf8('第一章正文'),
      evidenceSpan: null,
      confidence: null,
      origin: 'extracted',
      createdAt: NOW,
    });
    db.getStoryStateRepository().insert({
      id: 's-user',
      projectId: 'p1',
      subjectEntityId: 'e-user',
      predicate: '所在',
      objectEntityId: null,
      objectText: '东境',
      validFromChapter: 1,
      sourceChapterId: null,
      sourceContentHash: null,
      evidenceSpan: null,
      confidence: null,
      origin: 'user',
      createdAt: NOW,
    });
    db.getStoryExtractionRepository().register({
      id: 'x1',
      projectId: 'p1',
      chapterId: 'c1',
      sourceVersionId: 'v1',
      sourceContentHash: sha256Utf8('第一章正文'),
      taskId: null,
      status: 'succeeded',
      extractedAt: NOW,
    });

    const result = rebuildStoryGraph(rebuildDeps(), { projectId: 'p1' });

    expect(result.cleared.states).toBe(1);
    expect(result.cleared.entities).toBe(1);
    expect(result.cleared.extractions).toBe(1);
    expect(result.enqueued.map((e) => e.chapterId)).toEqual(['c1', 'c2']);
    expect(result.skippedChapters).toBe(0);

    // extracted 清空、user 保留
    expect(db.getStoryStateRepository().getById('p1', 's-auto')).toBeNull();
    expect(entityRepo.getById('p1', 'e-auto')).toBeNull();
    expect(entityRepo.getById('p1', 'e-user')?.profileSummary).toBe('我手写的设定');
    expect(db.getStoryStateRepository().getById('p1', 's-user')?.objectText).toBe('东境');

    // 账本被清空，所以每章都重新排上了
    const pending = extractTasks('PENDING');
    expect(pending).toHaveLength(2);
    expect(pending.map((t) => JSON.parse(t.payloadJson).chapterId).sort()).toEqual(['c1', 'c2']);
  });

  it('空章节只跳过、不报错', () => {
    seedChapter('c1', '第一章正文', 'v1');
    createChapter(mutationDeps(), {
      projectId: 'p1',
      manuscriptId: 'm1',
      insertBeforeChapterId: null,
      now: NOW,
      newChapterId: 'c-empty',
    });

    const result = rebuildStoryGraph(rebuildDeps(), { projectId: 'p1' });
    expect(result.enqueued.map((e) => e.chapterId)).toEqual(['c1']);
    expect(result.skippedChapters).toBe(0);
    expect(extractTasks('PENDING')).toHaveLength(1);
  });
});
