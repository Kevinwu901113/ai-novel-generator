/**
 * Idea Intake 旅程纯逻辑（B4，设计见 docs/development/b4-intake-ui-design.md）。
 *
 * - 四阶段旅程投影：WorkflowStage（展示投影）→ Idea/Research/Blueprint/Manuscript；
 * - run 选取与访谈相位派生：全部由 graph.listRuns / graph.getRunProgress 的 DTO 驱动，
 *   renderer 不自行推导 Graph 语义（锁定不变量：WorkflowStage 仅展示用）；
 * - 自动创建 run 的幂等键（D-B4-2）：同代际去重，failed 重建得新键。
 */

import type {
  GraphProgressProjectionDto,
  GraphRunSummaryDto,
  GrillQuestionPublicData,
  GrillAnswerPublicData,
  RunTerminalStatusDto,
} from '@ai-novel/contracts';

export type JourneyStage = 'idea' | 'research' | 'blueprint' | 'manuscript';

export const JOURNEY_STAGES: ReadonlyArray<{ readonly id: JourneyStage; readonly label: string }> =
  [
    { id: 'idea', label: '想法' },
    { id: 'research', label: '调研' },
    { id: 'blueprint', label: '蓝图' },
    { id: 'manuscript', label: '成稿' },
  ];

/** WorkflowStage（展示投影）→ 四阶段旅程 */
export function journeyStageOf(stage: string): JourneyStage {
  switch (stage) {
    case 'idea':
    case 'clarify':
      return 'idea';
    case 'research':
      return 'research';
    case 'blueprint':
      return 'blueprint';
    default:
      return 'manuscript';
  }
}

/** 最新的 project run（listRuns 无排序保证；按 createdAt、runId 稳定排序取最新） */
export function latestProjectRun(
  runs: ReadonlyArray<GraphRunSummaryDto>,
): GraphRunSummaryDto | null {
  const projectRuns = runs.filter((r) => r.kind === 'project');
  if (projectRuns.length === 0) return null;
  const sorted = [...projectRuns].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.runId < b.runId ? -1 : 1;
  });
  return sorted[sorted.length - 1];
}

/** 访谈相位（判别联合；驱动中栏渲染） */
export type IntakePhase =
  | { readonly kind: 'no-run' }
  | { readonly kind: 'working' }
  | { readonly kind: 'extracting' }
  | { readonly kind: 'awaiting-answer' }
  | { readonly kind: 'escalation' }
  | { readonly kind: 'beyond-intake'; readonly journeyStage: JourneyStage }
  | { readonly kind: 'terminal'; readonly status: RunTerminalStatusDto };

export function deriveIntakePhase(
  run: GraphRunSummaryDto | null,
  progress: GraphProgressProjectionDto | null,
): IntakePhase {
  if (!run) return { kind: 'no-run' };
  if (run.terminalStatus) return { kind: 'terminal', status: run.terminalStatus };
  if (!progress) return { kind: 'working' };
  const waiting = progress.activeNodes.find((n) => n.status === 'waiting_for_human');
  if (waiting?.nodeId === 'COLLECT_ANSWER') return { kind: 'awaiting-answer' };
  if (waiting?.nodeId === 'INTAKE_ESCALATION') return { kind: 'escalation' };
  if (progress.activeNodes.some((n) => n.nodeId === 'SPEC_EXTRACT')) {
    return { kind: 'extracting' };
  }
  const beyond = progress.activeNodes.find((n) => n.stage !== 'idea' && n.stage !== 'clarify');
  if (beyond) return { kind: 'beyond-intake', journeyStage: journeyStageOf(beyond.stage) };
  return { kind: 'working' };
}

/** 旅程当前阶段（导航高亮）：terminal / 无 run 时停留 Idea */
export function journeyStageFromPhase(phase: IntakePhase): JourneyStage {
  return phase.kind === 'beyond-intake' ? phase.journeyStage : 'idea';
}

/**
 * 自动创建 run 幂等键（D-B4-2）：以既有 project run 数为代际号——
 * 同代际重复点击/竞态天然去重（payloadHash 只含 projectId，同键即同 run），
 * failed 后重建因 run 数增长得到新键。
 */
export function intakeRunIdempotencyKey(projectId: string, existingRunCount: number): string {
  return `intake-auto:${projectId}:${existingRunCount}`;
}

/** 会话消息流条目（goal + 已答/已跳过问答 + 当前待答问题） */
export type IntakeMessage =
  | { readonly kind: 'goal'; readonly text: string }
  | {
      readonly kind: 'question';
      readonly questionId: string;
      readonly text: string;
      readonly answer: string | null;
      readonly skipped: boolean;
      readonly current: boolean;
    };

/**
 * 由问题与当前答案构造消息流：
 * - 按 sequence 升序；PLANNED（未问出）不显示——不暴露内部计划；
 * - ASKED 且无当前答案 = 当前待答问题（至多一个）。
 */
export function buildMessageStream(
  goal: string,
  questions: ReadonlyArray<GrillQuestionPublicData>,
  answers: ReadonlyArray<GrillAnswerPublicData>,
): IntakeMessage[] {
  const answerByQuestion = new Map(answers.map((a) => [a.questionId, a.text]));
  const messages: IntakeMessage[] = [{ kind: 'goal', text: goal }];
  const visible = [...questions]
    .filter((q) => q.status !== 'PLANNED' && q.status !== 'SUPERSEDED')
    .sort((a, b) => a.sequence - b.sequence);
  for (const q of visible) {
    const answer = answerByQuestion.get(q.id) ?? null;
    messages.push({
      kind: 'question',
      questionId: q.id,
      text: q.text,
      answer,
      skipped: q.status === 'SKIPPED',
      current: q.status === 'ASKED' && answer === null,
    });
  }
  return messages;
}

/** 当前待答问题（ASKED 且无当前答案），无则 null */
export function currentQuestion(
  questions: ReadonlyArray<GrillQuestionPublicData>,
  answers: ReadonlyArray<GrillAnswerPublicData>,
): GrillQuestionPublicData | null {
  const answered = new Set(answers.map((a) => a.questionId));
  const open = questions
    .filter((q) => q.status === 'ASKED' && !answered.has(q.id))
    .sort((a, b) => a.sequence - b.sequence);
  return open[0] ?? null;
}

/** INTAKE_ESCALATION 的用户可选项（domain 闭合枚举的友好文案投影） */
export const ESCALATION_OPTIONS: ReadonlyArray<{
  readonly outcome: string;
  readonly label: string;
  readonly description: string;
}> = [
  {
    outcome: 'continue_with_current_spec',
    label: '就用当前的创作要求',
    description: '不再追问，直接以现在整理出的要求继续',
  },
  {
    outcome: 'modify_idea',
    label: '修改我的想法',
    description: '回到最初想法重新开始整理',
  },
  {
    outcome: 'continue_later',
    label: '稍后再说',
    description: '先停在这里；之后回来需重新开始访谈（已整理的创作要求会保留）',
  },
  {
    outcome: 'cancel',
    label: '取消这个项目的访谈',
    description: '结束本次访谈（项目保留）',
  },
];
