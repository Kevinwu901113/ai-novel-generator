/**
 * Grill 问题规划 hook。
 *
 * 管理问题规划的完整工作流：
 * - 请求问题规划 → 获得 taskId
 * - 任务轮询（PENDING/RUNNING/SUCCEEDED/FAILED/CANCELLED/STALE）
 * - 提案加载与展示
 * - 显式接受提案
 * - 竞态失效（generation token）
 *
 * 设计原则：
 * - 不自动接受，用户必须显式点击
 * - 使用 generation token 防止旧响应覆盖新界面
 * - polling 使用 useRef 管理 timer，unmount/切换时清理
 * - 页面 hidden 时暂停轮询，visible 时立即刷新
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GrillQuestionPlanProposalPublicData, TaskPublicData } from '@ai-novel/contracts';
import { grillErrorMessage } from './status-labels';
import { toSafeUserError } from '../safety/safe-error';

/** 任务终态集合 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'STALE',
]);

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 2000;

/** hook 返回值接口 */
interface UseGrillQuestionPlanResult {
  /** 当前任务状态（仅显示当前问题计划任务） */
  task: TaskPublicData | null;
  /** 当前任务是否正在轮询 */
  isPolling: boolean;
  /** 请求问题规划（返回 taskId） */
  requestPlan: () => Promise<void>;
  /** 是否正在请求 */
  isRequesting: boolean;
  /** 问题规划提案列表 */
  proposals: ReadonlyArray<GrillQuestionPlanProposalPublicData>;
  /** 是否正在加载提案 */
  isLoadingProposals: boolean;
  /** 接受提案 */
  acceptProposal: (proposalId: string) => Promise<boolean>;
  /** 是否正在接受 */
  isAccepting: boolean;
  /** 安全错误消息 */
  error: string | null;
  /** 清除错误 */
  clearError: () => void;
  /** 手动刷新提案列表 */
  refreshProposals: () => Promise<void>;
}

/**
 * 问题规划 hook。
 *
 * @param projectId 当前项目 ID
 * @param sessionId 当前 session ID（null 表示无选中 session）
 * @param currentSessionVersion 当前 session 版本（来自 session hook，用于 expectedSessionVersion）
 * @param onAcceptSuccess 接受成功后的回调（用于刷新 session、questions 等）
 */
export function useGrillQuestionPlan(
  projectId: string | null,
  sessionId: string | null,
  currentSessionVersion: number,
  onAcceptSuccess: () => Promise<void>,
): UseGrillQuestionPlanResult {
  // ── 状态 ──────────────────────────────────────────────────────
  const [task, setTask] = useState<TaskPublicData | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [proposals, setProposals] = useState<ReadonlyArray<GrillQuestionPlanProposalPublicData>>(
    [],
  );
  const [isLoadingProposals, setIsLoadingProposals] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── 竞态失效：generation token ────────────────────────────────
  // 每次 session/project 切换时递增，旧响应的 generation 与当前不匹配时丢弃
  const generationRef = useRef(0);

  // ── 轮询 timer ────────────────────────────────────────────────
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── 请求锁 ────────────────────────────────────────────────────
  const requestLockRef = useRef(false);

  // ── 接受锁 ────────────────────────────────────────────────────
  const acceptLockRef = useRef(false);

  // ── 当前 session 版本 ref（用于轮询回调中获取最新值） ─────────
  const currentSessionVersionRef = useRef(currentSessionVersion);
  currentSessionVersionRef.current = currentSessionVersion;

  // ── onAcceptSuccess ref ───────────────────────────────────────
  const onAcceptSuccessRef = useRef(onAcceptSuccess);
  onAcceptSuccessRef.current = onAcceptSuccess;

  // ── 清理轮询 timer ────────────────────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setIsPolling(false);
  }, []);

  // ── 加载提案列表 ──────────────────────────────────────────────
  const loadProposals = useCallback(
    async (gen: number) => {
      if (!projectId || !sessionId) {
        setProposals([]);
        return;
      }
      setIsLoadingProposals(true);
      try {
        const list = await window.desktop.grill.listQuestionPlanProposals({
          projectId,
          sessionId,
        });
        // 检查 generation 是否仍然有效
        if (gen !== generationRef.current) return;
        setProposals(list);
      } catch {
        if (gen !== generationRef.current) return;
        // 非致命错误，不设置 error
      } finally {
        if (gen === generationRef.current) {
          setIsLoadingProposals(false);
        }
      }
    },
    [projectId, sessionId],
  );

  // ── 获取任务状态 ──────────────────────────────────────────────
  const fetchTask = useCallback(
    async (taskId: string, gen: number): Promise<TaskPublicData | null> => {
      if (!projectId) return null;
      try {
        const t = await window.desktop.tasks.get(projectId, taskId);
        if (gen !== generationRef.current) return null;
        return t;
      } catch {
        if (gen !== generationRef.current) return null;
        const safe = toSafeUserError(undefined, '获取任务状态失败');
        setError(safe.message);
        return null;
      }
    },
    [projectId],
  );

  // ── 处理任务终态 ──────────────────────────────────────────────
  const handleTerminalTask = useCallback(
    async (t: TaskPublicData, gen: number) => {
      setTask(t);
      stopPolling();

      if (t.status === 'SUCCEEDED') {
        // 任务成功，加载提案
        await loadProposals(gen);
      } else if (t.status === 'FAILED') {
        // 显示安全错误
        const safe = toSafeUserError(
          t.errorCode ? { code: t.errorCode } : undefined,
          '问题规划任务失败',
        );
        setError(safe.message);
      } else if (t.status === 'CANCELLED') {
        setError('问题规划任务已取消');
      } else if (t.status === 'STALE') {
        setError('问题规划任务已过期');
      }
    },
    [stopPolling, loadProposals],
  );

  // ── 轮询逻辑 ──────────────────────────────────────────────────
  const startPolling = useCallback(
    (taskId: string, gen: number) => {
      stopPolling();
      setIsPolling(true);

      const poll = async () => {
        if (gen !== generationRef.current) {
          stopPolling();
          return;
        }

        const t = await fetchTask(taskId, gen);
        if (!t || gen !== generationRef.current) return;

        setTask(t);

        if (TERMINAL_TASK_STATUSES.has(t.status)) {
          await handleTerminalTask(t, gen);
        }
      };

      // 立即执行一次
      void poll();

      // 设置轮询 timer
      pollTimerRef.current = setInterval(() => {
        void poll();
      }, POLL_INTERVAL_MS);
    },
    [stopPolling, fetchTask, handleTerminalTask],
  );

  // ── 页面可见性处理 ────────────────────────────────────────────
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // 页面隐藏时暂停轮询
        if (pollTimerRef.current !== null) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } else if (isPolling && task && !TERMINAL_TASK_STATUSES.has(task.status)) {
        // 页面重新可见时，如果正在轮询且任务未完成，立即刷新
        const gen = generationRef.current;
        const taskId = task.id;
        void (async () => {
          const t = await fetchTask(taskId, gen);
          if (!t || gen !== generationRef.current) return;
          setTask(t);
          if (TERMINAL_TASK_STATUSES.has(t.status)) {
            await handleTerminalTask(t, gen);
          } else {
            // 恢复轮询
            startPolling(taskId, gen);
          }
        })();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isPolling, task, fetchTask, handleTerminalTask, startPolling]);

  // ── session/project 切换时重置 ────────────────────────────────
  useEffect(() => {
    // 递增 generation，使所有旧响应失效
    generationRef.current += 1;
    const gen = generationRef.current;

    // 停止轮询
    stopPolling();

    // 重置状态
    setTask(null);
    setProposals([]);
    setError(null);
    setIsRequesting(false);
    setIsAccepting(false);
    requestLockRef.current = false;
    acceptLockRef.current = false;

    // 如果有 sessionId，加载当前提案（可能已有之前的规划结果）
    if (sessionId && projectId) {
      void loadProposals(gen);
    }
  }, [projectId, sessionId, loadProposals]);

  // ── 组件卸载时清理 ────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  // ── 请求问题规划 ──────────────────────────────────────────────
  const requestPlan = useCallback(async () => {
    if (!projectId || !sessionId) return;
    if (requestLockRef.current) return;

    requestLockRef.current = true;
    setIsRequesting(true);
    setError(null);

    const gen = generationRef.current;

    try {
      const result = await window.desktop.grill.requestQuestionPlan({
        projectId,
        sessionId,
        expectedSessionVersion: currentSessionVersionRef.current,
      });

      // 检查 generation
      if (gen !== generationRef.current) return;

      // 保存 taskId 并开始轮询
      setTask({
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
      });

      startPolling(result.taskId, gen);
    } catch (err) {
      if (gen !== generationRef.current) return;
      const code = (err as Error & { code?: string }).code;
      const safe = toSafeUserError(err, grillErrorMessage(code, '请求问题规划失败'));
      setError(safe.message);
    } finally {
      if (gen === generationRef.current) {
        requestLockRef.current = false;
        setIsRequesting(false);
      }
    }
  }, [projectId, sessionId, startPolling]);

  // ── 接受提案 ──────────────────────────────────────────────────
  const acceptProposal = useCallback(
    async (proposalId: string): Promise<boolean> => {
      if (!projectId || !sessionId) return false;
      if (acceptLockRef.current) return false;

      acceptLockRef.current = true;
      setIsAccepting(true);
      setError(null);

      const gen = generationRef.current;

      try {
        await window.desktop.grill.acceptQuestionPlanProposal({
          projectId,
          sessionId,
          proposalId,
          expectedSessionVersion: currentSessionVersionRef.current,
        });

        // 检查 generation
        if (gen !== generationRef.current) return false;

        // 接受成功，刷新提案列表
        await loadProposals(gen);

        // 通知外部刷新（session、questions 等）
        await onAcceptSuccessRef.current();

        return true;
      } catch (err) {
        if (gen !== generationRef.current) return false;
        const code = (err as Error & { code?: string }).code;
        const safe = toSafeUserError(err, grillErrorMessage(code, '接受问题规划提案失败'));
        setError(safe.message);
        return false;
      } finally {
        if (gen === generationRef.current) {
          acceptLockRef.current = false;
          setIsAccepting(false);
        }
      }
    },
    [projectId, sessionId, loadProposals],
  );

  // ── 手动刷新提案 ──────────────────────────────────────────────
  const refreshProposals = useCallback(async () => {
    await loadProposals(generationRef.current);
  }, [loadProposals]);

  // ── 清除错误 ──────────────────────────────────────────────────
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    task,
    isPolling,
    requestPlan,
    isRequesting,
    proposals,
    isLoadingProposals,
    acceptProposal,
    isAccepting,
    error,
    clearError,
    refreshProposals,
  };
}
