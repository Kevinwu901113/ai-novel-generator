/**
 * @ai-novel/domain - Idea-to-Novel Artifact Invalidation tests
 *
 * 覆盖任务要求的级联失效规则：
 * - CreationSpec 变化使 ResearchBundle、StoryBlueprint、GenerationRun 失效；
 * - ResearchBundle 变化使 StoryBlueprint、GenerationRun 失效；
 * - StoryBlueprint 变化使 GenerationRun 失效；
 * - Manuscript 用户编辑不会反向使上游 artifact 失效。
 */

import { describe, it, expect } from 'vitest';
import {
  computeInvalidationClosure,
  applyArtifactChange,
} from './idea-to-novel-graph-invalidation.js';
import {
  createInitialRunState,
  artifactRef,
  type ArtifactKind,
  type IdeaToNovelGraphRunState,
  type ProjectId,
} from './index.js';
import { IDEA_TO_NOVEL_GRAPH_V1, createWorkflowRunId } from './idea-to-novel-graph.js';

const G = IDEA_TO_NOVEL_GRAPH_V1;
const PROJECT_ID = 'project-1' as unknown as ProjectId;
const RUN_ID = createWorkflowRunId('run-1');

function fresh(): IdeaToNovelGraphRunState {
  return createInitialRunState({
    graph: G,
    projectId: PROJECT_ID,
    workflowRunId: RUN_ID,
    createdAt: '2026-08-03T00:00:00.000Z',
  });
}

function kindsOf(state: IdeaToNovelGraphRunState): ReadonlyArray<ArtifactKind> {
  return state.invalidatedArtifacts.map((r) => r.kind).sort();
}

describe('computeInvalidationClosure', () => {
  it('下游闭包随层级严格单向', () => {
    expect(computeInvalidationClosure('idea')).toEqual([
      'creationSpec',
      'researchBundle',
      'storyBlueprint',
      'generationRun',
    ]);
    expect(computeInvalidationClosure('creationSpec')).toEqual([
      'researchBundle',
      'storyBlueprint',
      'generationRun',
    ]);
    expect(computeInvalidationClosure('researchBundle')).toEqual([
      'storyBlueprint',
      'generationRun',
    ]);
    expect(computeInvalidationClosure('storyBlueprint')).toEqual(['generationRun']);
    expect(computeInvalidationClosure('generationRun')).toEqual([]);
    expect(computeInvalidationClosure('manuscript')).toEqual([]);
  });
});

describe('applyArtifactChange 级联失效', () => {
  function seeded(): IdeaToNovelGraphRunState {
    let s = fresh();
    s = applyArtifactChange(s, artifactRef('idea', 'idea-1'));
    s = applyArtifactChange(s, artifactRef('creationSpec', 'spec-1'));
    s = applyArtifactChange(s, artifactRef('researchBundle', 'rb-1'));
    s = applyArtifactChange(s, artifactRef('storyBlueprint', 'bp-1'));
    s = applyArtifactChange(s, artifactRef('generationRun', 'gen-1'));
    s = applyArtifactChange(s, artifactRef('manuscript', 'ms-1'));
    return s;
  }

  it('CreationSpec 变化使 ResearchBundle / StoryBlueprint / GenerationRun 失效', () => {
    const s = seeded();
    const next = applyArtifactChange(s, artifactRef('creationSpec', 'spec-2'));
    expect(kindsOf(next)).toEqual(['generationRun', 'researchBundle', 'storyBlueprint']);
    expect(next.artifacts.creationSpec?.artifactId).toBe('spec-2');
    // idea 与 manuscript 不失效
    expect(next.invalidatedArtifacts.some((r) => r.kind === 'idea')).toBe(false);
    expect(next.invalidatedArtifacts.some((r) => r.kind === 'manuscript')).toBe(false);
  });

  it('ResearchBundle 变化使 StoryBlueprint / GenerationRun 失效', () => {
    const s = seeded();
    const next = applyArtifactChange(s, artifactRef('researchBundle', 'rb-2'));
    expect(kindsOf(next)).toEqual(['generationRun', 'storyBlueprint']);
  });

  it('StoryBlueprint 变化使 GenerationRun 失效', () => {
    const s = seeded();
    const next = applyArtifactChange(s, artifactRef('storyBlueprint', 'bp-2'));
    expect(kindsOf(next)).toEqual(['generationRun']);
  });

  it('Manuscript 用户编辑不会反向使上游 artifact 失效', () => {
    const s = seeded();
    const next = applyArtifactChange(s, artifactRef('manuscript', 'ms-2'));
    expect(kindsOf(next)).toEqual([]);
    expect(next.artifacts.creationSpec?.artifactId).toBe('spec-1'); // 上游引用不变
    expect(next.artifacts.generationRun?.artifactId).toBe('gen-1');
  });

  it('重新生成某 artifact 会清除其自身失效，但下游继续失效（级联传播）', () => {
    let s = seeded();
    s = applyArtifactChange(s, artifactRef('creationSpec', 'spec-2'));
    expect(kindsOf(s)).toEqual(['generationRun', 'researchBundle', 'storyBlueprint']);

    s = applyArtifactChange(s, artifactRef('researchBundle', 'rb-2'));
    expect(s.invalidatedArtifacts.some((r) => r.kind === 'researchBundle')).toBe(false);
    expect(kindsOf(s)).toEqual(['generationRun', 'storyBlueprint']);
  });
});
