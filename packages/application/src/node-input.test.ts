/**
 * Canonical input contract / input snapshot 测试（RW-1-R5, Blocker 4）。
 *
 * 验证：
 * - snapshot 包含 activationNo（新 activation = 新输入）；
 * - 声明依赖的 outcome / budget / artifact / binding 变化 → snapshot 变化；
 * - **无关 fan-out 变化**（未声明的兄弟节点 outcome / artifact）→ snapshot 不变（契约即隔离边界）。
 */

import { describe, it, expect } from 'vitest';
import { createChapterRun, createProjectRun } from './index.js';
import { createTestDeps } from './graph-run-test-fakes.js';
import { computeNodeInputSnapshot, serializeInputSnapshot } from './node-input.js';
import { CHAPTER_GENERATION_GRAPH_V1, IDEA_TO_NOVEL_PROJECT_GRAPH_V1 } from '@ai-novel/domain';
import type { ChapterGenerationRunState, IdeaToNovelProjectRunState } from '@ai-novel/domain';

function snap(graph: unknown, state: unknown, nodeId: string, activationNo: number): string {
  return serializeInputSnapshot(
    computeNodeInputSnapshot(graph as never, state as never, nodeId, activationNo),
  );
}

describe('canonical input snapshot（节点 input 契约驱动）', () => {
  const base = createTestDeps();
  const projRun = createProjectRun(base.deps, { projectId: 'p1', idempotencyKey: 'inp-p' });
  const projState = projRun.run as IdeaToNovelProjectRunState;

  const chapRun = createChapterRun(base.deps, {
    projectId: 'p1',
    creationSpecVersionId: 'spec-1',
    researchBundleId: null,
    storyBlueprintId: 'bp-1',
    blueprintChapterId: 'ch-1',
    idempotencyKey: 'inp-c',
  });
  const chapState = chapRun.run as ChapterGenerationRunState;

  it('activationNo 参与 snapshot（同节点新 activation = 新输入）', () => {
    expect(snap(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, projState, 'IDEA_CAPTURE', 1)).not.toBe(
      snap(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, projState, 'IDEA_CAPTURE', 2),
    );
    expect(snap(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, projState, 'IDEA_CAPTURE', 1)).toBe(
      snap(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, projState, 'IDEA_CAPTURE', 1),
    );
  });

  it('声明 artifact 变化 → snapshot 变化（SPEC_EXTRACT requires idea）', () => {
    const withIdea = {
      ...projState,
      artifacts: { ...projState.artifacts, idea: { kind: 'idea', artifactId: 'idea-new' } },
    } as IdeaToNovelProjectRunState;
    expect(snap(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, projState, 'SPEC_EXTRACT', 1)).not.toBe(
      snap(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, withIdea, 'SPEC_EXTRACT', 1),
    );
  });

  it('声明 outcome 变化 → snapshot 变化（RESEARCH_PLAN requires RESEARCH_DECISION outcome）', () => {
    const withDecision = {
      ...projState,
      nodeOutcomes: {
        ...projState.nodeOutcomes,
        RESEARCH_DECISION: { condition: 'research_decision', value: 'deep' },
      },
    } as IdeaToNovelProjectRunState;
    const before = snap(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, projState, 'RESEARCH_PLAN', 1);
    const after = snap(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, withDecision, 'RESEARCH_PLAN', 1);
    expect(after).not.toBe(before);
  });

  it('声明 budget 变化 → snapshot 变化（RESEARCH_EXECUTE requires researchRetry）', () => {
    const withBudget = {
      ...projState,
      attemptBudget: { ...projState.attemptBudget, researchRetry: 1 },
    } as IdeaToNovelProjectRunState;
    expect(snap(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, projState, 'RESEARCH_EXECUTE', 1)).not.toBe(
      snap(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, withBudget, 'RESEARCH_EXECUTE', 1),
    );
  });

  it('声明 binding 变化 → snapshot 变化（CHAPTER_PLAN requiresBindings）', () => {
    const withBinding = {
      ...chapState,
      blueprintChapterId: 'ch-2',
    } as ChapterGenerationRunState;
    expect(snap(CHAPTER_GENERATION_GRAPH_V1, chapState, 'CHAPTER_PLAN', 1)).not.toBe(
      snap(CHAPTER_GENERATION_GRAPH_V1, withBinding, 'CHAPTER_PLAN', 1),
    );
  });

  it('无关 fan-out：未声明的兄弟节点 outcome 变化 → snapshot 不变', () => {
    // CONTINUITY_CRITIC 不声明任何 requiresOutcomes；STYLE_CRITIC 的 outcome 变化不应影响它
    const withSiblingOutcome = {
      ...chapState,
      nodeOutcomes: {
        ...chapState.nodeOutcomes,
        STYLE_CRITIC: { condition: 'critique_verdict', value: 'needs_rewrite' },
      },
    } as ChapterGenerationRunState;
    expect(snap(CHAPTER_GENERATION_GRAPH_V1, chapState, 'CONTINUITY_CRITIC', 1)).toBe(
      snap(CHAPTER_GENERATION_GRAPH_V1, withSiblingOutcome, 'CONTINUITY_CRITIC', 1),
    );
  });

  it('无关 fan-out：未声明的 artifact 槽位变化 → snapshot 不变（DRAFT 不声明 manuscript）', () => {
    const withManuscript = {
      ...chapState,
      artifacts: {
        ...chapState.artifacts,
        manuscript: { kind: 'manuscript', artifactId: 'ms-new' },
      },
    } as ChapterGenerationRunState;
    // DRAFT 只声明 generationRun；manuscript 槽位变化不影响 DRAFT snapshot
    expect(snap(CHAPTER_GENERATION_GRAPH_V1, chapState, 'DRAFT', 1)).toBe(
      snap(CHAPTER_GENERATION_GRAPH_V1, withManuscript, 'DRAFT', 1),
    );
  });

  it('声明 generationRun artifact 变化 → DRAFT snapshot 变化（rewrite 循环）', () => {
    const withDraft = {
      ...chapState,
      artifacts: {
        ...chapState.artifacts,
        generationRun: { kind: 'generationRun', artifactId: 'gen-new' },
      },
    } as ChapterGenerationRunState;
    expect(snap(CHAPTER_GENERATION_GRAPH_V1, chapState, 'DRAFT', 1)).not.toBe(
      snap(CHAPTER_GENERATION_GRAPH_V1, withDraft, 'DRAFT', 1),
    );
  });
});
