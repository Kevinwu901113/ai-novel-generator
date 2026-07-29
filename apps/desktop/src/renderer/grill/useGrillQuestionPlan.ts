/**
 * useGrillQuestionPlan — 问题规划 hook。
 *
 * 职责：
 * - 请求问题规划（requestQuestionPlan）
 * - 任务轮询（unified polling controller，single-flight）
 * - 加载问题规划提案（listQuestionPlanProposals）
 * - 接受问题规划提案（acceptQuestionPlanProposal）
 * - 竞态失效（generation token + operation-owned locks）
 * - 页面可见性管理（hidden 暂停，visible 立即恢复）
 * - 安全错误（toSafeUserError）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskPublicData, GrillQuestionPlanProposalPublicData } from '@ai-novel/contracts';
import { toSafeUserError } from '../safety/safe-error';
import { ERROR_CODE_LABELS } from '../safety/error-code-labels';

/** 安全错误回退消息 */
const SAFE_ERROR_FALLBACK = '操作失败，请稍后重试';

/** 任务终态 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'STALE',
]);

/** 轮询间隔 (ms) */
const POLL_INTERVAL_MS = 2000;

/** 任务终态错误消息映射 */
function terminalTaskError(status: string, errorCode: string | null): string {
  switch (status) {
    case 'FAILED': {
      const label = errorCode ? (ERROR_CODE_LABELS[errorCode] ?? '任务执行失败') : '任务执行失败';
      return errorCode ? `${label}（${errorCode}）` : label;
    }
    case 'CANCELLED':
      return '问题规划任务已取消';
    case 'STALE':
      return '问题规划任务已过期';
    default:
      return '任务已完成';
  }
}

interface UseGrillQuestionPlanResult {
  readonly task: TaskPublicData | null;
  readonly isPolling: boolean;
  readonly requestPlan: () => Promise<void>;
  readonly isRequesting: boolean;
  readonly proposals: ReadonlyArray<GrillQuestionPlanProposalPublicData>;
  readonly isLoadingProposals: boolean;
  readonly acceptProposal: (proposalId: string) => Promise<boolean>;
  readonly isAccepting: boolean;
  readonly refreshProposals: () => Promise<void>;
  readonly error: string | null;
  readonly clearError: () => void;
}

export function useGrillQuestionPlan(
  projectId: string | null,
  sessionId: string | null,
  currentSessionVersion: number,
  onAcceptSuccess: () => Promise<void>,
): UseGrillQuestionPlanResult {
  // ── 状态 ──────────────────────────────────────────────────────────
  const [task, setTask] = useState<TaskPublicData | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [proposals, setProposals] = useState<ReadonlyArray<GrillQuestionPlanProposalPublicData>>(
    [],
  );
  const [isLoadingProposals, setIsLoadingProposals] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── refs ────────────────────────────────────────────────────────────
  const generationRef = useRef(0);
  const pollLoopGenRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalLatchRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const resumeRequestedRef = useRef(false);
  const requestOpRef = useRef<{ gen: number } | null>(null);
  const acceptOpRef = useRef<{ gen: number } | null>(null);
  const currentSessionVersionRef = useRef(currentSessionVersion);
  currentSessionVersionRef.current = currentSessionVersion;
  const onAcceptSuccessRef = useRef(onAcceptSuccess);
  onAcceptSuccessRef.current = onAcceptSuccess;
  const proposalRequestSeqRef = useRef(0);
  const taskRef = useRef<TaskPublicData | null>(null);
  taskRef.current = task;
  const loadProposalsRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // ── requestPollNow ref（解决循环引用） ────────────────────────────
  const requestPollNowRef = useRef<() => void>(() => {});

  // ── 停止轮询 ──────────────────────────────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollLoopGenRef.current += 1;
    pollInFlightRef.current = false;
    resumeRequestedRef.current = false;
    setIsPolling(false);
  }, []);

  // ── 统一 polling controller ────────────────────────────────────────
  const requestPollNow = useCallback(() => {
    const loopGen = pollLoopGenRef.current;
    const gen = generationRef.current;

    if (loopGen !== pollLoopGenRef.current || gen !== generationRef.current) return;
    if (terminalLatchRef.current) return;
    if (pollInFlightRef.current) {
      resumeRequestedRef.current = true;
      return;
    }

    const currentTask = taskRef.current;
    if (!currentTask) return;

    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    pollInFlightRef.current = true;
    resumeRequestedRef.current = false;

    Promise.resolve(window.desktop.tasks.get(currentTask.projectId, currentTask.id))
      .then((updated) => {
        pollInFlightRef.current = false;

        if (loopGen !== pollLoopGenRef.current || gen !== generationRef.current) return;

        setTask(updated);

        if (TERMINAL_TASK_STATUSES.has(updated.status)) {
          terminalLatchRef.current = true;
          if (pollTimerRef.current !== null) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          pollLoopGenRef.current += 1;
          setIsPolling(false);
          if (updated.status === 'SUCCEEDED') {
            void loadProposalsRef.current();
          } else {
            setError(terminalTaskError(updated.status, updated.errorCode));
          }
          return;
        }

        // 非终态：安排下一次 poll
        pollTimerRef.current = setTimeout(() => {
          requestPollNowRef.current();
        }, POLL_INTERVAL_MS);

        // 在途请求返回后，如果 resume 被请求且页面可见，补一次
        if (
          resumeRequestedRef.current &&
          !terminalLatchRef.current &&
          loopGen === pollLoopGenRef.current &&
          gen === generationRef.current &&
          !document.hidden
        ) {
          resumeRequestedRef.current = false;
          requestPollNowRef.current();
        }
      })
      .catch(() => {
        pollInFlightRef.current = false;
        if (loopGen === pollLoopGenRef.current && gen === generationRef.current) {
          pollTimerRef.current = setTimeout(() => {
            requestPollNowRef.current();
          }, POLL_INTERVAL_MS);
        }
      });
  }, []);

  requestPollNowRef.current = requestPollNow;

  // ── 开始轮询 ──────────────────────────────────────────────────────
  const startPolling = useCallback(
    (_gen: number) => {
      stopPolling();
      terminalLatchRef.current = false;
      pollLoopGenRef.current += 1;
      setIsPolling(true);

      pollTimerRef.current = setTimeout(() => {
        requestPollNowRef.current();
      }, 0);
    },
    [stopPolling],
  );

  // ── 加载提案 ──────────────────────────────────────────────────────
  const loadProposals = useCallback(async () => {
    if (!sessionId || !projectId) return;

    const gen = generationRef.current;
    const seq = ++proposalRequestSeqRef.current;
    setIsLoadingProposals(true);

    try {
      const list = await window.desktop.grill.listQuestionPlanProposals({ projectId, sessionId });
      if (gen !== generationRef.current || seq !== proposalRequestSeqRef.current) return;
      setProposals(list);
    } catch {
      // 非关键错误
    } finally {
      if (gen === generationRef.current && seq === proposalRequestSeqRef.current) {
        setIsLoadingProposals(false);
      }
    }
  }, [projectId, sessionId]);

  loadProposalsRef.current = loadProposals;

  // ── 请求问题规划 ──────────────────────────────────────────────────
  const requestPlan = useCallback(async () => {
    if (!projectId || !sessionId) return;
    if (requestOpRef.current) return;

    const gen = generationRef.current;
    const op = { gen };
    requestOpRef.current = op;
    setIsRequesting(true);
    setError(null);

    try {
      const result = await window.desktop.grill.requestQuestionPlan({
        projectId,
        sessionId,
        expectedSessionVersion: currentSessionVersionRef.current,
      });

      if (requestOpRef.current !== op) return;
      if (gen !== generationRef.current) return;

      const newTask: TaskPublicData = {
        id: result.taskId,
        projectId,
        taskType: 'GRILL_QUESTION_PLAN',
        status: 'PENDING',
        attemptCount: 0,
        result: null,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      };

      setTask(newTask);
      terminalLatchRef.current = false;
      startPolling(gen);
    } catch (err) {
      if (requestOpRef.current !== op) return;
      if (gen !== generationRef.current) return;
      setError(toSafeUserError(err, SAFE_ERROR_FALLBACK).message);
    } finally {
      if (requestOpRef.current === op) {
        requestOpRef.current = null;
        setIsRequesting(false);
      }
    }
  }, [projectId, sessionId, startPolling]);

  // ── 接受提案 ──────────────────────────────────────────────────────
  const acceptProposal = useCallback(
    async (proposalId: string): Promise<boolean> => {
      if (!projectId || !sessionId) return false;
      if (acceptOpRef.current) return false;

      const gen = generationRef.current;
      const op = { gen };
      acceptOpRef.current = op;
      setIsAccepting(true);
      setError(null);

      try {
        await window.desktop.grill.acceptQuestionPlanProposal({
          projectId,
          sessionId,
          proposalId,
          expectedSessionVersion: currentSessionVersionRef.current,
        });

        if (acceptOpRef.current !== op) return false;
        if (gen !== generationRef.current) return false;

        await onAcceptSuccessRef.current();
        if (acceptOpRef.current !== op) return false;
        if (gen !== generationRef.current) return false;

        await loadProposalsRef.current();
        if (acceptOpRef.current !== op) return false;
        if (gen !== generationRef.current) return false;

        return true;
      } catch (err) {
        if (acceptOpRef.current !== op) return false;
        if (gen !== generationRef.current) return false;
        setError(toSafeUserError(err, SAFE_ERROR_FALLBACK).message);
        return false;
      } finally {
        if (acceptOpRef.current === op) {
          acceptOpRef.current = null;
          setIsAccepting(false);
        }
      }
    },
    [projectId, sessionId],
  );

  // ── session/project 切换重置 ──────────────────────────────────────
  useEffect(() => {
    generationRef.current += 1;
    stopPolling();
    setTask(null);
    setProposals([]);
    setError(null);
    setIsPolling(false);
    setIsRequesting(false);
    setIsLoadingProposals(false);
    setIsAccepting(false);
    terminalLatchRef.current = false;
    requestOpRef.current = null;
    acceptOpRef.current = null;
    proposalRequestSeqRef.current = 0;
  }, [sessionId, projectId, stopPolling]);

  // ── 页面可见性管理 ────────────────────────────────────────────────
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        if (pollTimerRef.current !== null) {
          clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } else if (isPolling && !terminalLatchRef.current) {
        requestPollNowRef.current();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isPolling]);

  // ── unmount 清理 ──────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const clearError = useCallback(() => setError(null), []);

  return {
    task,
    isPolling,
    requestPlan,
    isRequesting,
    proposals,
    isLoadingProposals,
    acceptProposal,
    isAccepting,
    refreshProposals: loadProposals,
    error,
    clearError,
  };
}
