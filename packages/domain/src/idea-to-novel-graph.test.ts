/**
 * @ai-novel/domain - Idea-to-Novel Graph Definition tests（Project / Chapter 两张 Graph）
 *
 * 覆盖：
 * - Project Graph 节点集合（16）与边集合；不包含 chapter generation 节点；
 * - Chapter Graph 节点集合（13）与边集合；不包含 Idea / Research 节点；
 * - 条件闭合枚举注册表完整性；
 * - Graph 与 Prompt 分离（只引用稳定 prompt ID，不含 prompt 文本）；
 * - 确定性序列化（两张 Graph 分别提供）；
 * - 只读辅助与 aggregateCritiqueVerdict。
 */

import { describe, it, expect } from 'vitest';
import {
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  CHAPTER_GENERATION_GRAPH_V1,
  GRAPH_CONDITION_OUTCOMES,
  PROMPT_IDS_V1,
  serializeIdeaToNovelProjectGraphV1,
  serializeChapterGenerationGraphV1,
  possibleNextNodes,
  getLoopBudgetMax,
  aggregateCritiqueVerdict,
  createStablePromptId,
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
} from './idea-to-novel-graph.js';
import {
  isValidIdeaToNovelProjectGraphV1,
  isValidChapterGenerationGraphV1,
} from './idea-to-novel-graph-validator.js';

const PROJECT_NODE_IDS = [
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
];

const CHAPTER_NODE_IDS = [
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
];

describe('Project Graph 定义', () => {
  it('包含全部 16 个项目级节点，且无遗漏', () => {
    const ids = IDEA_TO_NOVEL_PROJECT_GRAPH_V1.nodes.map((n) => n.id);
    for (const required of PROJECT_NODE_IDS) {
      expect(ids).toContain(required);
    }
    expect(ids).toHaveLength(16);
  });

  it('入口节点是 IDEA_CAPTURE 且为 IDEA_INPUT', () => {
    expect(IDEA_TO_NOVEL_PROJECT_GRAPH_V1.entryNodeId).toBe(IDEA_CAPTURE);
    const entry = IDEA_TO_NOVEL_PROJECT_GRAPH_V1.nodes.find((n) => n.id === IDEA_CAPTURE);
    expect(entry?.kind).toBe('IDEA_INPUT');
  });

  it('graph id / version / kind 稳定', () => {
    expect(IDEA_TO_NOVEL_PROJECT_GRAPH_V1.id).toBe('idea-to-novel-project');
    expect(IDEA_TO_NOVEL_PROJECT_GRAPH_V1.version).toBe('v1');
    expect(IDEA_TO_NOVEL_PROJECT_GRAPH_V1.kind).toBe('project');
  });

  it('不包含 chapter generation 节点（DRAFT / Critic / CRITIQUE_JOIN / REWRITE / CANDIDATE_GATE / MANUSCRIPT_COMMIT / CHAPTER_PLAN）', () => {
    const ids = IDEA_TO_NOVEL_PROJECT_GRAPH_V1.nodes.map((n) => n.id);
    for (const chapterOnly of [
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
    ]) {
      expect(ids).not.toContain(chapterOnly);
    }
  });

  it('基础定义通过静态校验', () => {
    expect(isValidIdeaToNovelProjectGraphV1(IDEA_TO_NOVEL_PROJECT_GRAPH_V1)).toBe(true);
  });
});

describe('Chapter Graph 定义', () => {
  it('包含全部 13 个章节级节点，且无遗漏', () => {
    const ids = CHAPTER_GENERATION_GRAPH_V1.nodes.map((n) => n.id);
    for (const required of CHAPTER_NODE_IDS) {
      expect(ids).toContain(required);
    }
    expect(ids).toHaveLength(13);
  });

  it('入口节点是 CHAPTER_PLAN 且为 PLAN', () => {
    expect(CHAPTER_GENERATION_GRAPH_V1.entryNodeId).toBe(CHAPTER_PLAN);
    const entry = CHAPTER_GENERATION_GRAPH_V1.nodes.find((n) => n.id === CHAPTER_PLAN);
    expect(entry?.kind).toBe('PLAN');
  });

  it('graph id / version / kind 稳定且与 Project 不同', () => {
    expect(CHAPTER_GENERATION_GRAPH_V1.id).toBe('chapter-generation');
    expect(CHAPTER_GENERATION_GRAPH_V1.version).toBe('v1');
    expect(CHAPTER_GENERATION_GRAPH_V1.kind).toBe('chapter');
    expect(CHAPTER_GENERATION_GRAPH_V1.id).not.toBe(IDEA_TO_NOVEL_PROJECT_GRAPH_V1.id);
  });

  it('不包含 Idea / Research 节点（IDEA_CAPTURE / SPEC_EXTRACT / RESEARCH_* / BLUEPRINT_*）', () => {
    const ids = CHAPTER_GENERATION_GRAPH_V1.nodes.map((n) => n.id);
    for (const projectOnly of [
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
    ]) {
      expect(ids).not.toContain(projectOnly);
    }
  });

  it('CRITIQUE_JOIN 声明 join.requiredIncoming = 3，且有 3 条 join 入边', () => {
    const joinNode = CHAPTER_GENERATION_GRAPH_V1.nodes.find((n) => n.id === CRITIQUE_JOIN);
    expect(joinNode?.join?.requiredIncoming).toBe(3);
    const joinIncoming = CHAPTER_GENERATION_GRAPH_V1.edges.filter(
      (e) => e.to === CRITIQUE_JOIN && e.mode === 'join',
    );
    expect(joinIncoming).toHaveLength(3);
  });

  it('DRAFT 对三个 Critic 构成 fan-out', () => {
    const targets = possibleNextNodes(CHAPTER_GENERATION_GRAPH_V1, DRAFT);
    expect(targets.sort()).toEqual([CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC].sort());
  });

  it('基础定义通过静态校验', () => {
    expect(isValidChapterGenerationGraphV1(CHAPTER_GENERATION_GRAPH_V1)).toBe(true);
  });
});

describe('有界循环预算', () => {
  it('Project 图预算键：clarification / intakeRevision / researchRetry / blueprintRewrite / specRevision', () => {
    const projectBudgets = new Set(IDEA_TO_NOVEL_PROJECT_GRAPH_V1.edges.map((e) => e.loop?.budget));
    for (const budget of [
      'clarification',
      'intakeRevision',
      'researchRetry',
      'blueprintRewrite',
      'specRevision',
    ]) {
      expect(projectBudgets.has(budget)).toBe(true);
    }
    expect(IDEA_TO_NOVEL_PROJECT_GRAPH_V1.budgetKeys).toEqual([
      'clarification',
      'intakeRevision',
      'researchRetry',
      'blueprintRewrite',
      'specRevision',
    ]);
  });

  it('Chapter 图预算键：rewrite / candidateRewrite / regenerate', () => {
    expect(CHAPTER_GENERATION_GRAPH_V1.budgetKeys).toEqual([
      'rewrite',
      'candidateRewrite',
      'regenerate',
    ]);
  });

  it('同一预算的 loop 边 maxIterations 一致（specRevision 出现在两个升级节点）', () => {
    for (const graph of [IDEA_TO_NOVEL_PROJECT_GRAPH_V1, CHAPTER_GENERATION_GRAPH_V1]) {
      const maxByBudget = new Map<string, number>();
      for (const e of graph.edges) {
        if (!e.loop) continue;
        const prev = maxByBudget.get(e.loop.budget);
        if (prev !== undefined) expect(e.loop.maxIterations, `预算 ${e.loop.budget}`).toBe(prev);
        maxByBudget.set(e.loop.budget, e.loop.maxIterations);
      }
    }
  });
});

describe('条件闭合枚举注册表', () => {
  it('所有注册条件都有非空闭合取值', () => {
    for (const [name, outcomes] of Object.entries(GRAPH_CONDITION_OUTCOMES)) {
      expect(outcomes.length, `条件 ${name}`).toBeGreaterThan(0);
    }
  });

  it('每条条件边引用的条件与取值都在注册表内（两张图）', () => {
    for (const graph of [IDEA_TO_NOVEL_PROJECT_GRAPH_V1, CHAPTER_GENERATION_GRAPH_V1]) {
      for (const edge of graph.edges) {
        if (edge.kind !== 'conditional') continue;
        expect(edge.requiredOutcomes?.length ?? 0, `边 ${edge.id}`).toBeGreaterThan(0);
        for (const req of edge.requiredOutcomes ?? []) {
          const outcomes = GRAPH_CONDITION_OUTCOMES[req.condition];
          expect(outcomes, `条件 ${req.condition}`).toBeDefined();
          expect(outcomes, `条件 ${req.condition}`).toContain(req.expectedOutcome);
        }
      }
    }
  });

  it('RESEARCH_DECISION 的 three 档调研强度各有出口', () => {
    const outcomes = IDEA_TO_NOVEL_PROJECT_GRAPH_V1.edges
      .filter((e) => e.from === RESEARCH_DECISION)
      .map((e) => e.requiredOutcomes?.[0]);
    const values = outcomes
      .filter((o) => o?.condition === 'research_decision')
      .map((o) => o!.expectedOutcome);
    expect(values.sort()).toEqual(['deep', 'light', 'none']);
  });

  it('intake_action 三个取值（answer / skip / finish）各有出口', () => {
    const edges = IDEA_TO_NOVEL_PROJECT_GRAPH_V1.edges.filter((e) => e.from === COLLECT_ANSWER);
    const actions = edges
      .filter((e) => e.requiredOutcomes?.[0]?.condition === 'intake_action')
      .map((e) => e.requiredOutcomes![0].expectedOutcome)
      .sort();
    expect(actions).toEqual(['answer', 'finish', 'skip']);
  });
});

describe('Graph 与 Prompt 分离', () => {
  it('所有模型类节点引用注册表内的稳定 prompt ID（两张图）', () => {
    const promptKinds = new Set([
      'EXTRACT',
      'CLARIFY_ASK',
      'PLAN',
      'GENERATE',
      'CRITIC',
      'REWRITE',
    ]);
    for (const graph of [IDEA_TO_NOVEL_PROJECT_GRAPH_V1, CHAPTER_GENERATION_GRAPH_V1]) {
      for (const node of graph.nodes) {
        if (promptKinds.has(node.kind)) {
          expect(node.promptId, `节点 ${node.id}`).toBeDefined();
          expect(PROMPT_IDS_V1).toContain(node.promptId);
        } else {
          expect(node.promptId, `节点 ${node.id}`).toBeUndefined();
        }
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

  it('序列化后的 Graph 不包含任何 prompt 文本（两张图）', () => {
    const serialized =
      serializeIdeaToNovelProjectGraphV1(IDEA_TO_NOVEL_PROJECT_GRAPH_V1) +
      serializeChapterGenerationGraphV1(CHAPTER_GENERATION_GRAPH_V1);
    const proseMarkers = ['资深小说', '请根据', '输出 JSON', '你是', '创作要求：'];
    for (const marker of proseMarkers) {
      expect(serialized, `不应包含 prompt 文本: ${marker}`).not.toContain(marker);
    }
  });
});

describe('确定性序列化', () => {
  it('两次序列化结果一致（两张图）', () => {
    expect(serializeIdeaToNovelProjectGraphV1(IDEA_TO_NOVEL_PROJECT_GRAPH_V1)).toBe(
      serializeIdeaToNovelProjectGraphV1(IDEA_TO_NOVEL_PROJECT_GRAPH_V1),
    );
    expect(serializeChapterGenerationGraphV1(CHAPTER_GENERATION_GRAPH_V1)).toBe(
      serializeChapterGenerationGraphV1(CHAPTER_GENERATION_GRAPH_V1),
    );
  });

  it('节点/边乱序后序列化结果仍一致（确定性，两张图）', () => {
    for (const graph of [IDEA_TO_NOVEL_PROJECT_GRAPH_V1, CHAPTER_GENERATION_GRAPH_V1]) {
      const shuffled = {
        ...graph,
        nodes: [...graph.nodes].reverse(),
        edges: [...graph.edges].reverse(),
      };
      const a =
        graph.kind === 'project'
          ? serializeIdeaToNovelProjectGraphV1
          : serializeChapterGenerationGraphV1;
      expect(a(shuffled)).toBe(a(graph));
    }
  });

  it('两张 Graph 的序列化不同（id 不同）', () => {
    expect(serializeIdeaToNovelProjectGraphV1(IDEA_TO_NOVEL_PROJECT_GRAPH_V1)).not.toBe(
      serializeChapterGenerationGraphV1(CHAPTER_GENERATION_GRAPH_V1),
    );
  });

  it('执行语义字段（output / humanDecisionType / budgetResetPolicy / joinAggregationPolicy / terminalStatus / kind / artifactKinds / budgetKeys）全部进入序列化', () => {
    const serialized =
      serializeIdeaToNovelProjectGraphV1(IDEA_TO_NOVEL_PROJECT_GRAPH_V1) +
      serializeChapterGenerationGraphV1(CHAPTER_GENERATION_GRAPH_V1);
    for (const key of [
      '"output"',
      '"humanDecisionType"',
      '"budgetResetPolicy"',
      '"joinAggregationPolicy"',
      '"terminalStatus"',
      '"kind"',
      '"artifactKinds"',
      '"budgetKeys"',
      '"artifactDownstreamOrder"',
    ]) {
      expect(serialized, key).toContain(key);
    }
  });

  it('组合字符 NFC / NFD 输入序列化结果一致（NFC 规范化 + code-point 比较，非 localeCompare）', () => {
    const make = (
      label: string,
    ): {
      id: string;
      version: string;
      kind: 'project';
      entryNodeId: string;
      nodes: Array<{
        id: string;
        kind: string;
        label: string;
        output: {
          requiredOutcomeCondition: null;
          allowedArtifactKind: string;
          outputRequired: boolean;
        };
      }>;
      edges: Array<never>;
      artifactKinds: Array<string>;
      budgetKeys: Array<string>;
      artifactDownstreamOrder: Array<string>;
    } => ({
      id: 'g',
      version: 'v1',
      kind: 'project',
      entryNodeId: 'A',
      nodes: [
        {
          id: 'A',
          kind: 'IDEA_INPUT',
          label,
          input: {
            requiresArtifacts: [],
            requiresOutcomes: [],
            requiresBudgetKeys: [],
            requiresBindings: false,
          },
          output: {
            requiredOutcomeCondition: null,
            allowedArtifactKind: 'idea',
            outputRequired: true,
          },
        },
      ],
      edges: [],
      artifactKinds: ['idea'],
      budgetKeys: [],
      artifactDownstreamOrder: ['idea'],
    });
    const nfd = make('é'); // e + combining acute
    const nfc = make('é'); // precomposed e-acute
    expect(serializeIdeaToNovelProjectGraphV1(nfd as never)).toBe(
      serializeIdeaToNovelProjectGraphV1(nfc as never),
    );
    const serialized = serializeIdeaToNovelProjectGraphV1(IDEA_TO_NOVEL_PROJECT_GRAPH_V1);
    expect(serialized).not.toContain('localeCompare');
  });
});

describe('只读辅助', () => {
  it('possibleNextNodes 返回直接后继（Project）', () => {
    expect(possibleNextNodes(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, IDEA_CAPTURE)).toEqual([SPEC_EXTRACT]);
  });

  it('possibleNextNodes 返回直接后继（Chapter）', () => {
    expect(possibleNextNodes(CHAPTER_GENERATION_GRAPH_V1, CHAPTER_PLAN)).toEqual([DRAFT]);
  });

  it('getLoopBudgetMax 读取 loop 边声明的最大值', () => {
    expect(getLoopBudgetMax(CHAPTER_GENERATION_GRAPH_V1, 'rewrite')).toBe(3);
    expect(getLoopBudgetMax(CHAPTER_GENERATION_GRAPH_V1, 'regenerate')).toBe(5);
    expect(getLoopBudgetMax(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, 'clarification')).toBe(12);
    expect(getLoopBudgetMax(IDEA_TO_NOVEL_PROJECT_GRAPH_V1, 'intakeRevision')).toBe(3);
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

  it('Project ready 意味着蓝图已被用户明确接受（accept 边到达 PROJECT_READY）', () => {
    const acceptEdges = IDEA_TO_NOVEL_PROJECT_GRAPH_V1.edges.filter((e) => e.to === PROJECT_READY);
    expect(acceptEdges.length).toBeGreaterThanOrEqual(2); // BLUEPRINT_USER_GATE + BLUEPRINT_ESCALATION
  });

  it('Chapter ready 后无 CHAPTER_READY → CHAPTER_PLAN 循环边（下一章由新 run 实现）', () => {
    const loopToPlan = CHAPTER_GENERATION_GRAPH_V1.edges.filter(
      (e) => e.from === CHAPTER_READY && e.to === CHAPTER_PLAN,
    );
    expect(loopToPlan).toHaveLength(0);
  });
});
