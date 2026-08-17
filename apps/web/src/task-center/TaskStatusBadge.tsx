/**
 * 任务状态徽标（B16，从 TaskList/TaskDetail 抽出共用）。
 *
 * 六种状态收敛到三组语义色 token：pending/cancelled/stale 共用中性灰，
 * running 用 --status-attention（暖橙，"进行中"），succeeded 用
 * --status-ready（绿，"已完成"），failed 用 --destructive（红）。
 * 不引入新硬编码色。
 */

import { cn } from '@/lib/utils';
import { taskStatusLabel } from './task-labels';

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-status-neutral/15 text-muted-foreground',
  RUNNING: 'bg-status-attention/15 text-status-attention',
  SUCCEEDED: 'bg-status-ready/15 text-status-ready',
  FAILED: 'bg-destructive/10 text-destructive',
  CANCELLED: 'bg-status-neutral/15 text-muted-foreground',
  STALE: 'bg-status-neutral/15 text-muted-foreground',
};

export function TaskStatusBadge({ status }: { readonly status: string }) {
  return (
    <span
      className={cn(
        // 'task-status-badge' 保留字面量类名（无对应 CSS 规则）：
        // accessibility.test.tsx「状态不只靠颜色表达」用 querySelectorAll
        // 定位所有状态徽标，断言文字内容非空——迁移不改变这条无障碍语义，
        // 保留选择器省去改测试（D-B16-3 允许但非必须改）。
        'task-status-badge inline-flex w-fit items-center rounded-full px-1.5 py-px text-[10px] font-medium',
        STATUS_STYLES[status] ?? 'bg-status-neutral/15 text-muted-foreground',
      )}
    >
      {taskStatusLabel(status)}
    </span>
  );
}
