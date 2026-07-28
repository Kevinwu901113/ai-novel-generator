/**
 * 任务列表组件。
 *
 * 显示任务短 ID、类型、状态、尝试次数、创建/完成时间。
 * 选中项清晰标记。
 *
 * 无障碍特性：
 * - 使用 listbox/option 模式 + roving tabindex
 * - ArrowDown/ArrowUp 移动焦点
 * - Home/End 跳转首尾
 * - Enter/Space 选择任务
 * - 当前选中 aria-selected
 * - 状态不只靠颜色表达（有文本标签）
 * - polling 刷新不夺走焦点
 */

import { useCallback, useEffect, useRef } from 'react';
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
  const focusIndexRef = useRef(0);

  /**
   * 获取当前焦点索引。
   * 如果有选中任务，优先使用选中任务的索引。
   */
  const getActiveIndex = useCallback((): number => {
    if (selectedTaskId) {
      const idx = tasks.findIndex((t) => t.id === selectedTaskId);
      if (idx >= 0) return idx;
    }
    // 确保索引在合法范围内
    const clamped = Math.min(focusIndexRef.current, Math.max(0, tasks.length - 1));
    focusIndexRef.current = clamped;
    return clamped;
  }, [tasks, selectedTaskId]);

  /**
   * 将焦点移动到指定索引的任务项。
   */
  const focusTaskAt = useCallback((index: number) => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll<HTMLElement>('[role="option"]');
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    focusIndexRef.current = clamped;
    items[clamped]?.focus();
  }, []);

  /**
   * 键盘事件处理。
   * 实现 roving tabindex 的键盘导航。
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (tasks.length === 0) return;

      const currentIndex = getActiveIndex();

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const next = Math.min(currentIndex + 1, tasks.length - 1);
          focusTaskAt(next);
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const prev = Math.max(currentIndex - 1, 0);
          focusTaskAt(prev);
          break;
        }
        case 'Home': {
          e.preventDefault();
          focusTaskAt(0);
          break;
        }
        case 'End': {
          e.preventDefault();
          focusTaskAt(tasks.length - 1);
          break;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          const task = tasks[currentIndex];
          if (task) {
            onSelect(task.id);
          }
          break;
        }
      }
    },
    [tasks, getActiveIndex, focusTaskAt, onSelect],
  );

  /**
   * 筛选变化后，将焦点移动到合法项。
   * 使用 setTimeout 等待 DOM 更新。
   */
  useEffect(() => {
    if (tasks.length > 0) {
      const idx = getActiveIndex();
      focusIndexRef.current = idx;
    }
  }, [tasks, statusFilter, typeFilter, getActiveIndex]);

  /**
   * 选中任务消失时安全移动焦点。
   */
  useEffect(() => {
    if (selectedTaskId && !tasks.find((t) => t.id === selectedTaskId)) {
      // 选中任务消失，移动到第一项或清空
      if (tasks.length > 0) {
        focusIndexRef.current = 0;
      }
    }
  }, [tasks, selectedTaskId]);

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
        <div className="task-list-empty" role="status">
          暂无任务
        </div>
      ) : (
        <ul
          ref={listRef}
          className="task-list"
          data-testid="task-list"
          role="listbox"
          aria-label="任务列表"
          onKeyDown={handleKeyDown}
        >
          {tasks.map((task, index) => {
            const isActive = selectedTaskId === task.id;
            const isFocused = index === getActiveIndex();
            return (
              <li
                key={task.id}
                className={`task-item ${isActive ? 'active' : ''}`}
                role="option"
                aria-selected={isActive}
                tabIndex={isFocused ? 0 : -1}
                onClick={() => onSelect(task.id)}
                onFocus={() => {
                  focusIndexRef.current = index;
                }}
                data-testid="task-item"
                aria-label={buildTaskAriaLabel(task)}
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
