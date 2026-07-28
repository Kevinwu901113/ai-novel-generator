/**
 * 任务统计摘要组件。
 *
 * 使用 tasks.getStats 作为统计来源。
 * 平均延迟的除数为 invocationCount。
 */

import type { TaskStatsPublicData } from '@ai-novel/contracts';
import { formatNumber, formatLatency, safeNumber } from './task-formatters';

interface TaskStatsProps {
  stats: TaskStatsPublicData | null;
  error: string | null;
}

export function TaskStats({ stats, error }: TaskStatsProps) {
  if (error) {
    return <div className="task-stats-error">统计加载失败：{error}</div>;
  }

  if (!stats) {
    return <div className="task-stats-loading">加载统计中…</div>;
  }

  const avgLatency =
    stats.invocationCount > 0 ? safeNumber(stats.totalLatencyMs / stats.invocationCount) : null;

  return (
    <div className="task-stats" data-testid="task-stats">
      <div className="task-stats-item">
        <span className="task-stats-label">模型调用</span>
        <span className="task-stats-value">{formatNumber(stats.invocationCount)}</span>
      </div>
      <div className="task-stats-item">
        <span className="task-stats-label">成功</span>
        <span className="task-stats-value task-stats-success">
          {formatNumber(stats.succeededCount)}
        </span>
      </div>
      <div className="task-stats-item">
        <span className="task-stats-label">失败</span>
        <span className="task-stats-value task-stats-failed">
          {formatNumber(stats.failedCount)}
        </span>
      </div>
      <div className="task-stats-item">
        <span className="task-stats-label">输入 Token</span>
        <span className="task-stats-value">{formatNumber(stats.totalInputTokens)}</span>
      </div>
      <div className="task-stats-item">
        <span className="task-stats-label">输出 Token</span>
        <span className="task-stats-value">{formatNumber(stats.totalOutputTokens)}</span>
      </div>
      <div className="task-stats-item">
        <span className="task-stats-label">总 Token</span>
        <span className="task-stats-value">{formatNumber(stats.totalTokens)}</span>
      </div>
      <div className="task-stats-item">
        <span className="task-stats-label">总延迟</span>
        <span className="task-stats-value">{formatLatency(stats.totalLatencyMs)}</span>
      </div>
      <div className="task-stats-item">
        <span className="task-stats-label">平均延迟</span>
        <span className="task-stats-value">
          {avgLatency !== null ? formatLatency(avgLatency) : '—'}
        </span>
      </div>
    </div>
  );
}
