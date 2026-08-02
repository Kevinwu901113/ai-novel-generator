/**
 * 稿件 / 章节 / 章节版本 mutation 用例（§7.2）。
 *
 * 全部写操作在单个 BEGIN IMMEDIATE 事务内完成（ManuscriptTransactionPort）。
 * Renderer 不传 ID / now / sourceType / taskId / invocationId —— 由 Worker 注入。
 * 权威规格：docs/development/manuscript-version-design.md（§6、§7、§11）。
 */

import type { ChapterVersionSourceType } from '@ai-novel/domain';
import type {
  ManuscriptPublicData,
  ChapterSummary,
  ChapterPublicData,
  ChapterVersionPublicData,
} from '@ai-novel/contracts';
import type { Sha256Port } from './creation-contract-types.js';
import type {
  ManuscriptTransactionPort,
  ManuscriptTransactionRepositories,
  GetOrCreateManuscriptCommand,
  CreateChapterCommand,
  CreateChapterVersionCommand,
  PromoteChapterVersionCommand,
  UpdateChapterOrderCommand,
  ArchiveChapterCommand,
  RestoreChapterCommand,
  UpdateManuscriptTitleCommand,
} from './manuscript-types.js';
import {
  ManuscriptNotFoundError,
  ManuscriptStateConflictError,
  ManuscriptVersionConflictError,
  ChapterNotFoundError,
  ChapterVersionNotFoundError,
  ContractDataCorruptionError,
  ValidationError,
} from './errors.js';
import {
  manuscriptToPublicData,
  chapterToPublicData,
  chapterToSummary,
  chapterVersionToPublicData,
  chapterVersionPortFrom,
  requireNonEmptyString,
  requireTitle,
  requireContent,
  requireIsoTimestamp,
  defaultTitle,
} from './manuscript-conversion.js';
import { requireSha256Digest } from './creation-contract-mutations.js';
import { computeTargetPosition, type PositionContext } from './manuscript-position.js';

// ── 依赖 ──────────────────────────────────────────────────

export interface ManuscriptMutationDeps {
  readonly transactionPort: ManuscriptTransactionPort;
  readonly sha256Port: Sha256Port;
}

// ── 输入验证 ──────────────────────────────────────────────────

function validateGetOrCreateCommand(input: GetOrCreateManuscriptCommand): void {
  requireNonEmptyString(input.projectId, 'projectId');
  requireNonEmptyString(input.newManuscriptId, 'newManuscriptId');
  requireIsoTimestamp(input.now, 'now');
  if (input.title !== undefined) requireTitle(input.title, 'title');
  if (input.creationContractVersionId !== undefined && input.creationContractVersionId !== null) {
    requireNonEmptyString(input.creationContractVersionId, 'creationContractVersionId');
  }
}

function validateCreateChapterCommand(input: CreateChapterCommand): void {
  requireNonEmptyString(input.projectId, 'projectId');
  requireNonEmptyString(input.manuscriptId, 'manuscriptId');
  requireNonEmptyString(input.newChapterId, 'newChapterId');
  requireIsoTimestamp(input.now, 'now');
  if (input.insertBeforeChapterId !== null) {
    requireNonEmptyString(input.insertBeforeChapterId, 'insertBeforeChapterId');
  }
}

function validateCreateChapterVersionCommand(input: CreateChapterVersionCommand): void {
  requireNonEmptyString(input.projectId, 'projectId');
  requireNonEmptyString(input.chapterId, 'chapterId');
  requireNonEmptyString(input.newVersionId, 'newVersionId');
  requireIsoTimestamp(input.now, 'now');
  requireTitle(input.title, 'title');
  requireContent(input.content, 'content');
  if (input.expectedCurrentVersionId !== null) {
    requireNonEmptyString(input.expectedCurrentVersionId, 'expectedCurrentVersionId');
  }
  if (input.creationContractVersionId !== undefined && input.creationContractVersionId !== null) {
    requireNonEmptyString(input.creationContractVersionId, 'creationContractVersionId');
  }
}

function validatePromoteCommand(input: PromoteChapterVersionCommand): void {
  requireNonEmptyString(input.projectId, 'projectId');
  requireNonEmptyString(input.chapterId, 'chapterId');
  requireNonEmptyString(input.versionId, 'versionId');
  requireIsoTimestamp(input.now, 'now');
  if (input.expectedCurrentVersionId !== null) {
    requireNonEmptyString(input.expectedCurrentVersionId, 'expectedCurrentVersionId');
  }
}

function validateUpdateOrderCommand(input: UpdateChapterOrderCommand): void {
  requireNonEmptyString(input.projectId, 'projectId');
  requireNonEmptyString(input.manuscriptId, 'manuscriptId');
  requireNonEmptyString(input.chapterId, 'chapterId');
  requireIsoTimestamp(input.now, 'now');
  if (input.insertBeforeChapterId !== null) {
    requireNonEmptyString(input.insertBeforeChapterId, 'insertBeforeChapterId');
  }
}

function validateArchiveRestoreCommand(input: ArchiveChapterCommand | RestoreChapterCommand): void {
  requireNonEmptyString(input.projectId, 'projectId');
  requireNonEmptyString(input.chapterId, 'chapterId');
  requireIsoTimestamp(input.now, 'now');
  if (input.expectedCurrentVersionId !== null) {
    requireNonEmptyString(input.expectedCurrentVersionId, 'expectedCurrentVersionId');
  }
}

function validateUpdateTitleCommand(input: UpdateManuscriptTitleCommand): void {
  requireNonEmptyString(input.projectId, 'projectId');
  requireNonEmptyString(input.manuscriptId, 'manuscriptId');
  requireTitle(input.title, 'title');
  requireIsoTimestamp(input.expectedUpdatedAt, 'expectedUpdatedAt');
  requireIsoTimestamp(input.now, 'now');
}

// ── provenance 一致性（§4.3 sourceType 规则，DB CHECK 兜底）────

function assertSourceTypeProvenance(
  sourceType: ChapterVersionSourceType,
  createdByTaskId: string | null,
  invocationId: string | null,
  creationContractVersionId: string | null,
): void {
  const isAi = sourceType === 'AI_GENERATION' || sourceType === 'AI_REWRITE';
  if (isAi) {
    if (createdByTaskId === null || invocationId === null || creationContractVersionId === null) {
      throw new ValidationError(
        'AI 来源版本必须提供 taskId / invocationId / creationContractVersionId',
      );
    }
  } else if (createdByTaskId !== null || invocationId !== null) {
    throw new ValidationError('非 AI 来源版本不得携带 taskId / invocationId');
  }
}

// ── 事务内上下文 ──────────────────────────────────────────

function makePositionContext(
  repos: ManuscriptTransactionRepositories,
  projectId: string,
  manuscriptId: string,
  now: string,
): PositionContext {
  return { projectId, manuscriptId, repos, now };
}

// ── GetOrCreateManuscript ──────────────────────────────────

export function getOrCreateManuscript(
  deps: ManuscriptMutationDeps,
  input: GetOrCreateManuscriptCommand,
): ManuscriptPublicData {
  validateGetOrCreateCommand(input);
  return deps.transactionPort.runInTransaction((repos) => {
    if (!repos.projectExistsReadPort.exists(input.projectId)) {
      throw new ManuscriptNotFoundError();
    }
    const existing = repos.manuscriptRepo.getActiveByProject(input.projectId);
    if (existing) {
      return manuscriptToPublicData(existing);
    }
    const title = defaultTitle(input.title);
    repos.manuscriptRepo.create({
      id: input.newManuscriptId,
      projectId: input.projectId,
      title,
      creationContractVersionId: input.creationContractVersionId ?? null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    const created = repos.manuscriptRepo.getById(input.projectId, input.newManuscriptId);
    if (!created) {
      throw new ContractDataCorruptionError('getOrCreateManuscript 创建后读取失败');
    }
    return manuscriptToPublicData(created);
  });
}

// ── CreateChapter ──────────────────────────────────────────

export function createChapter(
  deps: ManuscriptMutationDeps,
  input: CreateChapterCommand,
): ChapterPublicData {
  validateCreateChapterCommand(input);
  return deps.transactionPort.runInTransaction((repos) => {
    const { projectId, manuscriptId, insertBeforeChapterId, now, newChapterId } = input;
    if (!repos.projectExistsReadPort.exists(projectId)) {
      throw new ManuscriptNotFoundError();
    }
    const manuscript = repos.manuscriptRepo.getById(projectId, manuscriptId);
    if (!manuscript) {
      throw new ManuscriptNotFoundError();
    }
    if (manuscript.status !== 'active') {
      throw new ManuscriptStateConflictError('稿件状态不允许创建章节');
    }
    if (insertBeforeChapterId !== null) {
      const target = repos.chapterRepo.getById(projectId, insertBeforeChapterId);
      if (!target || target.manuscriptId !== manuscriptId) {
        throw new ChapterNotFoundError();
      }
      if (target.status !== 'active') {
        throw new ManuscriptStateConflictError('归档章节不能作为插入目标');
      }
    }
    const position = computeTargetPosition(
      makePositionContext(repos, projectId, manuscriptId, now),
      insertBeforeChapterId,
    );
    repos.chapterRepo.create({
      id: newChapterId,
      projectId,
      manuscriptId,
      position,
      createdAt: now,
      updatedAt: now,
    });
    repos.manuscriptRepo.touch(projectId, manuscriptId, now);
    return chapterToPublicData(chapterVersionPortFrom(repos.chapterVersionRepo), {
      id: newChapterId,
      projectId,
      manuscriptId,
      position,
      currentVersionId: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  });
}

// ── CreateChapterVersion（核心「保存新版本」，§11.1）──────────

export function createChapterVersion(
  deps: ManuscriptMutationDeps,
  input: CreateChapterVersionCommand,
): ChapterVersionPublicData {
  validateCreateChapterVersionCommand(input);
  const title = requireTitle(input.title, 'title');
  const content = requireContent(input.content, 'content');
  const sourceType = input.sourceType ?? 'USER';
  const createdByTaskId = input.createdByTaskId ?? null;
  const invocationId = input.invocationId ?? null;
  const creationContractVersionId = input.creationContractVersionId ?? null;
  assertSourceTypeProvenance(sourceType, createdByTaskId, invocationId, creationContractVersionId);

  return deps.transactionPort.runInTransaction((repos) => {
    const { projectId, chapterId, expectedCurrentVersionId, now, newVersionId } = input;

    // 1. 读 chapter（存在/归属/active）+ 读 current pointer
    const chapter = repos.chapterRepo.getById(projectId, chapterId);
    if (!chapter) {
      throw new ChapterNotFoundError();
    }
    if (chapter.status !== 'active') {
      throw new ManuscriptStateConflictError('归档章节不能接收新版本');
    }

    // 2. CAS 验证 current 指针（首版要求 IS NULL）
    if (chapter.currentVersionId !== expectedCurrentVersionId) {
      throw new ManuscriptVersionConflictError(
        `current pointer 不匹配：expected=${String(expectedCurrentVersionId)}, actual=${String(chapter.currentVersionId)}`,
      );
    }

    // 3. 版本号 = 章节内全局创建顺序 MAX+1（同一事务内计算）
    const maxNum = repos.chapterVersionRepo.getMaxVersionNumber(projectId, chapterId);
    const versionNumber = (maxNum ?? 0) + 1;

    // 4. parentVersionId = 编辑血缘（当前基线版本）
    const parentVersionId = chapter.currentVersionId;

    // 5. contentHash = sha256Utf8(content)
    const contentHash = requireSha256Digest(
      deps.sha256Port,
      content,
      'chapter version contentHash',
    );

    // 6. INSERT chapter_versions 行
    repos.chapterVersionRepo.create({
      id: newVersionId,
      projectId,
      chapterId,
      versionNumber,
      title,
      content,
      contentHash,
      parentVersionId,
      sourceType,
      createdByTaskId,
      invocationId,
      creationContractVersionId,
      createdAt: now,
    });

    // 7. CAS 更新 current 指针（二重保护，同谓词）
    const advanced = repos.chapterRepo.casUpdateCurrentVersionId(
      projectId,
      chapterId,
      chapter.currentVersionId,
      newVersionId,
      now,
    );
    if (!advanced) {
      throw new ManuscriptVersionConflictError('current pointer CAS 二重保护失败');
    }

    // 8. 更新 timestamps
    repos.manuscriptRepo.touch(projectId, chapter.manuscriptId, now);

    return chapterVersionToPublicData({
      id: newVersionId,
      projectId,
      chapterId,
      versionNumber,
      title,
      content,
      contentHash,
      parentVersionId,
      sourceType,
      createdByTaskId,
      invocationId,
      creationContractVersionId,
      createdAt: now,
    });
  });
}

// ── PromoteChapterVersion ──────────────────────────────────

export function promoteChapterVersion(
  deps: ManuscriptMutationDeps,
  input: PromoteChapterVersionCommand,
): ChapterVersionPublicData {
  validatePromoteCommand(input);
  return deps.transactionPort.runInTransaction((repos) => {
    const { projectId, chapterId, versionId, expectedCurrentVersionId, now } = input;

    const chapter = repos.chapterRepo.getById(projectId, chapterId);
    if (!chapter) {
      throw new ChapterNotFoundError();
    }
    if (chapter.status !== 'active') {
      throw new ManuscriptStateConflictError('归档章节不能切换版本');
    }

    // 目标版本必须属于同一章节（跨章 → CHAPTER_VERSION_NOT_FOUND）
    const target = repos.chapterVersionRepo.getById(projectId, chapterId, versionId);
    if (!target) {
      throw new ChapterVersionNotFoundError();
    }

    if (chapter.currentVersionId !== expectedCurrentVersionId) {
      throw new ManuscriptVersionConflictError(
        `current pointer 不匹配：expected=${String(expectedCurrentVersionId)}, actual=${String(chapter.currentVersionId)}`,
      );
    }

    // 幂等 no-op：重复 promote 已 current 版本
    if (chapter.currentVersionId === versionId) {
      return chapterVersionToPublicData(target);
    }

    const advanced = repos.chapterRepo.casUpdateCurrentVersionId(
      projectId,
      chapterId,
      expectedCurrentVersionId,
      versionId,
      now,
    );
    if (!advanced) {
      throw new ManuscriptVersionConflictError('current pointer CAS 失败');
    }
    repos.manuscriptRepo.touch(projectId, chapter.manuscriptId, now);

    return chapterVersionToPublicData(target);
  });
}

// ── UpdateChapterOrder ─────────────────────────────────────

export function updateChapterOrder(
  deps: ManuscriptMutationDeps,
  input: UpdateChapterOrderCommand,
): ReadonlyArray<ChapterSummary> {
  validateUpdateOrderCommand(input);
  return deps.transactionPort.runInTransaction((repos) => {
    const { projectId, manuscriptId, chapterId, insertBeforeChapterId, now } = input;

    const manuscript = repos.manuscriptRepo.getById(projectId, manuscriptId);
    if (!manuscript) {
      throw new ManuscriptNotFoundError();
    }
    if (manuscript.status !== 'active') {
      throw new ManuscriptStateConflictError('稿件状态不允许重排');
    }

    // 移动章节 M：必须 active
    const M = repos.chapterRepo.getById(projectId, chapterId);
    if (!M || M.manuscriptId !== manuscriptId) {
      throw new ChapterNotFoundError();
    }
    if (M.status !== 'active') {
      throw new ManuscriptStateConflictError('归档章节不能作为移动章节');
    }

    let moved = false;

    if (insertBeforeChapterId === null) {
      // append：移动到末尾（已是末尾 → no-op）
      const all = repos.chapterRepo.listByManuscript(projectId, manuscriptId);
      const last = all[all.length - 1];
      if (last.id !== M.id) {
        const target = computeTargetPosition(
          makePositionContext(repos, projectId, manuscriptId, now),
          null,
        );
        if (target !== M.position) {
          repos.chapterRepo.updatePosition(projectId, M.id, target, now);
          moved = true;
        }
      }
    } else {
      // move M before T
      const T = repos.chapterRepo.getById(projectId, insertBeforeChapterId);
      if (!T || T.manuscriptId !== manuscriptId) {
        throw new ChapterNotFoundError();
      }
      if (T.status !== 'active') {
        throw new ManuscriptStateConflictError('归档章节不能作为插入目标');
      }

      const all = repos.chapterRepo.listByManuscript(projectId, manuscriptId);
      const tIdx = all.findIndex((c) => c.id === insertBeforeChapterId);
      const immediatePrev = tIdx > 0 ? all[tIdx - 1] : null;
      const noop =
        M.id === T.id ||
        (tIdx === 0 && M.id === all[0].id) ||
        (immediatePrev !== null && immediatePrev.id === M.id);
      if (!noop) {
        const target = computeTargetPosition(
          makePositionContext(repos, projectId, manuscriptId, now),
          insertBeforeChapterId,
        );
        if (target !== M.position) {
          repos.chapterRepo.updatePosition(projectId, M.id, target, now);
          moved = true;
        }
      }
    }

    if (moved) {
      repos.manuscriptRepo.touch(projectId, manuscriptId, now);
    }

    // 返回 active 子序列（完整 position 序列的 active 子序列，不变量 16）
    const result = repos.chapterRepo.listByManuscript(projectId, manuscriptId);
    const port = chapterVersionPortFrom(repos.chapterVersionRepo);
    return result.filter((c) => c.status === 'active').map((c) => chapterToSummary(port, c));
  });
}

// ── ArchiveChapter / RestoreChapter ───────────────────────

export function archiveChapter(
  deps: ManuscriptMutationDeps,
  input: ArchiveChapterCommand,
): ChapterPublicData {
  validateArchiveRestoreCommand(input);
  return deps.transactionPort.runInTransaction((repos) => {
    const chapter = repos.chapterRepo.getById(input.projectId, input.chapterId);
    if (!chapter) {
      throw new ChapterNotFoundError();
    }
    if (chapter.currentVersionId !== input.expectedCurrentVersionId) {
      throw new ManuscriptVersionConflictError(
        `current pointer 不匹配：expected=${String(input.expectedCurrentVersionId)}, actual=${String(chapter.currentVersionId)}`,
      );
    }
    if (chapter.status === 'archived') {
      // 幂等 no-op
      return chapterToPublicData(chapterVersionPortFrom(repos.chapterVersionRepo), chapter);
    }
    const updated = repos.chapterRepo.casUpdateStatus(
      input.projectId,
      input.chapterId,
      input.expectedCurrentVersionId,
      'active',
      'archived',
      input.now,
    );
    if (!updated) {
      throw new ManuscriptVersionConflictError('chapter status CAS 失败');
    }
    repos.manuscriptRepo.touch(input.projectId, chapter.manuscriptId, input.now);
    return chapterToPublicData(chapterVersionPortFrom(repos.chapterVersionRepo), {
      ...chapter,
      status: 'archived',
      updatedAt: input.now,
    });
  });
}

export function restoreChapter(
  deps: ManuscriptMutationDeps,
  input: RestoreChapterCommand,
): ChapterPublicData {
  validateArchiveRestoreCommand(input);
  return deps.transactionPort.runInTransaction((repos) => {
    const chapter = repos.chapterRepo.getById(input.projectId, input.chapterId);
    if (!chapter) {
      throw new ChapterNotFoundError();
    }
    if (chapter.currentVersionId !== input.expectedCurrentVersionId) {
      throw new ManuscriptVersionConflictError(
        `current pointer 不匹配：expected=${String(input.expectedCurrentVersionId)}, actual=${String(chapter.currentVersionId)}`,
      );
    }
    if (chapter.status === 'active') {
      // 幂等 no-op
      return chapterToPublicData(chapterVersionPortFrom(repos.chapterVersionRepo), chapter);
    }
    const updated = repos.chapterRepo.casUpdateStatus(
      input.projectId,
      input.chapterId,
      input.expectedCurrentVersionId,
      'archived',
      'active',
      input.now,
    );
    if (!updated) {
      throw new ManuscriptVersionConflictError('chapter status CAS 失败');
    }
    repos.manuscriptRepo.touch(input.projectId, chapter.manuscriptId, input.now);
    return chapterToPublicData(chapterVersionPortFrom(repos.chapterVersionRepo), {
      ...chapter,
      status: 'active',
      updatedAt: input.now,
    });
  });
}

// ── UpdateManuscriptTitle ─────────────────────────────────

export function updateManuscriptTitle(
  deps: ManuscriptMutationDeps,
  input: UpdateManuscriptTitleCommand,
): ManuscriptPublicData {
  validateUpdateTitleCommand(input);
  const title = requireTitle(input.title, 'title');
  return deps.transactionPort.runInTransaction((repos) => {
    const manuscript = repos.manuscriptRepo.getById(input.projectId, input.manuscriptId);
    if (!manuscript) {
      throw new ManuscriptNotFoundError();
    }
    if (manuscript.updatedAt !== input.expectedUpdatedAt) {
      throw new ManuscriptVersionConflictError('manuscript updatedAt CAS 失败');
    }
    const updated = repos.manuscriptRepo.updateTitle(
      input.projectId,
      input.manuscriptId,
      title,
      input.expectedUpdatedAt,
      input.now,
    );
    if (!updated) {
      throw new ManuscriptVersionConflictError('manuscript title CAS 失败');
    }
    return manuscriptToPublicData({ ...manuscript, title, updatedAt: input.now });
  });
}
