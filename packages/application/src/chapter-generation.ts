/**
 * 章节生成应用层端口（GE-6 / B9）。
 *
 * 三个持久化端口 + 两个只读用例。写入一律发生在任务执行器的最终事务内
 * （与 invocation/task 终态、execution-bound envelope 同事务），本层只声明契约。
 *
 * "当前候选正文" = 同 run 内 `revisionNo` 最大的那一行（见 domain chapter-generation.ts
 * 顶部说明：REWRITE 按图契约 noOut，不换 artifact，只追加修订）。
 */

import type {
  ChapterCandidate,
  ChapterCritique,
  ChapterRewriteFeedback,
  ChapterScenePlan,
} from '@ai-novel/domain';

export interface ChapterScenePlanRepositoryPort {
  save(plan: ChapterScenePlan): void;
  /** 该 run 的最新场景计划（CHAPTER_PLAN 重跑时取最后一次） */
  getLatestByRun(projectId: string, graphRunId: string): ChapterScenePlan | null;
}

export interface ChapterCandidateRepositoryPort {
  save(candidate: ChapterCandidate): void;
  /** 当前候选：同 run 内修订号最大的一行 */
  getLatestByRun(projectId: string, graphRunId: string): ChapterCandidate | null;
  /** 同 run 现有最大修订号；无修订时返回 0（执行器 +1 作为新修订号） */
  getMaxRevisionNo(projectId: string, graphRunId: string): number;
  listByRun(projectId: string, graphRunId: string): ReadonlyArray<ChapterCandidate>;
  getByArtifactId(projectId: string, artifactId: string): ChapterCandidate | null;
}

export interface ChapterCritiqueRepositoryPort {
  save(critique: ChapterCritique): void;
  /** 某个候选修订的全部审查结论（改写 prompt 与候选界面消费） */
  listByCandidateRevision(
    projectId: string,
    graphRunId: string,
    candidateRevisionNo: number,
  ): ReadonlyArray<ChapterCritique>;
}

/** B10（D-B10-3）：候选 Gate 的改写意见持久化端口 */
export interface ChapterRewriteFeedbackRepositoryPort {
  save(feedback: ChapterRewriteFeedback): void;
  /** 某个候选修订上最新一条意见（同一修订可被多次提交，取最后一条） */
  getLatestForRevision(
    projectId: string,
    graphRunId: string,
    candidateRevisionNo: number,
  ): ChapterRewriteFeedback | null;
}

/** 当前候选正文（无候选时 null） */
export function getCurrentChapterCandidate(
  deps: { readonly candidateRepo: ChapterCandidateRepositoryPort },
  input: { readonly projectId: string; readonly graphRunId: string },
): ChapterCandidate | null {
  return deps.candidateRepo.getLatestByRun(input.projectId, input.graphRunId);
}

/** 当前候选对应的审查结论（无候选时空数组） */
export function listCurrentChapterCritiques(
  deps: {
    readonly candidateRepo: ChapterCandidateRepositoryPort;
    readonly critiqueRepo: ChapterCritiqueRepositoryPort;
  },
  input: { readonly projectId: string; readonly graphRunId: string },
): ReadonlyArray<ChapterCritique> {
  const candidate = deps.candidateRepo.getLatestByRun(input.projectId, input.graphRunId);
  if (!candidate) return [];
  return deps.critiqueRepo.listByCandidateRevision(
    input.projectId,
    input.graphRunId,
    candidate.revisionNo,
  );
}
