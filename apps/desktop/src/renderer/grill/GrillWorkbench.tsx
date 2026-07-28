/**
 * Grill-me 工作台根组件。
 *
 * 组合 session 列表、session 面板、问题详情。
 * 管理选中状态，处理 session 切换时清除陈旧状态。
 * 问题列表通过 grill.listQuestions API 从服务端获取。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GrillAnswerPublicData } from '@ai-novel/contracts';
import { useGrillSessions } from './useGrillSessions';
import { useGrillSession } from './useGrillSession';
import { useGrillQuestions } from './useGrillQuestions';
import { useGrillProposals } from './useGrillProposals';
import { GrillSessionList } from './GrillSessionList';
import { GrillSessionPanel } from './GrillSessionPanel';
import { GrillQuestionDetail } from './GrillQuestionDetail';
import { GrillDiagnostics } from './GrillDiagnostics';

interface GrillWorkbenchProps {
  projectId: string;
}

export function GrillWorkbench({ projectId }: GrillWorkbenchProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [currentAnswers, setCurrentAnswers] = useState<ReadonlyArray<GrillAnswerPublicData>>([]);

  // Session list
  const sessionsHook = useGrillSessions(projectId);

  // Single session
  const sessionHook = useGrillSession(projectId, selectedSessionId);

  // Questions — manages its own question list via API
  const questionsHook = useGrillQuestions(
    projectId,
    selectedSessionId,
    sessionHook.session?.version ?? 0,
    sessionHook.refresh,
  );

  // Proposals — uses onSuccess callback to refresh session after conflict resolution
  const proposalsHook = useGrillProposals(
    projectId,
    selectedSessionId,
    sessionHook.session?.version ?? 0,
    sessionHook.refresh,
  );

  // 使用 ref 保持 getCurrentAnswers 的稳定引用，避免 loadAnswers 因 questionsHook 整体变化而重建
  const getCurrentAnswersRef = useRef(questionsHook.getCurrentAnswers);
  getCurrentAnswersRef.current = questionsHook.getCurrentAnswers;

  /**
   * 并行加载当前答案。
   * 问题列表由 useGrillQuestions 内部管理。
   */
  const loadAnswers = useCallback(async () => {
    if (!projectId || !selectedSessionId) {
      setCurrentAnswers((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    try {
      const answers = await getCurrentAnswersRef.current();
      setCurrentAnswers(answers);
    } catch {
      // Non-critical
    }
  }, [projectId, selectedSessionId]);

  // Session 切换时并行加载所有数据
  useEffect(() => {
    if (!selectedSessionId) {
      setCurrentAnswers((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // questionsHook.listQuestions() is called automatically by useGrillQuestions on session change
    void loadAnswers();
    void proposalsHook.refresh();
  }, [selectedSessionId, loadAnswers, proposalsHook.refresh]);

  // 清除陈旧状态：session 切换
  useEffect(() => {
    setSelectedQuestionId(null);
    setCurrentAnswers((prev) => (prev.length === 0 ? prev : []));
  }, [selectedSessionId]);

  // 清除陈旧状态：project 切换
  useEffect(() => {
    setSelectedSessionId(null);
    setSelectedQuestionId(null);
    setCurrentAnswers((prev) => (prev.length === 0 ? prev : []));
  }, [projectId]);

  // 使用 ref 保持 hook 方法的稳定引用
  const sessionRefreshRef = useRef(sessionHook.refresh);
  sessionRefreshRef.current = sessionHook.refresh;
  const listQuestionsRef = useRef(questionsHook.listQuestions);
  listQuestionsRef.current = questionsHook.listQuestions;
  const proposalsRefreshRef = useRef(proposalsHook.refresh);
  proposalsRefreshRef.current = proposalsHook.refresh;
  const addQuestionsRef = useRef(questionsHook.addQuestions);
  addQuestionsRef.current = questionsHook.addQuestions;
  const answerQuestionRef = useRef(questionsHook.answerQuestion);
  answerQuestionRef.current = questionsHook.answerQuestion;
  const markQuestionAskedRef = useRef(questionsHook.markQuestionAsked);
  markQuestionAskedRef.current = questionsHook.markQuestionAsked;
  const skipQuestionRef = useRef(questionsHook.skipQuestion);
  skipQuestionRef.current = questionsHook.skipQuestion;
  const supersedeQuestionRef = useRef(questionsHook.supersedeQuestion);
  supersedeQuestionRef.current = questionsHook.supersedeQuestion;

  /** mutation 成功后刷新所有数据 */
  const refreshAll = useCallback(async () => {
    await sessionRefreshRef.current();
    await listQuestionsRef.current();
    await loadAnswers();
    await proposalsRefreshRef.current();
  }, [loadAnswers]);

  const handleAddQuestions = useCallback(
    async (
      questionInputs: ReadonlyArray<{ topic: string; text: string; rationale: string }>,
    ): Promise<boolean> => {
      const ok = await addQuestionsRef.current(questionInputs);
      if (ok) {
        await refreshAll();
      }
      return ok;
    },
    [refreshAll],
  );

  const handleAnswer = useCallback(
    async (questionId: string, text: string): Promise<boolean> => {
      const ok = await answerQuestionRef.current(questionId, text);
      if (ok) {
        await refreshAll();
      }
      return ok;
    },
    [refreshAll],
  );

  const handleMarkAsked = useCallback(
    async (questionId: string) => {
      await markQuestionAskedRef.current(questionId);
      await refreshAll();
    },
    [refreshAll],
  );

  const handleSkip = useCallback(
    async (questionId: string) => {
      await skipQuestionRef.current(questionId);
      await refreshAll();
    },
    [refreshAll],
  );

  const handleSupersede = useCallback(
    async (questionId: string) => {
      await supersedeQuestionRef.current(questionId);
      await refreshAll();
    },
    [refreshAll],
  );

  const handleSelectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
  }, []);

  const handleSelectQuestion = useCallback((questionId: string) => {
    setSelectedQuestionId(questionId);
  }, []);

  // 合并所有错误源
  const combinedError = sessionHook.error || questionsHook.error || proposalsHook.error;
  // 版本冲突来自 session hook、questions hook 或 proposals hook
  const hasVersionConflict =
    sessionHook.versionConflict || questionsHook.conflictNotice || proposalsHook.conflictNotice;
  const isAnyLoading =
    sessionsHook.isLoading ||
    sessionHook.isLoading ||
    questionsHook.isLoading ||
    proposalsHook.isLoading;

  const selectedQuestion = useMemo(
    () => questionsHook.questions.find((q) => q.id === selectedQuestionId) ?? null,
    [questionsHook.questions, selectedQuestionId],
  );

  return (
    <div className="grill-workbench">
      {/* 开发态诊断 */}
      <GrillDiagnostics
        projectId={projectId}
        sessionId={selectedSessionId}
        sessionVersion={sessionHook.session?.version ?? null}
      />

      {/* 全局错误 */}
      {combinedError && (
        <div className="grill-error-banner">
          <span>{combinedError}</span>
          <button
            onClick={() => {
              sessionHook.clearError();
              questionsHook.clearError();
              proposalsHook.clearError();
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* 版本冲突提示 */}
      {hasVersionConflict && (
        <div className="grill-conflict-banner">
          <span>会话已在其他操作中更新，数据已自动刷新。</span>
          <button
            onClick={() => {
              sessionHook.clearError();
              questionsHook.clearConflictNotice();
              proposalsHook.clearConflictNotice();
            }}
          >
            ✕
          </button>
        </div>
      )}

      <div className="grill-workbench-columns">
        {/* 左栏：Session 列表 */}
        <div className="grill-workbench-left">
          <GrillSessionList
            sessions={sessionsHook.sessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={handleSelectSession}
            onCreateSession={sessionsHook.createSession}
            isLoading={isAnyLoading}
          />
        </div>

        {/* 中栏：Session 面板 + 问题列表 */}
        <div className="grill-workbench-center">
          {sessionHook.session ? (
            <GrillSessionPanel
              session={sessionHook.session}
              questions={questionsHook.questions}
              isLoading={isAnyLoading}
              onStart={sessionHook.startSession}
              onPause={sessionHook.pauseSession}
              onResume={sessionHook.resumeSession}
              onComplete={sessionHook.completeSession}
              onAbandon={sessionHook.abandonSession}
              onAddQuestions={handleAddQuestions}
              onMarkAsked={handleMarkAsked}
              onSkip={handleSkip}
              onSupersede={handleSupersede}
              onSelectQuestion={handleSelectQuestion}
              selectedQuestionId={selectedQuestionId}
            />
          ) : (
            <div className="empty-state">
              <p>选择一个 Grill 会话</p>
              <p className="empty-hint">或在左栏创建新会话</p>
            </div>
          )}
        </div>

        {/* 右栏：问题详情 */}
        <div className="grill-workbench-right">
          {selectedQuestion && sessionHook.session ? (
            <GrillQuestionDetail
              question={selectedQuestion}
              sessionIsActive={sessionHook.session.status === 'ACTIVE'}
              currentAnswers={currentAnswers}
              proposals={proposalsHook.proposals.filter((p) =>
                p.basedOnAnswerIds.some((id) =>
                  currentAnswers.some((a) => a.id === id && a.questionId === selectedQuestion.id),
                ),
              )}
              isLoading={isAnyLoading}
              onAnswer={handleAnswer}
              onListAnswerHistory={questionsHook.listAnswerHistory}
              onCreateProposal={proposalsHook.createProposal}
              onReviewProposal={proposalsHook.reviewProposal}
            />
          ) : (
            <div className="empty-state">
              <p>选择一个问题查看详情</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
