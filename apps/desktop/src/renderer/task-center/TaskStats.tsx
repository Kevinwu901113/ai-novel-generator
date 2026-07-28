/**
 * 任务统计摘要组件。
 *
 * 使用 tasks.getStats 作为统计来源。
 * 平均延迟的除数为 invocationCount。
 *
 * 安全行为：
 * - stats refresh 失败时保留并继续显示上一次成功统计
 * - 同时显示独立错误提示
 * - 明确标记"统计可能已过期"
 * - stats 为 null 且失败时只显示错误
 */

import type { TaskStatsPublicData } from '@ai-novel/contracts';
import { formatNumber, formatLatency, safeNumber } from './task-formatters';

interface TaskStatsProps {
  stats: TaskStatsPublicData | null;
  error: string | null;
}

export function TaskStats({ stats, error }: TaskStatsProps) {
  // 有错误且没有上次成功数据时，只显示错误
  if (error && !stats) {
    return (
      <div className="task-stats-error" data-testid="task-stats-error">
        统计加载失败：{error}
      </div>
    );
  }

  // 有错误但有上次成功数据时，显示数据和过期提示
  if (error && stats) {
    return (
      <div className="task-stats" data-testid="task-stats">
        <div className="task-stats-stale-notice" data-testid="task-stats-stale">
          ⚠ 统计可能已过期
        </div>
        <TaskStatsContent stats={stats} />
      </div>
    );
  }

  // 无数据且无错误时，显示加载中
  if (!stats) {
    return <div className="task-stats-loading">加载统计中…</div>;
  }

  // 正常显示
  return (
    <div className="task-stats" data-testid="task-stats">
      <TaskStatsContent stats={stats} />
    </div>
  );
}

/**
 * 统计内容展示组件。
 * 提取出来以便复用。
 */
function TaskStatsContent({ stats }: { stats: TaskStatsPublicData }) {
  const avgLatency =
    stats.invocationCount > 0 ? safeNumber(stats.totalLatencyMs / stats.invocationCount) : null;

  return (
    <>
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
    </>
  );
}
