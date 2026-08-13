/**
 * 稿件工作区 RPC 处理器（GE-7）。
 *
 * - `manuscript.getWorkspace`：稿件标题 + 章节列表（含字数与蓝图章节归属）；
 * - `manuscript.getChapter`：单章正文 + **CAS 基线**（currentVersionId）；
 * - `manuscript.saveChapter`：追加新版本（sourceType=USER）+ CAS 拒绝覆盖；
 * - `manuscript.export`：按稿件顺序渲染 TXT / Markdown 正文（落盘在 main）。
 *
 * 纪律：稿件写入只有两条路——MANUSCRIPT_COMMIT（AI 产出，经用户接受）与本文件的
 * `saveChapter`（用户手写）。两条都走 `createChapterVersion` 的 CAS + append-only，
 * 任何一条都不会删除既有版本（锁定不变量"不静默覆盖用户正文"）。
 */

import { AppError, createChapterVersion, listChapters } from '@ai-novel/application';
import type { ManuscriptQueryDeps } from '@ai-novel/application';
import type { ChapterSummary } from '@ai-novel/contracts';
import type { ProjectDatabase } from '@ai-novel/database';
import { sha256Utf8 } from '@ai-novel/database';
import {
  isValidExportManuscriptInput,
  isValidGetManuscriptChapterInput,
  isValidGetManuscriptWorkspaceInput,
  isValidSaveManuscriptChapterInput,
} from '@ai-novel/contracts';
import type {
  ExportManuscriptInputDto,
  ManuscriptChapterDetailDto,
  ManuscriptChapterSummaryDto,
  ManuscriptWorkspaceDto,
  SaveManuscriptChapterInputDto,
} from '@ai-novel/contracts';
import { renderManuscript, suggestedExportFileName } from '@ai-novel/import-export';

export interface ManuscriptHandlerContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: { generate(): string };
  clock: { now(): string };
}

/** 内部：worker 内部使用的导出结果（main 负责落盘） */
export interface ManuscriptExportPayload {
  readonly fileName: string;
  readonly content: string;
  readonly chapterCount: number;
}

function withDb<T>(
  ctx: ManuscriptHandlerContext,
  projectId: string,
  fn: (projDb: ProjectDatabase) => T,
): T {
  const projDb = ctx.getProjectDb(projectId);
  try {
    return fn(projDb);
  } finally {
    projDb.close();
  }
}

function mutationDeps(projDb: ProjectDatabase) {
  return {
    transactionPort: projDb.getManuscriptTransaction(),
    sha256Port: { digestUtf8: (input: string) => sha256Utf8(input) },
  };
}

/**
 * 只读查询依赖：直接用 ProjectDatabase 暴露的三个仓库实现
 * （它们与事务内的是同一批实现类，只是不包在 BEGIN IMMEDIATE 里——
 * 读路径不需要写事务，也不该占用写锁）。
 */
function queryDeps(projDb: ProjectDatabase): ManuscriptQueryDeps {
  return {
    manuscriptRepo: projDb.getManuscriptRepository(),
    chapterRepo: projDb.getChapterRepository(),
    chapterVersionRepo: projDb.getChapterVersionRepository(),
  } as unknown as ManuscriptQueryDeps;
}

/** 去掉空白后的字符数（中文按字计；用于"这一章写了多少字"的直觉展示） */
export function countWords(content: string): number {
  return [...content.replace(/\s+/g, '')].length;
}

function chapterTitleOf(
  projDb: ProjectDatabase,
  projectId: string,
  chapter: ChapterSummary,
): { readonly title: string; readonly content: string } {
  if (chapter.currentVersionId === null) return { title: '（空章节）', content: '' };
  const version = projDb
    .getChapterVersionRepository()
    .getById(projectId, chapter.id, chapter.currentVersionId);
  if (!version) return { title: '（空章节）', content: '' };
  return { title: version.title, content: version.content };
}

export function getManuscriptWorkspace(
  ctx: ManuscriptHandlerContext,
  projectId: string,
): ManuscriptWorkspaceDto {
  return withDb(ctx, projectId, (projDb) => {
    const deps = queryDeps(projDb);
    const manuscript = deps.manuscriptRepo.getActiveByProject(projectId);
    if (!manuscript) return { manuscriptId: null, title: '', chapters: [] };
    const chapters = listChapters(deps, { projectId, manuscriptId: manuscript.id });
    const links = projDb.getManuscriptChapterLinkRepository().listByProject(projectId);
    const blueprintByChapter = new Map(links.map((l) => [l.chapterId, l.blueprintChapterId]));
    const summaries: ManuscriptChapterSummaryDto[] = chapters.map((chapter) => {
      const { title, content } = chapterTitleOf(projDb, projectId, chapter);
      return {
        chapterId: chapter.id,
        title,
        position: chapter.position,
        currentVersionId: chapter.currentVersionId,
        wordCount: countWords(content),
        blueprintChapterId: blueprintByChapter.get(chapter.id) ?? null,
      };
    });
    return { manuscriptId: manuscript.id, title: manuscript.title, chapters: summaries };
  });
}

export function getManuscriptChapter(
  ctx: ManuscriptHandlerContext,
  projectId: string,
  chapterId: string,
): ManuscriptChapterDetailDto | null {
  return withDb(ctx, projectId, (projDb) => {
    const deps = queryDeps(projDb);
    const chapter = deps.chapterRepo.getById(projectId, chapterId);
    if (!chapter) return null;
    const version =
      chapter.currentVersionId === null
        ? null
        : deps.chapterVersionRepo.getById(projectId, chapterId, chapter.currentVersionId);
    return {
      chapterId,
      title: version?.title ?? '（空章节）',
      content: version?.content ?? '',
      currentVersionId: chapter.currentVersionId,
      versionNumber: version?.versionNumber ?? null,
      versionCount: deps.chapterVersionRepo.countByChapter(projectId, chapterId),
    };
  });
}

export function saveManuscriptChapter(
  ctx: ManuscriptHandlerContext,
  input: SaveManuscriptChapterInputDto,
): ManuscriptChapterDetailDto {
  return withDb(ctx, input.projectId, (projDb) => {
    // CAS 由 createChapterVersion 内部执行（expectedCurrentVersionId 不匹配即抛
    // ManuscriptVersionConflictError）——这是"不静默覆盖"的实现点，不要在这里
    // 提前读一次再比，那样反而多一个 TOCTOU 窗口。
    createChapterVersion(mutationDeps(projDb), {
      projectId: input.projectId,
      chapterId: input.chapterId,
      newVersionId: ctx.idGenerator.generate(),
      title: input.title,
      content: input.content,
      expectedCurrentVersionId: input.expectedCurrentVersionId,
      sourceType: 'USER',
      now: ctx.clock.now(),
    });
    const detail = getManuscriptChapterInternal(projDb, input.projectId, input.chapterId);
    if (!detail) throw new AppError('VALIDATION_ERROR', '章节不存在');
    return detail;
  });
}

function getManuscriptChapterInternal(
  projDb: ProjectDatabase,
  projectId: string,
  chapterId: string,
): ManuscriptChapterDetailDto | null {
  const deps = queryDeps(projDb);
  const chapter = deps.chapterRepo.getById(projectId, chapterId);
  if (!chapter) return null;
  const version =
    chapter.currentVersionId === null
      ? null
      : deps.chapterVersionRepo.getById(projectId, chapterId, chapter.currentVersionId);
  return {
    chapterId,
    title: version?.title ?? '（空章节）',
    content: version?.content ?? '',
    currentVersionId: chapter.currentVersionId,
    versionNumber: version?.versionNumber ?? null,
    versionCount: deps.chapterVersionRepo.countByChapter(projectId, chapterId),
  };
}

/** 导出正文（落盘在 main；worker 只负责按稿件顺序渲染） */
export function exportManuscript(
  ctx: ManuscriptHandlerContext,
  input: ExportManuscriptInputDto,
): ManuscriptExportPayload {
  return withDb(ctx, input.projectId, (projDb) => {
    const deps = queryDeps(projDb);
    const manuscript = deps.manuscriptRepo.getActiveByProject(input.projectId);
    if (!manuscript) {
      throw new AppError('VALIDATION_ERROR', '还没有稿件可以导出');
    }
    const chapters = listChapters(deps, {
      projectId: input.projectId,
      manuscriptId: manuscript.id,
    });
    const exportChapters = chapters
      .map((chapter) => chapterTitleOf(projDb, input.projectId, chapter))
      .filter((c) => c.content.trim().length > 0);
    if (exportChapters.length === 0) {
      throw new AppError('VALIDATION_ERROR', '稿件里还没有正文');
    }
    return {
      fileName: suggestedExportFileName(manuscript.title, input.format),
      content: renderManuscript(input.format, {
        manuscriptTitle: manuscript.title,
        chapters: exportChapters,
      }),
      chapterCount: exportChapters.length,
    };
  });
}

export function dispatchManuscriptCommand(
  command: string,
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): unknown {
  switch (command) {
    case 'manuscript.getWorkspace': {
      if (!isValidGetManuscriptWorkspaceInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 manuscript.getWorkspace 输入');
      }
      return getManuscriptWorkspace(ctx, payload.projectId);
    }
    case 'manuscript.getChapter': {
      if (!isValidGetManuscriptChapterInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 manuscript.getChapter 输入');
      }
      return getManuscriptChapter(ctx, payload.projectId, payload.chapterId);
    }
    case 'manuscript.saveChapter': {
      if (!isValidSaveManuscriptChapterInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 manuscript.saveChapter 输入');
      }
      return saveManuscriptChapter(ctx, payload);
    }
    case 'manuscript.export': {
      if (!isValidExportManuscriptInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 manuscript.export 输入');
      }
      return exportManuscript(ctx, payload);
    }
    default:
      throw new AppError('VALIDATION_ERROR', `未知稿件命令: ${command}`);
  }
}
