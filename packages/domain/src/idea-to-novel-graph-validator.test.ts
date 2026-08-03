/**
 * @ai-novel/domain - Idea-to-Novel Graph Validator tests（required + exact，fail-closed）
 *
 * 覆盖：
 * - 两张权威 Graph 通过静态校验；
 * - Graph required-field 删除矩阵：删除任何必需字段都返回稳定 MISSING_* 错误码且不抛异常；
 * - malformed 输入矩阵：nodes/edges 含 null / 混合损坏 / 自定义原型，永不抛异常、永不返回 valid；
 * - 自定义 prototype 拒绝；
 * - unknown keys 拒绝；
 * - 字符串字段（非空 / 首尾空白 / 长度上限）；
 * - artifactKinds / budgetKeys / artifactDownstreamOrder 完整性；
 * - 预算耗尽出口业务条件合取（BUDGET_EXIT_CONDITION_MISMATCH / BUDGET_EXIT_NOT_BOUND）；
 * - 循环、覆盖、可达性等既有语义校验保留。
 */

import { describe, it, expect } from 'vitest';
import {
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  CHAPTER_GENERATION_GRAPH_V1,
  BLUEPRINT_USER_GATE,
  CRITIQUE_JOIN,
} from './idea-to-novel-graph.js';
import {
  validateIdeaToNovelProjectGraphV1,
  isValidIdeaToNovelProjectGraphV1,
  isValidChapterGenerationGraphV1,
  type GraphValidationError,
  type GraphValidationErrorCode,
} from './idea-to-novel-graph-validator.js';

function cloneGraph<T>(g: T): T {
  return JSON.parse(JSON.stringify(g)) as T;
}

function projectGraph(): Record<string, unknown> {
  return cloneGraph(IDEA_TO_NOVEL_PROJECT_GRAPH_V1) as Record<string, unknown>;
}

function chapterGraph(): Record<string, unknown> {
  return cloneGraph(CHAPTER_GENERATION_GRAPH_V1) as Record<string, unknown>;
}

function without(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

function deleteNodeField(
  g: Record<string, unknown>,
  nodeId: string,
  field: string,
): Record<string, unknown> {
  const nodes = (g.nodes as Array<Record<string, unknown>>).map((n) => {
    if (n.id !== nodeId) return n;
    const copy = { ...n };
    delete copy[field];
    return copy;
  });
  return { ...g, nodes };
}

function deleteOutputField(
  g: Record<string, unknown>,
  nodeId: string,
  field: string,
): Record<string, unknown> {
  const nodes = (g.nodes as Array<Record<string, unknown>>).map((n) => {
    if (n.id !== nodeId) return n;
    const copy = { ...n, output: { ...(n.output as Record<string, unknown>) } };
    delete copy.output[field];
    return copy;
  });
  return { ...g, nodes };
}

function deleteJoinField(
  g: Record<string, unknown>,
  nodeId: string,
  field: string,
): Record<string, unknown> {
  const nodes = (g.nodes as Array<Record<string, unknown>>).map((n) => {
    if (n.id !== nodeId) return n;
    const copy = { ...n, join: { ...(n.join as Record<string, unknown>) } };
    delete copy.join[field];
    return copy;
  });
  return { ...g, nodes };
}

function deleteEdgeField(
  g: Record<string, unknown>,
  edgeId: string,
  field: string,
): Record<string, unknown> {
  const edges = (g.edges as Array<Record<string, unknown>>).map((e) => {
    if (e.id !== edgeId) return e;
    const copy = { ...e };
    delete copy[field];
    return copy;
  });
  return { ...g, edges };
}

function deleteLoopField(
  g: Record<string, unknown>,
  edgeId: string,
  field: string,
): Record<string, unknown> {
  const edges = (g.edges as Array<Record<string, unknown>>).map((e) => {
    if (e.id !== edgeId) return e;
    const copy = { ...e, loop: { ...(e.loop as Record<string, unknown>) } };
    delete copy.loop[field];
    return copy;
  });
  return { ...g, edges };
}

function deleteRequirementField(
  g: Record<string, unknown>,
  edgeId: string,
  index: number,
  field: string,
): Record<string, unknown> {
  const edges = (g.edges as Array<Record<string, unknown>>).map((e) => {
    if (e.id !== edgeId) return e;
    const reqs = (e.requiredOutcomes as Array<Record<string, unknown>>).map((r, i) => {
      if (i !== index) return r;
      const copy = { ...r };
      delete copy[field];
      return copy;
    });
    return { ...e, requiredOutcomes: reqs };
  });
  return { ...g, edges };
}

/** 校验损坏图：不抛异常、返回至少一条错误、指定错误码出现 */
function expectBroken(
  g: Record<string, unknown>,
  code: GraphValidationErrorCode,
): ReadonlyArray<GraphValidationError> {
  const errors = validateIdeaToNovelProjectGraphV1(g as never);
  expect(() => validateIdeaToNovelProjectGraphV1(g as never)).not.toThrow();
  expect(errors.length).toBeGreaterThan(0);
  expect(isValidIdeaToNovelProjectGraphV1(g as never)).toBe(false);
  expect(errors.map((e) => e.code)).toContain(code);
  return errors;
}

const BLUEPRINT_USER_GATE_ID = String(BLUEPRINT_USER_GATE);
const CRITIQUE_JOIN_ID = String(CRITIQUE_JOIN);

describe('两张权威 Graph 通过静态校验', () => {
  it('Project Graph valid', () => {
    expect(isValidIdeaToNovelProjectGraphV1(IDEA_TO_NOVEL_PROJECT_GRAPH_V1)).toBe(true);
  });

  it('Chapter Graph valid', () => {
    expect(isValidChapterGenerationGraphV1(CHAPTER_GENERATION_GRAPH_V1)).toBe(true);
  });
});

describe('Graph required-field 删除矩阵', () => {
  it('删除 graph.id / graph.version / graph.entryNodeId → MISSING_GRAPH_KEY', () => {
    expectBroken(without(projectGraph(), 'id'), 'MISSING_GRAPH_KEY');
    expectBroken(without(projectGraph(), 'version'), 'MISSING_GRAPH_KEY');
    expectBroken(without(projectGraph(), 'entryNodeId'), 'MISSING_GRAPH_KEY');
  });

  it('删除 node.id / node.kind / node.label / node.output → MISSING_NODE_KEY', () => {
    expectBroken(deleteNodeField(projectGraph(), BLUEPRINT_USER_GATE_ID, 'id'), 'MISSING_NODE_KEY');
    expectBroken(
      deleteNodeField(projectGraph(), BLUEPRINT_USER_GATE_ID, 'kind'),
      'MISSING_NODE_KEY',
    );
    expectBroken(
      deleteNodeField(projectGraph(), BLUEPRINT_USER_GATE_ID, 'label'),
      'MISSING_NODE_KEY',
    );
    expectBroken(
      deleteNodeField(projectGraph(), BLUEPRINT_USER_GATE_ID, 'output'),
      'MISSING_NODE_KEY',
    );
  });

  it('删除 edge.id / edge.from / edge.to / edge.kind / edge.mode → MISSING_EDGE_KEY', () => {
    const edgeId = 'blueprint-user-gate--project-ready-accept';
    expectBroken(deleteEdgeField(projectGraph(), edgeId, 'id'), 'MISSING_EDGE_KEY');
    expectBroken(deleteEdgeField(projectGraph(), edgeId, 'from'), 'MISSING_EDGE_KEY');
    expectBroken(deleteEdgeField(projectGraph(), edgeId, 'to'), 'MISSING_EDGE_KEY');
    expectBroken(deleteEdgeField(projectGraph(), edgeId, 'kind'), 'MISSING_EDGE_KEY');
    expectBroken(deleteEdgeField(projectGraph(), edgeId, 'mode'), 'MISSING_EDGE_KEY');
  });

  it('删除 output.outputRequired → MISSING_OUTPUT_KEY', () => {
    expectBroken(
      deleteOutputField(projectGraph(), BLUEPRINT_USER_GATE_ID, 'outputRequired'),
      'MISSING_OUTPUT_KEY',
    );
  });

  it('删除 join.requiredIncoming → MISSING_JOIN_KEY', () => {
    expectBroken(
      deleteJoinField(chapterGraph(), CRITIQUE_JOIN_ID, 'requiredIncoming'),
      'MISSING_JOIN_KEY',
    );
  });

  it('删除 loop.budget / loop.maxIterations → MISSING_LOOP_KEY', () => {
    const loopEdge = 'spec-extract--ask-question';
    expectBroken(deleteLoopField(projectGraph(), loopEdge, 'budget'), 'MISSING_LOOP_KEY');
    expectBroken(deleteLoopField(projectGraph(), loopEdge, 'maxIterations'), 'MISSING_LOOP_KEY');
  });

  it('删除 requirement.condition / requirement.expectedOutcome → MISSING_REQUIREMENT_KEY', () => {
    const condEdge = 'blueprint-user-gate--project-ready-accept';
    expectBroken(
      deleteRequirementField(projectGraph(), condEdge, 0, 'condition'),
      'MISSING_REQUIREMENT_KEY',
    );
    expectBroken(
      deleteRequirementField(projectGraph(), condEdge, 0, 'expectedOutcome'),
      'MISSING_REQUIREMENT_KEY',
    );
  });

  it('删除 joinAggregationPolicy.kind / .sources / .rule → MISSING_JOIN_POLICY_KEY', () => {
    const g = chapterGraph();
    const originalNodes = g.nodes as Array<Record<string, unknown>>;
    for (const field of ['kind', 'sources', 'rule']) {
      const nodes = originalNodes.map((n) => {
        if (n.id !== CRITIQUE_JOIN_ID) return n;
        const policy = { ...(n.joinAggregationPolicy as Record<string, unknown>) };
        delete policy[field];
        return { ...n, joinAggregationPolicy: policy };
      });
      expectBroken({ ...g, nodes }, 'MISSING_JOIN_POLICY_KEY');
    }
  });
});

describe('malformed 输入矩阵（永不抛异常、永不返回 valid）', () => {
  it('nodes:[null] / edges:[null] / 空数组 → MALFORMED_GRAPH 且不抛', () => {
    expectBroken({ ...projectGraph(), nodes: [null] }, 'MALFORMED_GRAPH');
    expectBroken({ ...projectGraph(), edges: [null] }, 'MALFORMED_GRAPH');
    expectBroken({ ...projectGraph(), nodes: [], edges: [] }, 'MALFORMED_GRAPH');
  });

  it('混合损坏条目不抛异常', () => {
    const g = projectGraph();
    const nodes = g.nodes as Array<Record<string, unknown>>;
    const edges = g.edges as Array<Record<string, unknown>>;
    const mixed = {
      ...g,
      nodes: [...nodes.slice(0, 3), null, ...nodes.slice(3)],
      edges: [...edges.slice(0, 2), null, 'not-an-object', ...edges.slice(2)],
    };
    const errors = validateIdeaToNovelProjectGraphV1(mixed as never);
    expect(() => validateIdeaToNovelProjectGraphV1(mixed as never)).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.code)).toContain('MALFORMED_GRAPH');
  });

  it('graph 不是对象 / 是数组 / 是 null → MALFORMED_GRAPH', () => {
    expect(() => validateIdeaToNovelProjectGraphV1(null as never)).not.toThrow();
    expect(() => validateIdeaToNovelProjectGraphV1([] as never)).not.toThrow();
    expect(() => validateIdeaToNovelProjectGraphV1('graph' as never)).not.toThrow();
    expect(validateIdeaToNovelProjectGraphV1(null as never).length).toBeGreaterThan(0);
  });

  it('node.output 非对象 → INVALID_OUTPUT_CONTRACT', () => {
    const g = projectGraph();
    g.nodes = (g.nodes as Array<Record<string, unknown>>).map((n) =>
      n.id === BLUEPRINT_USER_GATE_ID ? { ...n, output: null } : n,
    );
    expectBroken(g as Record<string, unknown>, 'INVALID_OUTPUT_CONTRACT');
  });

  it('node.join 非对象 → JOIN_DECLARATION_MISMATCH；edge.loop 非对象 → INVALID_LOOP_MAX', () => {
    const g1 = chapterGraph();
    g1.nodes = (g1.nodes as Array<Record<string, unknown>>).map((n) =>
      n.id === CRITIQUE_JOIN_ID ? { ...n, join: null } : n,
    );
    expectBroken(g1 as Record<string, unknown>, 'JOIN_DECLARATION_MISMATCH');

    const g2 = projectGraph();
    g2.edges = (g2.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'spec-extract--ask-question' ? { ...e, loop: null } : e,
    );
    expectBroken(g2 as Record<string, unknown>, 'INVALID_LOOP_MAX');
  });

  it('edge.requiredOutcomes 含非对象 → UNKNOWN_REQUIREMENT_KEY', () => {
    const g = projectGraph();
    g.edges = (g.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'blueprint-user-gate--project-ready-accept' ? { ...e, requiredOutcomes: [null] } : e,
    );
    expectBroken(g as Record<string, unknown>, 'UNKNOWN_REQUIREMENT_KEY');
  });

  it('非法 kind / edge kind / edge mode → INVALID_NODE_KIND / INVALID_EDGE_KIND / INVALID_EDGE_MODE', () => {
    const g1 = projectGraph();
    g1.nodes = (g1.nodes as Array<Record<string, unknown>>).map((n) =>
      n.id === BLUEPRINT_USER_GATE_ID ? { ...n, kind: 'NOT_A_KIND' } : n,
    );
    expectBroken(g1 as Record<string, unknown>, 'INVALID_NODE_KIND');

    const g2 = projectGraph();
    g2.edges = (g2.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'blueprint-user-gate--project-ready-accept' ? { ...e, kind: 'dynamic' } : e,
    );
    expectBroken(g2 as Record<string, unknown>, 'INVALID_EDGE_KIND');

    const g3 = projectGraph();
    g3.edges = (g3.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'blueprint-user-gate--project-ready-accept' ? { ...e, mode: 'fan' } : e,
    );
    expectBroken(g3 as Record<string, unknown>, 'INVALID_EDGE_MODE');
  });
});

describe('自定义 prototype 拒绝', () => {
  it('graph 自定义原型 → MALFORMED_GRAPH', () => {
    const g = Object.create({ evil: true });
    g.id = 'x';
    g.version = 'v1';
    g.kind = 'project';
    g.entryNodeId = 'A';
    g.nodes = [];
    g.edges = [];
    g.artifactKinds = [];
    g.budgetKeys = [];
    g.artifactDownstreamOrder = [];
    const errors = validateIdeaToNovelProjectGraphV1(g as never);
    expect(() => validateIdeaToNovelProjectGraphV1(g as never)).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.code)).toContain('MALFORMED_GRAPH');
  });

  it('node 自定义原型条目 → MALFORMED_GRAPH', () => {
    const g = projectGraph();
    const evil = Object.create({ hidden: 'x' });
    evil.id = 'EVIL_NODE';
    evil.kind = 'DECISION';
    evil.label = 'evil';
    evil.output = {
      requiredOutcomeCondition: null,
      allowedArtifactKind: null,
      outputRequired: false,
    };
    g.nodes = [...(g.nodes as Array<unknown>), evil];
    expectBroken(g as Record<string, unknown>, 'MALFORMED_GRAPH');
  });

  it('原型键（constructor）作条件名被拒', () => {
    const g = projectGraph();
    g.edges = (g.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'blueprint-user-gate--project-ready-accept'
        ? { ...e, requiredOutcomes: [{ condition: 'constructor', expectedOutcome: 'accept' }] }
        : e,
    );
    const errors = validateIdeaToNovelProjectGraphV1(g as never);
    expect(errors.map((e) => e.code)).toContain('UNKNOWN_CONDITION');
  });
});

describe('unknown keys 拒绝', () => {
  it('graph / node / edge / output / join / loop / requirement 的未知键', () => {
    expectBroken({ ...projectGraph(), extra: 1 }, 'UNKNOWN_GRAPH_KEY');

    const g1 = projectGraph();
    g1.nodes = (g1.nodes as Array<Record<string, unknown>>).map((n) =>
      n.id === BLUEPRINT_USER_GATE_ID ? { ...n, extraNode: 1 } : n,
    );
    expectBroken(g1 as Record<string, unknown>, 'UNKNOWN_NODE_KEY');

    const g2 = projectGraph();
    g2.edges = (g2.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'blueprint-user-gate--project-ready-accept' ? { ...e, extraEdge: 1 } : e,
    );
    expectBroken(g2 as Record<string, unknown>, 'UNKNOWN_EDGE_KEY');

    const g3 = projectGraph();
    g3.nodes = (g3.nodes as Array<Record<string, unknown>>).map((n) =>
      n.id === BLUEPRINT_USER_GATE_ID
        ? { ...n, output: { ...(n.output as Record<string, unknown>), extraOutput: 1 } }
        : n,
    );
    expectBroken(g3 as Record<string, unknown>, 'UNKNOWN_OUTPUT_KEY');

    const g4 = chapterGraph();
    g4.nodes = (g4.nodes as Array<Record<string, unknown>>).map((n) =>
      n.id === CRITIQUE_JOIN_ID
        ? { ...n, join: { ...(n.join as Record<string, unknown>), extraJoin: 1 } }
        : n,
    );
    expectBroken(g4 as Record<string, unknown>, 'UNKNOWN_JOIN_KEY');

    const g5 = projectGraph();
    g5.edges = (g5.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'spec-extract--ask-question'
        ? { ...e, loop: { ...(e.loop as Record<string, unknown>), extraLoop: 1 } }
        : e,
    );
    expectBroken(g5 as Record<string, unknown>, 'UNKNOWN_LOOP_KEY');

    const g6 = projectGraph();
    g6.edges = (g6.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'blueprint-user-gate--project-ready-accept'
        ? {
            ...e,
            requiredOutcomes: [
              { condition: 'blueprint_gate', expectedOutcome: 'accept', extraReq: 1 },
            ],
          }
        : e,
    );
    expectBroken(g6 as Record<string, unknown>, 'UNKNOWN_REQUIREMENT_KEY');
  });
});

describe('字符串字段校验', () => {
  it('id / label 非空、无首尾空白、长度上限', () => {
    const g1 = projectGraph();
    g1.nodes = (g1.nodes as Array<Record<string, unknown>>).map((n) =>
      n.id === BLUEPRINT_USER_GATE_ID ? { ...n, id: '   ' } : n,
    );
    expectBroken(g1 as Record<string, unknown>, 'INVALID_ID_FIELD');

    const g2 = projectGraph();
    g2.nodes = (g2.nodes as Array<Record<string, unknown>>).map((n) =>
      n.id === BLUEPRINT_USER_GATE_ID ? { ...n, label: ' 带首尾空白 ' } : n,
    );
    expectBroken(g2 as Record<string, unknown>, 'INVALID_LABEL');

    const g3 = projectGraph();
    g3.nodes = (g3.nodes as Array<Record<string, unknown>>).map((n) =>
      n.id === BLUEPRINT_USER_GATE_ID ? { ...n, label: 'x'.repeat(300) } : n,
    );
    expectBroken(g3 as Record<string, unknown>, 'INVALID_LABEL');
  });
});

describe('artifactKinds / budgetKeys / artifactDownstreamOrder 完整性', () => {
  it('节点产物不在 artifactKinds 内 → INVALID_ARTIFACT_KINDS', () => {
    const g = projectGraph();
    g.artifactKinds = ['idea', 'creationSpec', 'researchBundle']; // 缺 storyBlueprint
    expectBroken(g as Record<string, unknown>, 'INVALID_ARTIFACT_KINDS');
  });

  it('loop 预算不在 budgetKeys 内 → INVALID_BUDGET_KEYS', () => {
    const g = projectGraph();
    g.budgetKeys = ['clarification', 'researchRetry', 'blueprintRewrite', 'specRevision']; // 缺 intakeRevision
    expectBroken(g as Record<string, unknown>, 'INVALID_BUDGET_KEYS');
  });

  it('artifactDownstreamOrder 与 artifactKinds 不一致 → INVALID_DOWNSTREAM_ORDER', () => {
    const g = projectGraph();
    g.artifactDownstreamOrder = ['idea', 'creationSpec', 'storyBlueprint']; // 缺 researchBundle
    expectBroken(g as Record<string, unknown>, 'INVALID_DOWNSTREAM_ORDER');
  });

  it('graph.kind 非法 → INVALID_GRAPH_KIND', () => {
    const g = projectGraph();
    g.kind = 'scene';
    expectBroken(g as Record<string, unknown>, 'INVALID_GRAPH_KIND');
  });
});

describe('预算耗尽出口业务条件合取', () => {
  it('耗尽出口业务条件与 loop 边不一致 → BUDGET_EXIT_CONDITION_MISMATCH', () => {
    const g = projectGraph();
    // blueprint-user-gate--blueprint-escalation：[request_rewrite, exhausted]
    g.edges = (g.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'blueprint-user-gate--blueprint-escalation'
        ? {
            ...e,
            requiredOutcomes: [
              { condition: 'blueprint_gate', expectedOutcome: 'accept' },
              { condition: 'blueprint_rewrite_budget', expectedOutcome: 'exhausted' },
            ],
          }
        : e,
    );
    expectBroken(g as Record<string, unknown>, 'BUDGET_EXIT_CONDITION_MISMATCH');
  });

  it('删除预算耗尽出口 → BUDGET_EXIT_NOT_BOUND', () => {
    const g = projectGraph();
    g.edges = (g.edges as Array<Record<string, unknown>>).filter(
      (e) => e.id !== 'blueprint-user-gate--blueprint-escalation',
    );
    expectBroken(g as Record<string, unknown>, 'BUDGET_EXIT_NOT_BOUND');
  });

  it('耗尽出口携带 loop 业务条件合取（research invalid + research_retry_budget exhausted）', () => {
    const g = projectGraph();
    const exit = (g.edges as Array<Record<string, unknown>>).find(
      (e) => e.id === 'research-validate--research-escalation',
    );
    expect(exit).toBeDefined();
    const reqs = exit!.requiredOutcomes as Array<Record<string, unknown>>;
    const conditions = reqs.map((r) => String(r.condition));
    expect(conditions).toEqual(['research_valid', 'research_retry_budget']);
    const nonBudget = reqs.filter((r) => String(r.condition) !== 'research_retry_budget');
    expect(nonBudget).toEqual([{ condition: 'research_valid', expectedOutcome: 'invalid' }]);
  });
});

describe('循环与覆盖语义保留', () => {
  it('loop maxIterations 非法 → INVALID_LOOP_MAX', () => {
    const g = projectGraph();
    g.edges = (g.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'spec-extract--ask-question'
        ? { ...e, loop: { budget: 'clarification', maxIterations: 0 } }
        : e,
    );
    expectBroken(g as Record<string, unknown>, 'INVALID_LOOP_MAX');
  });

  it('条件边缺条件 → EMPTY_CONDITIONAL_EDGE', () => {
    const g = projectGraph();
    g.edges = (g.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'blueprint-user-gate--project-ready-accept' ? { ...e, requiredOutcomes: [] } : e,
    );
    expectBroken(g as Record<string, unknown>, 'EMPTY_CONDITIONAL_EDGE');
  });

  it('固定边带条件 → CONDITIONAL_OUTCOMES_ON_FIXED_EDGE', () => {
    const g = projectGraph();
    g.edges = (g.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'idea-capture--spec-extract'
        ? { ...e, requiredOutcomes: [{ condition: 'blueprint_gate', expectedOutcome: 'accept' }] }
        : e,
    );
    expectBroken(g as Record<string, unknown>, 'CONDITIONAL_OUTCOMES_ON_FIXED_EDGE');
  });

  it('未知条件 / 非法取值 → UNKNOWN_CONDITION / UNKNOWN_CONDITION_OUTCOME', () => {
    const g1 = projectGraph();
    g1.edges = (g1.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'blueprint-user-gate--project-ready-accept'
        ? { ...e, requiredOutcomes: [{ condition: 'nonexistent', expectedOutcome: 'x' }] }
        : e,
    );
    expectBroken(g1 as Record<string, unknown>, 'UNKNOWN_CONDITION');

    const g2 = projectGraph();
    g2.edges = (g2.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'blueprint-user-gate--project-ready-accept'
        ? { ...e, requiredOutcomes: [{ condition: 'blueprint_gate', expectedOutcome: 'maybe' }] }
        : e,
    );
    expectBroken(g2 as Record<string, unknown>, 'UNKNOWN_CONDITION_OUTCOME');
  });

  it('Project 图新节点（INTAKE_ESCALATION / RESEARCH_ESCALATION）可达且整体有效', () => {
    const g = projectGraph();
    const nodes = g.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((n) => String(n.id))).toContain('INTAKE_ESCALATION');
    expect(nodes.map((n) => String(n.id))).toContain('RESEARCH_ESCALATION');
    expect(isValidIdeaToNovelProjectGraphV1(g as never)).toBe(true);
  });
});

describe('Project / Chapter 图节点边界（Run 边界语义）', () => {
  it('Project 图不含 chapter generation 节点；Chapter 图不含 project 节点', () => {
    const projectIds = IDEA_TO_NOVEL_PROJECT_GRAPH_V1.nodes.map((n) => n.id as unknown as string);
    const chapterIds = CHAPTER_GENERATION_GRAPH_V1.nodes.map((n) => n.id as unknown as string);
    for (const forbidden of [
      'DRAFT',
      'CRITIQUE_JOIN',
      'REWRITE',
      'CANDIDATE_GATE',
      'MANUSCRIPT_COMMIT',
    ]) {
      expect(projectIds).not.toContain(forbidden);
    }
    for (const forbidden of ['IDEA_CAPTURE', 'RESEARCH_DECISION', 'BLUEPRINT_GENERATE']) {
      expect(chapterIds).not.toContain(forbidden);
    }
  });
});

describe('malformed 剩余抛异常路径回归（永不抛异常）', () => {
  /** 校验一个损坏图：不抛异常、不返回 valid、返回至少一条错误 */
  function expectNoThrowBroken(g: Record<string, unknown>): void {
    expect(() => validateIdeaToNovelProjectGraphV1(g as never)).not.toThrow();
    const errors = validateIdeaToNovelProjectGraphV1(g as never);
    expect(errors.length).toBeGreaterThan(0);
    expect(isValidIdeaToNovelProjectGraphV1(g as never)).toBe(false);
  }

  it('edge.requiredOutcomes 为非数组原始值（42）→ 不抛', () => {
    const g = projectGraph();
    g.edges = (g.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'blueprint-user-gate--project-ready-accept' ? { ...e, requiredOutcomes: 42 } : e,
    );
    expectNoThrowBroken(g as Record<string, unknown>);
  });

  it('edge.requiredOutcomes 为字符串/对象（非数组）→ 不抛', () => {
    for (const bad of ['cond', { condition: 'blueprint_gate' }, [null, 42, 'x']]) {
      const g = projectGraph();
      g.edges = (g.edges as Array<Record<string, unknown>>).map((e) =>
        e.id === 'blueprint-user-gate--project-ready-accept' ? { ...e, requiredOutcomes: bad } : e,
      );
      expectNoThrowBroken(g as Record<string, unknown>);
    }
  });

  it('joinAggregationPolicy.sources 为非数组（42 / 字符串 / null）→ 不抛', () => {
    for (const bad of [42, 'x', null]) {
      const g = chapterGraph();
      g.nodes = (g.nodes as Array<Record<string, unknown>>).map((n) =>
        n.id === CRITIQUE_JOIN_ID
          ? {
              ...n,
              joinAggregationPolicy: {
                ...(n.joinAggregationPolicy as Record<string, unknown>),
                sources: bad,
              },
            }
          : n,
      );
      expectNoThrowBroken(g as Record<string, unknown>);
    }
  });

  it('node.budgetResetPolicy 为非数组（42 / 字符串）→ 不抛', () => {
    for (const bad of [42, 'x']) {
      const g = projectGraph();
      g.nodes = (g.nodes as Array<Record<string, unknown>>).map((n) =>
        n.id === BLUEPRINT_USER_GATE_ID ? { ...n, budgetResetPolicy: bad } : n,
      );
      expectNoThrowBroken(g as Record<string, unknown>);
    }
  });

  it('edge.loop 为原始值 / join 声明为原始值 / 混合损坏边 → 不抛', () => {
    const g1 = projectGraph();
    g1.edges = (g1.edges as Array<Record<string, unknown>>).map((e) =>
      e.id === 'spec-extract--ask-question' ? { ...e, loop: 42 } : e,
    );
    expectNoThrowBroken(g1 as Record<string, unknown>);

    const g2 = chapterGraph();
    g2.nodes = (g2.nodes as Array<Record<string, unknown>>).map((n) =>
      n.id === CRITIQUE_JOIN_ID ? { ...n, join: 42 } : n,
    );
    expectNoThrowBroken(g2 as Record<string, unknown>);

    const g3 = projectGraph();
    const edges = g3.edges as Array<Record<string, unknown>>;
    g3.edges = [
      ...edges.slice(0, 4),
      null,
      { id: 'x', from: 42, to: null, kind: 42, mode: 42, requiredOutcomes: 'bad' },
      'not-an-object',
      ...edges.slice(4),
    ];
    expectNoThrowBroken(g3 as Record<string, unknown>);
  });
});
