/**
 * 任务活动中心核心 Hook。
 *
 * 管理任务列表、统计、选中状态、筛选、轮询和竞态防护。
 *
 * 关键设计：
 * - generationRef：每次 projectId 切换递增，过期响应丢弃
 * - refreshLockRef：防止并发刷新
 * - visibility-aware 轮询：页面 hidden 时暂停，visible 时立即刷新
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskPublicData, TaskStatsPublicData } from '@ai-novel/contracts';
import { isTaskActive } from './task-labels';

const POLL_INTERVAL_MS = 2000;

interface UseTaskCenterReturn {
  tasks: ReadonlyArray<TaskPublicData>;
  filteredTasks: ReadonlyArray<TaskPublicData>;
  stats: TaskStatsPublicData | null;
  selectedTask: TaskPublicData | null;
  statusFilter: string;
  typeFilter: string;
  isLoading: boolean;
  error: string | null;
  statsError: string | null;
  setStatusFilter: (s: string) => void;
  setTypeFilter: (t: string) => void;
  selectTask: (taskId: string | null) => void;
  refresh: () => void;
}

export function useTaskCenter(projectId: string | null): UseTaskCenterReturn {
  const [tasks, setTasks] = useState<ReadonlyArray<TaskPublicData>>([]);
  const [stats, setStats] = useState<TaskStatsPublicData | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  // 竞态防护：每次 projectId 变化递增
  const generationRef = useRef(0);
  // 防止并发刷新
  const refreshLockRef = useRef(false);
  // 轮询 timer
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 当前 AbortController
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * 核心刷新函数。
   * 手动刷新与轮询共用此函数和 refreshLockRef。
   */
  const refresh = useCallback(async () => {
    if (!projectId) return;
    if (refreshLockRef.current) return;
    refreshLockRef.current = true;

    const gen = generationRef.current;
    const controller = new AbortController();
    abortControllerRef.current?.abort();
    abortControllerRef.current = controller;

    try {
      setIsLoading(true);
      setError(null);

      const [listResult, statsResult] = await Promise.allSettled([
        window.desktop.tasks.list(projectId),
        window.desktop.tasks.getStats(projectId),
      ]);

      // 检查 generation 是否过期
      if (generationRef.current !== gen) return;
      if (controller.signal.aborted) return;

      if (listResult.status === 'fulfilled') {
        setTasks(listResult.value);
        setError(null);
      } else {
        const err = listResult.reason;
        const msg = err instanceof Error ? err.message : '加载任务列表失败';
        setError(msg);
      }

      if (statsResult.status === 'fulfilled') {
        setStats(statsResult.value);
        setStatsError(null);
      } else {
        const err = statsResult.reason;
        const msg = err instanceof Error ? err.message : '加载统计失败';
        setStatsError(msg);
        // stats 失败不清空已有 stats
      }
    } finally {
      if (generationRef.current === gen) {
        setIsLoading(false);
      }
      refreshLockRef.current = false;
    }
  }, [projectId]);

  /**
   * 判断是否需要轮询。
   */
  const hasActiveTasks = useMemo(() => tasks.some((t) => isTaskActive(t.status)), [tasks]);

  /**
   * 启动/停止轮询。
   */
  useEffect(() => {
    // 清除旧轮询
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    if (!projectId || !hasActiveTasks) return;

    // 页面不可见时不启动高频轮询
    if (document.hidden) return;

    pollTimerRef.current = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [projectId, hasActiveTasks, refresh]);

  /**
   * visibilitychange 处理。
   * hidden → 暂停轮询
   * visible → 立即刷新 + 恢复轮询
   */
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } else {
        // 页面恢复可见时立即刷新
        if (projectId) {
          void refresh();
        }
        // 轮询将由上面的 effect 根据 hasActiveTasks 自动恢复
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [projectId, refresh]);

  /**
   * projectId 切换时：清空旧数据，停止旧轮询，递增 generation。
   */
  useEffect(() => {
    generationRef.current += 1;
    abortControllerRef.current?.abort();
    refreshLockRef.current = false;

    setTasks([]);
    setStats(null);
    setSelectedTaskId(null);
    setError(null);
    setStatsError(null);
    setIsLoading(false);

    if (projectId) {
      void refresh();
    }

    return () => {
      generationRef.current += 1;
      abortControllerRef.current?.abort();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [projectId]); // refresh is intentionally stable per projectId

  /**
   * 筛选后的任务列表。
   */
  const filteredTasks = useMemo(() => {
    let filtered = tasks;
    if (statusFilter !== 'ALL') {
      filtered = filtered.filter((t) => t.status === statusFilter);
    }
    if (typeFilter !== 'ALL') {
      filtered = filtered.filter((t) => t.taskType === typeFilter);
    }
    // 排序：createdAt 降序，相同 createdAt 按 id 稳定排序
    return [...filtered].sort((a, b) => {
      const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [tasks, statusFilter, typeFilter]);

  /**
   * 选中任务。
   * 列表更新时保留仍然存在的选中任务，清除不存在的。
   */
  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    return tasks.find((t) => t.id === selectedTaskId) ?? null;
  }, [tasks, selectedTaskId]);

  // 选中任务消失时清除
  useEffect(() => {
    if (selectedTaskId && !selectedTask) {
      setSelectedTaskId(null);
    }
  }, [selectedTaskId, selectedTask]);

  const selectTask = useCallback((taskId: string | null) => {
    setSelectedTaskId(taskId);
  }, []);

  return {
    tasks,
    filteredTasks,
    stats,
    selectedTask,
    statusFilter,
    typeFilter,
    isLoading,
    error,
    statsError,
    setStatusFilter,
    setTypeFilter,
    selectTask,
    refresh,
  };
}
