/**
 * 任务活动中心核心 Hook。
 *
 * 管理任务列表、统计、选中状态、筛选、轮询和竞态防护。
 *
 * 关键设计：
 * - generationRef：每次 projectId 切换递增，过期响应丢弃
 * - inFlightGenerationRef：generation-scoped 锁，旧 generation 请求不能解除新 generation 的锁
 * - isDocumentVisible：显式可见状态驱动轮询
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskPublicData, TaskStatsPublicData } from '@ai-novel/contracts';
import { isTaskActive } from './task-labels';
import { sanitizeLoadError } from './task-error-message';

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
  const [isDocumentVisible, setIsDocumentVisible] = useState(() => !document.hidden);

  // 竞态防护：每次 projectId 变化递增
  const generationRef = useRef(0);
  // generation-scoped 锁：记录当前持有锁的 generation
  const inFlightGenerationRef = useRef<number | null>(null);
  // 轮询 timer
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * 核心刷新函数。
   * 手动刷新与轮询共用此函数。
   * 使用 generation-scoped 锁：只有当前 generation 可以解除锁。
   */
  const refresh = useCallback(async () => {
    if (!projectId) return;

    const currentGen = generationRef.current;

    // 同一 generation 内禁止并发刷新
    if (inFlightGenerationRef.current === currentGen) return;
    inFlightGenerationRef.current = currentGen;

    try {
      setIsLoading(true);
      setError(null);

      const [listResult, statsResult] = await Promise.allSettled([
        window.desktop.tasks.list(projectId),
        window.desktop.tasks.getStats(projectId),
      ]);

      // generation 过期：丢弃响应，不更新状态
      if (generationRef.current !== currentGen) return;

      if (listResult.status === 'fulfilled') {
        setTasks(listResult.value);
        setError(null);
      } else {
        setError(sanitizeLoadError(listResult.reason, '加载任务列表失败'));
      }

      if (statsResult.status === 'fulfilled') {
        setStats(statsResult.value);
        setStatsError(null);
      } else {
        setStatsError(sanitizeLoadError(statsResult.reason, '加载任务统计失败'));
        // stats 失败不清空已有 stats
      }
    } finally {
      // 只有当 generation 仍匹配时才清除锁
      if (generationRef.current === currentGen) {
        setIsLoading(false);
        inFlightGenerationRef.current = null;
      }
    }
  }, [projectId]);

  /**
   * 判断是否需要轮询。
   */
  const hasActiveTasks = useMemo(() => tasks.some((t) => isTaskActive(t.status)), [tasks]);

  /**
   * visibilitychange 处理。
   * hidden → setIsDocumentVisible(false) → effect 清理 interval
   * visible → setIsDocumentVisible(true) + 立即 refresh → effect 重建 interval
   */
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        setIsDocumentVisible(false);
      } else {
        setIsDocumentVisible(true);
        if (projectId) {
          void refresh();
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [projectId, refresh]);

  /**
   * 轮询 effect。
   * 依赖：projectId, hasActiveTasks, isDocumentVisible, refresh
   * 规则：
   * - visible + active task → interval 存在
   * - hidden → interval 不存在
   * - terminal tasks → interval 清理
   * - unmount → interval 清理
   * - 同一时刻只有一个 interval
   */
  useEffect(() => {
    // 清除旧 interval
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    if (!projectId || !hasActiveTasks || !isDocumentVisible) return;

    pollTimerRef.current = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [projectId, hasActiveTasks, isDocumentVisible, refresh]);

  /**
   * projectId 切换时：清空旧数据（含筛选），停止旧轮询，递增 generation。
   */
  useEffect(() => {
    generationRef.current += 1;
    inFlightGenerationRef.current = null;

    setTasks([]);
    setStats(null);
    setSelectedTaskId(null);
    setStatusFilter('ALL');
    setTypeFilter('ALL');
    setError(null);
    setStatsError(null);
    setIsLoading(false);

    if (projectId) {
      void refresh();
    }

    return () => {
      generationRef.current += 1;
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
