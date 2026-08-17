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
      <div
        className="rounded-md bg-destructive/10 px-2 py-2 text-center text-xs text-destructive"
        data-testid="task-stats-error"
        role="alert"
        aria-live="assertive"
      >
        统计加载失败：{error}
      </div>
    );
  }

  // 有错误但有上次成功数据时，显示数据和过期提示
  if (error && stats) {
    return (
      <div className="grid grid-cols-2 gap-2" data-testid="task-stats">
        <div
          className="col-span-2 rounded-md bg-status-attention/10 px-2 py-1.5 text-xs text-status-attention"
          data-testid="task-stats-stale"
          role="status"
          aria-live="polite"
        >
          ⚠ 统计可能已过期
        </div>
        <TaskStatsContent stats={stats} />
      </div>
    );
  }

  // 无数据且无错误时，显示加载中
  if (!stats) {
    return (
      <div
        className="px-2 py-2 text-center text-xs text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        加载统计中…
      </div>
    );
  }

  // 正常显示
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="task-stats">
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
      <StatItem label="模型调用" value={formatNumber(stats.invocationCount)} />
      <StatItem
        label="成功"
        value={formatNumber(stats.succeededCount)}
        valueClassName="text-status-ready"
      />
      <StatItem
        label="失败"
        value={formatNumber(stats.failedCount)}
        valueClassName="text-destructive"
      />
      <StatItem label="输入 Token" value={formatNumber(stats.totalInputTokens)} />
      <StatItem label="输出 Token" value={formatNumber(stats.totalOutputTokens)} />
      <StatItem label="总 Token" value={formatNumber(stats.totalTokens)} />
      <StatItem label="总延迟" value={formatLatency(stats.totalLatencyMs)} />
      <StatItem label="平均延迟" value={avgLatency !== null ? formatLatency(avgLatency) : '—'} />
    </>
  );
}

function StatItem({
  label,
  value,
  valueClassName,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueClassName?: string;
}) {
  return (
    <div className="flex flex-col rounded border border-border bg-background px-2 py-1.5">
      <span className="mb-0.5 text-[11px] text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-semibold ${valueClassName ?? ''}`}>{value}</span>
    </div>
  );
}
