/**
 * Idea Intake 数据 hook（B4）。
 *
 * 数据源（D-B4-5）：graph.listRuns / graph.getRunProgress 驱动相位；
 * intake.getActiveIntakeSession + grill.listQuestions / getCurrentAnswers 组装消息流；
 * contract.getCurrent 读当前创作要求。回答/跳过/完成/升级一律走 graph.applyHumanDecision
 * （answer receipt 在 worker 事务内生成）。轮询沿用自递归 setTimeout 模式。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ContractVersionPublicData,
  GraphRunSummaryDto,
  GrillQuestionPublicData,
  GrillSessionPublicData,
} from '@ai-novel/contracts';
import {
  buildMessageStream,
  currentQuestion,
  deriveIntakePhase,
  intakeRunIdempotencyKey,
  latestProjectRun,
  type IntakeMessage,
  type IntakePhase,
} from './intake-logic';
import { toSafeUserError } from '../safety/safe-error';

const POLL_INTERVAL_MS = 1500;

export interface IntakeViewState {
  readonly phase: IntakePhase;
  readonly messages: ReadonlyArray<IntakeMessage>;
  readonly pendingQuestion: GrillQuestionPublicData | null;
  readonly spec: ContractVersionPublicData | null;
  readonly busy: boolean;
  readonly error: string | null;
}

export interface IntakeActions {
  submitAnswer(text: string): Promise<void>;
  skipQuestion(): Promise<void>;
  finishInterview(): Promise<void>;
  chooseEscalation(outcome: string): Promise<void>;
  restartInterview(): Promise<void>;
  refreshSpec(): Promise<void>;
}

export function useIntake(projectId: string): IntakeViewState & IntakeActions {
  const [phase, setPhase] = useState<IntakePhase>({ kind: 'working' });
  const [messages, setMessages] = useState<ReadonlyArray<IntakeMessage>>([]);
  const [pendingQuestion, setPendingQuestion] = useState<GrillQuestionPublicData | null>(null);
  const [spec, setSpec] = useState<ContractVersionPublicData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runRef = useRef<GraphRunSummaryDto | null>(null);
  const runCountRef = useRef(0);
  const sessionRef = useRef<GrillSessionPublicData | null>(null);
  // 自动创建仅尝试一次（失败后不无限重试；重建走显式按钮）
  const autoCreateAttempted = useRef(false);

  const refresh = useCallback(async () => {
    const runs = await window.desktop.graph.listRuns({ projectId });
    runCountRef.current = runs.filter((r) => r.kind === 'project').length;
    let run = latestProjectRun(runs);

    // D-B4-2：进入 Idea 阶段且无 project run → 自动开始访谈
    if (!run && !autoCreateAttempted.current) {
      autoCreateAttempted.current = true;
      await window.desktop.graph.createProjectRun({
        projectId,
        idempotencyKey: intakeRunIdempotencyKey(projectId, runCountRef.current),
      });
      const created = await window.desktop.graph.listRuns({ projectId });
      runCountRef.current = created.filter((r) => r.kind === 'project').length;
      run = latestProjectRun(created);
    }
    runRef.current = run;

    const progress = run
      ? await window.desktop.graph.getRunProgress({ projectId, runId: run.runId })
      : null;
    setPhase(deriveIntakePhase(run, progress));

    const session = await window.desktop.intake.getActiveIntakeSession({ projectId });
    sessionRef.current = session;
    if (session) {
      const [questions, answers] = await Promise.all([
        window.desktop.grill.listQuestions({ projectId, sessionId: session.id }),
        window.desktop.grill.getCurrentAnswers(projectId, session.id),
      ]);
      setMessages(buildMessageStream(session.goal, questions, answers));
      setPendingQuestion(currentQuestion(questions, answers));
    } else {
      setMessages([]);
      setPendingQuestion(null);
    }

    setSpec(await window.desktop.contract.getCurrent({ projectId }));
  }, [projectId]);

  // 轮询（自递归 setTimeout；卸载/项目切换取消）
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      try {
        await refresh();
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled) setError(toSafeUserError(err, '访谈状态加载失败').message);
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const runAction = useCallback(
    async (fn: () => Promise<unknown>, failMessage: string) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(toSafeUserError(err, failMessage).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const submitAnswer = useCallback(
    async (text: string) => {
      const run = runRef.current;
      const session = sessionRef.current;
      const question = pendingQuestion;
      if (!run || !session || !question) return;
      await runAction(
        () =>
          window.desktop.graph.applyHumanDecision({
            kind: 'intake_answer',
            projectId,
            runId: run.runId,
            nodeId: 'COLLECT_ANSWER',
            sessionId: session.id,
            questionId: question.id,
            text,
            idempotencyKey: crypto.randomUUID(),
          }),
        '提交回答失败',
      );
    },
    [projectId, pendingQuestion, runAction],
  );

  const skipQuestion = useCallback(async () => {
    const run = runRef.current;
    if (!run) return;
    await runAction(
      () =>
        window.desktop.graph.applyHumanDecision({
          kind: 'intake_skip',
          projectId,
          runId: run.runId,
          nodeId: 'COLLECT_ANSWER',
          idempotencyKey: crypto.randomUUID(),
        }),
      '跳过问题失败',
    );
  }, [projectId, runAction]);

  const finishInterview = useCallback(async () => {
    const run = runRef.current;
    if (!run) return;
    await runAction(
      () =>
        window.desktop.graph.applyHumanDecision({
          kind: 'intake_finish',
          projectId,
          runId: run.runId,
          nodeId: 'COLLECT_ANSWER',
          idempotencyKey: crypto.randomUUID(),
        }),
      '结束访谈失败',
    );
  }, [projectId, runAction]);

  const chooseEscalation = useCallback(
    async (outcome: string) => {
      const run = runRef.current;
      if (!run) return;
      await runAction(
        () =>
          window.desktop.graph.applyHumanDecision({
            kind: 'escalation',
            projectId,
            runId: run.runId,
            nodeId: 'INTAKE_ESCALATION',
            outcome,
            idempotencyKey: crypto.randomUUID(),
          }),
        '提交选择失败',
      );
    },
    [projectId, runAction],
  );

  // TD-022（D-B4-2）：failed run 一键重建——新代际幂等键创建新 run，
  // IDEA_CAPTURE 重新播种会话（旧会话由 TD-024 弃用），既有创作要求版本保留。
  const restartInterview = useCallback(async () => {
    await runAction(
      () =>
        window.desktop.graph.createProjectRun({
          projectId,
          idempotencyKey: intakeRunIdempotencyKey(projectId, runCountRef.current),
        }),
      '重新开始访谈失败',
    );
  }, [projectId, runAction]);

  const refreshSpec = useCallback(async () => {
    setSpec(await window.desktop.contract.getCurrent({ projectId }));
  }, [projectId]);

  return {
    phase,
    messages,
    pendingQuestion,
    spec,
    busy,
    error,
    submitAnswer,
    skipQuestion,
    finishInterview,
    chooseEscalation,
    restartInterview,
    refreshSpec,
  };
}
