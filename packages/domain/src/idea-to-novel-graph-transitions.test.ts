/**
 * @ai-novel/domain - Idea-to-Novel Graph Transition tests（Project / Chapter 两张图）
 *
 * 覆盖任务要求的全部主流程场景：
 * - Project：Idea Intake（answer/skip/finish 凭证制、澄清预算升级）→ Research（invalid 回环、
 *   耗尽显式升级）→ Blueprint（重写循环、人工升级）→ PROJECT_READY；
 * - Chapter：章节规划 → 草稿 → 三 Critic → join → rewrite 循环 → candidate gate → 稿件 → CHAPTER_READY；
 * - Idea Intake：answer 必须带 answerId / skip / finish / 最后答案重经 SPEC_EXTRACT / 预算耗尽升级；
 * - Research：invalid+available → retry；invalid+exhausted → RESEARCH_ESCALATION（不静默进蓝图）；
 * - Run 边界：Project state 不能用于 Chapter transition；Chapter state 不能用于 Project transition；
 *   ChapterRun 必须绑定 blueprintChapterId；
 * - 回归：accept 不双分支、JOIN 防伪造、fan-out failure、blocked 不可继续。
 */

import { describe, it, expect } from 'vitest';
import {
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  CHAPTER_GENERATION_GRAPH_V1,
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
  createWorkflowRunId,
  createAnswerReceiptId,
  isAnswerReceiptId,
  type AnswerReceiptId,
  type GraphNodeId,
  type GraphNodeOutcome,
} from './idea-to-novel-graph.js';
import { isValidGraphRunState } from './idea-to-novel-graph-state-validation.js';
import {
  createProjectInitialRunState,
  createChapterInitialRunState,
  artifactRef,
  type ChapterGenerationRunState,
  type IdeaToNovelProjectRunState,
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
  aggregateJoinOutcome,
  type ApplyNodeSuccessOptions,
  type HumanDecisionInput,
} from './idea-to-novel-graph-transitions.js';

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

function ps(
  state: IdeaToNovelProjectRunState,
  nodeId: GraphNodeId,
  opts?: ApplyNodeSuccessOptions,
): IdeaToNovelProjectRunState {
  return applyNodeSuccess(PG, state, nodeId, opts);
}

function cs(
  state: ChapterGenerationRunState,
  nodeId: GraphNodeId,
  opts?: ApplyNodeSuccessOptions,
): ChapterGenerationRunState {
  return applyNodeSuccess(CG, state, nodeId, opts);
}

function frontierOf(state: {
  activeFrontier: ReadonlyArray<GraphNodeId>;
}): ReadonlyArray<GraphNodeId> {
  return [...state.activeFrontier].sort();
}

/** 走完 Idea Intake → spec_complete → RESEARCH_DECISION 活跃（无追问） */
function intakeComplete(state: IdeaToNovelProjectRunState): IdeaToNovelProjectRunState {
  let s = ps(state, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'idea-1') });
  s = ps(s, SPEC_EXTRACT, {
    outcome: { condition: 'clarification_remaining', value: 'spec_complete' },
    artifactRef: artifactRef('creationSpec', 'spec-1'),
  });
  return s;
}

/** 走到 COLLECT_ANSWER 挂起（第一轮追问） */
function intakeQuestionWaiting(): IdeaToNovelProjectRunState {
  let s = projectFresh();
  s = ps(s, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'idea-1') });
  s = ps(s, SPEC_EXTRACT, {
    outcome: { condition: 'clarification_remaining', value: 'ask_more' },
    artifactRef: artifactRef('creationSpec', 'spec-1'),
  });
  s = ps(s, ASK_QUESTION);
  return requestHumanDecision(PG, s, COLLECT_ANSWER, 'intake_response');
}

/** 走到 INTAKE_ESCALATION 活跃（澄清预算耗尽） */
function intakeEscalation(): IdeaToNovelProjectRunState {
  let s = projectFresh();
  s = ps(s, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'idea-1') });
  s = { ...s, attemptBudget: { ...s.attemptBudget, clarification: 12 } };
  s = ps(s, SPEC_EXTRACT, {
    outcome: { condition: 'clarification_remaining', value: 'ask_more' },
    artifactRef: artifactRef('creationSpec', 'spec-1'),
  });
  return s;
}

/** 让 3 个 Critic 依次完成（不完成 join） */
function criticsDone(state: ChapterGenerationRunState): ChapterGenerationRunState {
  let s = state;
  for (const critic of [CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC]) {
    s = cs(s, critic, {
      outcome: { condition: 'critique_verdict', value: 'pass' } satisfies GraphNodeOutcome,
    });
  }
  return s;
}

/** 让 3 个 Critic 完成并汇合，返回 CRITIQUE_JOIN 完成后的状态 */
function criticsAll(
  state: ChapterGenerationRunState,
  verdict: 'pass' | 'needs_rewrite',
): ChapterGenerationRunState {
  let s = state;
  for (const critic of [CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC]) {
    s = cs(s, critic, {
      outcome: { condition: 'critique_verdict', value: verdict } satisfies GraphNodeOutcome,
    });
  }
  // CRITIQUE_JOIN 不接受调用方 verdict，由聚合策略从三个 Critic 确定性计算
  s = cs(s, CRITIQUE_JOIN);
  return s;
}

/** 走到 BLUEPRINT_USER_GATE 挂起（蓝图已生成） */
function blueprintGateWaiting(): IdeaToNovelProjectRunState {
  let s = intakeComplete(projectFresh());
  s = ps(s, RESEARCH_DECISION, {
    outcome: { condition: 'research_decision', value: 'none' },
  });
  s = ps(s, BLUEPRINT_GENERATE, { artifactRef: artifactRef('storyBlueprint', 'bp-1') });
  return requestHumanDecision(PG, s, BLUEPRINT_USER_GATE, 'blueprint_gate');
}

/** 走到 RESEARCH_ESCALATION 活跃（调研 invalid + 重试预算耗尽） */
function researchEscalation(): IdeaToNovelProjectRunState {
  let s = intakeComplete(projectFresh());
  s = ps(s, RESEARCH_DECISION, {
    outcome: { condition: 'research_decision', value: 'light' },
  });
  s = ps(s, RESEARCH_PLAN);
  // 三次 RESEARCH_EXECUTE → RESEARCH_VALIDATE invalid（第 3 次耗尽 researchRetry 预算）
  for (let i = 0; i < 3; i++) {
    s = ps(s, RESEARCH_EXECUTE, {
      artifactRef: artifactRef('researchBundle', `rb-${i + 1}`),
    });
    s = ps(s, RESEARCH_VALIDATE, {
      outcome: { condition: 'research_valid', value: 'invalid' },
    });
  }
  return s;
}

/** 走到 DRAFT 后状态 */
function chapterReachDraft(): ChapterGenerationRunState {
  let s = chapterFresh();
  s = cs(s, CHAPTER_PLAN);
  return s;
}

/** 走到 CANDIDATE_GATE 挂起 */
function chapterReachCandidateGate(): ChapterGenerationRunState {
  let s = chapterReachDraft();
  s = cs(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
  s = criticsAll(s, 'pass');
  return requestHumanDecision(CG, s, CANDIDATE_GATE, 'candidate_gate');
}

describe('Project 全链（无需调研）', () => {
  it('Idea → Spec → 无调研 → Blueprint → 用户接受 → PROJECT_READY', () => {
    let s = projectFresh();
    expect(frontierOf(s)).toEqual([IDEA_CAPTURE]);

    s = intakeComplete(s);
    expect(frontierOf(s)).toEqual([RESEARCH_DECISION]);

    s = ps(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'none' },
    });
    expect(frontierOf(s)).toEqual([BLUEPRINT_GENERATE]); // 无需调研 → 直接蓝图

    s = ps(s, BLUEPRINT_GENERATE, { artifactRef: artifactRef('storyBlueprint', 'bp-1') });
    expect(frontierOf(s)).toEqual([BLUEPRINT_USER_GATE]);

    s = requestHumanDecision(PG, s, BLUEPRINT_USER_GATE, 'blueprint_gate');
    s = applyHumanDecision(PG, s, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'accept',
    });
    expect(frontierOf(s)).toEqual([PROJECT_READY]);
    // 终止节点完成 → run 终止
    s = ps(s, PROJECT_READY);
    expect(terminalStatusOf(s)).toBe('completed');
    expect(frontierOf(s)).toEqual([]);
    expect(s.nodeStatuses[PROJECT_READY]).toBe('succeeded');
    // 项目就绪后 run 终止，可创建 ChapterGenerationRun
    expect(isRunTerminal(PG, s)).toBe(true);
  });
});

describe('Idea Intake 凭证制语义', () => {
  it('answer 必须带合法 AnswerReceiptId：空 / 首尾空白 / 129 字符拒绝，128 字符通过', () => {
    let s = intakeQuestionWaiting();
    // 空 answerId 拒绝
    expect(() =>
      applyHumanDecision(PG, s, {
        nodeId: COLLECT_ANSWER,
        decisionType: 'intake_response',
        action: 'answer',
        answerId: '' as AnswerReceiptId,
      }),
    ).toThrow();
    // 首尾空白 answerId 拒绝
    expect(() =>
      applyHumanDecision(PG, s, {
        nodeId: COLLECT_ANSWER,
        decisionType: 'intake_response',
        action: 'answer',
        answerId: '   ' as AnswerReceiptId,
      }),
    ).toThrow();
    // 129 字符（超上限）answerId 拒绝
    expect(() =>
      applyHumanDecision(PG, s, {
        nodeId: COLLECT_ANSWER,
        decisionType: 'intake_response',
        action: 'answer',
        answerId: 'x'.repeat(129) as AnswerReceiptId,
      }),
    ).toThrow();
    // 128 字符（恰好上限）receipt 通过；graph 不保存回答正文
    s = applyHumanDecision(PG, s, {
      nodeId: COLLECT_ANSWER,
      decisionType: 'intake_response',
      action: 'answer',
      answerId: 'x'.repeat(128) as AnswerReceiptId,
    });
    expect(frontierOf(s)).toEqual([SPEC_EXTRACT]);
  });

  it('skip 不需要 answerId，回到 SPEC_EXTRACT', () => {
    let s = intakeQuestionWaiting();
    s = applyHumanDecision(PG, s, {
      nodeId: COLLECT_ANSWER,
      decisionType: 'intake_response',
      action: 'skip',
    });
    expect(frontierOf(s)).toEqual([SPEC_EXTRACT]);
  });

  it('finish 不需要 answerId，直接结束访谈到 RESEARCH_DECISION', () => {
    let s = intakeQuestionWaiting();
    s = applyHumanDecision(PG, s, {
      nodeId: COLLECT_ANSWER,
      decisionType: 'intake_response',
      action: 'finish',
    });
    expect(frontierOf(s)).toEqual([RESEARCH_DECISION]);
    expect(frontierOf(s)).not.toContain(ASK_QUESTION);
  });

  it('最后一次 answer 必须重新经过 SPEC_EXTRACT', () => {
    let s = intakeQuestionWaiting();
    s = applyHumanDecision(PG, s, {
      nodeId: COLLECT_ANSWER,
      decisionType: 'intake_response',
      action: 'answer',
      answerId: createAnswerReceiptId('answer-1'),
    });
    expect(frontierOf(s)).toEqual([SPEC_EXTRACT]);
    // 第二轮到 SPEC_EXTRACT 后可再走 ask_more + 可用预算 → 追问
    s = ps(s, SPEC_EXTRACT, {
      outcome: { condition: 'clarification_remaining', value: 'ask_more' },
      artifactRef: artifactRef('creationSpec', 'spec-2'),
    });
    expect(frontierOf(s)).toEqual([ASK_QUESTION]);
  });

  it('澄清预算耗尽后不再激活 ASK_QUESTION，升级 INTAKE_ESCALATION', () => {
    const s = intakeEscalation();
    expect(frontierOf(s)).toEqual([INTAKE_ESCALATION]);
    expect(frontierOf(s)).not.toContain(ASK_QUESTION);
  });

  it('预算耗尽不自动替用户完成访谈：必须显式升级决策', () => {
    let s = intakeEscalation();
    s = requestHumanDecision(PG, s, INTAKE_ESCALATION, 'escalation');
    s = applyHumanDecision(PG, s, {
      nodeId: INTAKE_ESCALATION,
      decisionType: 'escalation',
      outcome: 'continue_with_current_spec',
    });
    expect(frontierOf(s)).toEqual([RESEARCH_DECISION]);
  });

  it('INTAKE_ESCALATION modify_idea → 项目级输入（IDEA_CAPTURE），受 intakeRevision 预算约束且重置澄清预算', () => {
    let s = intakeEscalation();
    s = requestHumanDecision(PG, s, INTAKE_ESCALATION, 'escalation');
    s = applyHumanDecision(PG, s, {
      nodeId: INTAKE_ESCALATION,
      decisionType: 'escalation',
      outcome: 'modify_idea',
    });
    expect(frontierOf(s)).toEqual([IDEA_CAPTURE]);
    expect(s.attemptBudget.intakeRevision).toBe(1);
    // IDEA_CAPTURE 完成后重置澄清预算 → 新抽取会话重新计数
    s = ps(s, IDEA_CAPTURE, { artifactRef: artifactRef('idea', 'idea-2') });
    expect(s.attemptBudget.clarification).toBe(0);
    expect(frontierOf(s)).toEqual([SPEC_EXTRACT]);
  });

  it('INTAKE_ESCALATION cancel → PROJECT_CANCELLED；continue_later → PROJECT_BLOCKED', () => {
    let s = intakeEscalation();
    s = requestHumanDecision(PG, s, INTAKE_ESCALATION, 'escalation');
    const cancelledState = applyHumanDecision(PG, s, {
      nodeId: INTAKE_ESCALATION,
      decisionType: 'escalation',
      outcome: 'cancel',
    });
    expect(frontierOf(cancelledState)).toEqual([PROJECT_CANCELLED]);
    const cancelled = ps(cancelledState, PROJECT_CANCELLED);
    expect(terminalStatusOf(cancelled)).toBe('cancelled');

    let b = intakeEscalation();
    b = requestHumanDecision(PG, b, INTAKE_ESCALATION, 'escalation');
    const blockedState = applyHumanDecision(PG, b, {
      nodeId: INTAKE_ESCALATION,
      decisionType: 'escalation',
      outcome: 'continue_later',
    });
    expect(frontierOf(blockedState)).toEqual([PROJECT_BLOCKED]);
    const blocked = ps(blockedState, PROJECT_BLOCKED);
    expect(terminalStatusOf(blocked)).toBe('blocked');
  });

  it('modify_idea 预算耗尽 → PROJECT_BLOCKED', () => {
    let s = intakeEscalation();
    s = { ...s, attemptBudget: { ...s.attemptBudget, intakeRevision: 3 } };
    s = requestHumanDecision(PG, s, INTAKE_ESCALATION, 'escalation');
    const blockedState = applyHumanDecision(PG, s, {
      nodeId: INTAKE_ESCALATION,
      decisionType: 'escalation',
      outcome: 'modify_idea',
    });
    expect(frontierOf(blockedState)).toEqual([PROJECT_BLOCKED]);
    const blocked = ps(blockedState, PROJECT_BLOCKED);
    expect(terminalStatusOf(blocked)).toBe('blocked');
  });
});

describe('Research 流程与显式升级', () => {
  it('invalid + budget available → 回环重试（researchRetry 递增）', () => {
    let s = intakeComplete(projectFresh());
    s = ps(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'deep' },
    });
    s = ps(s, RESEARCH_PLAN);
    s = ps(s, RESEARCH_EXECUTE, { artifactRef: artifactRef('researchBundle', 'rb-1') });
    s = ps(s, RESEARCH_VALIDATE, {
      outcome: { condition: 'research_valid', value: 'invalid' },
    });
    expect(frontierOf(s)).toEqual([RESEARCH_EXECUTE]);
    expect(s.attemptBudget.researchRetry).toBe(1);
  });

  it('invalid + exhausted → RESEARCH_ESCALATION（不进入 BLUEPRINT_GENERATE）', () => {
    const s = researchEscalation();
    expect(frontierOf(s)).toEqual([RESEARCH_ESCALATION]);
    expect(frontierOf(s)).not.toContain(BLUEPRINT_GENERATE);
    expect(s.attemptBudget.researchRetry).toBe(2);
  });

  it('use_current_research 由用户显式决定 → 进入蓝图', () => {
    let s = researchEscalation();
    s = requestHumanDecision(PG, s, RESEARCH_ESCALATION, 'escalation');
    s = applyHumanDecision(PG, s, {
      nodeId: RESEARCH_ESCALATION,
      decisionType: 'escalation',
      outcome: 'use_current_research',
    });
    expect(frontierOf(s)).toEqual([BLUEPRINT_GENERATE]);
  });

  it('skip_research 由用户显式决定 → 进入蓝图', () => {
    let s = researchEscalation();
    s = requestHumanDecision(PG, s, RESEARCH_ESCALATION, 'escalation');
    s = applyHumanDecision(PG, s, {
      nodeId: RESEARCH_ESCALATION,
      decisionType: 'escalation',
      outcome: 'skip_research',
    });
    expect(frontierOf(s)).toEqual([BLUEPRINT_GENERATE]);
  });

  it('RESEARCH_ESCALATION modify_requirements → SPEC_EXTRACT，受 specRevision 预算约束', () => {
    let s = researchEscalation();
    s = requestHumanDecision(PG, s, RESEARCH_ESCALATION, 'escalation');
    s = applyHumanDecision(PG, s, {
      nodeId: RESEARCH_ESCALATION,
      decisionType: 'escalation',
      outcome: 'modify_requirements',
    });
    expect(frontierOf(s)).toEqual([SPEC_EXTRACT]);
    expect(s.attemptBudget.specRevision).toBe(1);
  });

  it('research valid → 直接进入蓝图', () => {
    let s = intakeComplete(projectFresh());
    s = ps(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'light' },
    });
    s = ps(s, RESEARCH_PLAN);
    s = ps(s, RESEARCH_EXECUTE, { artifactRef: artifactRef('researchBundle', 'rb-1') });
    s = ps(s, RESEARCH_VALIDATE, {
      outcome: { condition: 'research_valid', value: 'valid' },
    });
    expect(frontierOf(s)).toEqual([BLUEPRINT_GENERATE]);
  });
});

describe('Blueprint 循环与人工升级', () => {
  it('request_rewrite 回环，预算耗尽后 accept 不双分支（仅走 accept）', () => {
    // 预算已耗尽仍接受 → 直接 PROJECT_READY，不再触发重写
    let s = blueprintGateWaiting();
    s = { ...s, attemptBudget: { ...s.attemptBudget, blueprintRewrite: 3 } };
    s = applyHumanDecision(PG, s, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'accept',
    });
    expect(frontierOf(s)).toEqual([PROJECT_READY]);
    s = ps(s, PROJECT_READY);
    expect(terminalStatusOf(s)).toBe('completed');
    expect(frontierOf(s)).toEqual([]);
  });

  it('request_rewrite + 预算耗尽 → BLUEPRINT_ESCALATION（不静默重写）', () => {
    let s = blueprintGateWaiting();
    s = { ...s, attemptBudget: { ...s.attemptBudget, blueprintRewrite: 3 } };
    s = applyHumanDecision(PG, s, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'request_rewrite',
    });
    expect(frontierOf(s)).toEqual([BLUEPRINT_ESCALATION]);
    expect(frontierOf(s)).not.toContain(BLUEPRINT_GENERATE);
  });

  it('request_rewrite + 预算可用 → 回环重写', () => {
    let s = blueprintGateWaiting();
    s = applyHumanDecision(PG, s, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'request_rewrite',
    });
    expect(frontierOf(s)).toEqual([BLUEPRINT_GENERATE]);
    expect(s.attemptBudget.blueprintRewrite).toBe(1);
  });

  it('BLUEPRINT_ESCALATION accept_current → PROJECT_READY；modify_requirements → SPEC_EXTRACT', () => {
    let s = blueprintGateWaiting();
    s = { ...s, attemptBudget: { ...s.attemptBudget, blueprintRewrite: 3 } };
    s = applyHumanDecision(PG, s, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'request_rewrite',
    });
    s = requestHumanDecision(PG, s, BLUEPRINT_ESCALATION, 'escalation');
    const acceptedState = applyHumanDecision(PG, s, {
      nodeId: BLUEPRINT_ESCALATION,
      decisionType: 'escalation',
      outcome: 'accept_current',
    });
    expect(frontierOf(acceptedState)).toEqual([PROJECT_READY]);
    const accepted = ps(acceptedState, PROJECT_READY);
    expect(terminalStatusOf(accepted)).toBe('completed');

    let m = blueprintGateWaiting();
    m = { ...m, attemptBudget: { ...m.attemptBudget, blueprintRewrite: 3 } };
    m = applyHumanDecision(PG, m, {
      nodeId: BLUEPRINT_USER_GATE,
      decisionType: 'blueprint_gate',
      outcome: 'request_rewrite',
    });
    m = requestHumanDecision(PG, m, BLUEPRINT_ESCALATION, 'escalation');
    m = applyHumanDecision(PG, m, {
      nodeId: BLUEPRINT_ESCALATION,
      decisionType: 'escalation',
      outcome: 'modify_requirements',
    });
    expect(frontierOf(m)).toEqual([SPEC_EXTRACT]);
    expect(m.attemptBudget.specRevision).toBe(1);
  });
});

describe('Chapter 全链', () => {
  it('plan → draft → 三 Critic → join → candidate accept → manuscript → CHAPTER_READY', () => {
    let s = chapterFresh();
    expect(frontierOf(s)).toEqual([CHAPTER_PLAN]);
    expect(s.blueprintChapterId).toBe('ch-1');

    s = cs(s, CHAPTER_PLAN);
    expect(frontierOf(s)).toEqual([DRAFT]);

    s = cs(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    expect(frontierOf(s).sort()).toEqual(
      [CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC].sort(),
    );

    s = criticsAll(s, 'pass');
    expect(frontierOf(s)).toEqual([CANDIDATE_GATE]); // join 后直接候选门禁

    s = requestHumanDecision(CG, s, CANDIDATE_GATE, 'candidate_gate');
    s = applyHumanDecision(CG, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'accept',
    });
    expect(frontierOf(s)).toEqual([MANUSCRIPT_COMMIT]);

    s = cs(s, MANUSCRIPT_COMMIT, { artifactRef: artifactRef('manuscript', 'ms-1') });
    expect(frontierOf(s)).toEqual([CHAPTER_READY]);
    s = cs(s, CHAPTER_READY);
    expect(terminalStatusOf(s)).toBe('completed');
    expect(frontierOf(s)).toEqual([]);
    expect(s.nodeStatuses[CHAPTER_READY]).toBe('succeeded');
  });

  it('rewrite 循环：needs_rewrite → REWRITE → 三 Critic 重新审查', () => {
    let s = chapterReachDraft();
    s = cs(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    s = criticsAll(s, 'needs_rewrite');
    expect(frontierOf(s)).toEqual([REWRITE]);
    expect(s.attemptBudget.rewrite).toBe(1);

    s = cs(s, REWRITE);
    expect(frontierOf(s).sort()).toEqual(
      [CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC].sort(),
    );
  });

  it('candidate request_rewrite / reject 预算耗尽 → CANDIDATE_ESCALATION', () => {
    let s = chapterReachCandidateGate();
    s = { ...s, attemptBudget: { ...s.attemptBudget, candidateRewrite: 5 } };
    s = applyHumanDecision(CG, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'request_rewrite',
    });
    expect(frontierOf(s)).toEqual([CANDIDATE_ESCALATION]);

    let t = chapterReachCandidateGate();
    t = { ...t, attemptBudget: { ...t.attemptBudget, regenerate: 5 } };
    t = applyHumanDecision(CG, t, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'reject',
    });
    expect(frontierOf(t)).toEqual([CANDIDATE_ESCALATION]);
  });

  it('CANDIDATE_ESCALATION：accept_current → 稿件；cancel → CHAPTER_CANCELLED；continue_later / modify_requirements → CHAPTER_BLOCKED', () => {
    let s = chapterReachCandidateGate();
    s = { ...s, attemptBudget: { ...s.attemptBudget, regenerate: 5 } };
    s = applyHumanDecision(CG, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'reject',
    });
    s = requestHumanDecision(CG, s, CANDIDATE_ESCALATION, 'escalation');

    const accepted = applyHumanDecision(CG, s, {
      nodeId: CANDIDATE_ESCALATION,
      decisionType: 'escalation',
      outcome: 'accept_current',
    });
    expect(frontierOf(accepted)).toEqual([MANUSCRIPT_COMMIT]);

    const cancelledState = applyHumanDecision(CG, s, {
      nodeId: CANDIDATE_ESCALATION,
      decisionType: 'escalation',
      outcome: 'cancel',
    });
    const cancelled = cs(cancelledState, CHAPTER_CANCELLED);
    expect(terminalStatusOf(cancelled)).toBe('cancelled');

    const blockedState = applyHumanDecision(CG, s, {
      nodeId: CANDIDATE_ESCALATION,
      decisionType: 'escalation',
      outcome: 'continue_later',
    });
    const blocked = cs(blockedState, CHAPTER_BLOCKED);
    expect(terminalStatusOf(blocked)).toBe('blocked');

    const modifyBlockedState = applyHumanDecision(CG, s, {
      nodeId: CANDIDATE_ESCALATION,
      decisionType: 'escalation',
      outcome: 'modify_requirements',
    });
    const modifyBlocked = cs(modifyBlockedState, CHAPTER_BLOCKED);
    expect(terminalStatusOf(modifyBlocked)).toBe('blocked');
  });

  it('同一 ChapterRun 不能继续下一章：CHAPTER_READY 后 run 终止，无下一章循环', () => {
    let s = chapterFresh();
    s = cs(s, CHAPTER_PLAN);
    s = cs(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    s = criticsAll(s, 'pass');
    s = requestHumanDecision(CG, s, CANDIDATE_GATE, 'candidate_gate');
    s = applyHumanDecision(CG, s, {
      nodeId: CANDIDATE_GATE,
      decisionType: 'candidate_gate',
      outcome: 'accept',
    });
    s = cs(s, MANUSCRIPT_COMMIT, { artifactRef: artifactRef('manuscript', 'ms-1') });
    s = cs(s, CHAPTER_READY);
    expect(terminalStatusOf(s)).toBe('completed');
    // 不能继续推进
    expect(() => cs(s, CHAPTER_PLAN)).toThrow();
  });
});

describe('JOIN 防伪造与 fan-out failure', () => {
  it('JOIN 拒绝调用方伪造的 outcome', () => {
    let s = chapterReachDraft();
    s = cs(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    s = criticsDone(s); // 三 Critic succeeded，CRITIQUE_JOIN 在 frontier
    expect(frontierOf(s)).toEqual([CRITIQUE_JOIN]);
    expect(() =>
      cs(s, CRITIQUE_JOIN, { outcome: { condition: 'critique_verdict', value: 'pass' } }),
    ).toThrow();
  });

  it('JOIN 防伪造：来源未 succeeded 的 state 被拒绝', () => {
    let s = chapterReachDraft();
    s = cs(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    const forged: ChapterGenerationRunState = {
      ...s,
      nodeOutcomes: {
        ...s.nodeOutcomes,
        [CONTINUITY_CRITIC]: { condition: 'critique_verdict', value: 'pass' },
        [STYLE_CRITIC]: { condition: 'critique_verdict', value: 'pass' },
        [REQUIREMENT_CRITIC]: { condition: 'critique_verdict', value: 'pass' },
      },
    };
    expect(() => cs(forged, CRITIQUE_JOIN)).toThrow();
  });

  it('fan-out failure：任一 Critic 失败 → 其它 active/waiting cancelled，run 终止 failed', () => {
    let s = chapterReachDraft();
    s = cs(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    s = applyNodeFailure(CG, s, CONTINUITY_CRITIC);
    expect(s.nodeStatuses[CONTINUITY_CRITIC]).toBe('failed');
    expect(s.nodeStatuses[STYLE_CRITIC]).toBe('cancelled');
    expect(s.nodeStatuses[REQUIREMENT_CRITIC]).toBe('cancelled');
    expect(frontierOf(s)).toEqual([]);
    expect(s.pendingHumanDecision).toBeNull();
    expect(terminalStatusOf(s)).toBe('failed');
  });
});

describe('blocked 终止语义', () => {
  it('blocked 是终止态，同一 run 不可继续（恢复需新 run）', () => {
    let s = intakeEscalation();
    s = requestHumanDecision(PG, s, INTAKE_ESCALATION, 'escalation');
    const blockedState = applyHumanDecision(PG, s, {
      nodeId: INTAKE_ESCALATION,
      decisionType: 'escalation',
      outcome: 'continue_later',
    });
    expect(frontierOf(blockedState)).toEqual([PROJECT_BLOCKED]);
    s = ps(blockedState, PROJECT_BLOCKED);
    expect(terminalStatusOf(s)).toBe('blocked');
    expect(isRunTerminal(PG, s)).toBe(true);
    // 已终止 run 不能继续推进
    expect(() =>
      ps(s, RESEARCH_DECISION, { outcome: { condition: 'research_decision', value: 'none' } }),
    ).toThrow();
  });
});

describe('Run 边界（Project / Chapter 状态分离）', () => {
  it('Project state 不能传给 Chapter transition', () => {
    const projectState = intakeComplete(projectFresh());
    expect(() => applyNodeSuccess(CG, projectState, CHAPTER_PLAN)).toThrow();
  });

  it('Chapter state 不能传给 Project transition', () => {
    const chapterState = chapterFresh();
    expect(() => applyNodeSuccess(PG, chapterState, IDEA_CAPTURE)).toThrow();
  });

  it('ChapterRun 必须绑定 blueprintChapterId', () => {
    const s = chapterFresh();
    expect(isValidGraphRunState(CG, s)).toBe(true);
    const withoutChapter = { ...s } as Record<string, unknown>;
    delete withoutChapter.blueprintChapterId;
    expect(isValidGraphRunState(CG, withoutChapter)).toBe(false);
  });

  it('Chapter state 缺少项目级输入引用时校验失败', () => {
    const s = chapterFresh();
    const withoutSpec = { ...s } as Record<string, unknown>;
    delete withoutSpec.creationSpecVersionId;
    expect(isValidGraphRunState(CG, withoutSpec)).toBe(false);
  });
});

describe('transition 前置不变量', () => {
  it('非法 state 被拒（nodeStatuses 缺失节点）', () => {
    const s = intakeComplete(projectFresh());
    const bad = { ...s, nodeStatuses: { ...s.nodeStatuses } } as Record<string, unknown>;
    delete bad.nodeStatuses[RESEARCH_DECISION];
    expect(() => ps(bad as never, SPEC_EXTRACT)).toThrow();
  });

  it('canTraverseEdge / computeNextFrontier 在 running state 上工作', () => {
    let s = intakeComplete(projectFresh());
    s = ps(s, RESEARCH_DECISION, {
      outcome: { condition: 'research_decision', value: 'light' },
    });
    // RESEARCH_DECISION succeeded → research-plan-light 边可走，RESEARCH_PLAN 已激活
    const edge = PG.edges.find((e) => e.from === RESEARCH_DECISION && e.to === RESEARCH_PLAN);
    expect(edge).toBeDefined();
    expect(canTraverseEdge(PG, s, edge!.id)).toBe(true);
    expect(frontierOf(s)).toEqual([RESEARCH_PLAN]);
  });

  it('aggregateJoinOutcome 对 Chapter join 确定性聚合', () => {
    let s = chapterReachDraft();
    s = cs(s, DRAFT, { artifactRef: artifactRef('generationRun', 'gen-1') });
    s = criticsDone(s);
    const outcome = aggregateJoinOutcome(CG, s, CRITIQUE_JOIN);
    expect(outcome).toEqual({ condition: 'critique_verdict', value: 'pass' });
  });
});

describe('HumanDecisionInput 类型约束（IntakeHumanDecision）', () => {
  it('intake answer 携带 answerId；skip / finish 不需要', () => {
    const answer: HumanDecisionInput = {
      nodeId: COLLECT_ANSWER,
      decisionType: 'intake_response',
      action: 'answer',
      answerId: createAnswerReceiptId('a-1'),
    };
    const skip: HumanDecisionInput = {
      nodeId: COLLECT_ANSWER,
      decisionType: 'intake_response',
      action: 'skip',
    };
    const finish: HumanDecisionInput = {
      nodeId: COLLECT_ANSWER,
      decisionType: 'intake_response',
      action: 'finish',
    };
    expect(answer.action).toBe('answer');
    expect(skip.action).toBe('skip');
    expect(finish.action).toBe('finish');
  });
});

describe('Idea Intake 原子事务 receipt 契约', () => {
  it('createAnswerReceiptId 冻结 receipt 格式：非空、trimmed、长度有界', () => {
    expect(createAnswerReceiptId('receipt-1')).toBe('receipt-1');
    expect(isAnswerReceiptId('receipt-1')).toBe(true);
    expect(() => createAnswerReceiptId('')).toThrow();
    expect(() => createAnswerReceiptId('   ')).toThrow();
    expect(() => createAnswerReceiptId('  x  ')).toThrow(); // 首尾空白拒绝
    expect(() => createAnswerReceiptId('x'.repeat(200))).toThrow(); // 超长拒绝
    expect(isAnswerReceiptId(42)).toBe(false);
    expect(isAnswerReceiptId('  x  ')).toBe(false);
  });

  it('createAnswerReceiptId 长度边界：129 字符拒绝、128 字符通过', () => {
    expect(isAnswerReceiptId('x'.repeat(129))).toBe(false);
    expect(() => createAnswerReceiptId('x'.repeat(129))).toThrow();
    expect(isAnswerReceiptId('x'.repeat(128))).toBe(true);
    expect(createAnswerReceiptId('x'.repeat(128))).toBe('x'.repeat(128));
  });

  it('graph 只记录 action，绝不保存回答正文或 receipt 本身', () => {
    let s = intakeQuestionWaiting();
    s = applyHumanDecision(PG, s, {
      nodeId: COLLECT_ANSWER,
      decisionType: 'intake_response',
      action: 'answer',
      answerId: createAnswerReceiptId('receipt-1'),
    });
    // 状态中只出现 intake_action 产出；回答正文与 receipt 本身都不进入 run state
    // （receipt 是原子事务的凭证，由未来 Runtime 写入权威存储后取得；graph 只在边界校验其合法性）
    expect(s.nodeOutcomes[COLLECT_ANSWER]).toEqual({ condition: 'intake_action', value: 'answer' });
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain('我的回答正文');
    expect(serialized).not.toContain('receipt-1');
  });

  it('空 receipt / 未持久化原始文本不能作为完成证据', () => {
    const s = intakeQuestionWaiting();
    expect(() =>
      applyHumanDecision(PG, s, {
        nodeId: COLLECT_ANSWER,
        decisionType: 'intake_response',
        action: 'answer',
        answerId: '' as AnswerReceiptId,
      }),
    ).toThrow();
    expect(() =>
      applyHumanDecision(PG, s, {
        nodeId: COLLECT_ANSWER,
        decisionType: 'intake_response',
        action: 'answer',
        answerId: '   ' as AnswerReceiptId,
      }),
    ).toThrow();
  });
});

describe('Project/Chapter artifact 与 budget 槽位真正拆开', () => {
  it('Project state 只含 Project artifact / budget 槽位', () => {
    const s = projectFresh();
    expect(Object.keys(s.artifacts).sort()).toEqual([
      'creationSpec',
      'idea',
      'researchBundle',
      'storyBlueprint',
    ]);
    expect(Object.keys(s.attemptBudget).sort()).toEqual([
      'blueprintRewrite',
      'clarification',
      'intakeRevision',
      'researchRetry',
      'specRevision',
    ]);
    // 不包含 chapter-only 槽位
    expect('generationRun' in s.artifacts).toBe(false);
    expect('manuscript' in s.artifacts).toBe(false);
    expect('rewrite' in s.attemptBudget).toBe(false);
  });

  it('Chapter state 只含 Chapter artifact / budget 槽位', () => {
    const s = chapterFresh();
    expect(Object.keys(s.artifacts).sort()).toEqual(['generationRun', 'manuscript']);
    expect(Object.keys(s.attemptBudget).sort()).toEqual([
      'candidateRewrite',
      'regenerate',
      'rewrite',
    ]);
    // 不包含 project-only 槽位
    expect('idea' in s.artifacts).toBe(false);
    expect('researchBundle' in s.artifacts).toBe(false);
    expect('clarification' in s.attemptBudget).toBe(false);
  });

  it('Project 图 artifact/budget 声明与 Project state 槽位一致', () => {
    const graphKinds = PG.artifactKinds.map((k) => k);
    const graphBudgets = PG.budgetKeys.map((k) => k);
    const s = projectFresh();
    expect(Object.keys(s.artifacts).sort()).toEqual([...graphKinds].sort());
    expect(Object.keys(s.attemptBudget).sort()).toEqual([...graphBudgets].sort());
  });
});
