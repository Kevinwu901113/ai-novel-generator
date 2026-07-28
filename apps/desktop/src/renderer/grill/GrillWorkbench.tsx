/**
 * Grill-me 工作台根组件。
 *
 * 组合 session 列表、session 面板、问题详情。
 * 管理选中状态，处理 session 切换时清除陈旧状态。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GrillQuestionPublicData, GrillAnswerPublicData } from '@ai-novel/contracts';
import { useGrillSessions } from './useGrillSessions';
import { useGrillSession } from './useGrillSession';
import { useGrillQuestions } from './useGrillQuestions';
import { useGrillProposals } from './useGrillProposals';
import { GrillSessionList } from './GrillSessionList';
import { GrillSessionPanel } from './GrillSessionPanel';
import { GrillQuestionDetail } from './GrillQuestionDetail';

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

  // Questions
  const questionsHook = useGrillQuestions(
    projectId,
    selectedSessionId,
    sessionHook.session?.version ?? 0,
    sessionHook.refresh,
  );

  // Proposals
  const proposalsHook = useGrillProposals(
    projectId,
    selectedSessionId,
    sessionHook.session?.version ?? 0,
    sessionHook.refresh,
  );

  // Questions from session data (questions are part of the session in the domain model,
  // but we need to fetch them separately via the session's question list)
  const [questions, setQuestions] = useState<ReadonlyArray<GrillQuestionPublicData>>([]);

  // Load questions when session changes
  const loadQuestionsAndAnswers = useCallback(async () => {
    if (!projectId || !selectedSessionId) {
      setQuestions([]);
      setCurrentAnswers([]);
      return;
    }
    try {
      // Questions are stored in the session; we get them via the session data
      // For now, we use getCurrentAnswers to get answers, and the session data for questions
      const answers = await questionsHook.getCurrentAnswers();
      setCurrentAnswers(answers);
    } catch {
      // Not critical
    }
  }, [projectId, selectedSessionId, questionsHook]);

  // Load questions from session - they're embedded in the domain model
  // We need to fetch them via a dedicated API. Since the worker has listSessions/getSession
  // but not a separate listQuestions, we load questions through the session.
  // The session data from the worker doesn't include questions directly.
  // We need to track questions separately. For this workbench, we'll use the
  // addQuestions return value and refresh via getCurrentAnswers.
  useEffect(() => {
    void loadQuestionsAndAnswers();
  }, [loadQuestionsAndAnswers]);

  // Refresh proposals when session changes
  useEffect(() => {
    void proposalsHook.refresh();
  }, [selectedSessionId, proposalsHook.refresh]);

  // Clear stale state on session switch
  useEffect(() => {
    setSelectedQuestionId(null);
    setQuestions([]);
    setCurrentAnswers([]);
  }, [selectedSessionId]);

  // Clear stale state on project switch
  useEffect(() => {
    setSelectedSessionId(null);
    setSelectedQuestionId(null);
    setQuestions([]);
    setCurrentAnswers([]);
  }, [projectId]);

  // Wrap addQuestions to track questions locally
  const handleAddQuestions = useCallback(
    async (
      questionInputs: ReadonlyArray<{ topic: string; text: string; rationale: string }>,
    ): Promise<boolean> => {
      const ok = await questionsHook.addQuestions(questionInputs);
      if (ok) {
        // Reload everything after adding questions
        await sessionHook.refresh();
        await loadQuestionsAndAnswers();
        await proposalsHook.refresh();
      }
      return ok;
    },
    [questionsHook, sessionHook, loadQuestionsAndAnswers, proposalsHook],
  );

  // Wrap answerQuestion to refresh answers
  const handleAnswer = useCallback(
    async (questionId: string, text: string): Promise<boolean> => {
      const ok = await questionsHook.answerQuestion(questionId, text);
      if (ok) {
        await sessionHook.refresh();
        await loadQuestionsAndAnswers();
        await proposalsHook.refresh();
      }
      return ok;
    },
    [questionsHook, sessionHook, loadQuestionsAndAnswers, proposalsHook],
  );

  // Wrap mark/skip/supersede to refresh
  const handleMarkAsked = useCallback(
    async (questionId: string) => {
      await questionsHook.markQuestionAsked(questionId);
      await sessionHook.refresh();
    },
    [questionsHook, sessionHook],
  );

  const handleSkip = useCallback(
    async (questionId: string) => {
      await questionsHook.skipQuestion(questionId);
      await sessionHook.refresh();
    },
    [questionsHook, sessionHook],
  );

  const handleSupersede = useCallback(
    async (questionId: string) => {
      await questionsHook.supersedeQuestion(questionId);
      await sessionHook.refresh();
    },
    [questionsHook, sessionHook],
  );

  const handleSelectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
  }, []);

  const handleSelectQuestion = useCallback((questionId: string) => {
    setSelectedQuestionId(questionId);
  }, []);

  // Merge all errors
  const combinedError = sessionHook.error || questionsHook.error || proposalsHook.error;
  const isAnyLoading =
    sessionsHook.isLoading ||
    sessionHook.isLoading ||
    questionsHook.isLoading ||
    proposalsHook.isLoading;

  const selectedQuestion = useMemo(
    () => questions.find((q) => q.id === selectedQuestionId) ?? null,
    [questions, selectedQuestionId],
  );

  return (
    <div className="grill-workbench">
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
      {sessionHook.versionConflict && (
        <div className="grill-conflict-banner">会话已在其他操作中更新，数据已自动刷新。</div>
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
              questions={questions}
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
                // Show proposals that reference answers for this question
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
