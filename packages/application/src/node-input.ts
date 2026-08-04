/**
 * Node input snapshot / inputHash（RW-1 Rework, Blocker 6）。
 *
 * inputHash 必须绑定真实输入：graph identity + node activation + 相关 artifact/version +
 * chapter binding + invalidatedArtifacts。用于拒绝 stale result（上游 artifact 改变后旧结果不得 settlement）。
 * 不使用全局 run expectedVersion 做 stale 判断（fan-out 中其它 Critic settlement 会合法改变 run version）。
 */

import type { AnyIdeaToNovelRunState } from '@ai-novel/domain';
import { CHAPTER_GENERATION_GRAPH_ID } from '@ai-novel/domain';

/** 由 run 状态构造节点输入的确定性快照 */
export function computeNodeInputSnapshot(state: AnyIdeaToNovelRunState, nodeId: string): unknown {
  const base: Record<string, unknown> = {
    graphId: state.graphId,
    graphVersion: state.graphVersion,
    nodeId,
    artifacts: state.artifacts,
    invalidatedArtifacts: state.invalidatedArtifacts,
  };
  if (state.graphId === CHAPTER_GENERATION_GRAPH_ID) {
    const chapter = state as {
      creationSpecVersionId: string;
      researchBundleId: string | null;
      storyBlueprintId: string;
      blueprintChapterId: string;
    };
    return {
      ...base,
      creationSpecVersionId: chapter.creationSpecVersionId,
      researchBundleId: chapter.researchBundleId,
      storyBlueprintId: chapter.storyBlueprintId,
      blueprintChapterId: chapter.blueprintChapterId,
    };
  }
  return base;
}
