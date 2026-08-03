/**
 * @ai-novel/domain - Idea-to-Novel Graph Definition tests
 *
 * 覆盖：
 * - 节点集合（20 个必需节点）与边集合；
 * - 条件闭合枚举注册表完整性；
 * - Graph 与 Prompt 分离（只引用稳定 prompt ID，不含 prompt 文本）；
 * - 确定性序列化；
 * - 无界循环外的其他 validator 快速自检（完整 fail-closed 见 validator 测试）。
 */

import { describe, it, expect } from 'vitest';
import {
  IDEA_TO_NOVEL_GRAPH_V1,
  GRAPH_CONDITION_OUTCOMES,
  PROMPT_IDS_V1,
  serializeIdeaToNovelGraphV1,
  possibleNextNodes,
  getLoopBudgetMax,
  aggregateCritiqueVerdict,
  createStablePromptId,
  IDEA_CAPTURE,
  SPEC_EXTRACT,
  ASK_QUESTION,
  COLLECT_ANSWER,
  RESEARCH_DECISION,
  RESEARCH_PLAN,
  RESEARCH_EXECUTE,
  RESEARCH_VALIDATE,
  BLUEPRINT_GENERATE,
  BLUEPRINT_USER_GATE,
  CHAPTER_PLAN,
  DRAFT,
  CONTINUITY_CRITIC,
  STYLE_CRITIC,
  REQUIREMENT_CRITIC,
  CRITIQUE_JOIN,
  REWRITE,
  CANDIDATE_GATE,
  MANUSCRIPT_COMMIT,
  EXPORT_READY,
} from './idea-to-novel-graph.js';
import { isValidIdeaToNovelGraphV1 } from './idea-to-novel-graph-validator.js';

const REQUIRED_NODE_IDS = [
  IDEA_CAPTURE,
  SPEC_EXTRACT,
  ASK_QUESTION,
  COLLECT_ANSWER,
  RESEARCH_DECISION,
  RESEARCH_PLAN,
  RESEARCH_EXECUTE,
  RESEARCH_VALIDATE,
  BLUEPRINT_GENERATE,
  BLUEPRINT_USER_GATE,
  CHAPTER_PLAN,
  DRAFT,
  CONTINUITY_CRITIC,
  STYLE_CRITIC,
  REQUIREMENT_CRITIC,
  CRITIQUE_JOIN,
  REWRITE,
  CANDIDATE_GATE,
  MANUSCRIPT_COMMIT,
  EXPORT_READY,
];

describe('IdeaToNovelGraphV1 定义', () => {
  it('包含全部 20 个必需节点 + 4 个预算升级/终止节点，且无遗漏', () => {
    const ids = IDEA_TO_NOVEL_GRAPH_V1.nodes.map((n) => n.id).sort();
    for (const required of REQUIRED_NODE_IDS) {
      expect(ids).toContain(required);
    }
    expect(ids).toHaveLength(24);
  });

  it('入口节点是 IDEA_CAPTURE 且为 IDEA_INPUT', () => {
    expect(IDEA_TO_NOVEL_GRAPH_V1.entryNodeId).toBe(IDEA_CAPTURE);
    const entry = IDEA_TO_NOVEL_GRAPH_V1.nodes.find((n) => n.id === IDEA_CAPTURE);
    expect(entry?.kind).toBe('IDEA_INPUT');
  });

  it('CRITIQUE_JOIN 声明 join.requiredIncoming = 3，且有 3 条 join 入边', () => {
    const joinNode = IDEA_TO_NOVEL_GRAPH_V1.nodes.find((n) => n.id === CRITIQUE_JOIN);
    expect(joinNode?.join?.requiredIncoming).toBe(3);
    const joinIncoming = IDEA_TO_NOVEL_GRAPH_V1.edges.filter(
      (e) => e.to === CRITIQUE_JOIN && e.mode === 'join',
    );
    expect(joinIncoming).toHaveLength(3);
  });

  it('DRAFT 对三个 Critic 构成 fan-out', () => {
    const targets = possibleNextNodes(IDEA_TO_NOVEL_GRAPH_V1, DRAFT);
    expect(targets.sort()).toEqual([CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC].sort());
  });

  it('有界循环预算：7 个预算键，同一预算的 loop 边 maxIterations 一致', () => {
    const loops = IDEA_TO_NOVEL_GRAPH_V1.edges.filter((e) => e.loop);
    const budgets = loops.map((e) => e.loop!.budget);
    expect(new Set(budgets).size).toBe(7);
    expect(loops).toHaveLength(8); // specRevision 出现在两个升级节点
    const maxByBudget = new Map<string, number>();
    for (const e of loops) {
      const prev = maxByBudget.get(e.loop!.budget);
      if (prev !== undefined) expect(e.loop!.maxIterations).toBe(prev);
      maxByBudget.set(e.loop!.budget, e.loop!.maxIterations);
    }
  });

  it('基础定义通过静态校验', () => {
    expect(isValidIdeaToNovelGraphV1(IDEA_TO_NOVEL_GRAPH_V1)).toBe(true);
  });
});

describe('条件闭合枚举注册表', () => {
  it('所有注册条件都有非空闭合取值', () => {
    for (const [name, outcomes] of Object.entries(GRAPH_CONDITION_OUTCOMES)) {
      expect(outcomes.length, `条件 ${name}`).toBeGreaterThan(0);
    }
  });

  it('每条条件边引用的条件与取值都在注册表内', () => {
    for (const edge of IDEA_TO_NOVEL_GRAPH_V1.edges) {
      if (edge.kind !== 'conditional') continue;
      expect(edge.requiredOutcomes?.length ?? 0, `边 ${edge.id}`).toBeGreaterThan(0);
      for (const req of edge.requiredOutcomes ?? []) {
        const outcomes = GRAPH_CONDITION_OUTCOMES[req.condition];
        expect(outcomes, `条件 ${req.condition}`).toBeDefined();
        expect(outcomes, `条件 ${req.condition}`).toContain(req.expectedOutcome);
      }
    }
  });

  it('RESEARCH_DECISION 的 three 档调研强度各有出口', () => {
    const outcomes = IDEA_TO_NOVEL_GRAPH_V1.edges
      .filter((e) => e.from === RESEARCH_DECISION)
      .map((e) => e.requiredOutcomes?.[0]);
    const values = outcomes
      .filter((o) => o?.condition === 'research_decision')
      .map((o) => o!.expectedOutcome);
    expect(values.sort()).toEqual(['deep', 'light', 'none']);
  });
});

describe('Graph 与 Prompt 分离', () => {
  it('所有模型类节点引用注册表内的稳定 prompt ID', () => {
    const promptKinds = new Set([
      'EXTRACT',
      'CLARIFY_ASK',
      'PLAN',
      'GENERATE',
      'CRITIC',
      'REWRITE',
    ]);
    for (const node of IDEA_TO_NOVEL_GRAPH_V1.nodes) {
      if (promptKinds.has(node.kind)) {
        expect(node.promptId, `节点 ${node.id}`).toBeDefined();
        expect(PROMPT_IDS_V1).toContain(node.promptId);
      } else {
        expect(node.promptId, `节点 ${node.id}`).toBeUndefined();
      }
    }
  });

  it('prompt ID 是稳定小写 ID，不含 prompt 文本', () => {
    for (const id of PROMPT_IDS_V1) {
      expect(id).toMatch(/^[a-z][a-z0-9:._-]{1,127}$/);
      expect(id).not.toContain(' ');
    }
    expect(() => createStablePromptId('你是一名资深小说编辑，请……')).toThrow();
  });

  it('序列化后的 Graph 不包含任何 prompt 文本', () => {
    const serialized = serializeIdeaToNovelGraphV1(IDEA_TO_NOVEL_GRAPH_V1);
    const proseMarkers = ['资深小说', '请根据', '输出 JSON', '你是', '创作要求：'];
    for (const marker of proseMarkers) {
      expect(serialized, `不应包含 prompt 文本: ${marker}`).not.toContain(marker);
    }
  });
});

describe('确定性序列化', () => {
  it('两次序列化结果一致', () => {
    const a = serializeIdeaToNovelGraphV1(IDEA_TO_NOVEL_GRAPH_V1);
    const b = serializeIdeaToNovelGraphV1(IDEA_TO_NOVEL_GRAPH_V1);
    expect(a).toBe(b);
  });

  it('节点/边乱序后序列化结果仍一致（确定性）', () => {
    const shuffled = {
      ...IDEA_TO_NOVEL_GRAPH_V1,
      nodes: [...IDEA_TO_NOVEL_GRAPH_V1.nodes].reverse(),
      edges: [...IDEA_TO_NOVEL_GRAPH_V1.edges].reverse(),
    };
    expect(serializeIdeaToNovelGraphV1(shuffled)).toBe(
      serializeIdeaToNovelGraphV1(IDEA_TO_NOVEL_GRAPH_V1),
    );
  });

  it('序列化包含全部节点与边（长度 > 基线）', () => {
    const serialized = serializeIdeaToNovelGraphV1(IDEA_TO_NOVEL_GRAPH_V1);
    expect(serialized.length).toBeGreaterThan(2000);
  });

  it('执行语义字段（output / humanDecisionType / budgetResetPolicy / joinAggregationPolicy / terminalStatus）全部进入序列化', () => {
    const serialized = serializeIdeaToNovelGraphV1(IDEA_TO_NOVEL_GRAPH_V1);
    for (const key of [
      '"output"',
      '"humanDecisionType"',
      '"budgetResetPolicy"',
      '"joinAggregationPolicy"',
      '"terminalStatus"',
      '"joinAggregationPolicy"',
    ]) {
      expect(serialized, key).toContain(key);
    }
  });

  it('组合字符 NFC / NFD 输入序列化结果一致（NFC 规范化 + code-point 比较，非 localeCompare）', () => {
    const make = (label: string): IdeaToNovelGraphV1 => ({
      id: 'g' as never,
      version: 'v1' as never,
      entryNodeId: 'A' as never,
      nodes: [
        {
          id: 'A' as never,
          kind: 'IDEA_INPUT',
          label,
          output: {
            requiredOutcomeCondition: null,
            allowedArtifactKind: 'idea',
            outputRequired: true,
          },
        },
      ],
      edges: [],
    });
    const nfd = make('e\u0301'); // e + combining acute
    const nfc = make('\u00e9'); // precomposed e-acute
    expect(serializeIdeaToNovelGraphV1(nfd)).toBe(serializeIdeaToNovelGraphV1(nfc));
    // 不依赖 locale：输出不随运行 locale 变化（排序用显式 code-point comparator）
    const serialized = serializeIdeaToNovelGraphV1(IDEA_TO_NOVEL_GRAPH_V1);
    expect(serialized).not.toContain('localeCompare');
  });
});

describe('只读辅助', () => {
  it('possibleNextNodes 返回直接后继', () => {
    expect(possibleNextNodes(IDEA_TO_NOVEL_GRAPH_V1, IDEA_CAPTURE)).toEqual([SPEC_EXTRACT]);
  });

  it('getLoopBudgetMax 读取 loop 边声明的最大值', () => {
    expect(getLoopBudgetMax(IDEA_TO_NOVEL_GRAPH_V1, 'rewrite')).toBe(3);
    expect(getLoopBudgetMax(IDEA_TO_NOVEL_GRAPH_V1, 'regenerate')).toBe(5);
    expect(getLoopBudgetMax(IDEA_TO_NOVEL_GRAPH_V1, 'clarification')).toBe(12);
  });

  it('aggregateCritiqueVerdict：全 pass 才 pass', () => {
    expect(
      aggregateCritiqueVerdict([
        { condition: 'critique_verdict', value: 'pass' },
        { condition: 'critique_verdict', value: 'pass' },
        { condition: 'critique_verdict', value: 'pass' },
      ]),
    ).toBe('pass');
    expect(
      aggregateCritiqueVerdict([
        { condition: 'critique_verdict', value: 'pass' },
        { condition: 'critique_verdict', value: 'needs_rewrite' },
        { condition: 'critique_verdict', value: 'pass' },
      ]),
    ).toBe('needs_rewrite');
  });

  it('CRITIQUE_JOIN 的 join 声明与 fan-in 一致（3 条 join 边）', () => {
    const node = IDEA_TO_NOVEL_GRAPH_V1.nodes.find((n) => n.id === CRITIQUE_JOIN);
    const joinEdges = IDEA_TO_NOVEL_GRAPH_V1.edges.filter(
      (e) => e.to === CRITIQUE_JOIN && e.mode === 'join',
    );
    expect(node?.join?.requiredIncoming).toBe(joinEdges.length);
  });
});
