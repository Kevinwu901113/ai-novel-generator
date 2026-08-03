/**
 * @ai-novel/domain - Idea-to-Novel Artifact Invalidation tests
 *
 * 覆盖级联失效规则（各 Graph 用自己的 artifactDownstreamOrder）：
 * - Project 顺序：idea → creationSpec → researchBundle → storyBlueprint；
 * - Chapter 顺序：generationRun → manuscript；
 * - Manuscript 用户编辑不会反向使上游 artifact 失效。
 */

import { describe, it, expect } from 'vitest';
import {
  computeInvalidationClosure,
  applyArtifactChange,
} from './idea-to-novel-graph-invalidation.js';
import {
  createProjectInitialRunState,
  artifactRef,
  type ArtifactKind,
  type IdeaToNovelProjectRunState,
  type ProjectId,
} from './index.js';
import {
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  PROJECT_ARTIFACT_DOWNSTREAM_ORDER,
  CHAPTER_ARTIFACT_DOWNSTREAM_ORDER,
  createWorkflowRunId,
} from './idea-to-novel-graph.js';

const G = IDEA_TO_NOVEL_PROJECT_GRAPH_V1;
const PROJECT_ORDER = PROJECT_ARTIFACT_DOWNSTREAM_ORDER;
const PROJECT_ID = 'project-1' as unknown as ProjectId;
const RUN_ID = createWorkflowRunId('run-1');

function fresh(): IdeaToNovelProjectRunState {
  return createProjectInitialRunState({
    graph: G,
    projectId: PROJECT_ID,
    workflowRunId: RUN_ID,
    createdAt: '2026-08-03T00:00:00.000Z',
  });
}

function kindsOf(state: IdeaToNovelProjectRunState): ReadonlyArray<ArtifactKind> {
  return state.invalidatedArtifacts.map((r) => r.kind).sort();
}

describe('computeInvalidationClosure', () => {
  it('下游闭包随 Project 顺序严格单向', () => {
    expect(computeInvalidationClosure(PROJECT_ORDER, 'idea')).toEqual([
      'creationSpec',
      'researchBundle',
      'storyBlueprint',
    ]);
    expect(computeInvalidationClosure(PROJECT_ORDER, 'creationSpec')).toEqual([
      'researchBundle',
      'storyBlueprint',
    ]);
    expect(computeInvalidationClosure(PROJECT_ORDER, 'researchBundle')).toEqual(['storyBlueprint']);
    expect(computeInvalidationClosure(PROJECT_ORDER, 'storyBlueprint')).toEqual([]);
    expect(computeInvalidationClosure(PROJECT_ORDER, 'generationRun')).toEqual([]);
  });

  it('Chapter 顺序：generationRun → manuscript', () => {
    expect(computeInvalidationClosure(CHAPTER_ARTIFACT_DOWNSTREAM_ORDER, 'generationRun')).toEqual([
      'manuscript',
    ]);
    expect(computeInvalidationClosure(CHAPTER_ARTIFACT_DOWNSTREAM_ORDER, 'manuscript')).toEqual([]);
  });
});

describe('applyArtifactChange 级联失效', () => {
  function seeded(): IdeaToNovelProjectRunState {
    let s = fresh();
    s = applyArtifactChange(s, artifactRef('idea', 'idea-1'), PROJECT_ORDER);
    s = applyArtifactChange(s, artifactRef('creationSpec', 'spec-1'), PROJECT_ORDER);
    s = applyArtifactChange(s, artifactRef('researchBundle', 'rb-1'), PROJECT_ORDER);
    s = applyArtifactChange(s, artifactRef('storyBlueprint', 'bp-1'), PROJECT_ORDER);
    return s;
  }

  it('CreationSpec 变化使 ResearchBundle / StoryBlueprint 失效', () => {
    const s = seeded();
    const next = applyArtifactChange(s, artifactRef('creationSpec', 'spec-2'), PROJECT_ORDER);
    expect(kindsOf(next)).toEqual(['researchBundle', 'storyBlueprint']);
    expect(next.artifacts.creationSpec?.artifactId).toBe('spec-2');
    // idea 不失效（上游）
    expect(next.invalidatedArtifacts.some((r) => r.kind === 'idea')).toBe(false);
  });

  it('ResearchBundle 变化使 StoryBlueprint 失效', () => {
    const s = seeded();
    const next = applyArtifactChange(s, artifactRef('researchBundle', 'rb-2'), PROJECT_ORDER);
    expect(kindsOf(next)).toEqual(['storyBlueprint']);
  });

  it('StoryBlueprint 变化（章节目：项目级无下游）', () => {
    const s = seeded();
    const next = applyArtifactChange(s, artifactRef('storyBlueprint', 'bp-2'), PROJECT_ORDER);
    expect(kindsOf(next)).toEqual([]);
  });

  it('重新生成某 artifact 会清除其自身失效，但下游继续失效（级联传播）', () => {
    let s = seeded();
    s = applyArtifactChange(s, artifactRef('creationSpec', 'spec-2'), PROJECT_ORDER);
    expect(kindsOf(s)).toEqual(['researchBundle', 'storyBlueprint']);

    s = applyArtifactChange(s, artifactRef('researchBundle', 'rb-2'), PROJECT_ORDER);
    expect(s.invalidatedArtifacts.some((r) => r.kind === 'researchBundle')).toBe(false);
    expect(kindsOf(s)).toEqual(['storyBlueprint']);
  });
});
