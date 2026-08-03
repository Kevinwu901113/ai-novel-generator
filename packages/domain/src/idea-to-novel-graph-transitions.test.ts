/**
 * @ai-novel/domain - Idea-to-Novel Graph Transition tests
 *
 * 覆盖任务要求的全部主流程场景：
 * - 无需调研分支；
 * - 轻量/深度调研分支；
 * - Research 校验失败后回环；
 * - 三个 Critic 并行后 join；
 * - Rewrite 回环达到最大次数；
 * - 用户接受、拒绝、要求重写；
 * - 不合法 transition 被拒绝；
 * - 失败终止 / 终止判断 / frontier 一致性与 computeNextFrontier。
 */

import { describe, it, expect } from 'vitest';
import {
  IDEA_TO_NOVEL_GRAPH_V1,
  IDEA_CAPTURE,
  SPEC_EXTRACT,
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
  BLUEPRINT_ESCALATION,
  CANDIDATE_ESCALATION,
  RUN_CANCELLED,
  RUN_BLOCKED,
  aggregateCritiqueVerdict,
  createWorkflowRunId,
  type GraphId,
  type GraphNodeId,
  type GraphNodeOutcome,
} from './idea-to-novel-graph.js';
import { isValidGraphRunState } from './idea-to-novel-graph-state-validation.js';
import {
  createInitialRunState,
  artifactRef,
  type IdeaToNovelGraphRunState,
  type ProjectId,
} from './index.js';
import {
  applyNodeSuccess,
  applyNodeFailure,
  applyHumanDecision,
  requestHumanDecision,
  isRunTerminal,
  terminalStatusOf,
  canTraverseEdge,
  computeNextFrontier,
  aggregateJoinOutcome,
  type ApplyNodeSuccessOptions,
  type HumanDecisionInput,
} from './idea-to-novel-graph-transitions.js';

const G = IDEA_TO_NOVEL_GRAPH_V1;
const PROJECT_ID = 'project-1' as unknown as ProjectId;
const RUN_ID = createWorkflowRunId('run-1');
const CREATED_AT = '2026-08-03T00:00:00.000Z';

function fresh(): IdeaToNovelGraphRunState {
  return createInitialRunState({
    graph: G,
    projectId: PROJECT_ID,
    workflowRunId: RUN_ID,
    createdAt: CREATED_AT,
  });
}

function success(
  state: IdeaToNovelGraphRunState,
  nodeId: GraphNodeId,
  opts?: ApplyNodeSuccessOptions,
): IdeaToNovelGraphRunState {
  return applyNodeSuccess(G, state, nodeId, opts);
}

function frontierOf(state: IdeaToNovelGraphRunState): ReadonlyArray<GraphNodeId> {
  return [...state.activeFrontier].sort();
}

/** 走完 Idea Intake → spec_complete → RESEARCH_DECISION 活跃 */
function intakeComplete(state: IdeaToNovelGraphRunState): IdeaToNovelGraphRunState {
  let s = success(state, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'idea-1') });
  s = success(s, SPEC_EXTRACT, {
    outcome: { condition: 'clarification_remaining', value: 'spec_complete' },
    artifactRef: artifactRef('creationSpec', 'spec-1'),
  });
  return s;
}

/** 让 3 个 Critic 依次完成并汇合，返回 CRITIQUE_JOIN 完成后的状态 */
function criticsAll(
  state: IdeaToNovelGraphRunState,
  verdict: 'pass' | 'needs_rewrite',
): IdeaToNovelGraphRunState {
  let s = state;
  for (const critic of [CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC]) {
    s = success(s, critic, {
      outcome: { condition: 'critique_verdict', value: verdict } satisfies GraphNodeOutcome,
    });
  }
  // CRITIQUE_JOIN 不接受调用方 verdict，由聚合策略从三个 Critic 确定性计算
  s = success(s, CRITIQUE_JOIN);
  return s;
}

/** 走到 BLUEPRINT_USER_GATE 通过（接受蓝图）后的 DRAFT 活跃状态 */
function reachDraft(state: IdeaToNovelGraphRunState): IdeaToNovelGraphRunState {
  let s = intakeComplete(state);
  s = success(s, RESEARCH_DECISION, { outcome: { condition: 'research_decision', value: 'none' } });
  s = success(s, BLUEPRINT_GENERATE, { artifactRef: artifactRef('storyBlueprint', 'bp-1') });
  s = requestHumanDecision(G, s, BLUEPRINT_USER_GATE, 'blueprint_gate');
  s = applyHumanDecision(G, s, {
    nodeId: BLUEPRINT_USER_GATE,
    decisionType: 'blueprint_gate',
    outcome: 'accept',
  });
  s = success(s, CHAPTER_PLAN);
  return s; // frontier: [DRAFT]
}

/** 从 DRAFT 前状态走到 CANDIDATE_GATE 挂起（等待用户对候选稿做决定） */
function reachCandidateGate(state: IdeaToNovelGraphRunState): IdeaToNovelGraphRunState {
  let s = success(state, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
  s = criticsAll(s, 'pass');
  return requestHumanDecision(G, s, CANDIDATE_GATE, 'candidate_gate');
}

/** 从 fresh 一路走到 CANDIDATE_GATE 挂起 */
function reachedCandidateGate(): IdeaToNovelGraphRunState {
  return reachCandidateGate(reachDraft(fresh()));
}

describe('无需调研分支（全链 completed）', () => {
  it('Idea → Spec → 无调研 → Blueprint → 生成 → 三个 Critic → 接受 → 稿件 → 导出', () => {
    let s = fresh();
    expect(frontierOf(s)).toEqual([IDEA_CAPTURE]);

    s = intakeComplete(s);
    expect(frontierOf(s)).toEqual([RESEARCH_DECISION]);

    s = success(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'none' },
    });
    expect(frontierOf(s)).toEqual([BLUEPRINT_GENERATE]); // 无需调研 → 直接蓝图

    s = success(s, BLUEPRINT_GENERATE, { artifactRef: artifactRef('storyBlueprint', 'bp-1') });
    expect(frontierOf(s)).toEqual([BLUEPRINT_USER_GATE]);

    s = requestHumanDecision(G, s, BLUEPRINT_USER_GATE, 'blueprint_gate');
    expect(s.nodeStatuses[BLUEPRINT_USER_GATE]).toBe('waiting_for_human');
    expect(s.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
    s = applyHumanDecision(G, s, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'accept',
    });
    expect(frontierOf(s)).toEqual([CHAPTER_PLAN]);

    s = success(s, CHAPTER_PLAN);
    expect(frontierOf(s)).toEqual([DRAFT]);

    s = success(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    expect(frontierOf(s)).toEqual([CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC].sort());

    // 三个 Critic 并行后 join：前两个完成时 CRITIQUE_JOIN 不应激活
    s = success(s, CONTINUITY_CRITIC, {
      outcome: { condition: 'critique_verdict', value: 'pass' },
    });
    expect(s.activeFrontier).not.toContain(CRITIQUE_JOIN);
    s = success(s, STYLE_CRITIC, {
      outcome: { condition: 'critique_verdict', value: 'pass' },
    });
    expect(s.activeFrontier).not.toContain(CRITIQUE_JOIN);
    s = success(s, REQUIREMENT_CRITIC, {
      outcome: { condition: 'critique_verdict', value: 'pass' },
    });
    expect(frontierOf(s)).toEqual([CRITIQUE_JOIN]); // 3/3 → join

    s = success(s, CRITIQUE_JOIN);
    expect(frontierOf(s)).toEqual([CANDIDATE_GATE]);

    s = requestHumanDecision(G, s, CANDIDATE_GATE, 'candidate_gate');
    s = applyHumanDecision(G, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'accept',
    });
    expect(frontierOf(s)).toEqual([MANUSCRIPT_COMMIT]);

    s = success(s, MANUSCRIPT_COMMIT, { artifactRef: artifactRef('manuscript', 'ms-1') });
    expect(frontierOf(s)).toEqual([EXPORT_READY]);

    s = success(s, EXPORT_READY);
    expect(s.terminalStatus).toBe('completed');
    expect(s.activeFrontier).toEqual([]);
    expect(isRunTerminal(G, s)).toBe(true);
  });
});

describe('轻量 / 深度调研分支', () => {
  it('light → RESEARCH_PLAN → RESEARCH_EXECUTE → 校验通过 → BLUEPRINT_GENERATE', () => {
    let s = intakeComplete(fresh());
    s = success(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'light' },
    });
    expect(frontierOf(s)).toEqual([RESEARCH_PLAN]);
    s = success(s, RESEARCH_PLAN);
    expect(frontierOf(s)).toEqual([RESEARCH_EXECUTE]);
    s = success(s, RESEARCH_EXECUTE, { artifactRef: artifactRef('researchBundle', 'rb-1') });
    expect(frontierOf(s)).toEqual([RESEARCH_VALIDATE]);
    s = success(s, RESEARCH_VALIDATE, { outcome: { condition: 'research_valid', value: 'valid' } });
    expect(frontierOf(s)).toEqual([BLUEPRINT_GENERATE]);
    expect(s.attemptBudget.researchRetry).toBe(0);
  });

  it('deep 与 light 进入同一个 RESEARCH_PLAN', () => {
    let s = intakeComplete(fresh());
    s = success(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'deep' },
    });
    expect(frontierOf(s)).toEqual([RESEARCH_PLAN]);
  });
});

describe('Research 校验失败后回环', () => {
  it('invalid → 回 RESEARCH_EXECUTE 重试 → 第二次 valid → 继续', () => {
    let s = intakeComplete(fresh());
    s = success(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'light' },
    });
    s = success(s, RESEARCH_PLAN);
    s = success(s, RESEARCH_EXECUTE, { artifactRef: artifactRef('researchBundle', 'rb-1') });
    s = success(s, RESEARCH_VALIDATE, {
      outcome: { condition: 'research_valid', value: 'invalid' },
    });
    expect(frontierOf(s)).toEqual([RESEARCH_EXECUTE]); // 回环
    expect(s.attemptBudget.researchRetry).toBe(1);

    s = success(s, RESEARCH_EXECUTE, { artifactRef: artifactRef('researchBundle', 'rb-2') });
    s = success(s, RESEARCH_VALIDATE, { outcome: { condition: 'research_valid', value: 'valid' } });
    expect(frontierOf(s)).toEqual([BLUEPRINT_GENERATE]);
    expect(s.attemptBudget.researchRetry).toBe(1);
  });

  it('连续 invalid 达到最大次数后走耗尽出口（降级继续）', () => {
    let s = intakeComplete(fresh());
    s = success(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'deep' },
    });
    s = success(s, RESEARCH_PLAN);
    s = success(s, RESEARCH_EXECUTE, { artifactRef: artifactRef('researchBundle', 'rb-1') });
    s = success(s, RESEARCH_VALIDATE, {
      outcome: { condition: 'research_valid', value: 'invalid' },
    });
    s = success(s, RESEARCH_EXECUTE, { artifactRef: artifactRef('researchBundle', 'rb-2') });
    s = success(s, RESEARCH_VALIDATE, {
      outcome: { condition: 'research_valid', value: 'invalid' },
    });
    // 已达 max=2：第三次 invalid → 预算耗尽出口
    s = success(s, RESEARCH_EXECUTE, { artifactRef: artifactRef('researchBundle', 'rb-3') });
    s = success(s, RESEARCH_VALIDATE, {
      outcome: { condition: 'research_valid', value: 'invalid' },
    });
    expect(s.attemptBudget.researchRetry).toBe(2);
    expect(frontierOf(s)).toEqual([BLUEPRINT_GENERATE]); // 降级继续
  });
});

describe('三个 Critic 并行后 join', () => {
  it('只有三个都完成后 CRITIQUE_JOIN 才激活', () => {
    let s = reachDraft(fresh());
    s = success(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    expect(frontierOf(s)).toEqual([CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC].sort());

    s = success(s, CONTINUITY_CRITIC, {
      outcome: { condition: 'critique_verdict', value: 'pass' },
    });
    expect(s.activeFrontier).not.toContain(CRITIQUE_JOIN);
    s = success(s, STYLE_CRITIC, { outcome: { condition: 'critique_verdict', value: 'pass' } });
    expect(s.activeFrontier).not.toContain(CRITIQUE_JOIN);
    s = success(s, REQUIREMENT_CRITIC, {
      outcome: { condition: 'critique_verdict', value: 'pass' },
    });
    expect(frontierOf(s)).toEqual([CRITIQUE_JOIN]);
  });
});

describe('Rewrite 回环达到最大次数', () => {
  it('critic 持续 needs_rewrite 时最多 rewrite 3 次，然后走到 CANDIDATE_GATE', () => {
    let s = reachDraft(fresh());
    s = success(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    s = criticsAll(s, 'needs_rewrite');
    expect(frontierOf(s)).toEqual([REWRITE]);
    expect(s.attemptBudget.rewrite).toBe(1);

    s = success(s, REWRITE);
    s = criticsAll(s, 'needs_rewrite');
    expect(s.attemptBudget.rewrite).toBe(2);
    expect(frontierOf(s)).toEqual([REWRITE]);

    s = success(s, REWRITE);
    s = criticsAll(s, 'needs_rewrite');
    expect(s.attemptBudget.rewrite).toBe(3);
    expect(frontierOf(s)).toEqual([REWRITE]);

    // 第三次 rewrite 后仍 needs_rewrite → 预算耗尽 → CANDIDATE_GATE
    s = success(s, REWRITE);
    s = criticsAll(s, 'needs_rewrite');
    expect(s.attemptBudget.rewrite).toBe(3);
    expect(frontierOf(s)).toEqual([CANDIDATE_GATE]);
  });

  it('critic 通过时不需要 rewrite，直接到 CANDIDATE_GATE', () => {
    let s = reachDraft(fresh());
    s = success(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    s = criticsAll(s, 'pass');
    expect(s.attemptBudget.rewrite).toBe(0);
    expect(frontierOf(s)).toEqual([CANDIDATE_GATE]);
  });
});

describe('用户接受 / 拒绝 / 要求重写', () => {
  it('accept → MANUSCRIPT_COMMIT', () => {
    let s = reachedCandidateGate();
    s = applyHumanDecision(G, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'accept',
    });
    expect(frontierOf(s)).toEqual([MANUSCRIPT_COMMIT]);
    expect(s.pendingHumanDecision).toBeNull();
  });

  it('reject → 重新 DRAFT（regenerate 预算 +1）', () => {
    let s = reachedCandidateGate();
    s = applyHumanDecision(G, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'reject',
    });
    expect(frontierOf(s)).toEqual([DRAFT]);
    expect(s.attemptBudget.regenerate).toBe(1);
  });

  it('request_rewrite → REWRITE（candidateRewrite 预算 +1）', () => {
    let s = reachedCandidateGate();
    s = applyHumanDecision(G, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'request_rewrite',
    });
    expect(frontierOf(s)).toEqual([REWRITE]);
    expect(s.attemptBudget.candidateRewrite).toBe(1);
  });

  it('request_rewrite 进入候选改写循环时刷新 critique rewrite 预算', () => {
    // 模拟 rewrite 预算已耗尽（3 次自动改写用光）
    const g = reachedCandidateGate();
    let s: IdeaToNovelGraphRunState = {
      ...g,
      attemptBudget: { ...g.attemptBudget, rewrite: 3 },
    };
    s = applyHumanDecision(G, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'request_rewrite',
    });
    expect(s.attemptBudget.rewrite).toBe(0); // CANDIDATE_GATE 成功后刷新
    expect(frontierOf(s)).toEqual([REWRITE]);

    s = success(s, REWRITE);
    s = criticsAll(s, 'needs_rewrite');
    // 新一轮 critique 改写循环可用，而不是立即弹回 CANDIDATE_GATE
    expect(s.attemptBudget.rewrite).toBe(1);
    expect(frontierOf(s)).toEqual([REWRITE]);
  });

  it('reject 后重新生成，DRAFT 会重置 rewrite / candidateRewrite 预算', () => {
    let s = reachedCandidateGate();
    // 先消耗一次 rewrite 预算
    s = {
      ...s,
      attemptBudget: { ...s.attemptBudget, rewrite: 3, candidateRewrite: 2 },
    };
    s = applyHumanDecision(G, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'reject',
    });
    s = success(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-2') });
    expect(s.attemptBudget.rewrite).toBe(0);
    expect(s.attemptBudget.candidateRewrite).toBe(0);
    expect(s.attemptBudget.regenerate).toBe(1);
  });
});

describe('不合法 transition 被拒绝', () => {
  it('applyNodeSuccess 对不在活跃 frontier 的节点抛错', () => {
    const s = fresh();
    expect(() => success(s, RESEARCH_DECISION)).toThrow();
  });

  it('applyNodeSuccess 对人工门禁节点（USER_GATE / CLARIFY_ANSWER）抛错', () => {
    const s = fresh();
    expect(() => success(s, CANDIDATE_GATE)).toThrow();
  });

  it('requestHumanDecision 对非人工节点 / 重复请求抛错', () => {
    const s = fresh();
    expect(() => requestHumanDecision(G, s, DRAFT, 'candidate_gate')).toThrow();
    let g = intakeComplete(fresh());
    g = success(g, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'none' },
    });
    g = success(g, BLUEPRINT_GENERATE, { artifactRef: artifactRef('storyBlueprint', 'bp-1') });
    g = requestHumanDecision(G, g, BLUEPRINT_USER_GATE, 'blueprint_gate');
    expect(() => requestHumanDecision(G, g, BLUEPRINT_USER_GATE, 'blueprint_gate')).toThrow();
  });

  it('applyHumanDecision 在没有待处理决策 / 节点不匹配 / 类型不匹配时抛错', () => {
    const s = fresh();
    const decision: HumanDecisionInput = {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'accept',
    };
    expect(() => applyHumanDecision(G, s, decision)).toThrow(); // 无待处理

    const g = reachedCandidateGate();
    expect(() => applyHumanDecision(G, g, { ...decision, nodeId: DRAFT })).toThrow(); // 节点不匹配
    expect(() =>
      applyHumanDecision(G, g, {
        nodeId: CANDIDATE_GATE,
        decisionType: 'blueprint_gate',
        outcome: 'accept',
      }),
    ).toThrow(); // 类型不匹配
  });

  it('blueprint_gate 不接受 reject（闭合枚举外取值）', () => {
    let s = intakeComplete(fresh());
    s = success(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'none' },
    });
    s = success(s, BLUEPRINT_GENERATE, { artifactRef: artifactRef('storyBlueprint', 'bp-1') });
    s = requestHumanDecision(G, s, BLUEPRINT_USER_GATE, 'blueprint_gate');
    expect(() =>
      applyHumanDecision(G, s, {
        nodeId: BLUEPRINT_USER_GATE,
        decisionType: 'blueprint_gate',
        outcome: 'reject',
      } as never),
    ).toThrow();
  });

  it('canTraverseEdge：源未成功或未知边返回 false', () => {
    const s = fresh();
    expect(canTraverseEdge(G, s, 'idea-capture--spec-extract')).toBe(false); // 源未成功
    expect(canTraverseEdge(G, s, 'no-such-edge')).toBe(false);
  });
});

describe('失败终止与终止判断', () => {
  it('applyNodeFailure → terminalStatus failed，frontier 清空', () => {
    let s = intakeComplete(fresh());
    s = success(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'deep' },
    });
    s = success(s, RESEARCH_PLAN);
    s = applyNodeFailure(G, s, RESEARCH_EXECUTE);
    expect(s.terminalStatus).toBe('failed');
    expect(s.activeFrontier).toEqual([]);
    expect(s.nodeStatuses[RESEARCH_EXECUTE]).toBe('failed');
    expect(isRunTerminal(G, s)).toBe(true);
  });

  it('applyNodeFailure 对不在 frontier 的节点抛错', () => {
    const s = fresh();
    expect(() => applyNodeFailure(G, s, DRAFT)).toThrow();
  });

  it('isRunTerminal 初始为 false，完成后为 true', () => {
    let s = fresh();
    expect(isRunTerminal(G, s)).toBe(false);
    // 走到完成
    s = intakeComplete(s);
    s = success(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'none' },
    });
    s = success(s, BLUEPRINT_GENERATE, { artifactRef: artifactRef('storyBlueprint', 'bp-1') });
    s = requestHumanDecision(G, s, BLUEPRINT_USER_GATE, 'blueprint_gate');
    s = applyHumanDecision(G, s, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'accept',
    });
    s = success(s, CHAPTER_PLAN);
    s = success(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    s = criticsAll(s, 'pass');
    s = requestHumanDecision(G, s, CANDIDATE_GATE, 'candidate_gate');
    s = applyHumanDecision(G, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'accept',
    });
    s = success(s, MANUSCRIPT_COMMIT, { artifactRef: artifactRef('manuscript', 'ms-1') });
    s = success(s, EXPORT_READY);
    expect(terminalStatusOf(s)).toBe('completed');
    expect(isRunTerminal(G, s)).toBe(true);
  });
});

describe('computeNextFrontier 与 frontier 一致性', () => {
  it('初始状态无新待激活节点', () => {
    expect(computeNextFrontier(G, fresh())).toEqual([]);
  });

  it('三个 Critic 全部完成后，computeNextFrontier 返回 CRITIQUE_JOIN', () => {
    let s = reachDraft(fresh());
    s = success(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    const manualState: IdeaToNovelGraphRunState = {
      ...s,
      nodeStatuses: {
        ...s.nodeStatuses,
        [CONTINUITY_CRITIC]: 'succeeded',
        [STYLE_CRITIC]: 'succeeded',
        [REQUIREMENT_CRITIC]: 'succeeded',
      },
      activeFrontier: [],
    };
    expect(computeNextFrontier(G, manualState)).toEqual([CRITIQUE_JOIN]);
  });

  it('applyNodeSuccess 产出的 frontier 与节点状态派生一致', () => {
    let s = fresh();
    s = intakeComplete(s);
    const derived = s.activeFrontier.every(
      (id) => s.nodeStatuses[id] === 'active' || s.nodeStatuses[id] === 'waiting_for_human',
    );
    expect(derived).toBe(true);
  });
});

/** 驱动 BLUEPRINT_USER_GATE 的 request_rewrite 直到 blueprintRewrite 耗尽，返回 BLUEPRINT_ESCALATION 活跃状态 */
function blueprintGateExhausted(): IdeaToNovelGraphRunState {
  let s = intakeComplete(fresh());
  s = success(s, RESEARCH_DECISION, {
    outcome: { condition: 'research_decision', value: 'none' },
  });
  s = success(s, BLUEPRINT_GENERATE, { artifactRef: artifactRef('storyBlueprint', 'bp-1') });
  for (let i = 0; i < 3; i++) {
    s = requestHumanDecision(G, s, BLUEPRINT_USER_GATE, 'blueprint_gate');
    s = applyHumanDecision(G, s, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'request_rewrite',
    });
    s = success(s, BLUEPRINT_GENERATE, {
      artifactRef: artifactRef('storyBlueprint', `bp-${i + 2}`),
    });
  }
  // 第 4 次 request_rewrite → blueprintRewrite 耗尽 → BLUEPRINT_ESCALATION（而非 CHAPTER_PLAN）
  s = requestHumanDecision(G, s, BLUEPRINT_USER_GATE, 'blueprint_gate');
  s = applyHumanDecision(G, s, {
    nodeId: BLUEPRINT_USER_GATE,
    decisionType: 'blueprint_gate',
    outcome: 'request_rewrite',
  });
  return s;
}

describe('预算耗尽人工升级（不自动接受）', () => {
  it('blueprintRewrite 耗尽 → 进入 BLUEPRINT_ESCALATION，而非自动 CHAPTER_PLAN', () => {
    const s = blueprintGateExhausted();
    expect(s.attemptBudget.blueprintRewrite).toBe(3);
    expect(frontierOf(s)).toEqual([BLUEPRINT_ESCALATION]);
    expect(s.activeFrontier).not.toContain(CHAPTER_PLAN);
  });

  it('升级节点 accept_current → CHAPTER_PLAN（用户显式接受）', () => {
    let s = blueprintGateExhausted();
    s = requestHumanDecision(G, s, BLUEPRINT_ESCALATION, 'escalation');
    s = applyHumanDecision(G, s, {
      nodeId: BLUEPRINT_ESCALATION,
      decisionType: 'escalation',
      outcome: 'accept_current',
    });
    expect(frontierOf(s)).toEqual([CHAPTER_PLAN]);
  });

  it('升级节点 cancel → RUN_CANCELLED → terminal cancelled', () => {
    let s = blueprintGateExhausted();
    s = requestHumanDecision(G, s, BLUEPRINT_ESCALATION, 'escalation');
    s = applyHumanDecision(G, s, {
      nodeId: BLUEPRINT_ESCALATION,
      decisionType: 'escalation',
      outcome: 'cancel',
    });
    expect(frontierOf(s)).toEqual([RUN_CANCELLED]);
    s = success(s, RUN_CANCELLED);
    expect(terminalStatusOf(s)).toBe('cancelled');
  });

  it('升级节点 continue_later → RUN_BLOCKED → terminal blocked（可恢复）', () => {
    let s = blueprintGateExhausted();
    s = requestHumanDecision(G, s, BLUEPRINT_ESCALATION, 'escalation');
    s = applyHumanDecision(G, s, {
      nodeId: BLUEPRINT_ESCALATION,
      decisionType: 'escalation',
      outcome: 'continue_later',
    });
    s = success(s, RUN_BLOCKED);
    expect(terminalStatusOf(s)).toBe('blocked');
  });

  it('升级节点 modify_requirements → 回 SPEC_EXTRACT（specRevision 预算 +1）', () => {
    let s = blueprintGateExhausted();
    s = requestHumanDecision(G, s, BLUEPRINT_ESCALATION, 'escalation');
    s = applyHumanDecision(G, s, {
      nodeId: BLUEPRINT_ESCALATION,
      decisionType: 'escalation',
      outcome: 'modify_requirements',
    });
    expect(frontierOf(s)).toEqual([SPEC_EXTRACT]);
    expect(s.attemptBudget.specRevision).toBe(1);
  });

  it('candidateRewrite 耗尽 → CANDIDATE_ESCALATION，而非自动 MANUSCRIPT_COMMIT', () => {
    const g = reachedCandidateGate();
    let s: IdeaToNovelGraphRunState = {
      ...g,
      attemptBudget: { ...g.attemptBudget, candidateRewrite: 5 },
    };
    s = applyHumanDecision(G, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'request_rewrite',
    });
    expect(frontierOf(s)).toEqual([CANDIDATE_ESCALATION]);
    expect(s.activeFrontier).not.toContain(MANUSCRIPT_COMMIT);
  });

  it('regenerate 耗尽 → CANDIDATE_ESCALATION；accept_current → 用户显式接受才写入稿件', () => {
    const g = reachedCandidateGate();
    let s: IdeaToNovelGraphRunState = {
      ...g,
      attemptBudget: { ...g.attemptBudget, regenerate: 5 },
    };
    s = applyHumanDecision(G, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'reject',
    });
    expect(frontierOf(s)).toEqual([CANDIDATE_ESCALATION]);
    s = requestHumanDecision(G, s, CANDIDATE_ESCALATION, 'escalation');
    s = applyHumanDecision(G, s, {
      nodeId: CANDIDATE_ESCALATION,
      decisionType: 'escalation',
      outcome: 'accept_current',
    });
    expect(frontierOf(s)).toEqual([MANUSCRIPT_COMMIT]);
  });
});

describe('节点输出契约强制', () => {
  it('缺少必需 outcome → 拒绝', () => {
    const s = intakeComplete(fresh());
    expect(() => success(s, RESEARCH_DECISION)).toThrow();
  });

  it('outcome 条件与节点契约不匹配 → 拒绝', () => {
    const s = intakeComplete(fresh());
    expect(() =>
      success(s, RESEARCH_DECISION, {
        outcome: { condition: 'research_valid', value: 'valid' },
      }),
    ).toThrow();
  });

  it('多余 outcome（节点不产出条件）→ 拒绝', () => {
    const s = intakeComplete(fresh());
    expect(() =>
      success(s, RESEARCH_PLAN, { outcome: { condition: 'research_decision', value: 'none' } }),
    ).toThrow();
  });

  it('缺少必需 artifact → 拒绝', () => {
    const s = intakeComplete(fresh());
    expect(() => success(s, BLUEPRINT_GENERATE)).toThrow();
  });

  it('artifact kind 与节点契约不匹配 → 拒绝', () => {
    const s = intakeComplete(fresh());
    expect(() =>
      success(s, DRAFT, { artifactRef: artifactRef('storyBlueprint', 'bp-x') }),
    ).toThrow();
  });

  it('不允许 artifact 的节点产出 artifact → 拒绝', () => {
    const s = intakeComplete(fresh());
    expect(() =>
      success(s, CHAPTER_PLAN, { artifactRef: artifactRef('manuscript', 'ms-x') }),
    ).toThrow();
  });
});

describe('Critique Join 确定性聚合', () => {
  function reachJoinActive(): IdeaToNovelGraphRunState {
    let s = reachDraft(fresh());
    s = success(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    s = success(s, CONTINUITY_CRITIC, {
      outcome: { condition: 'critique_verdict', value: 'pass' },
    });
    s = success(s, STYLE_CRITIC, { outcome: { condition: 'critique_verdict', value: 'pass' } });
    s = success(s, REQUIREMENT_CRITIC, {
      outcome: { condition: 'critique_verdict', value: 'pass' },
    });
    return s; // CRITIQUE_JOIN active
  }

  it('JOIN 不接受调用方伪造的 outcome → 拒绝', () => {
    const s = reachJoinActive();
    expect(() =>
      success(s, CRITIQUE_JOIN, { outcome: { condition: 'critique_verdict', value: 'pass' } }),
    ).toThrow();
  });

  it('全 pass 才 pass，否则 needs_rewrite（从三个来源确定性计算）', () => {
    let s = reachJoinActive();
    s = success(s, CRITIQUE_JOIN);
    expect(frontierOf(s)).toEqual([CANDIDATE_GATE]); // all pass → pass

    const mixed = reachJoinActive();
    const s2 = success(
      {
        ...mixed,
        nodeOutcomes: {
          ...mixed.nodeOutcomes,
          [STYLE_CRITIC]: { condition: 'critique_verdict', value: 'needs_rewrite' },
        },
      },
      CRITIQUE_JOIN,
    );
    expect(frontierOf(s2)).toEqual([REWRITE]); // needs_rewrite → rewrite loop
  });

  it('来源缺项 fail-closed → 抛错', () => {
    const s = reachJoinActive();
    const missing = {
      ...s,
      nodeOutcomes: { ...s.nodeOutcomes },
    };
    delete (missing.nodeOutcomes as Record<string, unknown>)[STYLE_CRITIC];
    expect(() => aggregateJoinOutcome(G, missing, CRITIQUE_JOIN)).toThrow();
  });
});

describe('transition 前置不变量', () => {
  it('state.graphId/version 与 graph 不一致 → 拒绝', () => {
    const s = { ...fresh(), graphId: 'other' as GraphId };
    expect(() => success(s, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'i') })).toThrow();
  });

  it('run 已终止 → 拒绝', () => {
    const s = { ...fresh(), terminalStatus: 'completed' as const };
    expect(() => success(s, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'i') })).toThrow();
  });

  it('activeFrontier 与节点状态不一致 → 拒绝', () => {
    const s = { ...fresh(), activeFrontier: [] };
    expect(() => success(s, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'i') })).toThrow();
  });

  it('nodeStatuses 缺节点 → 拒绝', () => {
    const s = fresh();
    const nodeStatuses = Object.fromEntries(
      Object.entries(s.nodeStatuses).filter(([id]) => id !== DRAFT),
    ) as unknown as IdeaToNovelGraphRunState['nodeStatuses'];
    expect(() =>
      success({ ...s, nodeStatuses }, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'i') }),
    ).toThrow();
  });

  it('pending decision 与节点状态不一致 → 拒绝', () => {
    const s = {
      ...fresh(),
      pendingHumanDecision: { nodeId: CANDIDATE_GATE, decisionType: 'candidate_gate' as const },
    };
    expect(() => success(s, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'i') })).toThrow();
  });

  it('attemptBudget 缺预算键 → 拒绝', () => {
    const s = fresh();
    const attemptBudget = Object.fromEntries(
      Object.entries(s.attemptBudget).filter(([k]) => k !== 'rewrite'),
    ) as unknown as IdeaToNovelGraphRunState['attemptBudget'];
    expect(() =>
      success({ ...s, attemptBudget }, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'i') }),
    ).toThrow();
  });
});

describe('Second Review：预算耗尽 conjunction / 防伪造 / fan-out / blocked', () => {
  function blueprintGateAtExhaustionWaiting(): IdeaToNovelGraphRunState {
    let s = intakeComplete(fresh());
    s = success(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'none' },
    });
    s = success(s, BLUEPRINT_GENERATE, { artifactRef: artifactRef('storyBlueprint', 'bp-1') });
    for (let i = 0; i < 3; i++) {
      s = requestHumanDecision(G, s, BLUEPRINT_USER_GATE, 'blueprint_gate');
      s = applyHumanDecision(G, s, {
        nodeId: BLUEPRINT_USER_GATE,
        decisionType: 'blueprint_gate',
        outcome: 'request_rewrite',
      });
      s = success(s, BLUEPRINT_GENERATE, {
        artifactRef: artifactRef('storyBlueprint', `bp-${i + 2}`),
      });
    }
    return requestHumanDecision(G, s, BLUEPRINT_USER_GATE, 'blueprint_gate');
  }

  it('blueprint 预算耗尽后 accept 不双分支（只走 accept → CHAPTER_PLAN）', () => {
    const s = blueprintGateAtExhaustionWaiting();
    expect(s.attemptBudget.blueprintRewrite).toBe(3);
    const next = applyHumanDecision(G, s, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'accept',
    });
    expect(frontierOf(next)).toEqual([CHAPTER_PLAN]);
    expect(next.activeFrontier).not.toContain(BLUEPRINT_ESCALATION);
  });

  it('blueprint 预算耗尽 + request_rewrite → 进入 BLUEPRINT_ESCALATION（conjunction）', () => {
    const s = blueprintGateAtExhaustionWaiting();
    const next = applyHumanDecision(G, s, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'request_rewrite',
    });
    expect(frontierOf(next)).toEqual([BLUEPRINT_ESCALATION]);
  });

  it('candidate 预算耗尽后 accept 不双分支（只走 accept → MANUSCRIPT_COMMIT）', () => {
    const g = reachedCandidateGate();
    const s: IdeaToNovelGraphRunState = {
      ...g,
      attemptBudget: { ...g.attemptBudget, candidateRewrite: 5, regenerate: 5 },
    };
    const next = applyHumanDecision(G, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'accept',
    });
    expect(frontierOf(next)).toEqual([MANUSCRIPT_COMMIT]);
    expect(next.activeFrontier).not.toContain(CANDIDATE_ESCALATION);
  });

  it('candidateRewrite 耗尽 + request_rewrite → CANDIDATE_ESCALATION；regenerate 耗尽 + reject → CANDIDATE_ESCALATION', () => {
    const g = reachedCandidateGate();
    const s1: IdeaToNovelGraphRunState = {
      ...g,
      attemptBudget: { ...g.attemptBudget, candidateRewrite: 5 },
    };
    expect(
      frontierOf(
        applyHumanDecision(G, s1, {
          nodeId: CANDIDATE_GATE,
          decisionType: 'candidate_gate',
          outcome: 'request_rewrite',
        }),
      ),
    ).toEqual([CANDIDATE_ESCALATION]);

    const s2: IdeaToNovelGraphRunState = {
      ...g,
      attemptBudget: { ...g.attemptBudget, regenerate: 5 },
    };
    expect(
      frontierOf(
        applyHumanDecision(G, s2, {
          nodeId: CANDIDATE_GATE,
          decisionType: 'candidate_gate',
          outcome: 'reject',
        }),
      ),
    ).toEqual([CANDIDATE_ESCALATION]);
  });

  it('specRevision 耗尽 + modify_requirements → RUN_BLOCKED（conjunction）', () => {
    // 先做一次 modify_requirements 得到合法状态，再构造 specRevision 耗尽 + 升级节点重激活
    const base = blueprintGateExhausted(); // BLUEPRINT_ESCALATION active
    const waiting = requestHumanDecision(G, base, BLUEPRINT_ESCALATION, 'escalation');
    const decided = applyHumanDecision(G, waiting, {
      nodeId: BLUEPRINT_ESCALATION,
      decisionType: 'escalation',
      outcome: 'modify_requirements',
    });
    expect(decided.attemptBudget.specRevision).toBe(1);
    const crafted: IdeaToNovelGraphRunState = {
      ...decided,
      attemptBudget: { ...decided.attemptBudget, specRevision: 3 },
      nodeStatuses: {
        ...decided.nodeStatuses,
        [BLUEPRINT_ESCALATION]: 'active',
        [SPEC_EXTRACT]: 'pending',
      },
      activeFrontier: [BLUEPRINT_ESCALATION],
    };
    const waiting2 = requestHumanDecision(G, crafted, BLUEPRINT_ESCALATION, 'escalation');
    const blocked = applyHumanDecision(G, waiting2, {
      nodeId: BLUEPRINT_ESCALATION,
      decisionType: 'escalation',
      outcome: 'modify_requirements',
    });
    expect(frontierOf(blocked)).toEqual([RUN_BLOCKED]);
  });

  it('伪造 JOIN（仅注入 nodeOutcomes、来源未 succeeded）→ 拒绝', () => {
    const s = fresh();
    const forged: IdeaToNovelGraphRunState = {
      ...s,
      nodeOutcomes: {
        [CONTINUITY_CRITIC]: { condition: 'critique_verdict', value: 'pass' },
        [STYLE_CRITIC]: { condition: 'critique_verdict', value: 'pass' },
        [REQUIREMENT_CRITIC]: { condition: 'critique_verdict', value: 'pass' },
      },
    };
    expect(() => aggregateJoinOutcome(G, forged, CRITIQUE_JOIN)).toThrow();
  });

  it('fan-out failure：失败节点 failed，其它 active/waiting 节点 cancelled，状态通过权威校验', () => {
    let s = intakeComplete(fresh());
    s = success(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'none' },
    });
    s = success(s, BLUEPRINT_GENERATE, { artifactRef: artifactRef('storyBlueprint', 'bp-1') });
    s = requestHumanDecision(G, s, BLUEPRINT_USER_GATE, 'blueprint_gate');
    s = applyHumanDecision(G, s, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'accept',
    });
    s = success(s, CHAPTER_PLAN);
    s = success(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    const failed = applyNodeFailure(G, s, CONTINUITY_CRITIC);
    expect(failed.terminalStatus).toBe('failed');
    expect(failed.nodeStatuses[CONTINUITY_CRITIC]).toBe('failed');
    expect(failed.nodeStatuses[STYLE_CRITIC]).toBe('cancelled');
    expect(failed.nodeStatuses[REQUIREMENT_CRITIC]).toBe('cancelled');
    expect(failed.activeFrontier).toEqual([]);
    expect(failed.pendingHumanDecision).toBeNull();
    expect(isValidGraphRunState(G, failed)).toBe(true);
  });

  it('empty aggregate → 抛错', () => {
    expect(() => aggregateCritiqueVerdict([])).toThrow();
    expect(() =>
      aggregateCritiqueVerdict([{ condition: 'critique_verdict', value: 'pass' }]),
    ).toThrow();
    expect(() =>
      aggregateCritiqueVerdict([
        { condition: 'critique_verdict', value: 'pass' },
        { condition: 'research_valid', value: 'valid' },
        { condition: 'critique_verdict', value: 'pass' },
      ]),
    ).toThrow();
  });

  it('blocked 恢复契约：同一 run 不可继续，恢复需创建新 workflow run', () => {
    let s = blueprintGateExhausted();
    s = requestHumanDecision(G, s, BLUEPRINT_ESCALATION, 'escalation');
    s = applyHumanDecision(G, s, {
      nodeId: BLUEPRINT_ESCALATION,
      decisionType: 'escalation',
      outcome: 'continue_later',
    });
    s = success(s, RUN_BLOCKED);
    expect(terminalStatusOf(s)).toBe('blocked');
    expect(isRunTerminal(G, s)).toBe(true);
    expect(() => success(s, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'i') })).toThrow();
    // 恢复 = 新建 workflow run（全新初始状态，非终止）
    const newRun = createInitialRunState({
      graph: G,
      projectId: PROJECT_ID,
      workflowRunId: createWorkflowRunId('run-2'),
      createdAt: '2026-08-03T00:01:00.000Z',
    });
    expect(newRun.terminalStatus).toBeNull();
    expect(frontierOf(newRun)).toEqual([IDEA_CAPTURE]);
  });
});
