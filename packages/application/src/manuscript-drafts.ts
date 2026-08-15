/**
 * 章节草稿用例（TD-033-3：编辑无自动保存的后端草稿层）。
 *
 * autosave 写入独立的 chapter_drafts 层，绝不产生章节版本、绝不推进
 * currentVersionId。显式保存清除草稿的规则由 manuscript-mutations.ts 的
 * createChapterVersion 在同一事务内完成；读取时只报告草稿是否已 stale，
 * 不自动套用、不自动删除。
 */

import type { ChapterDraftDto } from '@ai-novel/contracts';
import type {
  ChapterDraftRepositoryPort,
  ChapterRepositoryPort,
  DiscardChapterDraftCommand,
  GetChapterDraftCommand,
  SaveChapterDraftCommand,
} from './manuscript-types.js';
import type { ManuscriptMutationDeps } from './manuscript-mutations.js';
import { ChapterNotFoundError } from './errors.js';
import {
  requireContent,
  requireIsoTimestamp,
  requireNonEmptyString,
  requireNullableId,
} from './manuscript-conversion.js';

export interface ChapterDraftQueryDeps {
  readonly chapterRepo: ChapterRepositoryPort;
  readonly chapterDraftRepo: ChapterDraftRepositoryPort;
}

function validateSaveCommand(input: SaveChapterDraftCommand): void {
  requireNonEmptyString(input.projectId, 'projectId');
  requireNonEmptyString(input.chapterId, 'chapterId');
  requireContent(input.content, 'content');
  requireNullableId(input.baseVersionId, 'baseVersionId');
  requireIsoTimestamp(input.now, 'now');
}

function validateChapterId(input: GetChapterDraftCommand | DiscardChapterDraftCommand): void {
  requireNonEmptyString(input.projectId, 'projectId');
  requireNonEmptyString(input.chapterId, 'chapterId');
}

function requireChapter(
  chapterRepo: ChapterRepositoryPort,
  projectId: string,
  chapterId: string,
): void {
  if (!chapterRepo.getById(projectId, chapterId)) {
    throw new ChapterNotFoundError();
  }
}

/** 保存草稿（upsert）。不检查 baseVersionId 是否等于 current——stale 由读取时报告。 */
export function saveChapterDraft(
  deps: ManuscriptMutationDeps,
  input: SaveChapterDraftCommand,
): void {
  validateSaveCommand(input);
  deps.transactionPort.runInTransaction((repos) => {
    requireChapter(repos.chapterRepo, input.projectId, input.chapterId);
    repos.chapterDraftRepo.upsert({
      projectId: input.projectId,
      chapterId: input.chapterId,
      content: input.content,
      baseVersionId: input.baseVersionId,
      updatedAt: input.now,
    });
  });
}

/** 读取草稿。无草稿返回 null；stale 表示 currentVersionId 已偏离 baseVersionId。 */
export function getChapterDraft(
  deps: ChapterDraftQueryDeps,
  input: GetChapterDraftCommand,
): ChapterDraftDto | null {
  validateChapterId(input);
  const chapter = deps.chapterRepo.getById(input.projectId, input.chapterId);
  if (!chapter) {
    throw new ChapterNotFoundError();
  }
  const draft = deps.chapterDraftRepo.getByChapter(input.projectId, input.chapterId);
  if (!draft) {
    return null;
  }
  return {
    chapterId: draft.chapterId,
    content: draft.content,
    baseVersionId: draft.baseVersionId,
    currentVersionId: chapter.currentVersionId,
    stale: chapter.currentVersionId !== draft.baseVersionId,
    updatedAt: draft.updatedAt,
  };
}

/** 丢弃草稿。返回是否真的删除了草稿。 */
export function discardChapterDraft(
  deps: ManuscriptMutationDeps,
  input: DiscardChapterDraftCommand,
): boolean {
  validateChapterId(input);
  return deps.transactionPort.runInTransaction((repos) => {
    requireChapter(repos.chapterRepo, input.projectId, input.chapterId);
    return repos.chapterDraftRepo.deleteByChapter(input.projectId, input.chapterId);
  });
}
