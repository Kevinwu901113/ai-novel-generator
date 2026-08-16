/**
 * useGrillQuestionPlan — 问题规划 hook。
 *
 * 职责：
 * - 请求问题规划（requestQuestionPlan）
 * - 任务轮询（unified polling controller，operation-token single-flight）
 * - 加载问题规划提案（listQuestionPlanProposals）
 * - 接受问题规划提案（acceptQuestionPlanProposal，immutable accept context）
 * - 竞态失效（generation token + operation-owned locks）
 * - 页面可见性管理（hidden 暂停，真实 hidden→visible transition 恢复）
 * - 安全错误（toSafeUserError）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskPublicData, GrillQuestionPlanProposalPublicData } from '@ai-novel/contracts';
import { toSafeUserError } from '../safety/safe-error';
import { formatFailedTaskLabel } from './status-labels';

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
    case 'FAILED':
      return formatFailedTaskLabel(errorCode);
    case 'CANCELLED':
      return '问题规划任务已取消';
    case 'STALE':
      return '问题规划任务已过期';
    default:
      return '任务已完成';
  }
}

/** 每次 tasks.get 的唯一 operation token */
interface PollOperation {
  readonly sequence: number;
  readonly generation: number;
  readonly loopGeneration: number;
  readonly projectId: string;
  readonly taskId: string;
}

/** request/accept 的 operation token */
interface MutationOperation {
  readonly generation: number;
  readonly projectId: string;
  readonly sessionId: string;
}

/** 接受操作的不可变 context，传给 onAcceptSuccess */
export interface GrillPlanAcceptContext {
  readonly generation: number;
  readonly projectId: string;
  readonly sessionId: string;
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
  onAcceptSuccess: (context: GrillPlanAcceptContext) => Promise<boolean>,
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
  const pollSequenceRef = useRef(0);
  const activePollRef = useRef<PollOperation | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // terminal latch 归属于当前 loop：仅当记录的 loopGeneration 等于当前值时生效
  const terminalLatchLoopRef = useRef(-1);
  const resumeRequestedRef = useRef(false);
  const isPollingRef = useRef(false);
  const previousHiddenRef = useRef(typeof document !== 'undefined' ? document.hidden : false);
  const requestOpRef = useRef<MutationOperation | null>(null);
  const acceptOpRef = useRef<MutationOperation | null>(null);
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

  const isTerminalLatched = useCallback(
    () => terminalLatchLoopRef.current === pollLoopGenRef.current,
    [],
  );

  const setPollingState = useCallback((value: boolean) => {
    isPollingRef.current = value;
    setIsPolling(value);
  }, []);

  // ── 停止轮询：使当前 operation token 失效，不依赖旧 promise 结算 ──
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollLoopGenRef.current += 1;
    activePollRef.current = null;
    resumeRequestedRef.current = false;
    setPollingState(false);
  }, [setPollingState]);

  // ── 统一 polling controller ────────────────────────────────────────
  const requestPollNow = useCallback(() => {
    if (isTerminalLatched()) return;
    // hidden 时不得启动 tasks.get，也不得安排 timer
    if (document.hidden) return;
    if (activePollRef.current !== null) {
      // 在途请求返回后最多补一次
      resumeRequestedRef.current = true;
      return;
    }

    const currentTask = taskRef.current;
    if (!currentTask) return;

    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    const token: PollOperation = {
      sequence: ++pollSequenceRef.current,
      generation: generationRef.current,
      loopGeneration: pollLoopGenRef.current,
      projectId: currentTask.projectId,
      taskId: currentTask.id,
    };
    activePollRef.current = token;
    resumeRequestedRef.current = false;

    // 只有该 token 的 owner 可以清除 active poll、应用响应、安排 timer
    const owns = () =>
      activePollRef.current === token &&
      token.loopGeneration === pollLoopGenRef.current &&
      token.generation === generationRef.current;

    Promise.resolve(window.desktop.tasks.get(token.projectId, token.taskId))
      .then((updated) => {
        if (!owns()) return;
        activePollRef.current = null;

        setTask(updated);

        if (TERMINAL_TASK_STATUSES.has(updated.status)) {
          terminalLatchLoopRef.current = pollLoopGenRef.current;
          if (pollTimerRef.current !== null) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          resumeRequestedRef.current = false;
          setPollingState(false);
          if (updated.status === 'SUCCEEDED') {
            void loadProposalsRef.current();
          } else {
            setError(terminalTaskError(updated.status, updated.errorCode));
          }
          return;
        }

        // 非终态且页面 hidden：不安排下一次 timer，等待真实 visible transition
        if (document.hidden) {
          resumeRequestedRef.current = false;
          return;
        }

        pollTimerRef.current = setTimeout(() => {
          requestPollNowRef.current();
        }, POLL_INTERVAL_MS);

        // 在途请求返回后，如果 resume 被请求且页面可见，补一次
        if (resumeRequestedRef.current && !isTerminalLatched()) {
          resumeRequestedRef.current = false;
          requestPollNowRef.current();
        }
      })
      .catch(() => {
        if (!owns()) return;
        activePollRef.current = null;
        if (isTerminalLatched()) return;
        // hidden 时不安排 retry timer
        if (document.hidden) return;
        pollTimerRef.current = setTimeout(() => {
          requestPollNowRef.current();
        }, POLL_INTERVAL_MS);
      });
  }, [isTerminalLatched, setPollingState]);

  requestPollNowRef.current = requestPollNow;

  // ── 开始轮询 ──────────────────────────────────────────────────────
  const startPolling = useCallback(() => {
    stopPolling();
    setPollingState(true);

    // hidden 时不安排 timer；真实 visible transition 时恢复
    if (!document.hidden) {
      pollTimerRef.current = setTimeout(() => {
        requestPollNowRef.current();
      }, 0);
    }
  }, [stopPolling, setPollingState]);

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
    const op: MutationOperation = { generation: gen, projectId, sessionId };
    requestOpRef.current = op;
    setIsRequesting(true);
    setError(null);

    const owns = () => requestOpRef.current === op && gen === generationRef.current;

    try {
      const result = await window.desktop.grill.requestQuestionPlan({
        projectId,
        sessionId,
        expectedSessionVersion: currentSessionVersionRef.current,
      });

      if (!owns()) return;

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
      taskRef.current = newTask;
      startPolling();
    } catch (err) {
      if (!owns()) return;
      setError(toSafeUserError(err, SAFE_ERROR_FALLBACK).message);
    } finally {
      // 只有 owner 可以释放 busy/lock；旧 operation 结算不得释放新 operation
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
      const op: MutationOperation = { generation: gen, projectId, sessionId };
      acceptOpRef.current = op;
      setIsAccepting(true);
      setError(null);

      // accept 开始时捕获不可变 context、回调实例与绑定旧 session 的 loader
      const context: GrillPlanAcceptContext = { generation: gen, projectId, sessionId };
      const onAcceptSuccessAtStart = onAcceptSuccessRef.current;
      const boundLoadProposals = loadProposals;
      const owns = () => acceptOpRef.current === op && gen === generationRef.current;

      try {
        await window.desktop.grill.acceptQuestionPlanProposal({
          projectId,
          sessionId,
          proposalId,
          expectedSessionVersion: currentSessionVersionRef.current,
        });

        if (!owns()) return false;

        const contextStillValid = await onAcceptSuccessAtStart(context);
        if (!owns()) return false;
        if (!contextStillValid) return false;

        await boundLoadProposals();
        if (!owns()) return false;

        return true;
      } catch (err) {
        if (!owns()) return false;
        setError(toSafeUserError(err, SAFE_ERROR_FALLBACK).message);
        return false;
      } finally {
        // 只有 owner 可以释放 busy/lock；旧 operation 结算不得释放新 operation
        if (acceptOpRef.current === op) {
          acceptOpRef.current = null;
          setIsAccepting(false);
        }
      }
    },
    [projectId, sessionId, loadProposals],
  );

  // ── session/project 切换重置 ──────────────────────────────────────
  useEffect(() => {
    generationRef.current += 1;
    stopPolling();
    setTask(null);
    setProposals([]);
    setError(null);
    setIsRequesting(false);
    setIsLoadingProposals(false);
    setIsAccepting(false);
    requestOpRef.current = null;
    acceptOpRef.current = null;
    proposalRequestSeqRef.current = 0;
  }, [sessionId, projectId, stopPolling]);

  // ── 页面可见性管理：只在真实 hidden→visible transition 时恢复 ────
  useEffect(() => {
    const handleVisibility = () => {
      const wasHidden = previousHiddenRef.current;
      const nowHidden = document.hidden;
      previousHiddenRef.current = nowHidden;

      if (nowHidden) {
        // 进入 hidden：取消已安排的 timer；在途请求允许自然结算
        if (pollTimerRef.current !== null) {
          clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        return;
      }

      // 页面已经 visible 时的重复事件：不 poll、不设置 resume、不安排 timer
      if (!wasHidden) return;
      if (!isPollingRef.current) return;
      if (isTerminalLatched()) return;
      requestPollNowRef.current();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isTerminalLatched]);

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
