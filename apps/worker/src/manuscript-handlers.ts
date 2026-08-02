/**
 * 稿件 RPC 处理器（Minimal Manuscript Renderer，MV1-B）。
 *
 * 严格 payload 验证 → 打开 ProjectDatabase → 构造 repositories/adapters →
 * 注入 IdGenerator/Clock/Sha256Port → 调用 Application use case → DTO mapping →
 * 关闭 DB → 安全错误映射。与创作契约处理器同构（contract-handlers.ts）。
 *
 * Renderer/API caller 不得生成持久化 ID、时间戳或 sourceType：
 * - getOrCreateManuscript：newManuscriptId、now 由 Worker 注入；
 * - createChapter：newChapterId、now 由 Worker 注入；
 * - createChapterVersion：newVersionId、now、sourceType（用户保存固定 'USER'）由 Worker 注入；
 * - promote/order/archive/restore/title：now 由 Worker 注入。
 *
 * 全部 query 限定在当前 project（复合主键 + 应用层 projectId 校验）；
 * 跨 project 与 not-found 统一安全 NOT_FOUND（不泄露存在性）。
 */

import {
  isValidGetOrCreateManuscriptInput,
  isValidGetManuscriptInput,
  isValidListChaptersInput,
  isValidGetChapterInput,
  isValidGetCurrentChapterVersionInput,
  isValidListChapterVersionsInput,
  isValidGetChapterVersionInput,
  isValidCreateChapterInput,
  isValidCreateChapterVersionInput,
  isValidPromoteChapterVersionInput,
  isValidUpdateChapterOrderInput,
  isValidArchiveChapterInput,
  isValidRestoreChapterInput,
  isValidUpdateManuscriptTitleInput,
  type ManuscriptPublicData,
  type ChapterSummary,
  type ChapterPublicData,
  type ChapterVersionSummary,
  type ChapterVersionPublicData,
} from '@ai-novel/contracts';
import {
  AppError,
  getManuscript,
  listChapters,
  getChapter,
  getCurrentChapterVersion,
  listChapterVersions,
  getChapterVersion,
  getOrCreateManuscript,
  createChapter,
  createChapterVersion,
  promoteChapterVersion,
  updateChapterOrder,
  archiveChapter,
  restoreChapter,
  updateManuscriptTitle,
  type ManuscriptQueryDeps,
  type ManuscriptMutationDeps,
  type IdGenerator,
  type Clock,
} from '@ai-novel/application';
import type { ProjectDatabase } from '@ai-novel/database';
import { ManuscriptTransactionPortImpl, sha256Utf8 } from '@ai-novel/database';

// ── 上下文 ────────────────────────────────────────────────────────

export interface ManuscriptHandlerContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: IdGenerator;
  clock: Clock;
}

// ── Deps 构建 ─────────────────────────────────────────────────────

function buildQueryDeps(projDb: ProjectDatabase): ManuscriptQueryDeps {
  return {
    manuscriptRepo: projDb.getManuscriptRepository(),
    chapterRepo: projDb.getChapterRepository(),
    chapterVersionRepo: projDb.getChapterVersionRepository(),
  };
}

function buildMutationDeps(projDb: ProjectDatabase): ManuscriptMutationDeps {
  return {
    transactionPort: new ManuscriptTransactionPortImpl(projDb.database),
    sha256Port: { digestUtf8: (input: string) => sha256Utf8(input) },
  };
}

// ── 读取处理器 ─────────────────────────────────────────────────────

function handleGetOrCreateManuscript(
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): ManuscriptPublicData {
  if (!isValidGetOrCreateManuscriptInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的稿件创建输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return getOrCreateManuscript(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      title: payload.title,
      now: ctx.clock.now(),
      newManuscriptId: ctx.idGenerator.generate(),
    });
  } finally {
    projDb.close();
  }
}

function handleGetManuscript(
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): ManuscriptPublicData {
  if (!isValidGetManuscriptInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的稿件查询输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return getManuscript(buildQueryDeps(projDb), {
      projectId: payload.projectId,
      manuscriptId: payload.manuscriptId,
    });
  } finally {
    projDb.close();
  }
}

function handleListChapters(
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): ReadonlyArray<ChapterSummary> {
  if (!isValidListChaptersInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的章节列表输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return listChapters(buildQueryDeps(projDb), {
      projectId: payload.projectId,
      manuscriptId: payload.manuscriptId,
      includeArchived: payload.includeArchived,
    });
  } finally {
    projDb.close();
  }
}

function handleGetChapter(payload: unknown, ctx: ManuscriptHandlerContext): ChapterPublicData {
  if (!isValidGetChapterInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的章节查询输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return getChapter(buildQueryDeps(projDb), {
      projectId: payload.projectId,
      manuscriptId: payload.manuscriptId,
      chapterId: payload.chapterId,
    });
  } finally {
    projDb.close();
  }
}

function handleGetCurrentChapterVersion(
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): ChapterVersionPublicData | null {
  if (!isValidGetCurrentChapterVersionInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的当前版本查询输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return getCurrentChapterVersion(buildQueryDeps(projDb), {
      projectId: payload.projectId,
      chapterId: payload.chapterId,
    });
  } finally {
    projDb.close();
  }
}

function handleListChapterVersions(
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): ReadonlyArray<ChapterVersionSummary> {
  if (!isValidListChapterVersionsInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的版本历史输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return listChapterVersions(buildQueryDeps(projDb), {
      projectId: payload.projectId,
      chapterId: payload.chapterId,
    });
  } finally {
    projDb.close();
  }
}

function handleGetChapterVersion(
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): ChapterVersionPublicData {
  if (!isValidGetChapterVersionInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的版本查询输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return getChapterVersion(buildQueryDeps(projDb), {
      projectId: payload.projectId,
      chapterId: payload.chapterId,
      versionId: payload.versionId,
    });
  } finally {
    projDb.close();
  }
}

// ── 写入处理器 ─────────────────────────────────────────────────────

function handleCreateChapter(payload: unknown, ctx: ManuscriptHandlerContext): ChapterPublicData {
  if (!isValidCreateChapterInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的创建章节输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return createChapter(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      manuscriptId: payload.manuscriptId,
      insertBeforeChapterId: payload.insertBeforeChapterId,
      now: ctx.clock.now(),
      newChapterId: ctx.idGenerator.generate(),
    });
  } finally {
    projDb.close();
  }
}

function handleCreateChapterVersion(
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): ChapterVersionPublicData {
  if (!isValidCreateChapterVersionInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的保存版本输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return createChapterVersion(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      chapterId: payload.chapterId,
      title: payload.title,
      content: payload.content,
      expectedCurrentVersionId: payload.expectedCurrentVersionId,
      creationContractVersionId: payload.creationContractVersionId ?? null,
      now: ctx.clock.now(),
      newVersionId: ctx.idGenerator.generate(),
      sourceType: 'USER',
    });
  } finally {
    projDb.close();
  }
}

function handlePromoteChapterVersion(
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): ChapterVersionPublicData {
  if (!isValidPromoteChapterVersionInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的切换版本输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return promoteChapterVersion(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      chapterId: payload.chapterId,
      versionId: payload.versionId,
      expectedCurrentVersionId: payload.expectedCurrentVersionId,
      now: ctx.clock.now(),
    });
  } finally {
    projDb.close();
  }
}

function handleUpdateChapterOrder(
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): ReadonlyArray<ChapterSummary> {
  if (!isValidUpdateChapterOrderInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的重排输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return updateChapterOrder(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      manuscriptId: payload.manuscriptId,
      chapterId: payload.chapterId,
      insertBeforeChapterId: payload.insertBeforeChapterId,
      now: ctx.clock.now(),
    });
  } finally {
    projDb.close();
  }
}

function handleArchiveChapter(payload: unknown, ctx: ManuscriptHandlerContext): ChapterPublicData {
  if (!isValidArchiveChapterInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的归档章节输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return archiveChapter(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      chapterId: payload.chapterId,
      expectedCurrentVersionId: payload.expectedCurrentVersionId,
      now: ctx.clock.now(),
    });
  } finally {
    projDb.close();
  }
}

function handleRestoreChapter(payload: unknown, ctx: ManuscriptHandlerContext): ChapterPublicData {
  if (!isValidRestoreChapterInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的恢复章节输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return restoreChapter(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      chapterId: payload.chapterId,
      expectedCurrentVersionId: payload.expectedCurrentVersionId,
      now: ctx.clock.now(),
    });
  } finally {
    projDb.close();
  }
}

function handleUpdateManuscriptTitle(
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): ManuscriptPublicData {
  if (!isValidUpdateManuscriptTitleInput(payload)) {
    throw new AppError('VALIDATION_ERROR', '无效的稿件标题输入');
  }
  const projDb = ctx.getProjectDb(payload.projectId);
  try {
    return updateManuscriptTitle(buildMutationDeps(projDb), {
      projectId: payload.projectId,
      manuscriptId: payload.manuscriptId,
      title: payload.title,
      expectedUpdatedAt: payload.expectedUpdatedAt,
      now: ctx.clock.now(),
    });
  } finally {
    projDb.close();
  }
}

// ── 分发 ──────────────────────────────────────────────────────────

export function dispatchManuscriptCommand(
  command: string,
  payload: unknown,
  ctx: ManuscriptHandlerContext,
): unknown {
  switch (command) {
    case 'manuscript.getOrCreateManuscript':
      return handleGetOrCreateManuscript(payload, ctx);
    case 'manuscript.getManuscript':
      return handleGetManuscript(payload, ctx);
    case 'manuscript.listChapters':
      return handleListChapters(payload, ctx);
    case 'manuscript.getChapter':
      return handleGetChapter(payload, ctx);
    case 'manuscript.getCurrentChapterVersion':
      return handleGetCurrentChapterVersion(payload, ctx);
    case 'manuscript.listChapterVersions':
      return handleListChapterVersions(payload, ctx);
    case 'manuscript.getChapterVersion':
      return handleGetChapterVersion(payload, ctx);
    case 'manuscript.createChapter':
      return handleCreateChapter(payload, ctx);
    case 'manuscript.createChapterVersion':
      return handleCreateChapterVersion(payload, ctx);
    case 'manuscript.promoteChapterVersion':
      return handlePromoteChapterVersion(payload, ctx);
    case 'manuscript.updateChapterOrder':
      return handleUpdateChapterOrder(payload, ctx);
    case 'manuscript.archiveChapter':
      return handleArchiveChapter(payload, ctx);
    case 'manuscript.restoreChapter':
      return handleRestoreChapter(payload, ctx);
    case 'manuscript.updateManuscriptTitle':
      return handleUpdateManuscriptTitle(payload, ctx);
    default:
      throw new AppError('VALIDATION_ERROR', `未知命令: ${command}`);
  }
}
