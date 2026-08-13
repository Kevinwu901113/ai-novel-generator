/**
 * 稿件工作区 RPC 测试（GE-7，真实 SQLite）。
 *
 * 覆盖 GE-7 退出条件里的两条硬要求：
 * - **不静默覆盖手写正文**：CAS 基线过期时保存被拒，且既有版本一条不少；
 * - 导出闭环：按稿件顺序渲染 TXT / Markdown，空稿件明确拒绝。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase, sha256Utf8 } from '@ai-novel/database';
import {
  AppError,
  createChapter,
  createChapterVersion,
  getOrCreateManuscript,
} from '@ai-novel/application';
import {
  countWords,
  dispatchManuscriptCommand,
  type ManuscriptExportPayload,
  type ManuscriptHandlerContext,
} from './manuscript-handlers.js';
import type { ManuscriptChapterDetailDto, ManuscriptWorkspaceDto } from '@ai-novel/contracts';

const NOW = '2026-08-13T00:00:00.000Z';
const PROJECT_ID = 'p1';

let tempDir: string;
let dbPath: string;
let idCounter = 0;

const clock = { now: () => NOW };
const idGenerator = { generate: () => `id-${++idCounter}` };

function openDb(): ProjectDatabase {
  return new ProjectDatabase(dbPath);
}

function ctx(): ManuscriptHandlerContext {
  return { getProjectDb: () => openDb(), idGenerator, clock };
}

function mutationDeps(db: ProjectDatabase) {
  return {
    transactionPort: db.getManuscriptTransaction(),
    sha256Port: { digestUtf8: (input: string) => sha256Utf8(input) },
  };
}

/** 造一份两章稿件（第二章留空，用于验证导出跳过空章） */
function seedManuscript(): { chapterId: string; versionId: string } {
  const db = openDb();
  try {
    db.getProjectMetadataRepository().create({
      id: PROJECT_ID,
      name: '测试项目',
      initialIdea: '一个客栈故事',
      status: 'ACTIVE',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const deps = mutationDeps(db);
    const manuscript = getOrCreateManuscript(deps, {
      projectId: PROJECT_ID,
      newManuscriptId: 'ms-1',
      title: '位面客栈',
      creationContractVersionId: null,
      now: NOW,
    });
    const chapter = createChapter(deps, {
      projectId: PROJECT_ID,
      manuscriptId: manuscript.id,
      newChapterId: 'ch-1',
      insertBeforeChapterId: null,
      now: NOW,
    });
    const version = createChapterVersion(deps, {
      projectId: PROJECT_ID,
      chapterId: chapter.id,
      newVersionId: 'ver-1',
      title: '第一章 远客',
      content: '雨砸在屋檐上。\n小满擦干酒杯。',
      expectedCurrentVersionId: null,
      sourceType: 'USER',
      now: NOW,
    });
    createChapter(deps, {
      projectId: PROJECT_ID,
      manuscriptId: manuscript.id,
      newChapterId: 'ch-2',
      insertBeforeChapterId: null,
      now: NOW,
    });
    return { chapterId: chapter.id, versionId: version.id };
  } finally {
    db.close();
  }
}

describe('countWords', () => {
  it('按去空白后的字符数计（中文按字）', () => {
    expect(countWords('雨砸在屋檐上。\n小满擦干酒杯。')).toBe(14);
    expect(countWords('   ')).toBe(0);
  });
});

describe('稿件 RPC（真实 SQLite）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'manuscript-handlers-'));
    dbPath = join(tempDir, 'project.sqlite');
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('没有稿件时 getWorkspace 返回空（不报错）', () => {
    const db = openDb();
    db.getProjectMetadataRepository().create({
      id: PROJECT_ID,
      name: 'p',
      initialIdea: 'i',
      status: 'ACTIVE',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.close();
    const workspace = dispatchManuscriptCommand(
      'manuscript.getWorkspace',
      { projectId: PROJECT_ID },
      ctx(),
    ) as ManuscriptWorkspaceDto;
    expect(workspace.manuscriptId).toBeNull();
    expect(workspace.chapters).toHaveLength(0);
  });

  it('getWorkspace 列出章节与字数；getChapter 给出 CAS 基线', () => {
    const seeded = seedManuscript();
    const workspace = dispatchManuscriptCommand(
      'manuscript.getWorkspace',
      { projectId: PROJECT_ID },
      ctx(),
    ) as ManuscriptWorkspaceDto;
    expect(workspace.title).toBe('位面客栈');
    expect(workspace.chapters).toHaveLength(2);
    const first = workspace.chapters.find((c) => c.chapterId === seeded.chapterId)!;
    expect(first.title).toBe('第一章 远客');
    expect(first.wordCount).toBeGreaterThan(0);

    const detail = dispatchManuscriptCommand(
      'manuscript.getChapter',
      { projectId: PROJECT_ID, chapterId: seeded.chapterId },
      ctx(),
    ) as ManuscriptChapterDetailDto;
    expect(detail.currentVersionId).toBe(seeded.versionId);
    expect(detail.versionNumber).toBe(1);
    expect(detail.versionCount).toBe(1);
  });

  it('保存追加新版本（旧版本保留），并返回新的 CAS 基线', () => {
    const seeded = seedManuscript();
    const saved = dispatchManuscriptCommand(
      'manuscript.saveChapter',
      {
        projectId: PROJECT_ID,
        chapterId: seeded.chapterId,
        title: '第一章 远客',
        content: '改过的正文。',
        expectedCurrentVersionId: seeded.versionId,
      },
      ctx(),
    ) as ManuscriptChapterDetailDto;

    expect(saved.content).toBe('改过的正文。');
    expect(saved.versionCount).toBe(2);
    expect(saved.currentVersionId).not.toBe(seeded.versionId);

    // 旧版本仍在（append-only）
    const db = openDb();
    try {
      const versions = db
        .getChapterVersionRepository()
        .listSummariesByChapter(PROJECT_ID, seeded.chapterId);
      expect(versions.some((v) => v.id === seeded.versionId)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('CAS 基线过期 → 保存被拒，既有版本一条不少（不静默覆盖）', () => {
    const seeded = seedManuscript();
    // 期间发生了另一次写入（例如又一次 MANUSCRIPT_COMMIT）
    dispatchManuscriptCommand(
      'manuscript.saveChapter',
      {
        projectId: PROJECT_ID,
        chapterId: seeded.chapterId,
        title: '第一章 远客',
        content: '别处写入的正文。',
        expectedCurrentVersionId: seeded.versionId,
      },
      ctx(),
    );

    // 用过期基线保存 → 必须被拒
    expect(() =>
      dispatchManuscriptCommand(
        'manuscript.saveChapter',
        {
          projectId: PROJECT_ID,
          chapterId: seeded.chapterId,
          title: '第一章 远客',
          content: '基于旧版本的修改。',
          expectedCurrentVersionId: seeded.versionId,
        },
        ctx(),
      ),
    ).toThrow();

    const db = openDb();
    try {
      const versions = db
        .getChapterVersionRepository()
        .listSummariesByChapter(PROJECT_ID, seeded.chapterId);
      // 只有初始版本 + 那一次成功写入，被拒的这次没有留下任何东西
      expect(versions).toHaveLength(2);
      const chapter = db.getChapterRepository().getById(PROJECT_ID, seeded.chapterId)!;
      const current = db
        .getChapterVersionRepository()
        .getById(PROJECT_ID, seeded.chapterId, chapter.currentVersionId!)!;
      expect(current.content).toBe('别处写入的正文。');
    } finally {
      db.close();
    }
  });

  it('导出 TXT / Markdown：按稿件顺序、跳过空章', () => {
    seedManuscript();
    const txt = dispatchManuscriptCommand(
      'manuscript.export',
      { projectId: PROJECT_ID, format: 'txt' },
      ctx(),
    ) as ManuscriptExportPayload;
    expect(txt.fileName).toBe('位面客栈.txt');
    expect(txt.chapterCount).toBe(1);
    expect(txt.content).toContain('第一章 远客');

    const md = dispatchManuscriptCommand(
      'manuscript.export',
      { projectId: PROJECT_ID, format: 'markdown' },
      ctx(),
    ) as ManuscriptExportPayload;
    expect(md.fileName).toBe('位面客栈.md');
    expect(md.content.startsWith('# 位面客栈')).toBe(true);
  });

  it('稿件为空 / 无正文 → 导出明确拒绝（不产出空文件）', () => {
    const db = openDb();
    db.getProjectMetadataRepository().create({
      id: PROJECT_ID,
      name: 'p',
      initialIdea: 'i',
      status: 'ACTIVE',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.close();
    expect(() =>
      dispatchManuscriptCommand(
        'manuscript.export',
        { projectId: PROJECT_ID, format: 'txt' },
        ctx(),
      ),
    ).toThrow(AppError);
  });

  it('未知命令 / 非法输入一律拒绝', () => {
    seedManuscript();
    expect(() => dispatchManuscriptCommand('manuscript.unknown', {}, ctx())).toThrow(AppError);
    expect(() => dispatchManuscriptCommand('manuscript.getChapter', {}, ctx())).toThrow(AppError);
    expect(() =>
      dispatchManuscriptCommand(
        'manuscript.saveChapter',
        {
          projectId: PROJECT_ID,
          chapterId: 'ch-1',
          title: '   ',
          content: '正文',
          expectedCurrentVersionId: null,
        },
        ctx(),
      ),
    ).toThrow(AppError);
  });

  it('版本历史：按版本号倒序、标注来源与当前版；恢复只移动指针不删版本（TD-033-2）', () => {
    const seeded = seedManuscript();
    const saved = dispatchManuscriptCommand(
      'manuscript.saveChapter',
      {
        projectId: PROJECT_ID,
        chapterId: seeded.chapterId,
        title: '第一章 远客',
        content: '第二版正文。',
        expectedCurrentVersionId: seeded.versionId,
      },
      ctx(),
    ) as ManuscriptChapterDetailDto;

    const versions = dispatchManuscriptCommand(
      'manuscript.listVersions',
      { projectId: PROJECT_ID, chapterId: seeded.chapterId },
      ctx(),
    ) as ReadonlyArray<{
      versionId: string;
      versionNumber: number;
      source: string;
      isCurrent: boolean;
    }>;
    expect(versions).toHaveLength(2);
    expect(versions[0]!.versionNumber).toBe(2);
    expect(versions[0]!.isCurrent).toBe(true);
    expect(versions.every((v) => v.source === 'USER')).toBe(true);

    // 恢复到第 1 版
    const restored = dispatchManuscriptCommand(
      'manuscript.restoreVersion',
      {
        projectId: PROJECT_ID,
        chapterId: seeded.chapterId,
        versionId: seeded.versionId,
        expectedCurrentVersionId: saved.currentVersionId,
      },
      ctx(),
    ) as ManuscriptChapterDetailDto;
    expect(restored.currentVersionId).toBe(seeded.versionId);
    expect(restored.content).toBe('雨砸在屋檐上。\n小满擦干酒杯。');
    // 两版都还在（恢复不删除任何版本）
    expect(restored.versionCount).toBe(2);

    // 过期基线恢复被拒
    expect(() =>
      dispatchManuscriptCommand(
        'manuscript.restoreVersion',
        {
          projectId: PROJECT_ID,
          chapterId: seeded.chapterId,
          versionId: saved.currentVersionId,
          expectedCurrentVersionId: saved.currentVersionId,
        },
        ctx(),
      ),
    ).toThrow();
  });
});
