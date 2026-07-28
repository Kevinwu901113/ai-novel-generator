/**
 * 单个 Grill session 管理 hook。
 *
 * 处理 session 状态操作、version conflict、loading lock。
 */

import { useCallback, useEffect, useState } from 'react';
import type { GrillSessionPublicData } from '@ai-novel/contracts';
import { grillErrorMessage } from './status-labels';

interface UseGrillSessionResult {
  session: GrillSessionPublicData | null;
  isLoading: boolean;
  error: string | null;
  versionConflict: boolean;
  startSession: () => Promise<void>;
  pauseSession: () => Promise<void>;
  resumeSession: () => Promise<void>;
  completeSession: () => Promise<void>;
  abandonSession: () => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

export function useGrillSession(
  projectId: string | null,
  sessionId: string | null,
  onVersionConflict?: () => void,
): UseGrillSessionResult {
  const [session, setSession] = useState<GrillSessionPublicData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId || !sessionId) {
      setSession(null);
      return;
    }
    try {
      const s = await window.desktop.grill.getSession(projectId, sessionId);
      setSession(s);
      setVersionConflict(false);
      setError(null);
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      setError(grillErrorMessage(code, '加载会话失败'));
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    void refresh();
    setVersionConflict(false);
    setError(null);
  }, [refresh]);

  const handleMutation = useCallback(
    async (
      fn: (input: {
        projectId: string;
        sessionId: string;
        expectedVersion: number;
      }) => Promise<GrillSessionPublicData>,
      actionName: string,
    ) => {
      if (!projectId || !sessionId || !session || isLoading) return;
      setIsLoading(true);
      setError(null);
      try {
        const updated = await fn({
          projectId,
          sessionId,
          expectedVersion: session.version,
        });
        setSession(updated);
        setVersionConflict(false);
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code === 'GRILL_VERSION_CONFLICT') {
          setVersionConflict(true);
          setError('会话已在其他操作中更新');
          await refresh();
          onVersionConflict?.();
        } else if (code === 'GRILL_OWNERSHIP_CONFLICT') {
          setError('资源不属于当前会话');
        } else {
          setError(grillErrorMessage(code, `${actionName}失败`));
        }
      } finally {
        setIsLoading(false);
      }
    },
    [projectId, sessionId, session, isLoading, refresh, onVersionConflict],
  );

  const startSession = useCallback(
    () => handleMutation((input) => window.desktop.grill.startSession(input), '启动'),
    [handleMutation],
  );

  const pauseSession = useCallback(
    () => handleMutation((input) => window.desktop.grill.pauseSession(input), '暂停'),
    [handleMutation],
  );

  const resumeSession = useCallback(
    () => handleMutation((input) => window.desktop.grill.resumeSession(input), '恢复'),
    [handleMutation],
  );

  const completeSession = useCallback(
    () => handleMutation((input) => window.desktop.grill.completeSession(input), '完成'),
    [handleMutation],
  );

  const abandonSession = useCallback(
    () => handleMutation((input) => window.desktop.grill.abandonSession(input), '放弃'),
    [handleMutation],
  );

  const clearError = useCallback(() => {
    setError(null);
    setVersionConflict(false);
  }, []);

  return {
    session,
    isLoading,
    error,
    versionConflict,
    startSession,
    pauseSession,
    resumeSession,
    completeSession,
    abandonSession,
    refresh,
    clearError,
  };
}
