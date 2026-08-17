/**
 * 任务详情组件。
 *
 * 显示安全的任务信息。
 * 禁止显示 prompt、API Key、stack、绝对路径、完整 ID。
 */

import { MousePointerClick } from 'lucide-react';
import type { TaskPublicData } from '@ai-novel/contracts';
import { taskTypeLabel } from './task-labels';
import { formatTaskShortId, formatTime } from './task-formatters';
import { taskErrorMessage } from './task-error-message';
import { presentTaskResult } from './task-result-presenter';
import { EmptyState } from '@/components/EmptyState';
import { TaskStatusBadge } from './TaskStatusBadge';

interface TaskDetailProps {
  task: TaskPublicData | null;
}

export function TaskDetail({ task }: TaskDetailProps) {
  if (!task) {
    return (
      <div data-testid="task-detail-empty">
        <EmptyState icon={MousePointerClick} message="请选择任务" hint="点击左侧任务查看详情。" />
      </div>
    );
  }

  const errorMsg = taskErrorMessage(task.errorCode, task.errorMessage);
  const resultSummary = presentTaskResult(task.taskType, task.result);

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2.5"
      data-testid="task-detail"
    >
      <DetailField label="任务 ID" value={formatTaskShortId(task.id)} />
      <DetailField label="类型" value={taskTypeLabel(task.taskType)} />
      <div className="flex items-baseline gap-2">
        <span className="w-15 shrink-0 text-[11px] font-semibold text-muted-foreground">状态</span>
        <TaskStatusBadge status={task.status} />
      </div>
      <DetailField label="尝试次数" value={String(task.attemptCount)} />
      <DetailField label="创建时间" value={formatTime(task.createdAt)} />
      <DetailField label="更新时间" value={formatTime(task.updatedAt)} />
      <DetailField label="开始时间" value={formatTime(task.startedAt)} />
      <DetailField label="完成时间" value={formatTime(task.finishedAt)} />
      {task.errorCode && <DetailField label="错误码" value={task.errorCode} />}
      {task.status === 'FAILED' && (
        <DetailField label="错误信息" value={errorMsg} valueClassName="text-destructive" />
      )}
      {resultSummary && <DetailField label="结果" value={resultSummary} />}
    </div>
  );
}

function DetailField({
  label,
  value,
  valueClassName,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueClassName?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-15 shrink-0 text-[11px] font-semibold text-muted-foreground">{label}</span>
      <span className={`text-xs break-all ${valueClassName ?? 'text-foreground'}`}>{value}</span>
    </div>
  );
}
