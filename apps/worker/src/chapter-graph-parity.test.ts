/**
 * 章节图契约的跨层守卫（B10）。
 *
 * contracts 里的三个预算上限（CHAPTER_REWRITE_LIMIT / CHAPTER_CANDIDATE_REWRITE_LIMIT /
 * CHAPTER_REGENERATE_LIMIT）是渲染进程"还能改写几次"文案的依据，但它们是**手抄**的
 * ——contracts 不依赖 domain，引用不到 CHAPTER_GENERATION_GRAPH_V1 这个真源。
 * 这正是 TD-030-3 记录的那类"typecheck 全过、单测全绿、界面静默错"的缺口。
 *
 * 本文件是那道缺失的守卫：apps/worker 同时依赖 contracts 与 domain，逐条比对图上
 * loop.maxIterations 与 contracts 常量。图上调整预算而 contracts 没跟上时即红。
 */

import { describe, it, expect } from 'vitest';
import {
  CHAPTER_CANDIDATE_REWRITE_LIMIT,
  CHAPTER_REGENERATE_LIMIT,
  CHAPTER_REWRITE_LIMIT,
} from '@ai-novel/contracts';
import { CHAPTER_GENERATION_GRAPH_V1 } from '@ai-novel/domain';

/** 图上某预算键对应的循环上限（同一预算键的多条边必须声明同一上限） */
function maxIterationsFor(budget: string): number {
  const limits = new Set(
    CHAPTER_GENERATION_GRAPH_V1.edges
      .filter((edge) => edge.loop?.budget === budget)
      .map((edge) => edge.loop!.maxIterations),
  );
  expect(limits.size, `预算 ${budget} 在图上没有唯一的 maxIterations`).toBe(1);
  return [...limits][0]!;
}

describe('章节预算上限：contracts 常量与图定义 parity', () => {
  it('rewrite（自查触发的改写）上限一致', () => {
    expect(CHAPTER_REWRITE_LIMIT).toBe(maxIterationsFor('rewrite'));
  });

  it('candidateRewrite（用户请求的改写）上限一致', () => {
    expect(CHAPTER_CANDIDATE_REWRITE_LIMIT).toBe(maxIterationsFor('candidateRewrite'));
  });

  it('regenerate（用户否决后重新起草）上限一致', () => {
    expect(CHAPTER_REGENERATE_LIMIT).toBe(maxIterationsFor('regenerate'));
  });
});
