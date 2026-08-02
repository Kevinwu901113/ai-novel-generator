/**
 * 稿件 / 章节 / 章节版本 DTO 转换与共享验证。
 *
 * 由读取用例（manuscript.ts）与 mutation 用例（manuscript-mutations.ts）共用，
 * 避免两套会漂移的转换器。权威规格：manuscript-version-design.md §7。
 */

import {
  isValidChapterStatus,
  isValidManuscriptStatus,
  isValidChapterVersionSourceType,
  validateManuscriptTitle,
  validateChapterContent,
  MANUSCRIPT_DEFAULT_TITLE,
  type ManuscriptStatus,
  type ChapterStatus,
  type ChapterVersionSourceType,
} from '@ai-novel/domain';
import type {
  ManuscriptPublicData,
  ChapterSummary,
  ChapterPublicData,
  ChapterVersionSummary,
  ChapterVersionPublicData,
} from '@ai-novel/contracts';
import { ValidationError } from './errors.js';
import { validateIso8601Timestamp } from './creation-contract-validation.js';
import type {
  ManuscriptData,
  ChapterData,
  ChapterVersionData,
  ChapterVersionSummaryData,
  ChapterVersionRepositoryPort,
} from './manuscript-types.js';

// ── 转换 ──────────────────────────────────────────────────

export function manuscriptToPublicData(m: ManuscriptData): ManuscriptPublicData {
  return {
    id: m.id,
    projectId: m.projectId,
    title: m.title,
    status: m.status as ManuscriptStatus,
    creationContractVersionId: m.creationContractVersionId,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export function chapterVersionToPublicData(v: ChapterVersionData): ChapterVersionPublicData {
  return {
    id: v.id,
    projectId: v.projectId,
    chapterId: v.chapterId,
    versionNumber: v.versionNumber,
    title: v.title,
    content: v.content,
    contentHash: v.contentHash,
    parentVersionId: v.parentVersionId,
    sourceType: v.sourceType as ChapterVersionSourceType,
    createdByTaskId: v.createdByTaskId,
    invocationId: v.invocationId,
    creationContractVersionId: v.creationContractVersionId,
    createdAt: v.createdAt,
  };
}

export function chapterVersionSummaryToPublicData(
  v: ChapterVersionSummaryData,
): ChapterVersionSummary {
  return {
    id: v.id,
    chapterId: v.chapterId,
    versionNumber: v.versionNumber,
    title: v.title,
    sourceType: v.sourceType as ChapterVersionSourceType,
    createdAt: v.createdAt,
    parentVersionId: v.parentVersionId,
    creationContractVersionId: v.creationContractVersionId,
    contentHash: v.contentHash,
  };
}

/** 当前版本摘要读取端口（count + title） */
export type ChapterVersionReadPort = Pick<
  ChapterVersionRepositoryPort,
  'countByChapter' | 'getSummaryById'
>;

/** 把完整版本仓库端口适配为摘要读取端口（read / mutation 共用） */
export function chapterVersionPortFrom(repo: ChapterVersionRepositoryPort): ChapterVersionReadPort {
  return {
    countByChapter: (projectId, chapterId) => repo.countByChapter(projectId, chapterId),
    getSummaryById: (projectId, chapterId, id) => repo.getSummaryById(projectId, chapterId, id),
  };
}

export function chapterToSummary(
  versionPort: ChapterVersionReadPort,
  c: ChapterData,
): ChapterSummary {
  const versionCount = versionPort.countByChapter(c.projectId, c.id);
  const currentTitle =
    c.currentVersionId !== null
      ? (versionPort.getSummaryById(c.projectId, c.id, c.currentVersionId)?.title ?? null)
      : null;
  return {
    id: c.id,
    projectId: c.projectId,
    manuscriptId: c.manuscriptId,
    position: c.position,
    currentVersionId: c.currentVersionId,
    status: c.status as ChapterStatus,
    currentTitle,
    versionCount,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function chapterToPublicData(
  versionPort: ChapterVersionReadPort,
  c: ChapterData,
): ChapterPublicData {
  const versionCount = versionPort.countByChapter(c.projectId, c.id);
  const currentVersion =
    c.currentVersionId !== null
      ? versionPort.getSummaryById(c.projectId, c.id, c.currentVersionId)
      : null;
  return {
    id: c.id,
    projectId: c.projectId,
    manuscriptId: c.manuscriptId,
    position: c.position,
    currentVersionId: c.currentVersionId,
    status: c.status as ChapterStatus,
    currentVersion: currentVersion ? chapterVersionSummaryToPublicData(currentVersion) : null,
    versionCount,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ── 共享验证 ──────────────────────────────────────────────────

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${label} 必须是非空字符串`);
  }
  return value;
}

export function requireNullableId(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireNonEmptyString(value, label);
}

export function requireSafePositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(`${label} 必须是正安全整数`);
  }
  return value;
}

export function requireTitle(value: unknown, label: string): string {
  try {
    return validateManuscriptTitle(value);
  } catch (e) {
    throw new ValidationError(`${label} 无效：${e instanceof Error ? e.message : String(e)}`);
  }
}

export function requireContent(value: unknown, label: string): string {
  try {
    return validateChapterContent(value);
  } catch (e) {
    throw new ValidationError(`${label} 无效：${e instanceof Error ? e.message : String(e)}`);
  }
}

export function requireIsoTimestamp(value: unknown, label: string): string {
  return validateIso8601Timestamp(value, label);
}

export function defaultTitle(title: string | undefined): string {
  if (title === undefined) return MANUSCRIPT_DEFAULT_TITLE;
  return requireTitle(title, 'title');
}

/** 校验枚举值并返回类型化值 */
export function requireManuscriptStatus(value: unknown): ManuscriptStatus {
  if (!isValidManuscriptStatus(value)) {
    throw new ValidationError('manuscript status 无效');
  }
  return value;
}

export function requireChapterStatus(value: unknown): ChapterStatus {
  if (!isValidChapterStatus(value)) {
    throw new ValidationError('chapter status 无效');
  }
  return value;
}

export function requireSourceType(value: unknown): ChapterVersionSourceType {
  if (!isValidChapterVersionSourceType(value)) {
    throw new ValidationError('sourceType 无效');
  }
  return value;
}
