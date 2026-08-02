/**
 * @ai-novel/domain - Manuscript / Chapter / ChapterVersion Domain
 *
 * 真实稿件与章节版本管理的领域模型。
 * 纯 TypeScript —— 不依赖 Electron、SQLite、Node.js 或 Renderer。
 * 不负责随机 ID 或当前时间生成 —— ID 与时间由调用方注入。
 *
 * 权威规格：docs/development/manuscript-version-design.md（§4–§6）。
 */

// ── 常量 ──────────────────────────────────────────────────

/** 排序 gap（稀疏 position 间隔） */
export const POSITION_GAP = 1024;

/** position 与所有中间量在任何时刻不得超过 LIMIT */
export const POSITION_LIMIT = Number.MAX_SAFE_INTEGER;

/** 首章初始 position = 2048，为 prepend 保留 1..2047 首部空间 */
export const FIRST_POSITION = 2048;

/** 标题最大长度（UTF-16 code units） */
export const MANUSCRIPT_TITLE_MAX_LENGTH = 200;

/** 正文最大长度（UTF-16 code units，≈3MB UTF-8，远低于 SQLite TEXT 上限） */
export const CHAPTER_CONTENT_MAX_LENGTH = 1_000_000;

/** getOrCreateManuscript 创建时使用的默认标题 */
export const MANUSCRIPT_DEFAULT_TITLE = '未命名稿件';

// ── 闭合枚举 ──────────────────────────────────────────────

/** 稿件状态。V1 恒为 active；archived 为未来 reserved（§13）。 */
export type ManuscriptStatus = 'active' | 'archived';

/** 章节状态。chapter archive/restore 是 V1 能力（§7.2）。 */
export type ChapterStatus = 'active' | 'archived';

/** 章节版本来源。AI_* 必须携带 task/invocation/contract provenance（CHECK 兜底）。 */
export type ChapterVersionSourceType =
  'USER' | 'AI_GENERATION' | 'AI_REWRITE' | 'IMPORT' | 'RESTORE';

// ── Branded ID 类型 ───────────────────────────────────────

export type ManuscriptId = string & { readonly __brand: 'ManuscriptId' };
export type ChapterId = string & { readonly __brand: 'ChapterId' };
export type ChapterVersionId = string & { readonly __brand: 'ChapterVersionId' };

export function createManuscriptId(raw: string): ManuscriptId {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('ManuscriptId 不能为空');
  }
  return raw as ManuscriptId;
}

export function createChapterId(raw: string): ChapterId {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('ChapterId 不能为空');
  }
  return raw as ChapterId;
}

export function createChapterVersionId(raw: string): ChapterVersionId {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('ChapterVersionId 不能为空');
  }
  return raw as ChapterVersionId;
}

// ── 领域模型 ──────────────────────────────────────────────

export interface Manuscript {
  readonly id: ManuscriptId;
  readonly projectId: string;
  /** trim 后非空；≤ 200 UTF-16 code units */
  readonly title: string;
  readonly status: ManuscriptStatus;
  /** 初始 contract 锚点，永不自动更新（§10.1） */
  readonly creationContractVersionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Chapter {
  readonly id: ChapterId;
  readonly projectId: string;
  readonly manuscriptId: string;
  /** 稀疏正整数 rank，覆盖所有章节（含 archived） */
  readonly position: number;
  /** 当前版本指针；null = 空章节 */
  readonly currentVersionId: string | null;
  readonly status: ChapterStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChapterVersion {
  readonly id: ChapterVersionId;
  readonly projectId: string;
  readonly chapterId: string;
  /** 章节内全局创建顺序：MAX+1，永不重用既有编号 */
  readonly versionNumber: number;
  readonly title: string;
  readonly content: string;
  /** sha256Utf8(content) 精确 UTF-8 字节摘要 */
  readonly contentHash: string;
  /** 编辑血缘（被编辑的基线版本），与 versionNumber 无关 */
  readonly parentVersionId: string | null;
  readonly sourceType: ChapterVersionSourceType;
  readonly createdByTaskId: string | null;
  readonly invocationId: string | null;
  readonly creationContractVersionId: string | null;
  readonly createdAt: string;
}

// ── 枚举校验 ──────────────────────────────────────────────

const MANUSCRIPT_STATUS_SET: ReadonlySet<string> = new Set(['active', 'archived']);
const CHAPTER_STATUS_SET: ReadonlySet<string> = new Set(['active', 'archived']);
const SOURCE_TYPE_SET: ReadonlySet<string> = new Set([
  'USER',
  'AI_GENERATION',
  'AI_REWRITE',
  'IMPORT',
  'RESTORE',
]);

export function isValidManuscriptStatus(value: unknown): value is ManuscriptStatus {
  return typeof value === 'string' && MANUSCRIPT_STATUS_SET.has(value);
}

export function isValidChapterStatus(value: unknown): value is ChapterStatus {
  return typeof value === 'string' && CHAPTER_STATUS_SET.has(value);
}

export function isValidChapterVersionSourceType(value: unknown): value is ChapterVersionSourceType {
  return typeof value === 'string' && SOURCE_TYPE_SET.has(value);
}

// ── 校验函数 ──────────────────────────────────────────────

/**
 * 校验稿件/版本标题。
 *
 * - 必须是 string；
 * - trim 后非空；
 * - ≤ 200 UTF-16 code units（String.length）。
 *
 * 返回 trim 后的标题。不做 Unicode 规范化（NFC/NFD 均不执行，§6.2）。
 */
export function validateManuscriptTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('标题必须是字符串');
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error('标题 trim 后不能为空');
  if (trimmed.length > MANUSCRIPT_TITLE_MAX_LENGTH) {
    throw new Error(`标题超过 ${MANUSCRIPT_TITLE_MAX_LENGTH} 个 UTF-16 code units`);
  }
  return trimmed;
}

/**
 * 校验章节正文。
 *
 * - 必须是 string；
 * - 允许空字符串；
 * - ≤ 1,000,000 UTF-16 code units（String.length）。
 *
 * 返回原文，不 trim、不规范化、不改换行（§6.2）。
 */
export function validateChapterContent(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('正文必须是字符串');
  if (raw.length > CHAPTER_CONTENT_MAX_LENGTH) {
    throw new Error(`正文超过 ${CHAPTER_CONTENT_MAX_LENGTH} 个 UTF-16 code units`);
  }
  return raw;
}

/** position 必须为正安全整数（`Number.MAX_SAFE_INTEGER` 为上限） */
export function isValidPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** versionNumber 必须为正安全整数 */
export function isValidVersionNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

// ── 稀疏排序纯函数（§6.1）────────────────────────────────

/**
 * append 目标 position。
 *
 * 先验证（`M <= LIMIT - GAP`）后计算（`M + GAP`），不产生 unsafe 中间值。
 * 返回 null 表示需要 rebalance（或 M 已逼近 LIMIT）。
 */
export function computeAppendPosition(M: number): number | null {
  if (!Number.isSafeInteger(M) || M < 0) return null;
  if (M <= POSITION_LIMIT - POSITION_GAP) return M + POSITION_GAP;
  return null;
}

/**
 * prepend 目标 position（减半策略）。
 *
 * `floor(F / 2)`；结果为 0（`F == 1`）时返回 null 表示需要 rebalance。
 */
export function computePrependPosition(F: number): number | null {
  if (!Number.isSafeInteger(F) || F < 1) return null;
  const target = Math.floor(F / 2);
  if (target < 1) return null;
  return target;
}

/**
 * insert-before-X 安全 midpoint。
 *
 * 只使用 `P + floor((X - P) / 2)`（不用 `floor((P + X) / 2)`，避免 unsafe 中间和）。
 * `X - P >= 2`（gap >= 2）时返回严格介于两者且不与任何已占用值冲突的整数；
 * gap == 1 时返回 null 表示需要 rebalance。
 */
export function computeInsertBeforePosition(P: number, X: number): number | null {
  if (!Number.isSafeInteger(P) || !Number.isSafeInteger(X) || P < 1 || X < 1 || P >= X) {
    return null;
  }
  const gap = X - P;
  if (gap < 2) return null;
  return P + Math.floor(gap / 2);
}

/** rebalance 布局（数据级两阶段，§6.1）。 */
export interface RebalancedLayout {
  /** tempPositions[r-1] = 第 r 个 rank 的临时 position */
  readonly tempPositions: ReadonlyArray<number>;
  /** finalPositions[r-1] = 第 r 个 rank 的最终 position = (r + 2) * GAP */
  readonly finalPositions: ReadonlyArray<number>;
  readonly tempBase: number;
  readonly maxFinal: number;
  readonly b: number;
}

export type RebalanceResult =
  | { readonly status: 'ok'; readonly layout: RebalancedLayout }
  | { readonly status: 'overflow'; readonly reason: 'final-count' | 'temporary-domain' };

/**
 * 计算 rebalance 布局（纯函数，不执行任何写操作）。
 *
 * 顺序严格按设计：
 * 1. 先做 final-position 检查（`n > floor(LIMIT / GAP) - 2`）→ 失败返回 overflow；
 * 2. 检查通过后才计算 `maxFinal = (n + 2) * GAP`（不产生 unsafe 乘法）；
 * 3. `B = max(M, maxFinal)`；
 * 4. temporary-domain 检查（`B > LIMIT - n`）→ 失败返回 overflow；
 * 5. `TEMP_BASE = B + 1`；
 * 6. 构造 temp / final 数组。
 *
 * 任一步失败即返回 overflow，调用方必须整笔 rollback 且不写入任何行。
 */
export function computeRebalancedLayout(n: number, maxPosition: number): RebalanceResult {
  if (!Number.isSafeInteger(n) || n < 1) {
    return { status: 'overflow', reason: 'final-count' };
  }
  if (!Number.isSafeInteger(maxPosition) || maxPosition < 0) {
    return { status: 'overflow', reason: 'temporary-domain' };
  }

  // 先检查，后乘法
  if (n > Math.floor(POSITION_LIMIT / POSITION_GAP) - 2) {
    return { status: 'overflow', reason: 'final-count' };
  }
  const maxFinal = (n + 2) * POSITION_GAP;

  const b = Math.max(maxPosition, maxFinal);
  if (b > POSITION_LIMIT - n) {
    return { status: 'overflow', reason: 'temporary-domain' };
  }
  const tempBase = b + 1;

  const tempPositions: number[] = [];
  const finalPositions: number[] = [];
  for (let r = 1; r <= n; r++) {
    tempPositions.push(tempBase + (r - 1));
    finalPositions.push((r + 2) * POSITION_GAP);
  }

  return {
    status: 'ok',
    layout: { tempPositions, finalPositions, tempBase, maxFinal, b },
  };
}
