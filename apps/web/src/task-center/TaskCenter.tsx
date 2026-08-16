/**
 * 任务活动中心根组件。
 *
 * 只读、安全的任务活动视图。
 * 未打开项目时显示空状态。
 */

import { useTaskCenter } from './useTaskCenter';
import { TaskStats } from './TaskStats';
import { TaskList } from './TaskList';
import { TaskDetail } from './TaskDetail';

interface TaskCenterProps {
  projectId: string | null;
}

export function TaskCenter({ projectId }: TaskCenterProps) {
  const {
    filteredTasks,
    tasks,
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
  } = useTaskCenter(projectId);

  if (!projectId) {
    return (
      <div className="task-center-empty" data-testid="task-center-empty">
        请先打开项目
      </div>
    );
  }

  return (
    <div className="task-center" data-testid="task-center">
      {/* 统计摘要 */}
      <TaskStats stats={stats} error={statsError} />

      {/* 刷新按钮 */}
      <div className="task-center-actions">
        <button
          className="btn-retry-inline"
          onClick={() => refresh()}
          disabled={isLoading}
          aria-busy={isLoading}
          aria-label={isLoading ? '刷新中' : '刷新任务列表'}
          data-testid="task-refresh-btn"
        >
          {isLoading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {/* 任务列表错误 */}
      {error && (
        <div className="task-error" data-testid="task-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      {/* 任务列表 */}
      <TaskList
        tasks={filteredTasks}
        allTasks={tasks}
        selectedTaskId={selectedTask?.id ?? null}
        statusFilter={statusFilter}
        typeFilter={typeFilter}
        onStatusFilterChange={setStatusFilter}
        onTypeFilterChange={setTypeFilter}
        onSelect={selectTask}
      />

      {/* 任务详情 */}
      <TaskDetail task={selectedTask} />
    </div>
  );
}
