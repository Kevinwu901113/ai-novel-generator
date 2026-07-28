/**
 * Grill 提案操作 hook。
 *
 * version conflict 横幅在刷新后保持可见，直到用户关闭或下次成功 mutation。
 */

import { useCallback, useEffect, useState } from 'react';
import type { GrillProposalPublicData } from '@ai-novel/contracts';
import { grillErrorMessage } from './status-labels';

interface UseGrillProposalsResult {
  proposals: ReadonlyArray<GrillProposalPublicData>;
  isLoading: boolean;
  error: string | null;
  /** 版本冲突标记 —— 刷新后保持，直到用户关闭或成功 mutation */
  conflictNotice: boolean;
  createProposal: (input: {
    key: string;
    proposedValueJson: string;
    confidence: number;
    rationale: string;
    basedOnAnswerIds: ReadonlyArray<string>;
  }) => Promise<boolean>;
  reviewProposal: (proposalId: string, decision: 'ACCEPTED' | 'REJECTED') => Promise<boolean>;
  refresh: () => Promise<void>;
  clearError: () => void;
  clearConflictNotice: () => void;
}

export function useGrillProposals(
  projectId: string | null,
  sessionId: string | null,
  expectedVersion: number,
  onSuccess: () => Promise<void>,
): UseGrillProposalsResult {
  const [proposals, setProposals] = useState<ReadonlyArray<GrillProposalPublicData>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId || !sessionId) {
      setProposals([]);
      return;
    }
    try {
      const list = await window.desktop.grill.listProposals({ projectId, sessionId });
      setProposals(list);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      setError(grillErrorMessage(code, '加载提案列表失败'));
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    void refresh();
    setConflictNotice(false);
    setError(null);
  }, [refresh]);

  const handleMutation = useCallback(
    async (fn: () => Promise<unknown>, actionName: string): Promise<boolean> => {
      if (!projectId || !sessionId || isLoading) return false;
      setIsLoading(true);
      // Do NOT clear conflictNotice here — only clear on successful mutation
      setError(null);
      try {
        await fn();
        // Refresh data after successful mutation
        await refresh();
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
          await refresh();
          await onSuccess();
        } else {
          setError(grillErrorMessage(code, `${actionName}失败`));
        }
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [projectId, sessionId, isLoading, refresh, onSuccess],
  );

  const createProposal = useCallback(
    async (input: {
      key: string;
      proposedValueJson: string;
      confidence: number;
      rationale: string;
      basedOnAnswerIds: ReadonlyArray<string>;
    }): Promise<boolean> =>
      handleMutation(
        () =>
          window.desktop.grill.createProposal({
            projectId: projectId!,
            sessionId: sessionId!,
            expectedVersion,
            ...input,
          }),
        '创建提案',
      ),
    [handleMutation, projectId, sessionId, expectedVersion],
  );

  const reviewProposal = useCallback(
    async (proposalId: string, decision: 'ACCEPTED' | 'REJECTED'): Promise<boolean> =>
      handleMutation(
        () =>
          window.desktop.grill.reviewProposal({
            projectId: projectId!,
            sessionId: sessionId!,
            expectedVersion,
            proposalId,
            decision,
          }),
        '审核提案',
      ),
    [handleMutation, projectId, sessionId, expectedVersion],
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
    proposals,
    isLoading,
    error,
    conflictNotice,
    createProposal,
    reviewProposal,
    refresh,
    clearError,
    clearConflictNotice,
  };
}
