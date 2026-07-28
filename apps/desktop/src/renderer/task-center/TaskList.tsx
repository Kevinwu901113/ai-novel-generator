/**
 * 任务列表组件。
 *
 * 显示任务短 ID、类型、状态、尝试次数、创建/完成时间。
 * 选中项清晰标记。
 */

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
        <div className="task-list-empty">暂无任务</div>
      ) : (
        <ul className="task-list" data-testid="task-list">
          {tasks.map((task) => (
            <li
              key={task.id}
              className={`task-item ${selectedTaskId === task.id ? 'active' : ''}`}
              onClick={() => onSelect(task.id)}
              data-testid="task-item"
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
          ))}
        </ul>
      )}
    </div>
  );
}
