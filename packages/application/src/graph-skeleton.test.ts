/**
 * 双 Graph Walking Skeleton 全路径测试（GE-2，内存 fake 仓库）。
 *
 * Project Graph：happy path → PROJECT_READY；澄清循环 + 预算耗尽 → INTAKE_ESCALATION；
 * Research none/light/deep；research invalid 重试 → 升级；blueprint rewrite 循环；
 * INTAKE_ESCALATION cancel → PROJECT_CANCELLED。
 * Chapter Graph：happy path → CHAPTER_READY；critic needs_rewrite → CANDIDATE_GATE；
 * fan-out failure → run failed；终态 blocked/cancelled。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  advanceNode,
  applyHumanDecision,
  createChapterRun,
  createProjectRun,
  failNode,
  runFakeUntilHumanOrTerminal,
  type FakeExecutorConfig,
} from './index.js';
import { createTestDeps } from './graph-run-test-fakes.js';
import {
  BLUEPRINT_GENERATE,
  BLUEPRINT_USER_GATE,
  CANDIDATE_GATE,
  CHAPTER_PLAN,
  COLLECT_ANSWER,
  CONTINUITY_CRITIC,
  DRAFT,
  IDEA_CAPTURE,
  INTAKE_ESCALATION,
  MANUSCRIPT_COMMIT,
  PROJECT_CANCELLED,
  PROJECT_READY,
  REQUIREMENT_CRITIC,
  RESEARCH_DECISION,
  RESEARCH_ESCALATION,
  RESEARCH_EXECUTE,
  RESEARCH_VALIDATE,
  SPEC_EXTRACT,
  STYLE_CRITIC,
  CHAPTER_READY,
} from '@ai-novel/domain';
import type { IdeaToNovelProjectRunState, ChapterGenerationRunState } from '@ai-novel/domain';

type Deps = ReturnType<typeof createTestDeps>['deps'];

function skipPendingIntake(deps: Deps, runId: string, i: number): void {
  applyHumanDecision(deps, {
    kind: 'intake_skip',
    runId,
    nodeId: COLLECT_ANSWER,
    idempotencyKey: `skip-${i}`,
  });
}

describe('Project Graph walking skeleton', () => {
  let deps: Deps;

  beforeEach(() => {
    deps = createTestDeps().deps;
  });

  it('happy path：模糊想法 → CreationSpec → no-research → Blueprint → accept → PROJECT_READY', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c1' });

    const atGate = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
    expect(atGate.kind).toBe('human');
    expect(atGate.state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);

    applyHumanDecision(deps, {
      kind: 'gate',
      runId: run.workflowRunId,
      nodeId: BLUEPRINT_USER_GATE,
      outcome: 'accept',
      idempotencyKey: 'gate1',
    });
    const done = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
    expect(done.kind).toBe('terminal');
    const st = done.state as IdeaToNovelProjectRunState;
    expect(st.terminalStatus).toBe('completed');
    expect(st.nodeStatuses[PROJECT_READY]).toBe('succeeded');
    expect(st.nodeStatuses[IDEA_CAPTURE]).toBe('succeeded');
  });

  it('澄清循环 + 预算耗尽 → INTAKE_ESCALATION（bounded loop），再 continue → PROJECT_READY', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c2' });
    const config: FakeExecutorConfig = { [SPEC_EXTRACT]: { outcome: 'ask_more' } };

    let stop = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, config);
    let guard = 0;
    while (stop.kind === 'human' && stop.state.pendingHumanDecision?.nodeId !== INTAKE_ESCALATION) {
      skipPendingIntake(deps, run.workflowRunId, guard);
      stop = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, config);
      guard += 1;
      expect(guard).toBeLessThan(30); // 预算有界
    }
    expect(stop.kind).toBe('human');
    expect(stop.state.pendingHumanDecision?.nodeId).toBe(INTAKE_ESCALATION);
    const budget = (stop.state as IdeaToNovelProjectRunState).attemptBudget;
    expect(budget.clarification).toBeGreaterThanOrEqual(11);

    applyHumanDecision(deps, {
      kind: 'escalation',
      runId: run.workflowRunId,
      nodeId: INTAKE_ESCALATION,
      outcome: 'continue_with_current_spec',
      idempotencyKey: 'esc1',
    });
    const atBlueprint = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
    expect(atBlueprint.state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
    applyHumanDecision(deps, {
      kind: 'gate',
      runId: run.workflowRunId,
      nodeId: BLUEPRINT_USER_GATE,
      outcome: 'accept',
      idempotencyKey: 'gate2',
    });
    const done = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
    expect(done.state.terminalStatus).toBe('completed');
  });

  it('INTAKE_ESCALATION cancel → PROJECT_CANCELLED', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c3' });
    const config: FakeExecutorConfig = { [SPEC_EXTRACT]: { outcome: 'ask_more' } };
    let stop = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, config);
    let guard = 0;
    while (stop.kind === 'human' && stop.state.pendingHumanDecision?.nodeId !== INTAKE_ESCALATION) {
      skipPendingIntake(deps, run.workflowRunId, guard);
      stop = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, config);
      guard += 1;
      expect(guard).toBeLessThan(30);
    }
    applyHumanDecision(deps, {
      kind: 'escalation',
      runId: run.workflowRunId,
      nodeId: INTAKE_ESCALATION,
      outcome: 'cancel',
      idempotencyKey: 'esc-cancel',
    });
    const done = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
    expect(done.kind).toBe('terminal');
    expect(done.state.terminalStatus).toBe('cancelled');
    expect(done.state.nodeStatuses[PROJECT_CANCELLED]).toBe('succeeded');
  });

  it('Research light：调研执行产出 researchBundle artifact', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c4' });
    const config: FakeExecutorConfig = { [RESEARCH_DECISION]: { outcome: 'light' } };
    const stop = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, config);
    expect(stop.kind).toBe('human');
    expect(stop.state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
    const st = stop.state as IdeaToNovelProjectRunState;
    expect(st.nodeStatuses[RESEARCH_EXECUTE]).toBe('succeeded');
    expect(st.artifacts.researchBundle?.kind).toBe('researchBundle');
  });

  it('Research invalid 重试直到预算耗尽 → RESEARCH_ESCALATION；use_current_research 进入蓝图', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c5' });
    const config: FakeExecutorConfig = {
      [RESEARCH_DECISION]: { outcome: 'light' },
      [RESEARCH_VALIDATE]: { outcome: 'invalid' },
    };
    const stop = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, config);
    expect(stop.kind).toBe('human');
    expect(stop.state.pendingHumanDecision?.nodeId).toBe(RESEARCH_ESCALATION);
    const st = stop.state as IdeaToNovelProjectRunState;
    expect(st.attemptBudget.researchRetry).toBeGreaterThanOrEqual(2);

    applyHumanDecision(deps, {
      kind: 'escalation',
      runId: run.workflowRunId,
      nodeId: RESEARCH_ESCALATION,
      outcome: 'use_current_research',
      idempotencyKey: 'resc1',
    });
    const atBlueprint = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
    expect(atBlueprint.state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
  });

  it('Blueprint rewrite 循环：request_rewrite → 重新生成 → accept', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c6' });
    const stop1 = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
    expect(stop1.state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
    applyHumanDecision(deps, {
      kind: 'gate',
      runId: run.workflowRunId,
      nodeId: BLUEPRINT_USER_GATE,
      outcome: 'request_rewrite',
      idempotencyKey: 'rewrite1',
    });
    const stop2 = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
    expect(stop2.state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);
    expect(stop2.state.nodeStatuses[BLUEPRINT_GENERATE]).toBe('succeeded');
    applyHumanDecision(deps, {
      kind: 'gate',
      runId: run.workflowRunId,
      nodeId: BLUEPRINT_USER_GATE,
      outcome: 'accept',
      idempotencyKey: 'gate3',
    });
    const done = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, {});
    expect(done.state.terminalStatus).toBe('completed');
  });
});

describe('Chapter Graph walking skeleton', () => {
  let deps: Deps;

  beforeEach(() => {
    deps = createTestDeps().deps;
  });

  function newChapterRun(): string {
    const { run } = createChapterRun(deps, {
      projectId: 'p1',
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: 'cch1',
    });
    return run.workflowRunId;
  }

  it('happy path：plan → draft → 三 Critic 并行 → join → gate → commit → CHAPTER_READY', () => {
    const runId = newChapterRun();
    const stop = runFakeUntilHumanOrTerminal(deps, 'p1', runId, {});
    expect(stop.kind).toBe('human');
    expect(stop.state.pendingHumanDecision?.nodeId).toBe(CANDIDATE_GATE);
    const st = stop.state as ChapterGenerationRunState;
    expect(st.nodeStatuses[CHAPTER_PLAN]).toBe('succeeded');
    expect(st.nodeStatuses[DRAFT]).toBe('succeeded');
    expect(st.nodeStatuses[CONTINUITY_CRITIC]).toBe('succeeded');
    expect(st.nodeStatuses[STYLE_CRITIC]).toBe('succeeded');
    expect(st.nodeStatuses[REQUIREMENT_CRITIC]).toBe('succeeded');
    expect(st.artifacts.generationRun?.kind).toBe('generationRun');

    applyHumanDecision(deps, {
      kind: 'gate',
      runId,
      nodeId: CANDIDATE_GATE,
      outcome: 'accept',
      idempotencyKey: 'cand1',
    });
    const done = runFakeUntilHumanOrTerminal(deps, 'p1', runId, {});
    expect(done.kind).toBe('terminal');
    const doneSt = done.state as ChapterGenerationRunState;
    expect(doneSt.terminalStatus).toBe('completed');
    expect(doneSt.nodeStatuses[MANUSCRIPT_COMMIT]).toBe('succeeded');
    expect(doneSt.nodeStatuses[CHAPTER_READY]).toBe('succeeded');
    expect(doneSt.artifacts.manuscript?.kind).toBe('manuscript');
  });

  it('Critic needs_rewrite：rewrite 循环直到预算耗尽 → CANDIDATE_GATE（不自动提交）', () => {
    const runId = newChapterRun();
    const config: FakeExecutorConfig = {
      [CONTINUITY_CRITIC]: { outcome: 'needs_rewrite' },
      [STYLE_CRITIC]: { outcome: 'needs_rewrite' },
      [REQUIREMENT_CRITIC]: { outcome: 'needs_rewrite' },
    };
    const stop = runFakeUntilHumanOrTerminal(deps, 'p1', runId, config);
    expect(stop.kind).toBe('human');
    expect(stop.state.pendingHumanDecision?.nodeId).toBe(CANDIDATE_GATE);
    const st = stop.state as ChapterGenerationRunState;
    expect(st.attemptBudget.rewrite).toBeGreaterThanOrEqual(3);
    // 预算耗尽必须显式停在 gate，不得自动 accept/commit
    expect(st.terminalStatus).toBeNull();
  });

  it('fan-out failure：DRAFT 完成后一 Critic 失败 → run failed，其余 Critic cancelled', () => {
    const { run } = createChapterRun(deps, {
      projectId: 'p1',
      creationSpecVersionId: 'spec-1',
      researchBundleId: null,
      storyBlueprintId: 'bp-1',
      blueprintChapterId: 'ch-1',
      idempotencyKey: 'cch-fanout',
    });
    const runId = run.workflowRunId;
    // 手动步进到 DRAFT 完成，三 Critic 同时 active（骨架推进器会一直推到底，故用 service 步进）
    advanceNode(deps, { projectId: 'p1', runId, nodeId: CHAPTER_PLAN, idempotencyKey: 'p1' });
    advanceNode(deps, {
      projectId: 'p1',
      runId,
      nodeId: DRAFT,
      artifactRef: { kind: 'generationRun', artifactId: 'gen-1' },
      idempotencyKey: 'd1',
    });

    const after = failNode(deps, {
      projectId: 'p1',
      runId,
      nodeId: CONTINUITY_CRITIC,
      idempotencyKey: 'fail-critic',
    }).run as ChapterGenerationRunState;
    expect(after.terminalStatus).toBe('failed');
    expect(after.nodeStatuses[CONTINUITY_CRITIC]).toBe('failed');
    expect(after.nodeStatuses[STYLE_CRITIC]).toBe('cancelled');
    expect(after.nodeStatuses[REQUIREMENT_CRITIC]).toBe('cancelled');
  });
});
