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
  IDEA_TO_NOVEL_GRAPH_V1,
  possibleNextNodes,
  DRAFT,
  CRITIQUE_JOIN,
  REWRITE,
  CANDIDATE_GATE,
  CONTINUITY_CRITIC,
  SPEC_EXTRACT,
  ASK_QUESTION,
  COLLECT_ANSWER,
  type GraphNodeId,
} from './idea-to-novel-graph.js';
import {
  projectNodeToStage,
  workflowStageForNodeId,
  isValidWorkflowStage,
  NODE_TO_WORKFLOW_STAGE_V1,
} from './idea-to-novel-graph-stages.js';

describe('Stage 派生映射完整性', () => {
  it('图中每个节点都有 WorkflowStage 映射，且全部合法', () => {
    for (const node of IDEA_TO_NOVEL_GRAPH_V1.nodes) {
      const stage = workflowStageForNodeId(node.id);
      expect(stage, `节点 ${node.id}`).toBeDefined();
      expect(isValidWorkflowStage(stage)).toBe(true);
    }
  });

  it('projectNodeToStage 对图中节点成功，对未知节点抛错', () => {
    expect(projectNodeToStage(IDEA_TO_NOVEL_GRAPH_V1, DRAFT)).toBe('generate');
    expect(() =>
      projectNodeToStage(IDEA_TO_NOVEL_GRAPH_V1, 'NO_SUCH_NODE' as GraphNodeId),
    ).toThrow();
  });
});

describe('多个节点可映射到同一 WorkflowStage', () => {
  it('clarify 阶段包含 3 个节点（抽取/追问/回答）', () => {
    const inClarify = [SPEC_EXTRACT, ASK_QUESTION, COLLECT_ANSWER];
    for (const id of inClarify) {
      expect(projectNodeToStage(IDEA_TO_NOVEL_GRAPH_V1, id)).toBe('clarify');
    }
  });

  it('generate 阶段包含 8 个节点，且阶段数(7)远小于节点数(20)——证明不是把图压成 5 个 stage', () => {
    const generateNodes = IDEA_TO_NOVEL_GRAPH_V1.nodes.filter(
      (n) => projectNodeToStage(IDEA_TO_NOVEL_GRAPH_V1, n.id) === 'generate',
    );
    expect(generateNodes.length).toBeGreaterThanOrEqual(8);
    const stageCount = new Set(Object.values(NODE_TO_WORKFLOW_STAGE_V1)).size;
    expect(stageCount).toBe(7);
    expect(stageCount).toBeLessThan(IDEA_TO_NOVEL_GRAPH_V1.nodes.length);
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
    ].map((node) => ({ node, next: possibleNextNodes(IDEA_TO_NOVEL_GRAPH_V1, node).sort() }));

    for (const entry of generateGroup) {
      expect(projectNodeToStage(IDEA_TO_NOVEL_GRAPH_V1, entry.node)).toBe('generate');
    }
    const distinctNext = new Set(generateGroup.map((e) => JSON.stringify(e.next)));
    expect(distinctNext.size).toBeGreaterThan(1); // 同一 stage 内后继不一致
  });

  it('阶段转移信息完全来自边，不在阶段模块中（阶段不是图）', () => {
    // 阶段模块只导出投影函数与枚举，不导出任何 stage→node / stage→next-stage 函数。
    // 转移的唯一来源是 IDEA_TO_NOVEL_GRAPH_V1.edges，由 possibleNextNodes 读取。
    const edgeCount = IDEA_TO_NOVEL_GRAPH_V1.edges.length;
    expect(edgeCount).toBeGreaterThan(0);
    expect(possibleNextNodes(IDEA_TO_NOVEL_GRAPH_V1, DRAFT).length).toBeGreaterThan(0);
  });
});

describe('Renderer 不应根据 WorkflowStage 推导下一节点', () => {
  it('同一 stage 的下一节点集合出现分歧 → 必须用节点级 possibleNextNodes', () => {
    const nextOfDraft = possibleNextNodes(IDEA_TO_NOVEL_GRAPH_V1, DRAFT).sort();
    const nextOfJoin = possibleNextNodes(IDEA_TO_NOVEL_GRAPH_V1, CRITIQUE_JOIN).sort();
    // 两个节点同属 'generate' 阶段，但后继不同
    expect(projectNodeToStage(IDEA_TO_NOVEL_GRAPH_V1, DRAFT)).toBe(
      projectNodeToStage(IDEA_TO_NOVEL_GRAPH_V1, CRITIQUE_JOIN),
    );
    expect(nextOfDraft).not.toEqual(nextOfJoin);
    // 仅凭 'generate' 阶段无法得到唯一后继集合
    const stageOnlyNext = new Set<string>();
    for (const node of IDEA_TO_NOVEL_GRAPH_V1.nodes) {
      if (projectNodeToStage(IDEA_TO_NOVEL_GRAPH_V1, node.id) === 'generate') {
        for (const n of possibleNextNodes(IDEA_TO_NOVEL_GRAPH_V1, node.id)) stageOnlyNext.add(n);
      }
    }
    expect(stageOnlyNext.size).toBeGreaterThan(1);
  });

  it('WorkflowStage 枚举校验闭合', () => {
    expect(isValidWorkflowStage('generate')).toBe(true);
    expect(isValidWorkflowStage('done')).toBe(true);
    expect(isValidWorkflowStage('exported')).toBe(false);
    expect(isValidWorkflowStage(42)).toBe(false);
  });
});
