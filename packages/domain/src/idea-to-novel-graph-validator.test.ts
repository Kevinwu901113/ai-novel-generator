/**
 * @ai-novel/domain - Idea-to-Novel Graph Validator fail-closed tests
 *
 * 对各类损坏定义，validator 必须：
 * - 返回至少一条对应错误；
 * - `isValidIdeaToNovelGraphV1` 返回 false；
 * - 绝不抛异常（fail-closed）。
 */

import { describe, it, expect } from 'vitest';
import {
  IDEA_TO_NOVEL_GRAPH_V1,
  createStablePromptId,
  type IdeaToNovelGraphEdgeDefinition,
  type IdeaToNovelGraphNodeDefinition,
  type IdeaToNovelGraphV1,
} from './idea-to-novel-graph.js';
import {
  validateIdeaToNovelGraphV1,
  isValidIdeaToNovelGraphV1,
  type GraphValidationErrorCode,
} from './idea-to-novel-graph-validator.js';

function expectCode(graph: IdeaToNovelGraphV1, code: GraphValidationErrorCode): void {
  const errors = validateIdeaToNovelGraphV1(graph); // 不抛异常
  expect(
    errors.some((e) => e.code === code),
    JSON.stringify(errors),
  ).toBe(true);
  expect(isValidIdeaToNovelGraphV1(graph)).toBe(false);
}

function nodeById(
  graph: IdeaToNovelGraphV1,
  id: string,
): IdeaToNovelGraphNodeDefinition | undefined {
  return graph.nodes.find((n) => n.id === id);
}

function edgeById(
  graph: IdeaToNovelGraphV1,
  id: string,
): IdeaToNovelGraphEdgeDefinition | undefined {
  return graph.edges.find((e) => e.id === id);
}

function replaceNode(
  graph: IdeaToNovelGraphV1,
  id: string,
  patch: Partial<IdeaToNovelGraphNodeDefinition>,
): IdeaToNovelGraphV1 {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  };
}

describe('定义损坏 → fail closed', () => {
  it('重复 node ID', () => {
    const n = nodeById(IDEA_TO_NOVEL_GRAPH_V1, 'DRAFT')!;
    expectCode(
      { ...IDEA_TO_NOVEL_GRAPH_V1, nodes: [...IDEA_TO_NOVEL_GRAPH_V1.nodes, n] },
      'DUPLICATE_NODE_ID',
    );
  });

  it('重复 edge ID', () => {
    const e = edgeById(IDEA_TO_NOVEL_GRAPH_V1, 'chapter-plan--draft')!;
    expectCode(
      { ...IDEA_TO_NOVEL_GRAPH_V1, edges: [...IDEA_TO_NOVEL_GRAPH_V1.edges, e] },
      'DUPLICATE_EDGE_ID',
    );
  });

  it('不存在的 edge target / source', () => {
    const badTarget = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
        e.id === 'chapter-plan--draft' ? { ...e, to: 'NOPE' as never } : e,
      ),
    };
    expectCode(badTarget, 'UNKNOWN_EDGE_TARGET');

    const badSource = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
        e.id === 'chapter-plan--draft' ? { ...e, from: 'NOPE' as never } : e,
      ),
    };
    expectCode(badSource, 'UNKNOWN_EDGE_SOURCE');
  });

  it('未知入口节点', () => {
    expectCode({ ...IDEA_TO_NOVEL_GRAPH_V1, entryNodeId: 'NOPE' as never }, 'UNKNOWN_ENTRY_NODE');
  });

  it('不可达节点', () => {
    const ghost: IdeaToNovelGraphNodeDefinition = {
      id: 'GHOST' as never,
      kind: 'TERMINAL',
      label: '幽灵节点',
    };
    expectCode(
      { ...IDEA_TO_NOVEL_GRAPH_V1, nodes: [...IDEA_TO_NOVEL_GRAPH_V1.nodes, ghost] },
      'UNREACHABLE_NODE',
    );
  });

  it('无合法出口的非终止节点', () => {
    const graph = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.filter((e) => e.id !== 'manuscript-commit--export-ready'),
    };
    expectCode(graph, 'NO_LEGAL_EXIT');
  });

  it('没有 join 声明的 fan-in', () => {
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'CRITIQUE_JOIN', { join: undefined }),
      'FAN_IN_WITHOUT_JOIN',
    );
  });

  it('join 声明与实际 join 入边数不匹配', () => {
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'CRITIQUE_JOIN', { join: { requiredIncoming: 2 } }),
      'JOIN_DECLARATION_MISMATCH',
    );
  });

  it('无界循环（SCC 无 loop 边）', () => {
    const synthetic: IdeaToNovelGraphV1 = {
      id: 'synthetic' as never,
      version: 'v1' as never,
      entryNodeId: 'A' as never,
      nodes: [
        { id: 'A' as never, kind: 'IDEA_INPUT', label: 'A' },
        { id: 'B' as never, kind: 'TERMINAL', label: 'B' },
      ],
      edges: [
        {
          id: 'e1' as never,
          from: 'A' as never,
          to: 'B' as never,
          kind: 'fixed',
          mode: 'exclusive',
        },
        {
          id: 'e2' as never,
          from: 'B' as never,
          to: 'A' as never,
          kind: 'fixed',
          mode: 'exclusive',
        },
      ],
    };
    expectCode(synthetic, 'UNBOUNDED_CYCLE');
  });

  it('loop 边不在环上', () => {
    const graph: IdeaToNovelGraphV1 = {
      id: 'synthetic2' as never,
      version: 'v1' as never,
      entryNodeId: 'A' as never,
      nodes: [
        { id: 'A' as never, kind: 'IDEA_INPUT', label: 'A' },
        { id: 'B' as never, kind: 'TERMINAL', label: 'B' },
      ],
      edges: [
        {
          id: 'e1' as never,
          from: 'A' as never,
          to: 'B' as never,
          kind: 'fixed',
          mode: 'exclusive',
        },
        {
          id: 'loop-a-b' as never,
          from: 'A' as never,
          to: 'B' as never,
          kind: 'fixed',
          mode: 'exclusive',
          loop: { budget: 'rewrite', maxIterations: 3 },
        },
      ],
    };
    expectCode(graph, 'LOOP_EDGE_NOT_CYCLIC');
  });

  it('非法 loop maxIterations', () => {
    const graph = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
        e.id === 'critique-join--rewrite'
          ? { ...e, loop: { budget: 'rewrite' as const, maxIterations: 0 } }
          : e,
      ),
    };
    expectCode(graph, 'INVALID_LOOP_MAX');
  });

  it('同一预算键的 loop 边 maxIterations 不一致', () => {
    const selfLoop: IdeaToNovelGraphEdgeDefinition = {
      id: 'rewrite-self-loop' as never,
      from: 'REWRITE' as never,
      to: 'REWRITE' as never,
      kind: 'fixed',
      mode: 'exclusive',
      loop: { budget: 'rewrite', maxIterations: 1 },
    };
    expectCode(
      { ...IDEA_TO_NOVEL_GRAPH_V1, edges: [...IDEA_TO_NOVEL_GRAPH_V1.edges, selfLoop] },
      'LOOP_MAX_INCONSISTENT',
    );
  });

  it('预算耗尽出口未绑定到对应 loop source', () => {
    const graph = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.filter(
        (e) => e.id !== 'critique-join--candidate-gate-budget-exhausted',
      ),
    };
    expectCode(graph, 'BUDGET_EXIT_NOT_BOUND');
  });

  it('未知条件名', () => {
    const graph = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
        e.id === 'research-decision--blueprint-generate-none'
          ? {
              ...e,
              requiredOutcomes: [{ condition: 'bogus' as never, expectedOutcome: 'none' as never }],
            }
          : e,
      ),
    };
    expectCode(graph, 'UNKNOWN_CONDITION');
  });

  it('未覆盖的条件枚举取值', () => {
    const graph = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
        e.id === 'research-decision--blueprint-generate-none'
          ? {
              ...e,
              requiredOutcomes: [
                { condition: 'research_decision', expectedOutcome: 'blue' as never },
              ],
            }
          : e,
      ),
    };
    expectCode(graph, 'UNKNOWN_CONDITION_OUTCOME');
  });

  it('空条件条件边 / 固定边带条件', () => {
    const empty = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
        e.id === 'research-decision--blueprint-generate-none' ? { ...e, requiredOutcomes: [] } : e,
      ),
    };
    expectCode(empty, 'EMPTY_CONDITIONAL_EDGE');

    const fixedWithCond = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
        e.id === 'idea-capture--spec-extract'
          ? {
              ...e,
              requiredOutcomes: [{ condition: 'research_decision', expectedOutcome: 'none' }],
            }
          : e,
      ),
    };
    expectCode(fixedWithCond, 'CONDITIONAL_OUTCOMES_ON_FIXED_EDGE');
  });

  it('歧义条件（同源两条边条件相同）', () => {
    const dup = edgeById(IDEA_TO_NOVEL_GRAPH_V1, 'research-decision--research-plan-light')!;
    expectCode(
      {
        ...IDEA_TO_NOVEL_GRAPH_V1,
        edges: [...IDEA_TO_NOVEL_GRAPH_V1.edges, { ...dup, id: 'dup-light' as never }],
      },
      'AMBIGUOUS_EDGE_OUTCOMES',
    );
  });

  it('模型类节点缺 promptId / 未知 promptId', () => {
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'DRAFT', { promptId: undefined }),
      'MISSING_PROMPT_ID_FOR_MODEL_NODE',
    );
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'DRAFT', {
        promptId: createStablePromptId('prompt:unknown-v1'),
      }),
      'UNKNOWN_PROMPT_ID',
    );
  });

  it('人工交互节点缺决策类型映射', () => {
    const graph: IdeaToNovelGraphV1 = {
      id: 'synthetic3' as never,
      version: 'v1' as never,
      entryNodeId: 'A' as never,
      nodes: [
        { id: 'A' as never, kind: 'IDEA_INPUT', label: 'A' },
        { id: 'G' as never, kind: 'USER_GATE', label: 'G' },
        { id: 'T' as never, kind: 'TERMINAL', label: 'T' },
      ],
      edges: [
        {
          id: 'e1' as never,
          from: 'A' as never,
          to: 'G' as never,
          kind: 'fixed',
          mode: 'exclusive',
        },
        {
          id: 'e2' as never,
          from: 'G' as never,
          to: 'T' as never,
          kind: 'fixed',
          mode: 'exclusive',
        },
      ],
    };
    expectCode(graph, 'MISSING_HUMAN_DECISION_TYPE');
  });

  it('非法 stage projection', () => {
    const ghost: IdeaToNovelGraphNodeDefinition = {
      id: 'NEW_NODE' as never,
      kind: 'TERMINAL',
      label: '新节点',
    };
    expectCode(
      { ...IDEA_TO_NOVEL_GRAPH_V1, nodes: [...IDEA_TO_NOVEL_GRAPH_V1.nodes, ghost] },
      'INVALID_STAGE_PROJECTION',
    );
  });

  it('没有终止节点', () => {
    const graph = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      nodes: IDEA_TO_NOVEL_GRAPH_V1.nodes.map((n) =>
        n.kind === 'TERMINAL' ? { ...n, kind: 'GENERATE' as never } : n,
      ),
    };
    expectCode(graph, 'MISSING_TERMINAL_NODE');
  });

  it('malformed 输入返回 MALFORMED_GRAPH 且不抛异常', () => {
    expectCode(null as unknown as IdeaToNovelGraphV1, 'MALFORMED_GRAPH');
    expectCode({} as IdeaToNovelGraphV1, 'MALFORMED_GRAPH');
    expectCode(
      { ...IDEA_TO_NOVEL_GRAPH_V1, nodes: 'not-an-array' } as unknown as IdeaToNovelGraphV1,
      'MALFORMED_GRAPH',
    );
  });

  it('node.kind / edge.kind / edge.mode 闭合枚举', () => {
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'DRAFT', { kind: 'GARBAGE' as never }),
      'INVALID_NODE_KIND',
    );
    expectCode(
      {
        ...IDEA_TO_NOVEL_GRAPH_V1,
        edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
          e.id === 'idea-capture--spec-extract' ? { ...e, kind: 'GARBAGE' as never } : e,
        ),
      },
      'INVALID_EDGE_KIND',
    );
    expectCode(
      {
        ...IDEA_TO_NOVEL_GRAPH_V1,
        edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
          e.id === 'idea-capture--spec-extract' ? { ...e, mode: 'GARBAGE' as never } : e,
        ),
      },
      'INVALID_EDGE_MODE',
    );
  });

  it('未覆盖的条件枚举取值（如删掉 research_decision=deep 的出口）', () => {
    const noDeep = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.filter(
        (e) => e.id !== 'research-decision--research-plan-deep',
      ),
    };
    expectCode(noDeep, 'UNCOVERED_CONDITION_OUTCOME');
  });

  it('非终止节点只有预算耗尽出口 → 拒绝（强化 NO_LEGAL_EXIT）', () => {
    const graph: IdeaToNovelGraphV1 = {
      id: 'synthetic4' as never,
      version: 'v1' as never,
      entryNodeId: 'A' as never,
      nodes: [
        { id: 'A' as never, kind: 'IDEA_INPUT', label: 'A' },
        { id: 'D' as never, kind: 'DECISION', label: 'D' },
        { id: 'T' as never, kind: 'TERMINAL', label: 'T' },
      ],
      edges: [
        {
          id: 'e1' as never,
          from: 'A' as never,
          to: 'D' as never,
          kind: 'fixed',
          mode: 'exclusive',
        },
        {
          id: 'e2' as never,
          from: 'D' as never,
          to: 'T' as never,
          kind: 'conditional',
          requiredOutcomes: [{ condition: 'rewrite_budget', expectedOutcome: 'exhausted' }],
          mode: 'exclusive',
        },
      ],
    };
    expectCode(graph, 'NO_LEGAL_EXIT');
  });

  it('Object.prototype 键（constructor）不会让 validator 抛异常（fail-closed）', () => {
    const graph = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
        e.id === 'research-decision--blueprint-generate-none'
          ? {
              ...e,
              requiredOutcomes: [
                { condition: 'constructor' as never, expectedOutcome: 'none' as never },
              ],
            }
          : e,
      ),
    };
    expect(() => validateIdeaToNovelGraphV1(graph)).not.toThrow();
    expect(validateIdeaToNovelGraphV1(graph).some((e) => e.code === 'UNKNOWN_CONDITION')).toBe(
      true,
    );
  });
});

describe('REWORK：validator 强化', () => {
  it('终止节点禁止出口边', () => {
    const extraEdge: IdeaToNovelGraphEdgeDefinition = {
      id: 'export--draft' as never,
      from: 'EXPORT_READY' as never,
      to: 'DRAFT' as never,
      kind: 'fixed',
      mode: 'exclusive',
    };
    expectCode(
      { ...IDEA_TO_NOVEL_GRAPH_V1, edges: [...IDEA_TO_NOVEL_GRAPH_V1.edges, extraEdge] },
      'TERMINAL_HAS_OUTGOING_EDGE',
    );
  });

  it('JOIN kind 缺 join 声明；非 JOIN 声明 join', () => {
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'CRITIQUE_JOIN', { join: undefined }),
      'JOIN_KIND_WITHOUT_JOIN',
    );
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'DRAFT', { join: { requiredIncoming: 2 } }),
      'NON_JOIN_WITH_JOIN',
    );
  });

  it('joinAggregationPolicy 来源与 join 入边不匹配', () => {
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'CRITIQUE_JOIN', {
        joinAggregationPolicy: {
          kind: 'critique_verdict',
          sources: ['DRAFT', 'REWRITE', 'CHAPTER_PLAN'] as never,
          rule: 'all_pass_or_needs_rewrite',
        },
      }),
      'JOIN_POLICY_MISMATCH',
    );
  });

  it('exact-key：node / edge / output 的未知键被拒', () => {
    const node = nodeById(IDEA_TO_NOVEL_GRAPH_V1, 'DRAFT')!;
    expectCode(
      {
        ...IDEA_TO_NOVEL_GRAPH_V1,
        nodes: IDEA_TO_NOVEL_GRAPH_V1.nodes.map((n) => (n.id === 'DRAFT' ? { ...n, bogus: 1 } : n)),
      },
      'UNKNOWN_NODE_KEY',
    );
    expectCode(
      {
        ...IDEA_TO_NOVEL_GRAPH_V1,
        edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
          e.id === 'idea-capture--spec-extract' ? { ...e, bogus: 1 } : e,
        ),
      },
      'UNKNOWN_EDGE_KEY',
    );
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'DRAFT', {
        output: { ...node.output, bogus: 1 } as never,
      }),
      'UNKNOWN_OUTPUT_KEY',
    );
  });

  it('移除全部 loop 边后仍存在环 → 拒绝', () => {
    // CANDIDATE_GATE→CHAPTER_PLAN 是一条非 loop 反向边，形成纯非 loop 环
    const extra: IdeaToNovelGraphEdgeDefinition = {
      id: 'candidate-gate--chapter-plan-non-loop' as never,
      from: 'CANDIDATE_GATE' as never,
      to: 'CHAPTER_PLAN' as never,
      kind: 'fixed',
      mode: 'exclusive',
    };
    expectCode(
      { ...IDEA_TO_NOVEL_GRAPH_V1, edges: [...IDEA_TO_NOVEL_GRAPH_V1.edges, extra] },
      'CYCLE_AFTER_LOOP_REMOVAL',
    );
  });

  it('输出契约不一致（outputRequired true 但无输出类型）', () => {
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'DRAFT', {
        output: {
          requiredOutcomeCondition: null,
          allowedArtifactKind: null,
          outputRequired: true,
        } as never,
      }),
      'INVALID_OUTPUT_CONTRACT',
    );
  });

  it('原型键作为条件名 / 节点 id 被拒（fail-closed）', () => {
    const graph = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      nodes: [
        ...IDEA_TO_NOVEL_GRAPH_V1.nodes,
        {
          id: '__proto__' as never,
          kind: 'TERMINAL' as never,
          label: 'p',
          output: {
            requiredOutcomeCondition: null,
            allowedArtifactKind: null,
            outputRequired: false,
          },
        },
      ],
    };
    expect(() => validateIdeaToNovelGraphV1(graph)).not.toThrow();
    expect(
      validateIdeaToNovelGraphV1(graph).some((e) => e.code === 'INVALID_STAGE_PROJECTION'),
    ).toBe(true);
    // __proto__ 作为条件名 → UNKNOWN_CONDITION
    const condGraph = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
        e.id === 'research-decision--blueprint-generate-none'
          ? {
              ...e,
              requiredOutcomes: [
                { condition: '__proto__' as never, expectedOutcome: 'none' as never },
              ],
            }
          : e,
      ),
    };
    expect(() => validateIdeaToNovelGraphV1(condGraph)).not.toThrow();
    expect(validateIdeaToNovelGraphV1(condGraph).some((e) => e.code === 'UNKNOWN_CONDITION')).toBe(
      true,
    );
  });
});

describe('Second Review：validator 强化', () => {
  it('耗尽出口业务条件与 loop 边不一致 → BUDGET_EXIT_CONDITION_MISMATCH', () => {
    const graph = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      edges: IDEA_TO_NOVEL_GRAPH_V1.edges.map((e) =>
        e.id === 'blueprint-user-gate--blueprint-escalation-budget-exhausted'
          ? {
              ...e,
              requiredOutcomes: [
                { condition: 'blueprint_gate', expectedOutcome: 'accept' as never },
                { condition: 'blueprint_rewrite_budget', expectedOutcome: 'exhausted' },
              ],
            }
          : e,
      ),
    };
    expectCode(graph, 'BUDGET_EXIT_CONDITION_MISMATCH');
  });

  it('budgetResetPolicy 未知元素 / 重复 → INVALID_BUDGET_RESET_POLICY', () => {
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'DRAFT', { budgetResetPolicy: ['bogus'] as never }),
      'INVALID_BUDGET_RESET_POLICY',
    );
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'DRAFT', { budgetResetPolicy: ['rewrite', 'rewrite'] }),
      'INVALID_BUDGET_RESET_POLICY',
    );
  });

  it('joinAggregationPolicy exact keys → INVALID_JOIN_POLICY', () => {
    expectCode(
      replaceNode(IDEA_TO_NOVEL_GRAPH_V1, 'CRITIQUE_JOIN', {
        joinAggregationPolicy: {
          kind: 'critique_verdict',
          sources: ['CONTINUITY_CRITIC', 'STYLE_CRITIC', 'REQUIREMENT_CRITIC'],
          rule: 'all_pass_or_needs_rewrite',
          bogus: 1,
        } as never,
      }),
      'INVALID_JOIN_POLICY',
    );
  });

  it('graph 顶层未知键 → UNKNOWN_GRAPH_KEY', () => {
    expectCode(
      { ...IDEA_TO_NOVEL_GRAPH_V1, bogus: 1 } as unknown as IdeaToNovelGraphV1,
      'UNKNOWN_GRAPH_KEY',
    );
  });

  it('自定义原型 graph / nodes 数组含 null → MALFORMED_GRAPH 且不抛异常', () => {
    const customProto = Object.create({});
    Object.assign(customProto, IDEA_TO_NOVEL_GRAPH_V1);
    expectCode(customProto as unknown as IdeaToNovelGraphV1, 'MALFORMED_GRAPH');
    expectCode(
      {
        ...IDEA_TO_NOVEL_GRAPH_V1,
        nodes: [...IDEA_TO_NOVEL_GRAPH_V1.nodes, null],
      } as unknown as IdeaToNovelGraphV1,
      'MALFORMED_GRAPH',
    );
    expectCode(
      {
        ...IDEA_TO_NOVEL_GRAPH_V1,
        edges: [...IDEA_TO_NOVEL_GRAPH_V1.edges, null],
      } as unknown as IdeaToNovelGraphV1,
      'MALFORMED_GRAPH',
    );
  });

  it('malformed matrix 永不抛异常（no-throw）', () => {
    const malformed: Array<unknown> = [
      null,
      undefined,
      42,
      'x',
      [],
      {},
      { nodes: null, edges: null, entryNodeId: null, id: 1, version: 2 },
      { ...IDEA_TO_NOVEL_GRAPH_V1, nodes: [null, undefined, 42, 'x', []] },
      { ...IDEA_TO_NOVEL_GRAPH_V1, edges: [null, undefined, 'e'] },
      { ...IDEA_TO_NOVEL_GRAPH_V1, nodes: IDEA_TO_NOVEL_GRAPH_V1.nodes.map(() => null) },
      Object.create(null),
      JSON.parse('{"nodes":[{"id":1}],"edges":[{"id":2}],"entryNodeId":"A"}'),
    ];
    for (const input of malformed) {
      expect(() => validateIdeaToNovelGraphV1(input as IdeaToNovelGraphV1)).not.toThrow();
    }
  });
});
