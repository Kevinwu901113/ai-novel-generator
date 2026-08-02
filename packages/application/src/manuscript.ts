/**
 * 稿件读取用例（§7.1）。
 *
 * 全部返回确定排序（不变量 16）：chapters 按 position ASC, id ASC；
 * versions 按 version_number DESC, id ASC。跨 project / not-found 统一
 * NOT_FOUND，不泄露存在性（§7）。
 */

import type {
  ManuscriptPublicData,
  ChapterSummary,
  ChapterPublicData,
  ChapterVersionSummary,
  ChapterVersionPublicData,
} from '@ai-novel/contracts';
import type {
  ManuscriptRepositoryPort,
  ChapterRepositoryPort,
  ChapterVersionRepositoryPort,
} from './manuscript-types.js';
import {
  ManuscriptNotFoundError,
  ChapterNotFoundError,
  ChapterVersionNotFoundError,
  ContractDataCorruptionError,
} from './errors.js';
import {
  manuscriptToPublicData,
  chapterToSummary,
  chapterToPublicData,
  chapterVersionToPublicData,
  chapterVersionSummaryToPublicData,
  chapterVersionPortFrom,
  requireNonEmptyString,
} from './manuscript-conversion.js';

// ── 依赖 ──────────────────────────────────────────────────

export interface ManuscriptQueryDeps {
  readonly manuscriptRepo: ManuscriptRepositoryPort;
  readonly chapterRepo: ChapterRepositoryPort;
  readonly chapterVersionRepo: ChapterVersionRepositoryPort;
}

const versionReadPort = (deps: ManuscriptQueryDeps) =>
  chapterVersionPortFrom(deps.chapterVersionRepo);

// ── 输入验证 ──────────────────────────────────────────────────

interface IdInput {
  readonly projectId: string;
  readonly manuscriptId?: string;
  readonly chapterId?: string;
  readonly versionId?: string;
}

function validateReadInput(input: IdInput): void {
  requireNonEmptyString(input.projectId, 'projectId');
  if (input.manuscriptId !== undefined) {
    requireNonEmptyString(input.manuscriptId, 'manuscriptId');
  }
  if (input.chapterId !== undefined) {
    requireNonEmptyString(input.chapterId, 'chapterId');
  }
  if (input.versionId !== undefined) {
    requireNonEmptyString(input.versionId, 'versionId');
  }
}

// ── GetManuscript ──────────────────────────────────────────

export interface GetManuscriptInput {
  readonly projectId: string;
  readonly manuscriptId: string;
}

export function getManuscript(
  deps: ManuscriptQueryDeps,
  input: GetManuscriptInput,
): ManuscriptPublicData {
  validateReadInput(input);
  const manuscript = deps.manuscriptRepo.getById(input.projectId, input.manuscriptId);
  if (!manuscript) {
    throw new ManuscriptNotFoundError();
  }
  return manuscriptToPublicData(manuscript);
}

// ── ListChapters ──────────────────────────────────────────

export interface ListChaptersInput {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly includeArchived?: boolean;
}

export function listChapters(
  deps: ManuscriptQueryDeps,
  input: ListChaptersInput,
): ReadonlyArray<ChapterSummary> {
  validateReadInput(input);
  const manuscript = deps.manuscriptRepo.getById(input.projectId, input.manuscriptId);
  if (!manuscript) {
    throw new ManuscriptNotFoundError();
  }
  const all = deps.chapterRepo.listByManuscript(input.projectId, input.manuscriptId);
  const includeArchived = input.includeArchived === true;
  const rows = includeArchived ? all : all.filter((c) => c.status === 'active');
  const port = versionReadPort(deps);
  return rows.map((c) => chapterToSummary(port, c));
}

// ── GetChapter ─────────────────────────────────────────────

export interface GetChapterInput {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly chapterId: string;
}

export function getChapter(deps: ManuscriptQueryDeps, input: GetChapterInput): ChapterPublicData {
  validateReadInput(input);
  const manuscript = deps.manuscriptRepo.getById(input.projectId, input.manuscriptId);
  if (!manuscript) {
    throw new ManuscriptNotFoundError();
  }
  const chapter = deps.chapterRepo.getById(input.projectId, input.chapterId);
  if (!chapter || chapter.manuscriptId !== input.manuscriptId) {
    throw new ChapterNotFoundError();
  }
  return chapterToPublicData(versionReadPort(deps), chapter);
}

// ── GetCurrentChapterVersion ───────────────────────────────

export interface GetCurrentChapterVersionInput {
  readonly projectId: string;
  readonly chapterId: string;
}

export function getCurrentChapterVersion(
  deps: ManuscriptQueryDeps,
  input: GetCurrentChapterVersionInput,
): ChapterVersionPublicData | null {
  validateReadInput(input);
  const chapter = deps.chapterRepo.getById(input.projectId, input.chapterId);
  if (!chapter) {
    throw new ChapterNotFoundError();
  }
  if (chapter.currentVersionId === null) {
    return null;
  }
  const version = deps.chapterVersionRepo.getById(
    input.projectId,
    input.chapterId,
    chapter.currentVersionId,
  );
  if (!version) {
    throw new ContractDataCorruptionError(
      `current pointer 引用不存在的版本: projectId=${input.projectId}, chapterId=${input.chapterId}, versionId=${chapter.currentVersionId}`,
    );
  }
  return chapterVersionToPublicData(version);
}

// ── ListChapterVersions ────────────────────────────────────

export interface ListChapterVersionsInput {
  readonly projectId: string;
  readonly chapterId: string;
}

export function listChapterVersions(
  deps: ManuscriptQueryDeps,
  input: ListChapterVersionsInput,
): ReadonlyArray<ChapterVersionSummary> {
  validateReadInput(input);
  const chapter = deps.chapterRepo.getById(input.projectId, input.chapterId);
  if (!chapter) {
    throw new ChapterNotFoundError();
  }
  const versions = deps.chapterVersionRepo.listSummariesByChapter(input.projectId, input.chapterId);
  return versions.map((v) => chapterVersionSummaryToPublicData(v));
}

// ── GetChapterVersion ──────────────────────────────────────

export interface GetChapterVersionInput {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
}

export function getChapterVersion(
  deps: ManuscriptQueryDeps,
  input: GetChapterVersionInput,
): ChapterVersionPublicData {
  validateReadInput(input);
  const chapter = deps.chapterRepo.getById(input.projectId, input.chapterId);
  if (!chapter) {
    throw new ChapterNotFoundError();
  }
  const version = deps.chapterVersionRepo.getById(
    input.projectId,
    input.chapterId,
    input.versionId,
  );
  if (!version) {
    throw new ChapterVersionNotFoundError();
  }
  return chapterVersionToPublicData(version);
}
