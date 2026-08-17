/**
 * 任务活动中心根组件。
 *
 * 只读、安全的任务活动视图。
 * 未打开项目时显示空状态。
 */

import { FolderOpen } from 'lucide-react';
import { useTaskCenter } from './useTaskCenter';
import { TaskStats } from './TaskStats';
import { TaskList } from './TaskList';
import { TaskDetail } from './TaskDetail';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';

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
      <div data-testid="task-center-empty">
        <EmptyState
          icon={FolderOpen}
          message="请先打开项目"
          hint="打开项目后这里会显示任务活动。"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="task-center">
      {/* 统计摘要 */}
      <TaskStats stats={stats} error={statsError} />

      {/* 刷新按钮 */}
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => refresh()}
          disabled={isLoading}
          aria-busy={isLoading}
          aria-label={isLoading ? '刷新中' : '刷新任务列表'}
          data-testid="task-refresh-btn"
        >
          {isLoading ? '刷新中…' : '刷新'}
        </Button>
      </div>

      {/* 任务列表错误 */}
      {error && (
        <div
          className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="task-error"
          role="alert"
          aria-live="assertive"
        >
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
