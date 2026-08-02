/**
 * 章节稀疏排序编排（§6.1）。
 *
 * 全部在单个 BEGIN IMMEDIATE 事务内执行。排序是数据操作：
 * 唯一索引 `uq_chapters_project_manuscript_position` 全程存在，
 * **不执行任何运行时 DROP / CREATE INDEX**（不变量 18）。
 *
 * rebalance 使用数据级两阶段算法（temp → final），
 * 任一步失败（含 MANUSCRIPT_POSITION_OVERFLOW）→ 调用方整笔 rollback。
 */

import {
  FIRST_POSITION,
  computeAppendPosition,
  computePrependPosition,
  computeInsertBeforePosition,
  computeRebalancedLayout,
} from '@ai-novel/domain';
import type { ManuscriptTransactionRepositories } from './manuscript-types.js';
import { ManuscriptPositionOverflowError, ChapterNotFoundError } from './errors.js';

export interface PositionContext {
  readonly projectId: string;
  readonly manuscriptId: string;
  readonly repos: ManuscriptTransactionRepositories;
  readonly now: string;
}

function overflow(): never {
  throw new ManuscriptPositionOverflowError();
}

/**
 * 数据级两阶段 rebalance（§6.1 procedure）：
 * 1. 读取全部章节（position ASC, id ASC），得 rank 与 M；
 * 2. final-position 检查（先检查后乘法）→ 失败 MANUSCRIPT_POSITION_OVERFLOW；
 * 3. temporary-domain 检查（`B > LIMIT - n`）→ 失败 MANUSCRIPT_POSITION_OVERFLOW；
 * 4. 第一阶段：rank r → `TEMP_BASE + (r - 1)`（全部 > B >= M，与现有行无冲突）；
 * 5. 第二阶段：rank r → `(r + 2) * GAP`（全部 <= maxFinal < TEMP_BASE，无冲突）。
 */
export function rebalanceManuscript(ctx: PositionContext): void {
  const { projectId, manuscriptId, repos, now } = ctx;
  const chapters = repos.chapterRepo.listByManuscript(projectId, manuscriptId);
  const n = chapters.length;
  if (n === 0) return;
  const M = chapters[n - 1].position; // 已按 position ASC 排序，末位即 MAX

  const result = computeRebalancedLayout(n, M);
  if (result.status === 'overflow') {
    overflow();
  }
  const { tempPositions, finalPositions } = result.layout;

  // 第一阶段：临时值（互异、全部 > B >= M，不与任何现有行冲突）
  for (let i = 0; i < n; i++) {
    repos.chapterRepo.updatePosition(projectId, chapters[i].id, tempPositions[i], now);
  }
  // 第二阶段：最终值（全部 <= maxFinal < TEMP_BASE <= 任一临时值，无冲突）
  for (let i = 0; i < n; i++) {
    repos.chapterRepo.updatePosition(projectId, chapters[i].id, finalPositions[i], now);
  }
}

/**
 * 计算新章节 / 移动章节的目标 position（§6.1）。
 *
 * - insertBeforeChapterId === null → append（逼近 LIMIT 先 rebalance）；
 * - T 为首章 → prepend 减半（撞 0 先 rebalance）；
 * - 否则安全 midpoint `P + floor((X - P) / 2)`（gap == 1 先 rebalance）。
 *
 * 调用方必须已保证 T（若有）存在、属于同一 manuscript 且 status='active'。
 */
export function computeTargetPosition(
  ctx: PositionContext,
  insertBeforeChapterId: string | null,
): number {
  const { projectId, manuscriptId, repos } = ctx;
  const chapters = repos.chapterRepo.listByManuscript(projectId, manuscriptId);
  const n = chapters.length;
  if (n === 0) return FIRST_POSITION;

  if (insertBeforeChapterId === null) {
    // append
    const M = chapters[n - 1].position;
    const target = computeAppendPosition(M);
    if (target !== null) return target;
    rebalanceManuscript(ctx);
    const after = repos.chapterRepo.listByManuscript(projectId, manuscriptId);
    const M2 = after[after.length - 1].position;
    const target2 = computeAppendPosition(M2);
    if (target2 !== null) return target2;
    return overflow();
  }

  const tIdx = chapters.findIndex((c) => c.id === insertBeforeChapterId);
  if (tIdx === -1) {
    throw new ChapterNotFoundError();
  }

  if (tIdx === 0) {
    // T 为首章 → prepend
    const target = computePrependPosition(chapters[0].position);
    if (target !== null) return target;
    rebalanceManuscript(ctx);
    const after = repos.chapterRepo.listByManuscript(projectId, manuscriptId);
    const target2 = computePrependPosition(after[0].position);
    if (target2 !== null) return target2;
    return overflow();
  }

  const P = chapters[tIdx - 1];
  const T = chapters[tIdx];
  const mid = computeInsertBeforePosition(P.position, T.position);
  if (mid !== null) return mid;

  // gap == 1 → rebalance 后重算
  rebalanceManuscript(ctx);
  const after = repos.chapterRepo.listByManuscript(projectId, manuscriptId);
  const newTIdx = after.findIndex((c) => c.id === insertBeforeChapterId);
  const newMid = computeInsertBeforePosition(after[newTIdx - 1].position, after[newTIdx].position);
  if (newMid !== null) return newMid;
  return overflow();
}
