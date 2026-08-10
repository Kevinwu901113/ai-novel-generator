/**
 * Idea Intake 纯逻辑单测（B4）：阶段映射、run 选取、相位派生、消息流构造、幂等键。
 */

import { describe, it, expect } from 'vitest';
import type {
  GraphProgressProjectionDto,
  GraphRunSummaryDto,
  GrillAnswerPublicData,
  GrillQuestionPublicData,
} from '@ai-novel/contracts';
import {
  buildMessageStream,
  currentQuestion,
  deriveIntakePhase,
  intakeRunIdempotencyKey,
  journeyStageFromPhase,
  journeyStageOf,
  latestProjectRun,
} from './intake-logic';

function run(overrides: Partial<GraphRunSummaryDto> = {}): GraphRunSummaryDto {
  return {
    runId: 'run-1',
    graphId: 'idea-to-novel-project-v1',
    graphVersion: 1,
    kind: 'project',
    terminalStatus: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  } as GraphRunSummaryDto;
}

function progress(
  nodes: ReadonlyArray<{ nodeId: string; stage: string; status: string }>,
): GraphProgressProjectionDto {
  return { activeNodes: nodes, possibleNextNodes: [] } as unknown as GraphProgressProjectionDto;
}

function question(overrides: Partial<GrillQuestionPublicData>): GrillQuestionPublicData {
  return {
    id: 'q1',
    sessionId: 's1',
    sequence: 1,
    topic: 't',
    text: '问题？',
    rationale: 'r',
    status: 'ASKED',
    dependsOnQuestionIds: [],
    createdAt: '2026-08-10T00:00:00.000Z',
    askedAt: null,
    answeredAt: null,
    skippedAt: null,
    ...overrides,
  } as GrillQuestionPublicData;
}

function answer(questionId: string, text: string): GrillAnswerPublicData {
  return {
    id: `a-${questionId}`,
    sessionId: 's1',
    questionId,
    revision: 1,
    source: 'USER',
    text,
    createdAt: '2026-08-10T00:00:00.000Z',
    supersededAt: null,
  } as GrillAnswerPublicData;
}

describe('journeyStageOf', () => {
  it('idea/clarify → idea；research/blueprint 各归其位；其余 → manuscript', () => {
    expect(journeyStageOf('idea')).toBe('idea');
    expect(journeyStageOf('clarify')).toBe('idea');
    expect(journeyStageOf('research')).toBe('research');
    expect(journeyStageOf('blueprint')).toBe('blueprint');
    expect(journeyStageOf('generate')).toBe('manuscript');
    expect(journeyStageOf('manuscript')).toBe('manuscript');
    expect(journeyStageOf('done')).toBe('manuscript');
  });
});

describe('latestProjectRun', () => {
  it('无 project run → null（chapter run 不计）', () => {
    expect(latestProjectRun([])).toBeNull();
    expect(latestProjectRun([run({ kind: 'chapter' } as never)])).toBeNull();
  });

  it('按 createdAt 取最新；同时间戳按 runId 稳定', () => {
    const a = run({ runId: 'run-a', createdAt: '2026-08-10T00:00:00.000Z' });
    const b = run({ runId: 'run-b', createdAt: '2026-08-11T00:00:00.000Z' });
    expect(latestProjectRun([a, b])?.runId).toBe('run-b');
    expect(latestProjectRun([b, a])?.runId).toBe('run-b');
    const c = run({ runId: 'run-c', createdAt: '2026-08-10T00:00:00.000Z' });
    expect(latestProjectRun([c, a])?.runId).toBe('run-c');
  });
});

describe('deriveIntakePhase', () => {
  it('无 run → no-run；终态 → terminal', () => {
    expect(deriveIntakePhase(null, null)).toEqual({ kind: 'no-run' });
    expect(deriveIntakePhase(run({ terminalStatus: 'failed' }), null)).toEqual({
      kind: 'terminal',
      status: 'failed',
    });
  });

  it('COLLECT_ANSWER 待答 → awaiting-answer；INTAKE_ESCALATION → escalation', () => {
    expect(
      deriveIntakePhase(
        run(),
        progress([{ nodeId: 'COLLECT_ANSWER', stage: 'clarify', status: 'waiting_for_human' }]),
      ),
    ).toEqual({ kind: 'awaiting-answer' });
    expect(
      deriveIntakePhase(
        run(),
        progress([{ nodeId: 'INTAKE_ESCALATION', stage: 'clarify', status: 'waiting_for_human' }]),
      ),
    ).toEqual({ kind: 'escalation' });
  });

  it('SPEC_EXTRACT 在途 → extracting；越过访谈 → beyond-intake（映射旅程阶段）', () => {
    expect(
      deriveIntakePhase(
        run(),
        progress([{ nodeId: 'SPEC_EXTRACT', stage: 'idea', status: 'active' }]),
      ),
    ).toEqual({ kind: 'extracting' });
    const beyond = deriveIntakePhase(
      run(),
      progress([{ nodeId: 'RESEARCH_DECISION', stage: 'research', status: 'active' }]),
    );
    expect(beyond).toEqual({ kind: 'beyond-intake', journeyStage: 'research' });
    expect(journeyStageFromPhase(beyond)).toBe('research');
  });

  it('IDEA_CAPTURE 在途 / 空 activeNodes → working', () => {
    expect(
      deriveIntakePhase(
        run(),
        progress([{ nodeId: 'IDEA_CAPTURE', stage: 'idea', status: 'active' }]),
      ),
    ).toEqual({ kind: 'working' });
    expect(deriveIntakePhase(run(), progress([]))).toEqual({ kind: 'working' });
  });
});

describe('buildMessageStream / currentQuestion', () => {
  it('goal 开头；PLANNED/SUPERSEDED 不显示；ASKED 未答为当前问题', () => {
    const questions = [
      question({ id: 'q1', sequence: 1, status: 'ANSWERED', text: '第一问' }),
      question({ id: 'q2', sequence: 2, status: 'ASKED', text: '第二问' }),
      question({ id: 'q3', sequence: 3, status: 'PLANNED', text: '内部计划' }),
      question({ id: 'q4', sequence: 4, status: 'SUPERSEDED', text: '作废' }),
    ];
    const answers = [answer('q1', '第一答')];
    const stream = buildMessageStream('我的想法', questions, answers);
    expect(stream[0]).toEqual({ kind: 'goal', text: '我的想法' });
    expect(stream).toHaveLength(3);
    expect(stream[1]).toMatchObject({ questionId: 'q1', answer: '第一答', current: false });
    expect(stream[2]).toMatchObject({ questionId: 'q2', answer: null, current: true });
    expect(currentQuestion(questions, answers)?.id).toBe('q2');
  });

  it('SKIPPED 标记跳过；全部已答 → 无当前问题', () => {
    const questions = [question({ id: 'q1', status: 'SKIPPED' })];
    const stream = buildMessageStream('g', questions, []);
    expect(stream[1]).toMatchObject({ skipped: true, current: false });
    expect(currentQuestion(questions, [])).toBeNull();
  });
});

describe('intakeRunIdempotencyKey', () => {
  it('同代际同键（去重），代际增长得新键（TD-022 重建）', () => {
    expect(intakeRunIdempotencyKey('p1', 0)).toBe(intakeRunIdempotencyKey('p1', 0));
    expect(intakeRunIdempotencyKey('p1', 0)).not.toBe(intakeRunIdempotencyKey('p1', 1));
    expect(intakeRunIdempotencyKey('p1', 0)).not.toBe(intakeRunIdempotencyKey('p2', 0));
  });
});
