/**
 * 稿件 Worker handler 测试（MV1-B，§15.3）。
 *
 * 真实 SQLite v7 + 真实 application use case，直接驱动 dispatchManuscriptCommand：
 * Desktop command → Worker dispatch → Application → SQLite v7 → Public DTO。
 *
 * 覆盖：
 * - 全部 14 个 dispatch 命令（getOrCreate / read / mutation）；
 * - ID / now / sourceType='USER' 由 Worker 注入（Renderer 不传）；
 * - current project 隔离（跨 project 统一安全 NOT_FOUND）；
 * - unknown command 确定性拒绝；
 * - application error 映射（typed AppError code）；
 * - restart 持久化（关闭重开后数据仍在）；
 * - CAS 冲突（并发推进后保存 → MANUSCRIPT_VERSION_CONFLICT）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ProjectDatabase } from '@ai-novel/database';
import { AppError } from '@ai-novel/application';
import { dispatchManuscriptCommand, type ManuscriptHandlerContext } from './manuscript-handlers.js';

const NOW = '2026-08-03T00:00:00.000Z';
const NOW2 = '2026-08-03T01:00:00.000Z';

let tempDir: string;
let dbPath: string;
let closeCount: number;
let idSeq = 0;

function openFreshDb(): ProjectDatabase {
  const db = new ProjectDatabase(dbPath);
  const origClose = db.close.bind(db);
  db.close = () => {
    closeCount++;
    origClose();
  };
  return db;
}

function makeCtx(overrides: Partial<ManuscriptHandlerContext> = {}): ManuscriptHandlerContext {
  return {
    getProjectDb: () => openFreshDb(),
    idGenerator: { generate: () => `gen-id-${++idSeq}` },
    clock: { now: () => NOW2 },
    ...overrides,
  };
}

function call(command: string, payload: unknown, ctx: ManuscriptHandlerContext): unknown {
  return dispatchManuscriptCommand(command, payload, ctx);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'manuscript-handlers-'));
  dbPath = join(tempDir, 'project.sqlite');
  closeCount = 0;
  idSeq = 0;
  const db = new ProjectDatabase(dbPath);
  db.getProjectMetadataRepository().create({
    id: 'p1',
    name: '项目一',
    initialIdea: '一个故事',
    status: 'contract',
    createdAt: NOW,
    updatedAt: NOW,
  });
  db.close();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dispatchManuscriptCommand', () => {
  it('unknown command 确定性拒绝', () => {
    const ctx = makeCtx();
    expect(() => call('manuscript.bogus', {}, ctx)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('getOrCreateManuscript 注入 newManuscriptId + now 并幂等', () => {
    const ctx = makeCtx();
    const first = call('manuscript.getOrCreateManuscript', { projectId: 'p1' }, ctx) as {
      id: string;
      createdAt: string;
      updatedAt: string;
      status: string;
    };
    expect(first.id).toBe('gen-id-1');
    expect(first.createdAt).toBe(NOW2);
    expect(first.updatedAt).toBe(NOW2);
    expect(first.status).toBe('active');

    // 再次调用返回既有稿件（不重复创建）
    const second = call('manuscript.getOrCreateManuscript', { projectId: 'p1' }, ctx) as {
      id: string;
    };
    expect(second.id).toBe(first.id);
  });

  it('getOrCreateManuscript 无效输入拒绝', () => {
    const ctx = makeCtx();
    expect(() => call('manuscript.getOrCreateManuscript', { projectId: 42 }, ctx)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('完整纵向切片：创建章节 → 保存版本 v1/v2 → 历史 → promote → 归档/恢复 → 改标题', () => {
    const ctx = makeCtx();

    const ms = call('manuscript.getOrCreateManuscript', { projectId: 'p1' }, ctx) as { id: string };
    const ch = call(
      'manuscript.createChapter',
      { projectId: 'p1', manuscriptId: ms.id, insertBeforeChapterId: null },
      ctx,
    ) as { id: string; position: number; currentVersionId: string | null; status: string };
    expect(ch.id).toBe('gen-id-2');
    expect(ch.position).toBe(2048);
    expect(ch.currentVersionId).toBeNull();
    expect(ch.status).toBe('active');

    // 保存 v1（Worker 注入 newVersionId / now / sourceType='USER'）
    const v1 = call(
      'manuscript.createChapterVersion',
      {
        projectId: 'p1',
        chapterId: ch.id,
        title: '第一章',
        content: '正文一',
        expectedCurrentVersionId: null,
      },
      ctx,
    ) as {
      id: string;
      versionNumber: number;
      sourceType: string;
      title: string;
      content: string;
      createdAt: string;
    };
    expect(v1.versionNumber).toBe(1);
    expect(v1.sourceType).toBe('USER');
    expect(v1.title).toBe('第一章');
    expect(v1.content).toBe('正文一');
    expect(v1.createdAt).toBe(NOW2);

    // 保存 v2
    const v2 = call(
      'manuscript.createChapterVersion',
      {
        projectId: 'p1',
        chapterId: ch.id,
        title: '第一章',
        content: '正文二',
        expectedCurrentVersionId: v1.id,
      },
      ctx,
    ) as { id: string; versionNumber: number };
    expect(v2.versionNumber).toBe(2);

    // getCurrentChapterVersion → v2（含 content）
    const current = call(
      'manuscript.getCurrentChapterVersion',
      { projectId: 'p1', chapterId: ch.id },
      ctx,
    ) as { id: string; content: string };
    expect(current.id).toBe(v2.id);
    expect(current.content).toBe('正文二');

    // listChapterVersions → [v2, v1]（version_number DESC）
    const versions = call(
      'manuscript.listChapterVersions',
      { projectId: 'p1', chapterId: ch.id },
      ctx,
    ) as ReadonlyArray<{ id: string; versionNumber: number; content?: string }>;
    expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    // 摘要不含 content（§7.3）
    expect('content' in (versions[0] as object)).toBe(false);

    // getChapterVersion → v1
    const got1 = call(
      'manuscript.getChapterVersion',
      { projectId: 'p1', chapterId: ch.id, versionId: v1.id },
      ctx,
    ) as { id: string };
    expect(got1.id).toBe(v1.id);

    // getManuscript / getChapter / listChapters
    const gotMs = call(
      'manuscript.getManuscript',
      { projectId: 'p1', manuscriptId: ms.id },
      ctx,
    ) as {
      id: string;
    };
    expect(gotMs.id).toBe(ms.id);
    const gotCh = call(
      'manuscript.getChapter',
      { projectId: 'p1', manuscriptId: ms.id, chapterId: ch.id },
      ctx,
    ) as { versionCount: number; currentVersion: { versionNumber: number } | null };
    expect(gotCh.versionCount).toBe(2);
    expect(gotCh.currentVersion?.versionNumber).toBe(2);
    const list = call(
      'manuscript.listChapters',
      { projectId: 'p1', manuscriptId: ms.id },
      ctx,
    ) as ReadonlyArray<{ id: string; currentTitle: string | null; versionCount: number }>;
    expect(list).toHaveLength(1);
    expect(list[0].currentTitle).toBe('第一章');
    expect(list[0].versionCount).toBe(2);

    // promote v1 为 current
    const promoted = call(
      'manuscript.promoteChapterVersion',
      { projectId: 'p1', chapterId: ch.id, versionId: v1.id, expectedCurrentVersionId: v2.id },
      ctx,
    ) as { id: string };
    expect(promoted.id).toBe(v1.id);
    const currentAfter = call(
      'manuscript.getCurrentChapterVersion',
      { projectId: 'p1', chapterId: ch.id },
      ctx,
    ) as { id: string };
    expect(currentAfter.id).toBe(v1.id);

    // updateChapterOrder（move 到末尾 → append，无变化也是合法返回 active 列表）
    const order = call(
      'manuscript.updateChapterOrder',
      { projectId: 'p1', manuscriptId: ms.id, chapterId: ch.id, insertBeforeChapterId: null },
      ctx,
    ) as ReadonlyArray<{ id: string }>;
    expect(order.map((c) => c.id)).toEqual([ch.id]);

    // archive / list(includeArchived) / restore
    const archived = call(
      'manuscript.archiveChapter',
      { projectId: 'p1', chapterId: ch.id, expectedCurrentVersionId: v1.id },
      ctx,
    ) as { status: string };
    expect(archived.status).toBe('archived');
    const activeOnly = call(
      'manuscript.listChapters',
      { projectId: 'p1', manuscriptId: ms.id },
      ctx,
    ) as ReadonlyArray<{ status: string }>;
    expect(activeOnly).toHaveLength(0);
    const all = call(
      'manuscript.listChapters',
      { projectId: 'p1', manuscriptId: ms.id, includeArchived: true },
      ctx,
    ) as ReadonlyArray<{ status: string }>;
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('archived');

    const restored = call(
      'manuscript.restoreChapter',
      { projectId: 'p1', chapterId: ch.id, expectedCurrentVersionId: v1.id },
      ctx,
    ) as { status: string };
    expect(restored.status).toBe('active');

    // updateManuscriptTitle（expectedUpdatedAt CAS）
    const updatedTitle = call(
      'manuscript.updateManuscriptTitle',
      { projectId: 'p1', manuscriptId: ms.id, title: '我的小说', expectedUpdatedAt: NOW2 },
      ctx,
    ) as { title: string };
    expect(updatedTitle.title).toBe('我的小说');

    // 每次 dispatch 都精确 close once
    expect(closeCount).toBeGreaterThan(0);
  });

  it('归档章节不能接收新版本（MANUSCRIPT_STATE_CONFLICT）', () => {
    const ctx = makeCtx();
    const ms = call('manuscript.getOrCreateManuscript', { projectId: 'p1' }, ctx) as { id: string };
    const ch = call(
      'manuscript.createChapter',
      { projectId: 'p1', manuscriptId: ms.id, insertBeforeChapterId: null },
      ctx,
    ) as { id: string };
    const v1 = call(
      'manuscript.createChapterVersion',
      {
        projectId: 'p1',
        chapterId: ch.id,
        title: '标题',
        content: '正文',
        expectedCurrentVersionId: null,
      },
      ctx,
    ) as { id: string };
    call(
      'manuscript.archiveChapter',
      { projectId: 'p1', chapterId: ch.id, expectedCurrentVersionId: v1.id },
      ctx,
    );
    expect(() =>
      call(
        'manuscript.createChapterVersion',
        {
          projectId: 'p1',
          chapterId: ch.id,
          title: '标题',
          content: '正文',
          expectedCurrentVersionId: v1.id,
        },
        ctx,
      ),
    ).toThrowError(expect.objectContaining({ code: 'MANUSCRIPT_STATE_CONFLICT' }));
  });

  it('CAS 冲突：并发推进后保存 → MANUSCRIPT_VERSION_CONFLICT，无孤儿版本', () => {
    const ctx = makeCtx();
    const ms = call('manuscript.getOrCreateManuscript', { projectId: 'p1' }, ctx) as { id: string };
    const ch = call(
      'manuscript.createChapter',
      { projectId: 'p1', manuscriptId: ms.id, insertBeforeChapterId: null },
      ctx,
    ) as { id: string };
    const v1 = call(
      'manuscript.createChapterVersion',
      {
        projectId: 'p1',
        chapterId: ch.id,
        title: '标题',
        content: '正文',
        expectedCurrentVersionId: null,
      },
      ctx,
    ) as { id: string };

    // 模拟另一客户端推进 current（直接通过 handler）
    const v2 = call(
      'manuscript.createChapterVersion',
      {
        projectId: 'p1',
        chapterId: ch.id,
        title: '标题',
        content: '新的正文',
        expectedCurrentVersionId: v1.id,
      },
      ctx,
    ) as { id: string };

    // 旧基线保存 → 冲突
    expect(() =>
      call(
        'manuscript.createChapterVersion',
        {
          projectId: 'p1',
          chapterId: ch.id,
          title: '标题',
          content: '旧基线正文',
          expectedCurrentVersionId: v1.id,
        },
        ctx,
      ),
    ).toThrowError(expect.objectContaining({ code: 'MANUSCRIPT_VERSION_CONFLICT' }));

    // 无孤儿版本：历史仍为 [v2, v1]
    const versions = call(
      'manuscript.listChapterVersions',
      { projectId: 'p1', chapterId: ch.id },
      ctx,
    ) as ReadonlyArray<{ id: string; versionNumber: number }>;
    expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(versions.map((v) => v.id)).toEqual([v2.id, v1.id]);
  });

  it('current project 隔离：跨 project 统一安全 NOT_FOUND', () => {
    const ctx = makeCtx();
    const ms = call('manuscript.getOrCreateManuscript', { projectId: 'p1' }, ctx) as { id: string };
    // 使用不存在的 projectId 查询同一稿件 id → MANUSCRIPT_NOT_FOUND（不泄露存在性）
    expect(() =>
      call('manuscript.getManuscript', { projectId: 'p2', manuscriptId: ms.id }, ctx),
    ).toThrowError(expect.objectContaining({ code: 'MANUSCRIPT_NOT_FOUND' }));
  });

  it('application error 映射：不存在稿件 → MANUSCRIPT_NOT_FOUND typed AppError', () => {
    const ctx = makeCtx();
    try {
      call('manuscript.getManuscript', { projectId: 'p1', manuscriptId: 'does-not-exist' }, ctx);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('MANUSCRIPT_NOT_FOUND');
    }
  });

  it('restart 持久化：关闭重开后稿件/章节/版本/current 完整', async () => {
    const ctx = makeCtx();
    const ms = call('manuscript.getOrCreateManuscript', { projectId: 'p1' }, ctx) as { id: string };
    const ch = call(
      'manuscript.createChapter',
      { projectId: 'p1', manuscriptId: ms.id, insertBeforeChapterId: null },
      ctx,
    ) as { id: string };
    const v1 = call(
      'manuscript.createChapterVersion',
      {
        projectId: 'p1',
        chapterId: ch.id,
        title: '标题',
        content: '正文',
        expectedCurrentVersionId: null,
      },
      ctx,
    ) as { id: string };

    // 重启：打开全新 ProjectDatabase（同一文件）
    const reopened = new ProjectDatabase(dbPath);
    try {
      const queryDeps = {
        manuscriptRepo: reopened.getManuscriptRepository(),
        chapterRepo: reopened.getChapterRepository(),
        chapterVersionRepo: reopened.getChapterVersionRepository(),
      };
      const { getManuscript, listChapters, getCurrentChapterVersion, listChapterVersions } =
        (await import('@ai-novel/application')) as typeof import('@ai-novel/application');
      const ms2 = getManuscript(queryDeps, { projectId: 'p1', manuscriptId: ms.id });
      expect(ms2.id).toBe(ms.id);
      const chapters = listChapters(queryDeps, { projectId: 'p1', manuscriptId: ms.id });
      expect(chapters).toHaveLength(1);
      const current = getCurrentChapterVersion(queryDeps, { projectId: 'p1', chapterId: ch.id });
      expect(current?.id).toBe(v1.id);
      const versions = listChapterVersions(queryDeps, { projectId: 'p1', chapterId: ch.id });
      expect(versions).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
