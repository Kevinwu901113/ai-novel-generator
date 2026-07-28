/**
 * Grill 问题操作 hook。
 *
 * 管理问题列表和问题级操作。
 * 问题列表通过 grill.listQuestions API 从服务端获取。
 */

import { useCallback, useEffect, useState } from 'react';
import type { GrillQuestionPublicData, GrillAnswerPublicData } from '@ai-novel/contracts';
import { grillErrorMessage } from './status-labels';

interface UseGrillQuestionsResult {
  questions: ReadonlyArray<GrillQuestionPublicData>;
  isLoading: boolean;
  error: string | null;
  /** 标记是否因版本冲突设置的错误（不应被 refresh 立即清除） */
  conflictNotice: boolean;
  listQuestions: () => Promise<void>;
  addQuestions: (
    questions: ReadonlyArray<{ topic: string; text: string; rationale: string }>,
  ) => Promise<boolean>;
  markQuestionAsked: (questionId: string) => Promise<boolean>;
  answerQuestion: (questionId: string, text: string) => Promise<boolean>;
  skipQuestion: (questionId: string) => Promise<boolean>;
  supersedeQuestion: (questionId: string) => Promise<boolean>;
  getCurrentAnswers: () => Promise<ReadonlyArray<GrillAnswerPublicData>>;
  listAnswerHistory: (questionId: string) => Promise<ReadonlyArray<GrillAnswerPublicData>>;
  clearError: () => void;
  clearConflictNotice: () => void;
}

export function useGrillQuestions(
  projectId: string | null,
  sessionId: string | null,
  expectedVersion: number,
  onSuccess: () => Promise<void>,
): UseGrillQuestionsResult {
  const [questions, setQuestions] = useState<ReadonlyArray<GrillQuestionPublicData>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState(false);

  const listQuestions = useCallback(async () => {
    if (!projectId || !sessionId) {
      setQuestions([]);
      return;
    }
    try {
      const qs = await window.desktop.grill.listQuestions({ projectId, sessionId });
      setQuestions(qs);
    } catch {
      // Non-critical; questions will be stale but not fatal
    }
  }, [projectId, sessionId]);

  // Load questions when session changes
  useEffect(() => {
    void listQuestions();
    setError(null);
    setConflictNotice(false);
  }, [listQuestions]);

  const handleMutation = useCallback(
    async (fn: () => Promise<unknown>, actionName: string): Promise<boolean> => {
      if (!projectId || !sessionId || isLoading) return false;
      setIsLoading(true);
      // Do NOT clear conflictNotice here — only clear on successful mutation
      setError(null);
      try {
        await fn();
        // Refresh data after successful mutation
        await listQuestions();
        await onSuccess();
        // Clear conflict notice on success
        setConflictNotice(false);
        return true;
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code === 'GRILL_VERSION_CONFLICT') {
          setError('会话已在其他操作中更新');
          setConflictNotice(true);
          // Refresh data but keep conflict notice
          await listQuestions();
          await onSuccess();
        } else if (code === 'GRILL_OWNERSHIP_CONFLICT') {
          setError('资源不属于当前会话');
        } else {
          setError(grillErrorMessage(code, `${actionName}失败`));
        }
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [projectId, sessionId, expectedVersion, isLoading, listQuestions, onSuccess],
  );

  const addQuestions = useCallback(
    (questionInputs: ReadonlyArray<{ topic: string; text: string; rationale: string }>) =>
      handleMutation(
        () =>
          window.desktop.grill.addQuestions({
            projectId: projectId!,
            sessionId: sessionId!,
            expectedVersion,
            questions: questionInputs.map((q) => ({
              topic: q.topic,
              text: q.text,
              rationale: q.rationale,
              dependsOnQuestionIds: [],
            })),
          }),
        '添加问题',
      ),
    [handleMutation, projectId, sessionId, expectedVersion],
  );

  const markQuestionAsked = useCallback(
    (questionId: string) =>
      handleMutation(
        () =>
          window.desktop.grill.markQuestionAsked({
            projectId: projectId!,
            sessionId: sessionId!,
            expectedVersion,
            questionId,
          }),
        '标记已提问',
      ),
    [handleMutation, projectId, sessionId, expectedVersion],
  );

  const answerQuestion = useCallback(
    (questionId: string, text: string) =>
      handleMutation(
        () =>
          window.desktop.grill.answerQuestion({
            projectId: projectId!,
            sessionId: sessionId!,
            expectedVersion,
            questionId,
            text,
            source: 'USER',
          }),
        '回答问题',
      ),
    [handleMutation, projectId, sessionId, expectedVersion],
  );

  const skipQuestion = useCallback(
    (questionId: string) =>
      handleMutation(
        () =>
          window.desktop.grill.skipQuestion({
            projectId: projectId!,
            sessionId: sessionId!,
            expectedVersion,
            questionId,
          }),
        '跳过问题',
      ),
    [handleMutation, projectId, sessionId, expectedVersion],
  );

  const supersedeQuestion = useCallback(
    (questionId: string) =>
      handleMutation(
        () =>
          window.desktop.grill.supersedeQuestion({
            projectId: projectId!,
            sessionId: sessionId!,
            expectedVersion,
            questionId,
          }),
        '废弃问题',
      ),
    [handleMutation, projectId, sessionId, expectedVersion],
  );

  const getCurrentAnswers = useCallback(async (): Promise<ReadonlyArray<GrillAnswerPublicData>> => {
    if (!projectId || !sessionId) return [];
    return window.desktop.grill.getCurrentAnswers(projectId, sessionId);
  }, [projectId, sessionId]);

  const listAnswerHistory = useCallback(
    async (questionId: string): Promise<ReadonlyArray<GrillAnswerPublicData>> => {
      if (!projectId || !sessionId) return [];
      return window.desktop.grill.listAnswerHistory({
        projectId,
        sessionId,
        questionId,
      });
    },
    [projectId, sessionId],
  );

  const clearError = useCallback(() => {
    setError(null);
    setConflictNotice(false);
  }, []);

  const clearConflictNotice = useCallback(() => {
    setConflictNotice(false);
    if (error === '会话已在其他操作中更新') {
      setError(null);
    }
  }, [error]);

  return {
    questions,
    isLoading,
    error,
    conflictNotice,
    listQuestions,
    addQuestions,
    markQuestionAsked,
    answerQuestion,
    skipQuestion,
    supersedeQuestion,
    getCurrentAnswers,
    listAnswerHistory,
    clearError,
    clearConflictNotice,
  };
}
