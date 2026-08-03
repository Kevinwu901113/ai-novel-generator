/**
 * @ai-novel/domain - WorkflowStage Projection tests
 *
 * 证明：
 * 1. 多个 Graph Node 可映射到同一 WorkflowStage；
 * 2. WorkflowStage 不能决定合法转移（阶段不是图）；
 * 3. Renderer 不应根据 WorkflowStage 推导下一节点 —— 必须用 possibleNextNodes。
 */

import { describe, it, expect } from 'vitest';
import {
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  CHAPTER_GENERATION_GRAPH_V1,
  possibleNextNodes,
  DRAFT,
  CRITIQUE_JOIN,
  REWRITE,
  CANDIDATE_GATE,
  CONTINUITY_CRITIC,
  SPEC_EXTRACT,
  ASK_QUESTION,
  COLLECT_ANSWER,
  INTAKE_ESCALATION,
  RESEARCH_ESCALATION,
  type GraphNodeId,
} from './idea-to-novel-graph.js';
import {
  projectNodeToStage,
  workflowStageForNodeId,
  isValidWorkflowStage,
  NODE_TO_WORKFLOW_STAGE_V1,
} from './idea-to-novel-graph-stages.js';

const BOTH_GRAPHS = [IDEA_TO_NOVEL_PROJECT_GRAPH_V1, CHAPTER_GENERATION_GRAPH_V1];

describe('Stage 派生映射完整性', () => {
  it('每张图中每个节点都有 WorkflowStage 映射，且全部合法', () => {
    for (const graph of BOTH_GRAPHS) {
      for (const node of graph.nodes) {
        const stage = workflowStageForNodeId(node.id);
        expect(stage, `节点 ${node.id}`).toBeDefined();
        expect(isValidWorkflowStage(stage)).toBe(true);
      }
    }
  });

  it('projectNodeToStage 对图中节点成功，对未知节点抛错', () => {
    expect(projectNodeToStage(CHAPTER_GENERATION_GRAPH_V1, DRAFT)).toBe('generate');
    expect(() =>
      projectNodeToStage(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, 'NO_SUCH_NODE' as GraphNodeId),
    ).toThrow();
  });
});

describe('多个节点可映射到同一 WorkflowStage', () => {
  it('clarify 阶段包含抽取/追问/回答/澄清升级', () => {
    const inClarify = [SPEC_EXTRACT, ASK_QUESTION, COLLECT_ANSWER, INTAKE_ESCALATION];
    for (const id of inClarify) {
      expect(projectNodeToStage(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, id)).toBe('clarify');
    }
  });

  it('research 阶段包含调研校验升级', () => {
    expect(projectNodeToStage(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, RESEARCH_ESCALATION)).toBe(
      'research',
    );
  });

  it('generate 阶段节点数远大于阶段数 —— 证明不是把图压成 5 个 stage', () => {
    const generateNodes = CHAPTER_GENERATION_GRAPH_V1.nodes.filter(
      (n) => projectNodeToStage(CHAPTER_GENERATION_GRAPH_V1, n.id) === 'generate',
    );
    expect(generateNodes.length).toBeGreaterThanOrEqual(8);
    const stageCount = new Set(Object.values(NODE_TO_WORKFLOW_STAGE_V1)).size;
    expect(stageCount).toBe(7);
    expect(stageCount).toBeLessThan(CHAPTER_GENERATION_GRAPH_V1.nodes.length);
  });
});

describe('WorkflowStage 不能决定合法转移', () => {
  it('同一阶段的节点后继集合互不相同 → 仅凭 stage 无法确定下一步', () => {
    const generateGroup: Array<{ node: GraphNodeId; next: ReadonlyArray<GraphNodeId> }> = [
      DRAFT,
      CONTINUITY_CRITIC,
      CRITIQUE_JOIN,
      REWRITE,
      CANDIDATE_GATE,
    ].map((node) => ({
      node,
      next: possibleNextNodes(CHAPTER_GENERATION_GRAPH_V1, node).sort(),
    }));

    for (const entry of generateGroup) {
      expect(projectNodeToStage(CHAPTER_GENERATION_GRAPH_V1, entry.node)).toBe('generate');
    }
    const distinctNext = new Set(generateGroup.map((e) => JSON.stringify(e.next)));
    expect(distinctNext.size).toBeGreaterThan(1); // 同一 stage 内后继不一致
  });
});

describe('Renderer 不应根据 WorkflowStage 推导下一节点', () => {
  it('同一 stage 的下一节点集合出现分歧 → 必须用节点级 possibleNextNodes', () => {
    const nextOfDraft = possibleNextNodes(CHAPTER_GENERATION_GRAPH_V1, DRAFT).sort();
    const nextOfJoin = possibleNextNodes(CHAPTER_GENERATION_GRAPH_V1, CRITIQUE_JOIN).sort();
    expect(projectNodeToStage(CHAPTER_GENERATION_GRAPH_V1, DRAFT)).toBe(
      projectNodeToStage(CHAPTER_GENERATION_GRAPH_V1, CRITIQUE_JOIN),
    );
    expect(nextOfDraft).not.toEqual(nextOfJoin);
  });

  it('WorkflowStage 枚举校验闭合', () => {
    expect(isValidWorkflowStage('generate')).toBe(true);
    expect(isValidWorkflowStage('done')).toBe(true);
    expect(isValidWorkflowStage('exported')).toBe(false);
    expect(isValidWorkflowStage(42)).toBe(false);
  });
});
