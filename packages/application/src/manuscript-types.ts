/**
 * 稿件 / 章节 / 章节版本应用层端口接口。
 *
 * 应用用例通过这些接口与基础设施交互，
 * 不依赖 Electron、React 或 node:sqlite。
 * 权威规格：docs/development/manuscript-version-design.md（§4、§7）。
 */

import type { ManuscriptStatus, ChapterStatus, ChapterVersionSourceType } from '@ai-novel/domain';
import type { ProjectExistsReadPort } from './creation-contract-types.js';

// ── 数据接口 ──────────────────────────────────────────────────

export interface ManuscriptData {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: ManuscriptStatus;
  readonly creationContractVersionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChapterData {
  readonly id: string;
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly position: number;
  readonly currentVersionId: string | null;
  readonly status: ChapterStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChapterVersionData {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
  readonly parentVersionId: string | null;
  readonly sourceType: ChapterVersionSourceType;
  readonly createdByTaskId: string | null;
  readonly invocationId: string | null;
  readonly creationContractVersionId: string | null;
  readonly createdAt: string;
}

/** 章节版本摘要数据 —— listChapterVersions 用，**不含 content** */
export interface ChapterVersionSummaryData {
  readonly id: string;
  readonly chapterId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly sourceType: ChapterVersionSourceType;
  readonly createdAt: string;
  readonly parentVersionId: string | null;
  readonly creationContractVersionId: string | null;
  readonly contentHash: string;
}

// ── 创建输入 ──────────────────────────────────────────────────

export interface CreateManuscriptInput {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly creationContractVersionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChapterInput {
  readonly id: string;
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChapterVersionInput {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
  readonly parentVersionId: string | null;
  readonly sourceType: ChapterVersionSourceType;
  readonly createdByTaskId: string | null;
  readonly invocationId: string | null;
  readonly creationContractVersionId: string | null;
  readonly createdAt: string;
}

// ── 仓库端口 ──────────────────────────────────────────────────

export interface ManuscriptRepositoryPort {
  create(data: CreateManuscriptInput): void;
  getById(projectId: string, id: string): ManuscriptData | null;
  /** V1 每 project 至多一个 active manuscript（partial unique index 兜底） */
  getActiveByProject(projectId: string): ManuscriptData | null;
  /** CAS 更新标题：WHERE updated_at = expectedUpdatedAt */
  updateTitle(
    projectId: string,
    id: string,
    title: string,
    expectedUpdatedAt: string,
    now: string,
  ): boolean;
  /** 更新 manuscript.updated_at（章节/版本结构变更时） */
  touch(projectId: string, id: string, now: string): void;
}

export interface ChapterRepositoryPort {
  create(data: CreateChapterInput): void;
  getById(projectId: string, id: string): ChapterData | null;
  /** 全部章节（含 archived），ORDER BY position ASC, id ASC（不变量 16） */
  listByManuscript(projectId: string, manuscriptId: string): ReadonlyArray<ChapterData>;
  /** MAX(position over manuscript 全部章节，含 archived）；无章节返回 null */
  getMaxPosition(projectId: string, manuscriptId: string): number | null;
  /**
   * CAS 推进 current 指针。
   * 谓词 `current_version_id IS ?`：expected 为 null 时匹配首版（IS NULL）。
   * 返回 affected == 1。
   */
  casUpdateCurrentVersionId(
    projectId: string,
    chapterId: string,
    expectedCurrentVersionId: string | null,
    newVersionId: string,
    now: string,
  ): boolean;
  /**
   * CAS 切换 status（status 第二谓词，§7.2 archive/restore）。
   * 谓词 `current_version_id IS ? AND status = ?`。
   */
  casUpdateStatus(
    projectId: string,
    chapterId: string,
    expectedCurrentVersionId: string | null,
    expectedStatus: ChapterStatus,
    newStatus: ChapterStatus,
    now: string,
  ): boolean;
  /** 更新 position（重排 / rebalance / move），同时更新 updated_at */
  updatePosition(projectId: string, chapterId: string, position: number, now: string): void;
}

export interface ChapterVersionRepositoryPort {
  create(data: CreateChapterVersionInput): void;
  getById(projectId: string, chapterId: string, id: string): ChapterVersionData | null;
  /** 摘要读取（不含 content） */
  getSummaryById(
    projectId: string,
    chapterId: string,
    id: string,
  ): ChapterVersionSummaryData | null;
  /** 摘要列表，ORDER BY version_number DESC, id ASC（不变量 16） */
  listSummariesByChapter(
    projectId: string,
    chapterId: string,
  ): ReadonlyArray<ChapterVersionSummaryData>;
  /** 章节内全局创建顺序 MAX(version_number)；无版本返回 null */
  getMaxVersionNumber(projectId: string, chapterId: string): number | null;
  /** 章节版本数 */
  countByChapter(projectId: string, chapterId: string): number;
}

// ── 事务端口 ──────────────────────────────────────────────────

export interface ManuscriptTransactionRepositories {
  readonly manuscriptRepo: ManuscriptRepositoryPort;
  readonly chapterRepo: ChapterRepositoryPort;
  readonly chapterVersionRepo: ChapterVersionRepositoryPort;
  readonly projectExistsReadPort: ProjectExistsReadPort;
}

/** 事务端口 —— database adapter 实现，application 依赖此接口 */
export interface ManuscriptTransactionPort {
  runInTransaction<T>(operation: (repositories: ManuscriptTransactionRepositories) => T): T;
}

// ── 用例命令输入（Worker 注入 ID / now / sourceType 等生成字段）─────
// Renderer 面输入定义在 @ai-novel/contracts；此处为 Worker 组装后的完整命令。

export interface GetOrCreateManuscriptCommand {
  readonly projectId: string;
  readonly title?: string;
  /** Worker 注入 */
  readonly now: string;
  /** Worker 注入 */
  readonly newManuscriptId: string;
  /** Worker 注入（初始 contract 锚点，可为 null，永不自动更新） */
  readonly creationContractVersionId?: string | null;
}

export interface GetManuscriptCommand {
  readonly projectId: string;
  readonly manuscriptId: string;
}

export interface ListChaptersCommand {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly includeArchived?: boolean;
}

export interface GetChapterCommand {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly chapterId: string;
}

export interface GetCurrentChapterVersionCommand {
  readonly projectId: string;
  readonly chapterId: string;
}

export interface ListChapterVersionsCommand {
  readonly projectId: string;
  readonly chapterId: string;
}

export interface GetChapterVersionCommand {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
}

export interface CreateChapterCommand {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly insertBeforeChapterId: string | null;
  /** Worker 注入 */
  readonly now: string;
  /** Worker 注入 */
  readonly newChapterId: string;
}

export interface CreateChapterVersionCommand {
  readonly projectId: string;
  readonly chapterId: string;
  readonly title: string;
  readonly content: string;
  readonly expectedCurrentVersionId: string | null;
  readonly creationContractVersionId?: string | null;
  /** Worker 注入 */
  readonly now: string;
  /** Worker 注入 */
  readonly newVersionId: string;
  /** Worker 注入；用户保存默认 'USER'，AI settle 注入 AI_* + provenance */
  readonly sourceType?: ChapterVersionSourceType;
  readonly createdByTaskId?: string | null;
  readonly invocationId?: string | null;
}

export interface PromoteChapterVersionCommand {
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly expectedCurrentVersionId: string | null;
  /** Worker 注入 */
  readonly now: string;
}

export interface UpdateChapterOrderCommand {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly chapterId: string;
  readonly insertBeforeChapterId: string | null;
  /** Worker 注入 */
  readonly now: string;
}

export interface ArchiveChapterCommand {
  readonly projectId: string;
  readonly chapterId: string;
  readonly expectedCurrentVersionId: string | null;
  /** Worker 注入 */
  readonly now: string;
}

export interface RestoreChapterCommand {
  readonly projectId: string;
  readonly chapterId: string;
  readonly expectedCurrentVersionId: string | null;
  /** Worker 注入 */
  readonly now: string;
}

export interface UpdateManuscriptTitleCommand {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly title: string;
  readonly expectedUpdatedAt: string;
  /** Worker 注入 */
  readonly now: string;
}
