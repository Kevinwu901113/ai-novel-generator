/**
 * 任务详情组件。
 *
 * 显示安全的任务信息。
 * 禁止显示 prompt、API Key、stack、绝对路径、完整 ID。
 */

import type { TaskPublicData } from '@ai-novel/contracts';
import { taskStatusLabel, taskTypeLabel } from './task-labels';
import { formatTaskShortId, formatTime } from './task-formatters';
import { taskErrorMessage } from './task-error-message';
import { presentTaskResult } from './task-result-presenter';

interface TaskDetailProps {
  task: TaskPublicData | null;
}

export function TaskDetail({ task }: TaskDetailProps) {
  if (!task) {
    return (
      <div className="task-detail-empty" data-testid="task-detail-empty">
        请选择任务
      </div>
    );
  }

  const errorMsg = taskErrorMessage(task.errorCode, task.errorMessage);
  const resultSummary = presentTaskResult(task.taskType, task.result);

  return (
    <div className="task-detail" data-testid="task-detail">
      <div className="task-detail-field">
        <span className="task-detail-label">任务 ID</span>
        <span className="task-detail-value">{formatTaskShortId(task.id)}</span>
      </div>
      <div className="task-detail-field">
        <span className="task-detail-label">类型</span>
        <span className="task-detail-value">{taskTypeLabel(task.taskType)}</span>
      </div>
      <div className="task-detail-field">
        <span className="task-detail-label">状态</span>
        <span className={`task-status-badge status-${task.status.toLowerCase()}`}>
          {taskStatusLabel(task.status)}
        </span>
      </div>
      <div className="task-detail-field">
        <span className="task-detail-label">尝试次数</span>
        <span className="task-detail-value">{task.attemptCount}</span>
      </div>
      <div className="task-detail-field">
        <span className="task-detail-label">创建时间</span>
        <span className="task-detail-value">{formatTime(task.createdAt)}</span>
      </div>
      <div className="task-detail-field">
        <span className="task-detail-label">更新时间</span>
        <span className="task-detail-value">{formatTime(task.updatedAt)}</span>
      </div>
      <div className="task-detail-field">
        <span className="task-detail-label">开始时间</span>
        <span className="task-detail-value">{formatTime(task.startedAt)}</span>
      </div>
      <div className="task-detail-field">
        <span className="task-detail-label">完成时间</span>
        <span className="task-detail-value">{formatTime(task.finishedAt)}</span>
      </div>
      {task.errorCode && (
        <div className="task-detail-field">
          <span className="task-detail-label">错误码</span>
          <span className="task-detail-value">{task.errorCode}</span>
        </div>
      )}
      {task.status === 'FAILED' && (
        <div className="task-detail-field">
          <span className="task-detail-label">错误信息</span>
          <span className="task-detail-value task-detail-error">{errorMsg}</span>
        </div>
      )}
      {resultSummary && (
        <div className="task-detail-field">
          <span className="task-detail-label">结果</span>
          <span className="task-detail-value">{resultSummary}</span>
        </div>
      )}
    </div>
  );
}
