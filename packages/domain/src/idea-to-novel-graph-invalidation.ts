/**
 * @ai-novel/domain - Idea-to-Novel Artifact Invalidation Rules
 *
 * Artifact 依赖是严格单向的下游依赖链（由各 Graph 的 `artifactDownstreamOrder` 声明）：
 *
 *   Project：idea → creationSpec → researchBundle → storyBlueprint
 *   Chapter：generationRun → manuscript
 *
 * 上游 artifact 变化会使所有严格下游 artifact 失效；
 * 下游 artifact（如 manuscript）的用户编辑不会反向使上游失效。
 *
 * 纯函数 —— 不访问时间、UUID、文件系统、数据库或模型。
 */

import type { ArtifactKind } from './idea-to-novel-graph.js';
import type { AnyIdeaToNovelRunState, ArtifactRef } from './idea-to-novel-graph-state.js';

/**
 * 计算某个 artifact 变化后的下游失效闭包。
 *
 * `order` 是权威的 artifact 下游依赖顺序（来自 Graph 的 artifactDownstreamOrder）。
 * manuscript 是用户权威内容，不因任何上游变化失效，因此不在失效链内（各 Graph 的顺序不含它
 * 的下游）。
 */
export function computeInvalidationClosure(
  order: ReadonlyArray<ArtifactKind>,
  changed: ArtifactKind,
): ReadonlyArray<ArtifactKind> {
  const idx = order.indexOf(changed);
  if (idx < 0) return [];
  return order.slice(idx + 1);
}

/**
 * 应用一次 artifact 变化（新的权威 ref 生效）。
 *
 * - 更新 `artifacts[changed.kind]`；
 * - 若该 kind 此前已失效（重新生成后不再失效），从 invalidated 中清除；
 * - 把当前仍存在的严格下游权威 ref 加入 invalidatedArtifacts。
 *
 * 返回新状态；纯函数，不修改入参。
 */
export function applyArtifactChange<S extends AnyIdeaToNovelRunState>(
  state: S,
  changed: ArtifactRef,
  order: ReadonlyArray<ArtifactKind>,
): S {
  // 状态类型的 artifacts 只含本图槽位；changed.kind 由 graph-aware 校验保证 ∈ 本图槽位
  const nextArtifacts = {
    ...(state.artifacts as Readonly<Record<ArtifactKind, ArtifactRef | null>>),
    [changed.kind]: changed,
  } as S['artifacts'];

  // 重新生成的 kind 不再失效
  const cleared = state.invalidatedArtifacts.filter((ref) => ref.kind !== changed.kind);

  const staleKinds = new Set(cleared.map((ref) => ref.kind));
  const additions: ArtifactRef[] = [];
  const artifactsView = state.artifacts as Readonly<Record<ArtifactKind, ArtifactRef | null>>;
  for (const kind of computeInvalidationClosure(order, changed.kind)) {
    if (staleKinds.has(kind)) continue;
    const current = artifactsView[kind];
    if (current !== null) {
      additions.push(current);
      staleKinds.add(kind);
    }
  }

  return {
    ...state,
    artifacts: nextArtifacts,
    invalidatedArtifacts: [...cleared, ...additions],
  };
}
