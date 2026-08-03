/**
 * Idea Intake 适配（GE-3）。
 *
 * 把现有 Grill 资产适配为真实 Idea Intake：
 * - `createIntakeSessionFromIdea`：把 `projects.initial_idea` 自动播种进 intake 会话目标
 *   （复用 grill_sessions，不新建表、不物理重命名）；
 * - `getActiveIntakeSession`：读取项目当前 intake 会话（供 Graph executor / renderer）；
 * - `propagateCreationSpecInvalidation`：CreationSpec 更新后按 Graph 规则失效下游
 *   （researchBundle / storyBlueprint），并重新播种 creationSpec artifact。
 *
 * 用户侧概念（session/proposal/字段锁）不暴露；内部保留 grill 命名。
 */

import type { GraphRunDeps } from './graph-run.js';
import { applyArtifactChange, listRuns } from './graph-run.js';
import type { GrillSessionDeps } from './grill-session.js';
import { createGrillSession, listGrillSessions, startGrillSession } from './grill-session.js';
import type { GrillSessionData } from './grill-types.js';

export interface IdeaIntakeDeps {
  readonly grillDeps: GrillSessionDeps;
  readonly graphDeps: GraphRunDeps;
}

export function createIntakeSessionFromIdea(
  deps: IdeaIntakeDeps,
  input: { readonly projectId: string; readonly initialIdea: string },
): GrillSessionData {
  const session = createGrillSession(deps.grillDeps, {
    projectId: input.projectId,
    goal: input.initialIdea,
  });
  return startGrillSession(deps.grillDeps, {
    sessionId: session.id,
    expectedVersion: session.version,
  });
}

export function getActiveIntakeSession(
  deps: IdeaIntakeDeps,
  input: { readonly projectId: string },
): GrillSessionData | null {
  const sessions = listGrillSessions(deps.grillDeps, { projectId: input.projectId });
  // 最新的 ACTIVE 会话（Idea Intake 访谈期间至多一个）
  const active = [...sessions]
    .filter((s) => s.status === 'ACTIVE')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return active[0] ?? null;
}

export interface PropagateSpecInvalidationResult {
  readonly runId: string;
  readonly invalidatedKinds: ReadonlyArray<string>;
}

/**
 * CreationSpec 更新后按 Graph 规则传播失效：对所有非终态 ProjectRun 应用
 * applyArtifactChange(creationSpec)，把 researchBundle / storyBlueprint 加入
 * invalidatedArtifacts（必须重新生成才能 PROJECT_READY）。
 */
export function propagateCreationSpecInvalidation(
  deps: IdeaIntakeDeps,
  input: { readonly projectId: string; readonly creationSpecVersionId: string },
): ReadonlyArray<PropagateSpecInvalidationResult> {
  const runs = listRuns(deps.graphDeps, { projectId: input.projectId });
  const results: PropagateSpecInvalidationResult[] = [];
  for (const record of runs) {
    if (record.kind !== 'project') continue;
    if (record.state.terminalStatus !== null) continue;
    const res = applyArtifactChange(deps.graphDeps, {
      projectId: input.projectId,
      runId: record.state.workflowRunId,
      artifactKind: 'creationSpec',
      artifactId: input.creationSpecVersionId,
      idempotencyKey: `spec-invalidate:${record.state.workflowRunId}:${input.creationSpecVersionId}`,
    });
    results.push({
      runId: record.state.workflowRunId,
      invalidatedKinds: res.run.invalidatedArtifacts.map((ref) => ref.kind),
    });
  }
  return results;
}
