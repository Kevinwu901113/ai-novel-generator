/**
 * 章节生成域对象（GE-6 / B9，设计见 docs/development/b9-chapter-wiring-design.md）。
 *
 * ChapterGenerationGraphV1 的三类权威持久化对象：
 * - `ChapterScenePlan`：CHAPTER_PLAN 产出的**内部** artifact（锁定不变量 §3：Scene Plan
 *   是内部 artifact，不是 Graph artifact 槽位；图契约上 CHAPTER_PLAN 是 `noOut`）；
 * - `ChapterCandidate`：候选正文修订链。DRAFT 产出的修订同时是 Graph 的 `generationRun`
 *   artifact（`artifactId` 非空）；REWRITE 产出的修订按图契约 `noOut` **不产生新
 *   artifact**（`artifactId` 为 null），只在同一 run 内追加修订号。
 * - `ChapterCritique`：三个 Critic 各自的审查结论与问题清单，绑定被审的修订号。
 *
 * 为什么 REWRITE 不换 artifact：`CHAPTER_GENERATION_GRAPH_V1` 的 REWRITE 节点
 * `output: noOut`（图定义已冻结，不得改），所以 `artifacts.generationRun` 在整个 rewrite
 * 循环内恒指向 DRAFT 那一版。因此"当前候选正文"的权威定义是
 * **同 run 内修订号最大的那一行**，而不是 artifact ref 指向的那一行——所有消费方
 * （三个 Critic、CANDIDATE_GATE、GE-7 的 MANUSCRIPT_COMMIT）必须按 run + 最大修订号读。
 *
 * 纯类型 + 工厂校验，无外部依赖。
 */

import type { CritiqueVerdict } from './idea-to-novel-graph.js';

// ── Scene Plan（内部 artifact）─────────────────────────────────────

/** 场景计划中的单个场景 */
export interface ChapterScene {
  readonly summary: string;
  readonly beats: ReadonlyArray<string>;
}

/** CHAPTER_PLAN 产出：一次章节生成 run 的场景计划（内部 artifact） */
export interface ChapterScenePlan {
  readonly id: string;
  readonly projectId: string;
  readonly graphRunId: string;
  readonly blueprintChapterId: string;
  readonly title: string;
  readonly scenes: ReadonlyArray<ChapterScene>;
  readonly createdAt: string;
}

// ── 候选正文修订 ───────────────────────────────────────────────────

/** 产出候选修订的节点（图节点 id 子集；用于区分首稿与改写稿） */
export type ChapterCandidateSource = 'DRAFT' | 'REWRITE';

/** 候选正文的一个修订（append-only；同 run 内 revisionNo 递增） */
export interface ChapterCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly graphRunId: string;
  /** 同 run 内自 1 起递增；最大者即当前候选 */
  readonly revisionNo: number;
  readonly source: ChapterCandidateSource;
  /**
   * Graph `generationRun` artifact id。
   * DRAFT 修订非空（等于 execution-bound envelope 的 artifactId）；
   * REWRITE 修订恒为 null（图契约 noOut，不产生新 artifact）。
   */
  readonly artifactId: string | null;
  readonly title: string;
  readonly content: string;
  readonly createdAt: string;
}

// ── Critic 审查结论 ────────────────────────────────────────────────

/** Critic 指出的单个问题 */
export interface ChapterCritiqueIssue {
  readonly severity: 'minor' | 'major';
  /** 问题所在的原文片段（供改写定位；可为空字符串表示全篇性问题） */
  readonly excerpt: string;
  readonly problem: string;
  readonly suggestion: string;
}

/** 一个 Critic 对某个候选修订的审查结论 */
export interface ChapterCritique {
  readonly id: string;
  readonly projectId: string;
  readonly graphRunId: string;
  /** 被审查的候选修订号 */
  readonly candidateRevisionNo: number;
  /** 审查者节点 id（CONTINUITY_CRITIC / STYLE_CRITIC / REQUIREMENT_CRITIC） */
  readonly criticNodeId: string;
  readonly verdict: CritiqueVerdict;
  readonly summary: string;
  readonly issues: ReadonlyArray<ChapterCritiqueIssue>;
  readonly createdAt: string;
}

// ── 工厂（构造即校验）──────────────────────────────────────────────

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} 不能为空`);
  }
}

export function createChapterScenePlan(input: ChapterScenePlan): ChapterScenePlan {
  assertNonEmpty(input.id, 'ChapterScenePlan id');
  assertNonEmpty(input.projectId, 'ChapterScenePlan projectId');
  assertNonEmpty(input.graphRunId, 'ChapterScenePlan graphRunId');
  assertNonEmpty(input.blueprintChapterId, 'ChapterScenePlan blueprintChapterId');
  assertNonEmpty(input.title, 'ChapterScenePlan title');
  if (input.scenes.length === 0) {
    throw new Error('ChapterScenePlan 至少需要一个场景');
  }
  for (const scene of input.scenes) {
    assertNonEmpty(scene.summary, 'ChapterScene summary');
  }
  return { ...input };
}

export function createChapterCandidate(input: ChapterCandidate): ChapterCandidate {
  assertNonEmpty(input.id, 'ChapterCandidate id');
  assertNonEmpty(input.projectId, 'ChapterCandidate projectId');
  assertNonEmpty(input.graphRunId, 'ChapterCandidate graphRunId');
  assertNonEmpty(input.title, 'ChapterCandidate title');
  assertNonEmpty(input.content, 'ChapterCandidate content');
  if (!Number.isInteger(input.revisionNo) || input.revisionNo < 1) {
    throw new Error('ChapterCandidate revisionNo 必须是 >=1 的整数');
  }
  // 图契约：DRAFT 产出 generationRun artifact，REWRITE 是 noOut。
  // 把这条契约钉在构造处，避免任一执行器写出"改写产生了新 artifact"的行。
  if (input.source === 'DRAFT') {
    assertNonEmpty(input.artifactId ?? '', 'DRAFT 修订的 artifactId');
  } else if (input.artifactId !== null) {
    throw new Error('REWRITE 修订不得携带 artifactId（图契约 noOut）');
  }
  return { ...input };
}

export function createChapterCritique(input: ChapterCritique): ChapterCritique {
  assertNonEmpty(input.id, 'ChapterCritique id');
  assertNonEmpty(input.projectId, 'ChapterCritique projectId');
  assertNonEmpty(input.graphRunId, 'ChapterCritique graphRunId');
  assertNonEmpty(input.criticNodeId, 'ChapterCritique criticNodeId');
  assertNonEmpty(input.summary, 'ChapterCritique summary');
  if (!Number.isInteger(input.candidateRevisionNo) || input.candidateRevisionNo < 1) {
    throw new Error('ChapterCritique candidateRevisionNo 必须是 >=1 的整数');
  }
  if (input.verdict !== 'pass' && input.verdict !== 'needs_rewrite') {
    throw new Error(`ChapterCritique verdict 非法: ${String(input.verdict)}`);
  }
  for (const issue of input.issues) {
    if (issue.severity !== 'minor' && issue.severity !== 'major') {
      throw new Error(`ChapterCritiqueIssue severity 非法: ${String(issue.severity)}`);
    }
    assertNonEmpty(issue.problem, 'ChapterCritiqueIssue problem');
  }
  return { ...input };
}

// ── 候选 Gate 的改写意见（B10 / D-B10-3）──────────────────────────

/**
 * 用户在候选确认环节点"请求改写"时附带的意见。
 *
 * 图的 `candidate_gate` 决策 DTO 没有 feedback 字段（图定义已冻结），因此意见走
 * 独立权威存储：提交决策时先落这一行，再推进 Graph；REWRITE 任务按
 * run + 被改写的候选修订号取最新一条送进 prompt。
 */
export interface ChapterRewriteFeedback {
  readonly id: string;
  readonly projectId: string;
  readonly graphRunId: string;
  /** 提意见时所针对的候选修订号（即将被改写的那一版） */
  readonly candidateRevisionNo: number;
  readonly feedback: string;
  readonly createdAt: string;
}

export function createChapterRewriteFeedback(
  input: ChapterRewriteFeedback,
): ChapterRewriteFeedback {
  assertNonEmpty(input.id, 'ChapterRewriteFeedback id');
  assertNonEmpty(input.projectId, 'ChapterRewriteFeedback projectId');
  assertNonEmpty(input.graphRunId, 'ChapterRewriteFeedback graphRunId');
  assertNonEmpty(input.feedback, 'ChapterRewriteFeedback feedback');
  if (!Number.isInteger(input.candidateRevisionNo) || input.candidateRevisionNo < 1) {
    throw new Error('ChapterRewriteFeedback candidateRevisionNo 必须是 >=1 的整数');
  }
  return { ...input };
}
