/**
 * @ai-novel/domain - Idea-to-Novel WorkflowStage Projection
 *
 * `WorkflowStage` 是**纯派生**的 UI 阶段：只由节点 id → 阶段的投影函数产出。
 *
 * 约束（由测试证明）：
 * - 多个 Graph Node 可映射到同一 WorkflowStage（many-to-one）；
 * - WorkflowStage 不能决定合法转移（阶段不是图）；
 * - Renderer 不应根据 WorkflowStage 推导下一节点 —— 必须用 `possibleNextNodes`。
 *
 * Project / Chapter 两张 Graph 的节点 id 互不相同，共用同一张派生表。
 * Graph Definition 本身不含 stage 字段；本模块是唯一派生来源。
 */

import {
  IDEA_CAPTURE,
  SPEC_EXTRACT,
  ASK_QUESTION,
  COLLECT_ANSWER,
  INTAKE_ESCALATION,
  RESEARCH_DECISION,
  RESEARCH_PLAN,
  RESEARCH_EXECUTE,
  RESEARCH_VALIDATE,
  RESEARCH_ESCALATION,
  BLUEPRINT_GENERATE,
  BLUEPRINT_USER_GATE,
  BLUEPRINT_ESCALATION,
  PROJECT_READY,
  PROJECT_CANCELLED,
  PROJECT_BLOCKED,
  CHAPTER_PLAN,
  DRAFT,
  CONTINUITY_CRITIC,
  STYLE_CRITIC,
  REQUIREMENT_CRITIC,
  CRITIQUE_JOIN,
  REWRITE,
  CANDIDATE_GATE,
  CANDIDATE_ESCALATION,
  MANUSCRIPT_COMMIT,
  CHAPTER_READY,
  CHAPTER_CANCELLED,
  CHAPTER_BLOCKED,
  type AnyIdeaToNovelGraphV1,
  type GraphNodeId,
} from './idea-to-novel-graph.js';

/** UI 阶段（派生，非图） */
export type WorkflowStage =
  | 'idea' // 想法捕获
  | 'clarify' // 澄清追问
  | 'research' // 调研
  | 'blueprint' // 故事蓝图
  | 'generate' // 生成
  | 'manuscript' // 稿件
  | 'done'; // 完成/导出

/** 节点 → UI 阶段派生表（唯一权威来源，键使用导出的品牌常量） */
export const NODE_TO_WORKFLOW_STAGE_V1: Readonly<Record<string, WorkflowStage>> = {
  // Project：Idea Intake
  [IDEA_CAPTURE]: 'idea',
  [SPEC_EXTRACT]: 'clarify',
  [ASK_QUESTION]: 'clarify',
  [COLLECT_ANSWER]: 'clarify',
  [INTAKE_ESCALATION]: 'clarify',
  // Project：Research
  [RESEARCH_DECISION]: 'research',
  [RESEARCH_PLAN]: 'research',
  [RESEARCH_EXECUTE]: 'research',
  [RESEARCH_VALIDATE]: 'research',
  [RESEARCH_ESCALATION]: 'research',
  // Project：Blueprint
  [BLUEPRINT_GENERATE]: 'blueprint',
  [BLUEPRINT_USER_GATE]: 'blueprint',
  [BLUEPRINT_ESCALATION]: 'blueprint',
  // Project：终止
  [PROJECT_READY]: 'done',
  [PROJECT_CANCELLED]: 'done',
  [PROJECT_BLOCKED]: 'done',
  // Chapter：生成
  [CHAPTER_PLAN]: 'generate',
  [DRAFT]: 'generate',
  [CONTINUITY_CRITIC]: 'generate',
  [STYLE_CRITIC]: 'generate',
  [REQUIREMENT_CRITIC]: 'generate',
  [CRITIQUE_JOIN]: 'generate',
  [REWRITE]: 'generate',
  [CANDIDATE_GATE]: 'generate',
  [CANDIDATE_ESCALATION]: 'generate',
  // Chapter：稿件
  [MANUSCRIPT_COMMIT]: 'manuscript',
  // Chapter：终止
  [CHAPTER_READY]: 'done',
  [CHAPTER_CANCELLED]: 'done',
  [CHAPTER_BLOCKED]: 'done',
};

/** 阶段闭合枚举校验 */
export function isValidWorkflowStage(value: unknown): value is WorkflowStage {
  return (
    value === 'idea' ||
    value === 'clarify' ||
    value === 'research' ||
    value === 'blueprint' ||
    value === 'generate' ||
    value === 'manuscript' ||
    value === 'done'
  );
}

/**
 * 查询某节点的阶段；未映射时返回 undefined（validator 用于 fail-closed）。
 *
 * 使用 hasOwnProperty 防止原型键（__proto__ / constructor / toString）命中继承属性。
 */
export function workflowStageForNodeId(nodeId: GraphNodeId): WorkflowStage | undefined {
  if (!Object.prototype.hasOwnProperty.call(NODE_TO_WORKFLOW_STAGE_V1, nodeId)) return undefined;
  return NODE_TO_WORKFLOW_STAGE_V1[nodeId];
}

/**
 * 把节点投影为 UI 阶段。
 *
 * 图中每个节点都必须有映射；未映射时抛出（fail fast）。
 * Renderer 用它显示节点所属阶段，但不得用它推导下一节点。
 */
export function projectNodeToStage(
  graph: AnyIdeaToNovelGraphV1,
  nodeId: GraphNodeId,
): WorkflowStage {
  if (!graph.nodes.some((n) => n.id === nodeId)) {
    throw new Error(`节点不存在于图中: ${nodeId}`);
  }
  const stage = NODE_TO_WORKFLOW_STAGE_V1[nodeId];
  if (!stage) {
    throw new Error(`节点 ${nodeId} 没有 WorkflowStage 映射`);
  }
  return stage;
}
