/**
 * 章节草稿层数据库集成测试（TD-033-3）。
 *
 * 覆盖三条后端规则：
 * - 规则 A：保存草稿不产生任何新版本、不推进 currentVersionId；
 * - 规则 B：显式保存 manuscript.saveChapter 成功后，同一事务内清除草稿；
 * - 规则 C：读取草稿时，currentVersionId 偏离 baseVersionId 则如实返回
 *   stale=true，不自动套用、不自动删除。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from './project-database.js';
import { sha256Utf8 } from './creation-contract-repositories.js';
import {
  createChapter,
  createChapterVersion,
  getOrCreateManuscript,
  promoteChapterVersion,
  saveChapterDraft,
  getChapterDraft,
  discardChapterDraft,
  ManuscriptVersionConflictError,
} from '@ai-novel/application';

const NOW = '2026-01-01T00:00:00.000Z';

interface Ctx {
  dir: string;
  db: ProjectDatabase;
  mutationDeps: {
    transactionPort: ReturnType<ProjectDatabase['getManuscriptTransaction']>;
    sha256Port: { digestUtf8(s: string): string };
  };
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'chapter-draft-integ-'));
  const db = new ProjectDatabase(join(dir, 'project.sqlite'));
  db.getProjectMetadataRepository().create({
    id: 'p1',
    name: '项目一',
    initialIdea: '一个故事',
    status: 'contract',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const mutationDeps = {
    transactionPort: db.getManuscriptTransaction(),
    sha256Port: { digestUtf8: (s: string) => sha256Utf8(s) },
  };
  return { dir, db, mutationDeps };
}

function seedManuscript(ctx: Ctx, manuscriptId = 'm1'): void {
  getOrCreateManuscript(ctx.mutationDeps, {
    projectId: 'p1',
    newManuscriptId: manuscriptId,
    now: NOW,
  });
}

function seedChapter(ctx: Ctx, chapterId: string, manuscriptId = 'm1'): void {
  createChapter(ctx.mutationDeps, {
    projectId: 'p1',
    manuscriptId,
    insertBeforeChapterId: null,
    now: NOW,
    newChapterId: chapterId,
  });
}

function seedVersion(
  ctx: Ctx,
  chapterId: string,
  versionId: string,
  expected: string | null,
): void {
  createChapterVersion(ctx.mutationDeps, {
    projectId: 'p1',
    chapterId,
    title: '章',
    content: `正文-${versionId}`,
    expectedCurrentVersionId: expected,
    now: NOW,
    newVersionId: versionId,
  });
}

function draftDeps(ctx: Ctx) {
  return {
    chapterRepo: ctx.db.getChapterRepository(),
    chapterDraftRepo: ctx.db.getChapterDraftRepository(),
  };
}

describe('chapter_drafts 后端草稿层', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => {
    try {
      ctx.db.close();
    } catch {
      // 测试内已关闭时忽略
    }
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('规则 A：保存草稿不产生任何新版本、不推进 currentVersionId', () => {
    seedManuscript(ctx);
    seedChapter(ctx, 'c1');
    seedVersion(ctx, 'c1', 'v1', null);

    const beforeChapter = ctx.db.getChapterRepository().getById('p1', 'c1');
    const beforeCount = ctx.db.getChapterVersionRepository().countByChapter('p1', 'c1');
    expect(beforeChapter?.currentVersionId).toBe('v1');

    saveChapterDraft(ctx.mutationDeps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: '草稿标题',
      content: '自动保存的草稿正文',
      baseVersionId: 'v1',
      now: '2026-01-01T00:05:00.000Z',
    });

    const afterChapter = ctx.db.getChapterRepository().getById('p1', 'c1');
    const afterCount = ctx.db.getChapterVersionRepository().countByChapter('p1', 'c1');
    expect(afterCount).toBe(beforeCount);
    expect(afterChapter?.currentVersionId).toBe(beforeChapter?.currentVersionId);
    expect(afterChapter?.currentVersionId).toBe('v1');
  });

  it('规则 B：显式保存成功后清除草稿；CAS 失败时草稿保留（同事务）', () => {
    seedManuscript(ctx);
    seedChapter(ctx, 'c1');
    seedVersion(ctx, 'c1', 'v1', null);
    saveChapterDraft(ctx.mutationDeps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: '草稿标题',
      content: '草稿正文',
      baseVersionId: 'v1',
      now: NOW,
    });

    expect(getChapterDraft(draftDeps(ctx), { projectId: 'p1', chapterId: 'c1' })).not.toBeNull();

    createChapterVersion(ctx.mutationDeps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: '第二章',
      content: '显式保存正文',
      expectedCurrentVersionId: 'v1',
      clearDraftOnSuccess: true,
      now: NOW,
      newVersionId: 'v2',
    });
    expect(getChapterDraft(draftDeps(ctx), { projectId: 'p1', chapterId: 'c1' })).toBeNull();

    // 再存一份草稿，然后故意让 CAS 失败：草稿必须还在（删除在成功路径，且同事务回滚）。
    saveChapterDraft(ctx.mutationDeps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: '草稿标题',
      content: '第二份草稿',
      baseVersionId: 'v2',
      now: NOW,
    });
    expect(() =>
      createChapterVersion(ctx.mutationDeps, {
        projectId: 'p1',
        chapterId: 'c1',
        title: '冲突保存',
        content: '不应该成功',
        expectedCurrentVersionId: 'v1',
        clearDraftOnSuccess: true,
        now: NOW,
        newVersionId: 'v3',
      }),
    ).toThrow(ManuscriptVersionConflictError);
    expect(getChapterDraft(draftDeps(ctx), { projectId: 'p1', chapterId: 'c1' })).not.toBeNull();
  });

  it('规则 C：currentVersionId 偏离 baseVersionId 时返回 stale=true，且不自动删除/套用', () => {
    seedManuscript(ctx);
    seedChapter(ctx, 'c1');
    seedVersion(ctx, 'c1', 'v1', null);

    // 草稿基线 v1，当前也是 v1：不 stale。
    saveChapterDraft(ctx.mutationDeps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: '草稿标题',
      content: '草稿-v1',
      baseVersionId: 'v1',
      now: NOW,
    });
    const fresh = getChapterDraft(draftDeps(ctx), { projectId: 'p1', chapterId: 'c1' });
    expect(fresh?.stale).toBe(false);
    expect(fresh?.baseVersionId).toBe('v1');
    expect(fresh?.currentVersionId).toBe('v1');

    // 显式保存 v2（会清草稿），再存一份基线为 v2 的草稿。
    createChapterVersion(ctx.mutationDeps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: '第二章',
      content: '正文-v2',
      expectedCurrentVersionId: 'v1',
      clearDraftOnSuccess: true,
      now: NOW,
      newVersionId: 'v2',
    });
    saveChapterDraft(ctx.mutationDeps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: '草稿标题',
      content: '草稿-v2',
      baseVersionId: 'v2',
      now: NOW,
    });

    // 恢复到 v1：current 偏离草稿基线 v2。
    promoteChapterVersion(ctx.mutationDeps, {
      projectId: 'p1',
      chapterId: 'c1',
      versionId: 'v1',
      expectedCurrentVersionId: 'v2',
      now: NOW,
    });

    const stale = getChapterDraft(draftDeps(ctx), { projectId: 'p1', chapterId: 'c1' });
    expect(stale).not.toBeNull();
    expect(stale?.baseVersionId).toBe('v2');
    expect(stale?.currentVersionId).toBe('v1');
    expect(stale?.stale).toBe(true);
    expect(stale?.content).toBe('草稿-v2');

    // 不自动删除、不自动套用：再读一次仍在。
    const again = getChapterDraft(draftDeps(ctx), { projectId: 'p1', chapterId: 'c1' });
    expect(again?.stale).toBe(true);
    expect(ctx.db.getChapterDraftRepository().getByChapter('p1', 'c1')).not.toBeNull();
  });

  it('丢弃草稿：删除当前草稿并返回 true', () => {
    seedManuscript(ctx);
    seedChapter(ctx, 'c1');
    seedVersion(ctx, 'c1', 'v1', null);
    saveChapterDraft(ctx.mutationDeps, {
      projectId: 'p1',
      chapterId: 'c1',
      title: '草稿标题',
      content: '待丢弃草稿',
      baseVersionId: 'v1',
      now: NOW,
    });

    expect(discardChapterDraft(ctx.mutationDeps, { projectId: 'p1', chapterId: 'c1' })).toBe(true);
    expect(getChapterDraft(draftDeps(ctx), { projectId: 'p1', chapterId: 'c1' })).toBeNull();
  });
});
