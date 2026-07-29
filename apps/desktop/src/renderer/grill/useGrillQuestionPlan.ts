/**
 * useGrillQuestionPlan — 问题规划 hook。
 *
 * 职责：
 * - 请求问题规划（requestQuestionPlan）
 * - 任务轮询（recursive setTimeout，single-flight）
 * - 加载问题规划提案（listQuestionPlanProposals）
 * - 接受问题规划提案（acceptQuestionPlanProposal）
 * - 竞态失效（generation token + proposal request sequence）
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
function terminalTaskError(status: string, errorCode: string | null): string | null {
  switch (status) {
    case 'FAILED':
      return errorCode ? (ERROR_CODE_LABELS[errorCode] ?? '任务执行失败') : '任务执行失败';
    case 'CANCELLED':
      return '问题规划任务已取消';
    case 'STALE':
      return '问题规划任务已过期';
    default:
      return null;
  }
}

interface UseGrillQuestionPlanResult {
  /** 当前任务 */
  readonly task: TaskPublicData | null;
  /** 是否正在轮询 */
  readonly isPolling: boolean;
  /** 请求问题规划 */
  readonly requestPlan: () => Promise<void>;
  /** 是否正在请求 */
  readonly isRequesting: boolean;
  /** 问题规划提案列表 */
  readonly proposals: ReadonlyArray<GrillQuestionPlanProposalPublicData>;
  /** 是否正在加载提案 */
  readonly isLoadingProposals: boolean;
  /** 接受提案 */
  readonly acceptProposal: (proposalId: string) => Promise<boolean>;
  /** 是否正在接受 */
  readonly isAccepting: boolean;
  /** 刷新提案列表 */
  readonly refreshProposals: () => Promise<void>;
  /** 错误消息 */
  readonly error: string | null;
  /** 清除错误 */
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
  /** generation token：每次 session/project 切换递增 */
  const generationRef = useRef(0);
  /** 当前轮询 loop generation（用于 recursive setTimeout） */
  const pollLoopGenRef = useRef(0);
  /** 当前轮询 timer ID */
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** terminal latch：终态一旦应用，不再接受后续响应 */
  const terminalLatchRef = useRef(false);
  /** request/accept 锁 */
  const requestLockRef = useRef(false);
  const acceptLockRef = useRef(false);
  /** 最新 session version（ref 供异步回调使用） */
  const currentSessionVersionRef = useRef(currentSessionVersion);
  currentSessionVersionRef.current = currentSessionVersion;
  /** 最新 onAcceptSuccess callback */
  const onAcceptSuccessRef = useRef(onAcceptSuccess);
  onAcceptSuccessRef.current = onAcceptSuccess;
  /** proposal request sequence：只允许最新请求写入 */
  const proposalRequestSeqRef = useRef(0);

  // ── 计数器 ref（重置相关） ─────────────────────────────────────────
  const taskRef = useRef<TaskPublicData | null>(null);
  taskRef.current = task;

  // ── 加载提案 ref（供轮询回调使用） ────────────────────────────────
  const loadProposalsRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // ── 清理轮询 ──────────────────────────────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollLoopGenRef.current += 1;
    setIsPolling(false);
  }, []);

  // ── 加载提案 ──────────────────────────────────────────────────────
  const loadProposals = useCallback(async () => {
    if (!sessionId || !projectId) return;

    const gen = generationRef.current;
    const seq = ++proposalRequestSeqRef.current;
    setIsLoadingProposals(true);

    try {
      const list = await window.desktop.grill.listQuestionPlanProposals({ projectId, sessionId });

      // 只有最新 request 可以写入
      if (gen !== generationRef.current || seq !== proposalRequestSeqRef.current) {
        return;
      }

      setProposals(list);
    } catch {
      // 非关键错误，不设置 error
    } finally {
      if (gen === generationRef.current && seq === proposalRequestSeqRef.current) {
        setIsLoadingProposals(false);
      }
    }
  }, [projectId, sessionId]);

  // 保持 loadProposals ref 最新
  loadProposalsRef.current = loadProposals;

  // ── 开始轮询（recursive setTimeout，single-flight） ─────────────
  const startPolling = useCallback(
    (gen: number) => {
      stopPolling();
      terminalLatchRef.current = false;
      const loopGen = ++pollLoopGenRef.current;
      setIsPolling(true);

      // poll 函数：同步调度，不使用 async/await
      const poll = () => {
        if (loopGen !== pollLoopGenRef.current || gen !== generationRef.current) {
          return;
        }

        const currentTask = taskRef.current;
        if (!currentTask || terminalLatchRef.current) {
          return;
        }

        Promise.resolve(window.desktop.tasks.get(currentTask.projectId, currentTask.id))
          .then((updated) => {
            // 再次检查 loop 和 generation
            if (loopGen !== pollLoopGenRef.current || gen !== generationRef.current) {
              return;
            }

            setTask(updated);

            if (TERMINAL_TASK_STATUSES.has(updated.status)) {
              terminalLatchRef.current = true;
              stopPolling();

              if (updated.status === 'SUCCEEDED') {
                void loadProposalsRef.current();
              } else {
                const errMsg = terminalTaskError(updated.status, updated.errorCode);
                if (errMsg) setError(errMsg);
              }
              return;
            }

            // 非终态：安排下一次 poll
            pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
          })
          .catch(() => {
            // 单次 poll 失败不停止轮询
            if (loopGen === pollLoopGenRef.current && gen === generationRef.current) {
              pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
            }
          });
      };

      // 首次立即 poll
      pollTimerRef.current = setTimeout(poll, 0);
    },
    [stopPolling],
  );

  // ── 请求问题规划 ──────────────────────────────────────────────────
  const requestPlan = useCallback(async () => {
    if (!projectId || !sessionId) return;
    if (requestLockRef.current) return;

    requestLockRef.current = true;
    setIsRequesting(true);
    setError(null);

    try {
      const result = await window.desktop.grill.requestQuestionPlan({
        projectId,
        sessionId,
        expectedSessionVersion: currentSessionVersionRef.current,
      });

      // generation 检查
      if (result.sessionId !== sessionId) {
        return;
      }

      // 创建临时 task
      const newTask: TaskPublicData = {
        id: result.taskId,
        projectId: projectId,
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
      startPolling(generationRef.current);
    } catch (err) {
      setError(toSafeUserError(err, SAFE_ERROR_FALLBACK).message);
    } finally {
      requestLockRef.current = false;
      setIsRequesting(false);
    }
  }, [projectId, sessionId, startPolling]);

  // ── 接受提案 ──────────────────────────────────────────────────────
  const acceptProposal = useCallback(
    async (proposalId: string): Promise<boolean> => {
      if (!projectId || !sessionId) return false;
      if (acceptLockRef.current) return false;

      const gen = generationRef.current;
      acceptLockRef.current = true;
      setIsAccepting(true);
      setError(null);

      try {
        await window.desktop.grill.acceptQuestionPlanProposal({
          projectId,
          sessionId,
          proposalId,
          expectedSessionVersion: currentSessionVersionRef.current,
        });

        // generation 检查
        if (gen !== generationRef.current) return false;

        // 刷新后检查
        await onAcceptSuccessRef.current();
        if (gen !== generationRef.current) return false;

        // 刷新提案
        await loadProposalsRef.current();
        if (gen !== generationRef.current) return false;

        return true;
      } catch (err) {
        if (gen !== generationRef.current) return false;
        setError(toSafeUserError(err, SAFE_ERROR_FALLBACK).message);
        return false;
      } finally {
        if (gen === generationRef.current) {
          setIsAccepting(false);
        }
        acceptLockRef.current = false;
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
    requestLockRef.current = false;
    acceptLockRef.current = false;
    proposalRequestSeqRef.current = 0;
  }, [sessionId, projectId, stopPolling]);

  // ── 页面可见性管理 ────────────────────────────────────────────────
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        // hidden：取消下一次 timer
        if (pollTimerRef.current !== null) {
          clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } else if (isPolling && !terminalLatchRef.current) {
        // visible：触发一次即时 poll
        const loopGen = pollLoopGenRef.current;
        const gen = generationRef.current;

        pollTimerRef.current = setTimeout(() => {
          if (loopGen !== pollLoopGenRef.current || gen !== generationRef.current) {
            return;
          }
          const currentTask = taskRef.current;
          if (!currentTask || terminalLatchRef.current) return;

          Promise.resolve(window.desktop.tasks.get(currentTask.projectId, currentTask.id))
            .then((updated) => {
              if (loopGen !== pollLoopGenRef.current || gen !== generationRef.current) return;
              setTask(updated);
              if (TERMINAL_TASK_STATUSES.has(updated.status)) {
                terminalLatchRef.current = true;
                stopPolling();
                if (updated.status === 'SUCCEEDED') {
                  void loadProposalsRef.current();
                } else {
                  const errMsg = terminalTaskError(updated.status, updated.errorCode);
                  if (errMsg) setError(errMsg);
                }
              } else {
                // 恢复正常 polling loop
                pollTimerRef.current = setTimeout(() => {
                  if (loopGen === pollLoopGenRef.current && gen === generationRef.current) {
                    startPolling(gen);
                  }
                }, POLL_INTERVAL_MS);
              }
            })
            .catch(() => {
              /* ignore */
            });
        }, 0);
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isPolling, stopPolling, startPolling]);

  // ── unmount 清理 ──────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  // ── clearError ────────────────────────────────────────────────────
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
