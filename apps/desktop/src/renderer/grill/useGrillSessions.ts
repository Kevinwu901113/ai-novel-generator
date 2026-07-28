/**
 * Grill session 列表管理 hook。
 */

import { useCallback, useEffect, useState } from 'react';
import type { GrillSessionPublicData } from '@ai-novel/contracts';
import { grillErrorMessage } from './status-labels';

interface UseGrillSessionsResult {
  sessions: ReadonlyArray<GrillSessionPublicData>;
  isLoading: boolean;
  error: string | null;
  createSession: (goal: string) => Promise<GrillSessionPublicData | null>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

export function useGrillSessions(projectId: string | null): UseGrillSessionsResult {
  const [sessions, setSessions] = useState<ReadonlyArray<GrillSessionPublicData>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setSessions([]);
      return;
    }
    setIsLoading(true);
    try {
      const list = await window.desktop.grill.listSessions(projectId);
      setSessions(list);
      setError(null);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      setError(grillErrorMessage(code, '加载会话列表失败'));
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createSession = useCallback(
    async (goal: string): Promise<GrillSessionPublicData | null> => {
      if (!projectId) return null;
      setIsLoading(true);
      setError(null);
      try {
        const session = await window.desktop.grill.createSession({ projectId, goal });
        await refresh();
        return session;
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        setError(grillErrorMessage(code, '创建会话失败'));
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [projectId, refresh],
  );

  const clearError = useCallback(() => setError(null), []);

  return { sessions, isLoading, error, createSession, refresh, clearError };
}
