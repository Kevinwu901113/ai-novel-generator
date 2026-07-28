/**
 * Grill-me 工作台根组件。
 *
 * 组合 session 列表、session 面板、问题详情。
 * 管理选中状态，处理 session 切换时清除陈旧状态。
 * 问题列表通过 grill.listQuestions API 从服务端获取。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GrillAnswerPublicData } from '@ai-novel/contracts';
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

  // Questions — manages its own question list via API
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

  /**
   * 并行加载当前答案。
   * 问题列表由 useGrillQuestions 内部管理。
   */
  const loadAnswers = useCallback(async () => {
    if (!projectId || !selectedSessionId) {
      setCurrentAnswers([]);
      return;
    }
    try {
      const answers = await questionsHook.getCurrentAnswers();
      setCurrentAnswers(answers);
    } catch {
      // Non-critical
    }
  }, [projectId, selectedSessionId, questionsHook]);

  // Session 切换时并行加载所有数据
  useEffect(() => {
    if (!selectedSessionId) {
      setCurrentAnswers([]);
      return;
    }
    // questionsHook.listQuestions() is called automatically by useGrillQuestions on session change
    void loadAnswers();
    void proposalsHook.refresh();
  }, [selectedSessionId, loadAnswers, proposalsHook.refresh]);

  // 清除陈旧状态：session 切换
  useEffect(() => {
    setSelectedQuestionId(null);
    setCurrentAnswers([]);
  }, [selectedSessionId]);

  // 清除陈旧状态：project 切换
  useEffect(() => {
    setSelectedSessionId(null);
    setSelectedQuestionId(null);
    setCurrentAnswers([]);
  }, [projectId]);

  /** mutation 成功后刷新所有数据 */
  const refreshAll = useCallback(async () => {
    await sessionHook.refresh();
    await questionsHook.listQuestions();
    await loadAnswers();
    await proposalsHook.refresh();
  }, [sessionHook, questionsHook, loadAnswers, proposalsHook]);

  const handleAddQuestions = useCallback(
    async (
      questionInputs: ReadonlyArray<{ topic: string; text: string; rationale: string }>,
    ): Promise<boolean> => {
      const ok = await questionsHook.addQuestions(questionInputs);
      if (ok) {
        await refreshAll();
      }
      return ok;
    },
    [questionsHook, refreshAll],
  );

  const handleAnswer = useCallback(
    async (questionId: string, text: string): Promise<boolean> => {
      const ok = await questionsHook.answerQuestion(questionId, text);
      if (ok) {
        await refreshAll();
      }
      return ok;
    },
    [questionsHook, refreshAll],
  );

  const handleMarkAsked = useCallback(
    async (questionId: string) => {
      await questionsHook.markQuestionAsked(questionId);
      await refreshAll();
    },
    [questionsHook, refreshAll],
  );

  const handleSkip = useCallback(
    async (questionId: string) => {
      await questionsHook.skipQuestion(questionId);
      await refreshAll();
    },
    [questionsHook, refreshAll],
  );

  const handleSupersede = useCallback(
    async (questionId: string) => {
      await questionsHook.supersedeQuestion(questionId);
      await refreshAll();
    },
    [questionsHook, refreshAll],
  );

  const handleSelectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
  }, []);

  const handleSelectQuestion = useCallback((questionId: string) => {
    setSelectedQuestionId(questionId);
  }, []);

  // 合并所有错误源
  const combinedError = sessionHook.error || questionsHook.error || proposalsHook.error;
  // 版本冲突来自 session hook 或 questions hook
  const hasVersionConflict = sessionHook.versionConflict || questionsHook.conflictNotice;
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
