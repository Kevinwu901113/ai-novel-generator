/**
 * Grill 问题操作 hook。
 */

import { useCallback, useState } from 'react';
import type { GrillAnswerPublicData } from '@ai-novel/contracts';
import { grillErrorMessage } from './status-labels';

interface UseGrillQuestionsResult {
  isLoading: boolean;
  error: string | null;
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
}

export function useGrillQuestions(
  projectId: string | null,
  sessionId: string | null,
  expectedVersion: number,
  onSuccess: () => Promise<void>,
): UseGrillQuestionsResult {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMutation = useCallback(
    async (fn: () => Promise<unknown>, actionName: string): Promise<boolean> => {
      if (!projectId || !sessionId || isLoading) return false;
      setIsLoading(true);
      setError(null);
      try {
        await fn();
        await onSuccess();
        return true;
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code === 'GRILL_VERSION_CONFLICT') {
          setError('会话已在其他操作中更新');
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
    [projectId, sessionId, expectedVersion, isLoading, onSuccess],
  );

  const addQuestions = useCallback(
    (questions: ReadonlyArray<{ topic: string; text: string; rationale: string }>) =>
      handleMutation(
        () =>
          window.desktop.grill.addQuestions({
            projectId: projectId!,
            sessionId: sessionId!,
            expectedVersion,
            questions: questions.map((q) => ({
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

  const clearError = useCallback(() => setError(null), []);

  return {
    isLoading,
    error,
    addQuestions,
    markQuestionAsked,
    answerQuestion,
    skipQuestion,
    supersedeQuestion,
    getCurrentAnswers,
    listAnswerHistory,
    clearError,
  };
}
