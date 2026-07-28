/**
 * Grill 提案操作 hook。
 */

import { useCallback, useEffect, useState } from 'react';
import type { GrillProposalPublicData } from '@ai-novel/contracts';
import { grillErrorMessage } from './status-labels';

interface UseGrillProposalsResult {
  proposals: ReadonlyArray<GrillProposalPublicData>;
  isLoading: boolean;
  error: string | null;
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
}

export function useGrillProposals(
  projectId: string | null,
  sessionId: string | null,
  expectedVersion: number,
  onVersionConflict: () => Promise<void>,
): UseGrillProposalsResult {
  const [proposals, setProposals] = useState<ReadonlyArray<GrillProposalPublicData>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId || !sessionId) {
      setProposals([]);
      return;
    }
    try {
      const list = await window.desktop.grill.listProposals({ projectId, sessionId });
      setProposals(list);
      setError(null);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      setError(grillErrorMessage(code, '加载提案列表失败'));
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createProposal = useCallback(
    async (input: {
      key: string;
      proposedValueJson: string;
      confidence: number;
      rationale: string;
      basedOnAnswerIds: ReadonlyArray<string>;
    }): Promise<boolean> => {
      if (!projectId || !sessionId || isLoading) return false;
      setIsLoading(true);
      setError(null);
      try {
        await window.desktop.grill.createProposal({
          projectId,
          sessionId,
          expectedVersion,
          ...input,
        });
        await refresh();
        return true;
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code === 'GRILL_VERSION_CONFLICT') {
          setError('会话已在其他操作中更新');
          await onVersionConflict();
        } else {
          setError(grillErrorMessage(code, '创建提案失败'));
        }
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [projectId, sessionId, expectedVersion, isLoading, refresh, onVersionConflict],
  );

  const reviewProposal = useCallback(
    async (proposalId: string, decision: 'ACCEPTED' | 'REJECTED'): Promise<boolean> => {
      if (!projectId || !sessionId || isLoading) return false;
      setIsLoading(true);
      setError(null);
      try {
        await window.desktop.grill.reviewProposal({
          projectId,
          sessionId,
          expectedVersion,
          proposalId,
          decision,
        });
        await refresh();
        return true;
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code === 'GRILL_VERSION_CONFLICT') {
          setError('会话已在其他操作中更新');
          await onVersionConflict();
        } else {
          setError(grillErrorMessage(code, '审核提案失败'));
        }
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [projectId, sessionId, expectedVersion, isLoading, refresh, onVersionConflict],
  );

  const clearError = useCallback(() => setError(null), []);

  return { proposals, isLoading, error, createProposal, reviewProposal, refresh, clearError };
}
