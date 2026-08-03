/**
 * @ai-novel/domain - Graph-aware Run State Validation tests（unknown 输入边界，fail-closed）
 *
 * 覆盖：
 * - 嵌套损坏组合矩阵：nodeStatuses / activeFrontier / pendingHumanDecision / artifacts /
 *   nodeOutcomes / attemptBudget / consumedEdges 任意损坏（null / [] / 自定义原型 / 非字符串），
 *   每个输入必须 not.toThrow() 且返回至少一条错误；
 * - 多个字段同时损坏；
 * - required + exact 顶层键（按 graph kind）；
 * - 自定义 prototype 拒绝；
 * - graphId/version 匹配；chapter 输入引用校验；
 * - frontier ↔ status 双向一致；pending decision 双向一致；
 * - consumedEdges / nodeOutcomes 契约；cross-kind 拒绝（Project state vs Chapter graph）。
 */

import { describe, it, expect } from 'vitest';
import {
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  CHAPTER_GENERATION_GRAPH_V1,
  IDEA_CAPTURE,
  SPEC_EXTRACT,
  BLUEPRINT_USER_GATE,
  RESEARCH_DECISION,
  createWorkflowRunId,
  type GraphNodeId,
} from './idea-to-novel-graph.js';
import {
  validateGraphRunState,
  isValidGraphRunState,
} from './idea-to-novel-graph-state-validation.js';
import {
  createProjectInitialRunState,
  createChapterInitialRunState,
  artifactRef,
  type ChapterGenerationRunState,
  type IdeaToNovelProjectRunState,
  type ProjectId,
} from './index.js';

const PG = IDEA_TO_NOVEL_PROJECT_GRAPH_V1;
const CG = CHAPTER_GENERATION_GRAPH_V1;
const PROJECT_ID = 'project-1' as unknown as ProjectId;
const RUN_ID = createWorkflowRunId('run-1');
const CREATED_AT = '2026-08-03T00:00:00.000Z';

function projectFresh(): IdeaToNovelProjectRunState {
  return createProjectInitialRunState({
    graph: PG,
    projectId: PROJECT_ID,
    workflowRunId: RUN_ID,
    createdAt: CREATED_AT,
  });
}

function chapterFresh(): ChapterGenerationRunState {
  return createChapterInitialRunState({
    graph: CG,
    projectId: PROJECT_ID,
    workflowRunId: RUN_ID,
    creationSpecVersionId: 'spec-v1' as never,
    researchBundleId: null,
    storyBlueprintId: 'bp-1' as never,
    blueprintChapterId: 'ch-1' as never,
    createdAt: CREATED_AT,
  });
}

/** 一个通过校验的合法 state（走到 SPEC_EXTRACT 活跃） */
function validProjectState(): IdeaToNovelProjectRunState {
  return {
    ...projectFresh(),
    nodeStatuses: {
      ...projectFresh().nodeStatuses,
      [IDEA_CAPTURE]: 'succeeded',
      [SPEC_EXTRACT]: 'active',
    },
    activeFrontier: [SPEC_EXTRACT],
  };
}

/** 断言：任意输入不抛异常且返回至少一条错误 */
function expectRejected(input: unknown, graph = PG): void {
  expect(() => validateGraphRunState(graph, input)).not.toThrow();
  expect(validateGraphRunState(graph, input).length).toBeGreaterThan(0);
}

describe('嵌套损坏组合矩阵（任意输入不抛、返回至少一条错误）', () => {
  it('nodeStatuses = null / [] / 自定义原型', () => {
    const base = validProjectState();
    expectRejected({ ...base, nodeStatuses: null });
    expectRejected({ ...base, nodeStatuses: [] });
    const evil = Object.create({ hidden: 'x' });
    expectRejected({ ...base, nodeStatuses: evil });
  });

  it('activeFrontier = null / {} / 含非字符串', () => {
    const base = validProjectState();
    expectRejected({ ...base, activeFrontier: null });
    expectRejected({ ...base, activeFrontier: {} });
    expectRejected({ ...base, activeFrontier: [123, 'string'] });
  });

  it('pendingHumanDecision 合法对象 + activeFrontier=null', () => {
    const base = validProjectState();
    const withPending = {
      ...base,
      nodeStatuses: { ...base.nodeStatuses, [SPEC_EXTRACT]: 'waiting_for_human' },
      pendingHumanDecision: { nodeId: SPEC_EXTRACT, decisionType: 'intake_response' },
    };
    expectRejected({ ...withPending, activeFrontier: null });
  });

  it('pendingHumanDecision 合法对象 + nodeStatuses=null', () => {
    const base = validProjectState();
    const withPending = {
      ...base,
      nodeStatuses: { ...base.nodeStatuses, [SPEC_EXTRACT]: 'waiting_for_human' },
      pendingHumanDecision: { nodeId: SPEC_EXTRACT, decisionType: 'intake_response' },
    };
    expectRejected({ ...withPending, nodeStatuses: null });
  });

  it('artifacts=null / nodeOutcomes=null / attemptBudget=null / consumedEdges=null', () => {
    const base = validProjectState();
    expectRejected({ ...base, artifacts: null });
    expectRejected({ ...base, nodeOutcomes: null });
    expectRejected({ ...base, attemptBudget: null });
    expectRejected({ ...base, consumedEdges: null });
  });

  it('多个字段同时损坏（nodeStatuses=null + activeFrontier=null + artifacts=null）', () => {
    const base = validProjectState();
    expectRejected({
      ...base,
      nodeStatuses: null,
      activeFrontier: null,
      artifacts: null,
      nodeOutcomes: null,
      attemptBudget: null,
      consumedEdges: null,
      invalidatedArtifacts: null,
    });
  });

  it('顶层非对象 / 自定义原型', () => {
    expectRejected(null);
    expectRejected(undefined);
    expectRejected(42);
    expectRejected('state');
    expectRejected([]);
    expectRejected(Object.create({ evil: true }));
  });
});

describe('required + exact 顶层键', () => {
  it('缺失必需键 → STATE_MISSING_KEY；多余键 → STATE_EXTRA_KEY', () => {
    const base = validProjectState();
    const missing = { ...base } as Record<string, unknown>;
    delete missing.nodeStatuses;
    const missingErrors = validateGraphRunState(PG, missing);
    expect(missingErrors.map((e) => e.code)).toContain('STATE_MISSING_KEY');

    const extra = { ...base, extraKey: 1 };
    const extraErrors = validateGraphRunState(PG, extra);
    expect(extraErrors.map((e) => e.code)).toContain('STATE_EXTRA_KEY');
  });

  it('graphId/version 与权威 Graph 不一致 → STATE_GRAPH_ID_MISMATCH', () => {
    const base = validProjectState();
    expectRejected({ ...base, graphId: 'wrong-graph' });
    expectRejected({ ...base, graphVersion: 'v2' });
  });

  it('id 字段 trim 为空 → STATE_EMPTY_ID', () => {
    const base = validProjectState();
    expectRejected({ ...base, projectId: '   ' });
    expectRejected({ ...base, workflowRunId: '' });
    expectRejected({ ...base, createdAt: '  ' });
  });
});

describe('Chapter state required 字段', () => {
  it('Chapter state 缺失 blueprintChapterId / creationSpecVersionId / storyBlueprintId → 拒绝', () => {
    const s = chapterFresh();
    expect(isValidGraphRunState(CG, s)).toBe(true);
    for (const key of ['blueprintChapterId', 'creationSpecVersionId', 'storyBlueprintId']) {
      const broken = { ...s } as Record<string, unknown>;
      delete broken[key];
      expectRejected(broken, CG);
    }
    const badResearch = { ...s, researchBundleId: '   ' };
    expectRejected(badResearch, CG);
  });
});

describe('frontier ↔ status 双向一致', () => {
  it('frontier 与 active/waiting 不一致 → STATE_FRONTIER_STATUS_MISMATCH', () => {
    const base = validProjectState();
    // frontier 声称 RESEARCH_DECISION active，但状态是 pending
    expectRejected({ ...base, activeFrontier: [RESEARCH_DECISION] });
    // status 为 active 但不在 frontier
    const statusOnlyActive = {
      ...base,
      nodeStatuses: { ...base.nodeStatuses, [BLUEPRINT_USER_GATE]: 'active' },
      activeFrontier: [SPEC_EXTRACT],
    };
    expectRejected(statusOnlyActive);
    // frontier 重复
    expectRejected({ ...base, activeFrontier: [SPEC_EXTRACT, SPEC_EXTRACT] });
    // frontier 含未知节点
    expectRejected({ ...base, activeFrontier: ['NO_SUCH_NODE' as GraphNodeId] });
  });
});

describe('pending decision 双向一致', () => {
  it('waiting_for_human 必须恰好对应一个 pending decision', () => {
    const base = validProjectState();
    // waiting_for_human 但无 pending
    const noPending = {
      ...base,
      nodeStatuses: { ...base.nodeStatuses, [SPEC_EXTRACT]: 'waiting_for_human' },
    };
    expectRejected(noPending);
    // 有 pending 但节点不是 waiting_for_human
    const notWaiting = {
      ...base,
      pendingHumanDecision: { nodeId: SPEC_EXTRACT, decisionType: 'intake_response' },
    };
    expectRejected(notWaiting);
    // pending 决策类型与节点不匹配（SPEC_EXTRACT 不是人工节点）
    const wrongType = {
      ...base,
      nodeStatuses: { ...base.nodeStatuses, [SPEC_EXTRACT]: 'waiting_for_human' },
      pendingHumanDecision: { nodeId: SPEC_EXTRACT, decisionType: 'blueprint_gate' },
    };
    expectRejected(wrongType);
  });
});

describe('artifacts / nodeOutcomes / consumedEdges 契约', () => {
  it('artifact 引用 kind 不匹配 / ID 为空 → 拒绝', () => {
    const base = validProjectState();
    expectRejected({
      ...base,
      artifacts: {
        ...base.artifacts,
        idea: { kind: 'creationSpec', artifactId: 'x' },
      },
    });
    expectRejected({
      ...base,
      artifacts: { ...base.artifacts, idea: { kind: 'idea', artifactId: '  ' } },
    });
  });

  it('nodeOutcomes：节点未知 / condition 与契约不一致 / value 非法 → 拒绝', () => {
    const base = validProjectState();
    const withSucceeded = {
      ...base,
      nodeStatuses: { ...base.nodeStatuses, [SPEC_EXTRACT]: 'succeeded' },
    };
    // condition 与输出契约不一致（SPEC_EXTRACT 产出 clarification_remaining）
    expectRejected({
      ...withSucceeded,
      nodeOutcomes: { [SPEC_EXTRACT]: { condition: 'blueprint_gate', value: 'accept' } },
    });
    // value 非法
    expectRejected({
      ...withSucceeded,
      nodeOutcomes: {
        [SPEC_EXTRACT]: { condition: 'clarification_remaining', value: 'maybe' },
      },
    });
    // 有 outcome 但节点未 succeeded
    expectRejected({
      ...base,
      nodeOutcomes: { [SPEC_EXTRACT]: { condition: 'clarification_remaining', value: 'ask_more' } },
    });
  });

  it('consumedEdges：未知边 / 重复 → 拒绝', () => {
    const base = validProjectState();
    expectRejected({ ...base, consumedEdges: ['not-an-edge'] });
    expectRejected({
      ...base,
      consumedEdges: ['idea-capture--spec-extract', 'idea-capture--spec-extract'],
    });
  });

  it('terminal 一致性：terminal run frontier 非空 / 终止节点未 succeeded → 拒绝', () => {
    const base = validProjectState();
    // completed 但 frontier 非空
    expectRejected({
      ...base,
      terminalStatus: 'completed',
      nodeStatuses: { ...base.nodeStatuses, [BLUEPRINT_USER_GATE]: 'succeeded' },
    });
    // completed 但 PROJECT_READY 未 succeeded
    expectRejected({
      ...base,
      terminalStatus: 'completed',
      activeFrontier: [],
      nodeStatuses: {
        ...base.nodeStatuses,
        [SPEC_EXTRACT]: 'succeeded',
        [BLUEPRINT_USER_GATE]: 'pending',
      },
    });
  });
});

describe('cross-kind 拒绝（Project state vs Chapter graph）', () => {
  it('Project state 传给 Chapter graph → 拒绝', () => {
    const s = validProjectState();
    expectRejected(s, CG);
  });

  it('Chapter state 传给 Project graph → 拒绝', () => {
    expectRejected(chapterFresh(), PG);
  });

  it('合法 Project state 通过；合法 Chapter state 通过', () => {
    expect(isValidGraphRunState(PG, validProjectState())).toBe(true);
    expect(isValidGraphRunState(CG, chapterFresh())).toBe(true);
  });
});

describe('artifactRef 使用示例（契约保持闭合判别联合）', () => {
  it('project 状态持有权威 artifact ref', () => {
    let s = projectFresh();
    s = {
      ...s,
      nodeStatuses: { ...s.nodeStatuses, [IDEA_CAPTURE]: 'succeeded' },
      activeFrontier: [],
      artifacts: { ...s.artifacts, idea: artifactRef('idea', 'idea-1') },
    };
    expect(isValidGraphRunState(PG, s)).toBe(true);
    expect(s.artifacts.idea).toEqual({ kind: 'idea', artifactId: 'idea-1' });
  });
});
