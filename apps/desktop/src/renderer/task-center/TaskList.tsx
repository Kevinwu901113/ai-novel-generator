/**
 * 任务列表组件。
 *
 * 显示任务短 ID、类型、状态、尝试次数、创建/完成时间。
 * 选中项清晰标记。
 *
 * 无障碍特性：
 * - role="listbox" + role="option" 列表模式
 * - roving tabindex: 只有活跃项 tabIndex=0，其余 -1
 * - activeTaskId（焦点）与 selectedTaskId（选中）分离
 * - ArrowDown/ArrowUp/Home/End 移动焦点
 * - Enter/Space 选择活跃项
 * - aria-selected 标记选中任务
 * - 筛选变化保持焦点在合法项
 * - polling 时保持焦点在同一任务 DOM 节点
 * - 焦点任务消失时移动到最近合法项（仅当焦点在列表内）
 * - 空列表清理 activeTaskId
 */

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { TaskPublicData } from '@ai-novel/contracts';
import {
  taskStatusLabel,
  taskTypeLabel,
  TASK_STATUS_OPTIONS,
  buildTaskTypeOptions,
} from './task-labels';
import { formatTaskShortId, formatTime } from './task-formatters';

interface TaskListProps {
  tasks: ReadonlyArray<TaskPublicData>;
  allTasks: ReadonlyArray<TaskPublicData>;
  selectedTaskId: string | null;
  statusFilter: string;
  typeFilter: string;
  onStatusFilterChange: (s: string) => void;
  onTypeFilterChange: (t: string) => void;
  onSelect: (taskId: string) => void;
}

/**
 * 构建任务项的可访问名称。
 */
function buildTaskAriaLabel(task: TaskPublicData): string {
  const parts: string[] = [
    `任务 ${formatTaskShortId(task.id)}`,
    taskTypeLabel(task.taskType),
    taskStatusLabel(task.status),
  ];
  if (task.attemptCount > 0) {
    parts.push(`尝试 ${task.attemptCount} 次`);
  }
  return parts.join('，');
}

export function TaskList({
  tasks,
  allTasks,
  selectedTaskId,
  statusFilter,
  typeFilter,
  onStatusFilterChange,
  onTypeFilterChange,
  onSelect,
}: TaskListProps) {
  const typeOptions = buildTaskTypeOptions(allTasks);
  const listRef = useRef<HTMLUListElement>(null);
  // 活跃项（焦点所在）与选中项（用户确认选择）分离
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // 记录焦点是否在列表内，通过 focus/blur 事件实时跟踪
  const listHasFocusRef = useRef(false);

  // ── 工具函数 ──────────────────────────────────────────────────────

  /** 获取当前列表中所有可聚焦的 option 元素 */
  const getOptionElements = useCallback((): HTMLElement[] => {
    if (!listRef.current) return [];
    return Array.from(listRef.current.querySelectorAll<HTMLElement>('[role="option"]'));
  }, []);

  /** 通过任务 ID 获取 option 元素 */
  const getOptionById = useCallback((taskId: string): HTMLElement | null => {
    if (!listRef.current) return null;
    return listRef.current.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
  }, []);

  /** 将焦点移到指定任务并更新 activeTaskId */
  const focusTask = useCallback(
    (taskId: string) => {
      const el = getOptionById(taskId);
      if (el) {
        el.focus();
        setActiveTaskId(taskId);
      }
    },
    [getOptionById],
  );

  /** 在当前列表中查找指定任务 ID 的索引，不存在返回 -1 */
  const findIndexById = useCallback(
    (taskId: string | null): number => {
      if (!taskId) return -1;
      return tasks.findIndex((t) => t.id === taskId);
    },
    [tasks],
  );

  // ── 初始化 activeTaskId ───────────────────────────────────────────

  // 列表内容变化时，确保 activeTaskId 指向合法项
  useEffect(() => {
    if (tasks.length === 0) {
      setActiveTaskId(null);
      return;
    }

    setActiveTaskId((prev) => {
      // 如果当前 active 仍在列表中，保持不变
      if (prev && tasks.some((t) => t.id === prev)) {
        return prev;
      }
      // 如果选中项在列表中，使用选中项
      if (selectedTaskId && tasks.some((t) => t.id === selectedTaskId)) {
        return selectedTaskId;
      }
      // 否则使用第一项
      return tasks[0].id;
    });
  }, [tasks, selectedTaskId]);

  // ── 焦点同步 ──────────────────────────────────────────────────────

  // activeTaskId 变化时，同步更新 DOM tabIndex
  useEffect(() => {
    const options = getOptionElements();
    options.forEach((el) => {
      const taskId = el.getAttribute('data-task-id');
      el.setAttribute('tabindex', taskId === activeTaskId ? '0' : '-1');
    });
  }, [activeTaskId, getOptionElements]);

  // ── selectedTaskId 变化时的焦点同步 ────────────────────────────────
  // 只有当焦点在列表内且当前 active 已不存在时才同步
  useEffect(() => {
    if (!selectedTaskId) return;
    // 如果焦点不在列表内，不干预
    if (!listHasFocusRef.current) return;
    // 如果当前 active 仍在列表中，保持不变
    if (activeTaskId && tasks.some((t) => t.id === activeTaskId)) return;
    // 同步到选中项
    focusTask(selectedTaskId);
  }, [selectedTaskId, activeTaskId, tasks, focusTask]);

  // ── 焦点任务消失时的处理 ──────────────────────────────────────────
  // 任务列表变化后，检查焦点任务是否消失
  useEffect(() => {
    if (!activeTaskId) return;
    if (tasks.some((t) => t.id === activeTaskId)) return;
    // active 已不在列表中
    // 只有当焦点原本在列表内时才移动
    if (!listHasFocusRef.current) return;
    // 移动到第一项
    if (tasks.length > 0) {
      focusTask(tasks[0].id);
    } else {
      setActiveTaskId(null);
    }
  }, [tasks, activeTaskId, focusTask]);

  // ── 事件处理 ──────────────────────────────────────────────────────

  /** option 获得焦点时更新 activeTaskId */
  const handleOptionFocus = useCallback((taskId: string) => {
    setActiveTaskId(taskId);
  }, []);

  /** option 点击时选择任务 */
  const handleOptionClick = useCallback(
    (taskId: string) => {
      onSelect(taskId);
    },
    [onSelect],
  );

  /** 键盘导航 */
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLUListElement>) => {
      const options = getOptionElements();
      if (options.length === 0) return;

      // 基于当前 activeTaskId 或 document.activeElement 计算当前位置
      let currentIndex = activeTaskId ? findIndexById(activeTaskId) : -1;
      // 如果 activeTaskId 不在列表中，尝试用 activeElement
      if (currentIndex === -1) {
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl && listRef.current?.contains(activeEl)) {
          const activeId = activeEl.getAttribute('data-task-id');
          currentIndex = activeId ? findIndexById(activeId) : -1;
        }
      }
      if (currentIndex === -1) currentIndex = 0;

      let nextIndex: number | null = null;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          nextIndex = Math.min(currentIndex + 1, options.length - 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          nextIndex = Math.max(currentIndex - 1, 0);
          break;
        case 'Home':
          e.preventDefault();
          nextIndex = 0;
          break;
        case 'End':
          e.preventDefault();
          nextIndex = options.length - 1;
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (activeTaskId) {
            onSelect(activeTaskId);
          } else if (currentIndex >= 0 && currentIndex < tasks.length) {
            onSelect(tasks[currentIndex].id);
          }
          break;
      }

      if (nextIndex !== null && nextIndex !== currentIndex) {
        const nextId = tasks[nextIndex]?.id;
        if (nextId) {
          focusTask(nextId);
        }
      }
    },
    [activeTaskId, tasks, getOptionElements, findIndexById, focusTask, onSelect],
  );

  // ── 渲染 ──────────────────────────────────────────────────────────

  return (
    <div className="task-list-container">
      {/* 筛选栏 */}
      <div className="task-filters">
        <label className="task-filter-label">
          状态：
          <select
            className="task-filter-select"
            value={statusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value)}
            data-testid="status-filter"
          >
            {TASK_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="task-filter-label">
          类型：
          <select
            className="task-filter-select"
            value={typeFilter}
            onChange={(e) => onTypeFilterChange(e.target.value)}
            data-testid="type-filter"
          >
            {typeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 列表 */}
      {tasks.length === 0 ? (
        <div className="task-list-empty" data-testid="task-empty">
          暂无任务
        </div>
      ) : (
        <ul
          ref={listRef}
          className="task-list"
          role="listbox"
          aria-label="任务列表"
          onKeyDown={handleKeyDown}
          onFocusCapture={() => {
            listHasFocusRef.current = true;
          }}
          onBlurCapture={(e) => {
            // 只有当焦点完全离开列表时才标记为 false
            // relatedTarget 是获得焦点的元素
            if (!listRef.current?.contains(e.relatedTarget as Node)) {
              listHasFocusRef.current = false;
            }
          }}
          data-testid="task-list"
        >
          {tasks.map((task) => {
            const isFocused = task.id === activeTaskId;
            const isActive = task.id === selectedTaskId;
            return (
              <li
                key={task.id}
                role="option"
                data-task-id={task.id}
                data-testid="task-item"
                tabIndex={isFocused ? 0 : -1}
                aria-selected={isActive ? 'true' : 'false'}
                aria-label={buildTaskAriaLabel(task)}
                className={`task-item ${isActive ? 'active' : ''}`}
                onClick={() => handleOptionClick(task.id)}
                onFocus={() => handleOptionFocus(task.id)}
              >
                <div className="task-item-header">
                  <span className="task-item-id">{formatTaskShortId(task.id)}</span>
                  <span className={`task-status-badge status-${task.status.toLowerCase()}`}>
                    {taskStatusLabel(task.status)}
                  </span>
                </div>
                <div className="task-item-meta">
                  <span className="task-item-type">{taskTypeLabel(task.taskType)}</span>
                  <span className="task-item-attempts">尝试 {task.attemptCount}</span>
                </div>
                <div className="task-item-times">
                  <span>{formatTime(task.createdAt)}</span>
                  {task.finishedAt && <span>→ {formatTime(task.finishedAt)}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
