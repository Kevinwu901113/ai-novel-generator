/**
 * @ai-novel/domain - Idea-to-Novel Artifact Invalidation Rules
 *
 * Artifact 依赖是严格单向的下游依赖链：
 *
 *   idea → creationSpec → researchBundle → storyBlueprint → generationRun → manuscript
 *
 * 上游 artifact 变化会使所有严格下游 artifact 失效；
 * 下游 artifact（如 manuscript）的用户编辑不会反向使上游失效。
 *
 * 纯函数 —— 不访问时间、UUID、文件系统、数据库或模型。
 */

import type { ArtifactKind } from './idea-to-novel-graph.js';
import type { ArtifactRef, IdeaToNovelGraphRunState } from './idea-to-novel-graph-state.js';

/**
 * 权威 artifact 的失效依赖顺序（严格单向）。
 *
 * 不含 manuscript：manuscript 是用户权威内容，不被任何上游变化失效。
 */
export const ARTIFACT_DOWNSTREAM_ORDER: readonly ArtifactKind[] = [
  'idea',
  'creationSpec',
  'researchBundle',
  'storyBlueprint',
  'generationRun',
];

/**
 * 计算某个 artifact 变化后的下游失效闭包。
 *
 * manuscript 是用户权威内容，不因任何上游变化失效，因此不在失效链内：
 * - creationSpec 变化 → [researchBundle, storyBlueprint, generationRun]；
 * - researchBundle 变化 → [storyBlueprint, generationRun]；
 * - storyBlueprint 变化 → [generationRun]；
 * - manuscript 变化 → []（用户编辑不反向使上游失效）；
 * - idea 变化 → [creationSpec, researchBundle, storyBlueprint, generationRun]。
 */
export function computeInvalidationClosure(changed: ArtifactKind): ReadonlyArray<ArtifactKind> {
  const idx = ARTIFACT_DOWNSTREAM_ORDER.indexOf(changed);
  if (idx < 0) return [];
  return ARTIFACT_DOWNSTREAM_ORDER.slice(idx + 1);
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
export function applyArtifactChange(
  state: IdeaToNovelGraphRunState,
  changed: ArtifactRef,
): IdeaToNovelGraphRunState {
  const nextArtifacts = { ...state.artifacts, [changed.kind]: changed };

  // 重新生成的 kind 不再失效
  const cleared = state.invalidatedArtifacts.filter((ref) => ref.kind !== changed.kind);

  const staleKinds = new Set(cleared.map((ref) => ref.kind));
  const additions: ArtifactRef[] = [];
  for (const kind of computeInvalidationClosure(changed.kind)) {
    if (staleKinds.has(kind)) continue;
    const current = state.artifacts[kind];
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
