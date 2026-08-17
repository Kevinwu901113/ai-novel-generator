import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  readonly icon: LucideIcon;
  readonly message: string;
  readonly hint?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly className?: string;
}

/**
 * 通用空状态占位（B15，D-B15-2）：图标 + 主文案 + 可选引导按钮。
 *
 * 不预设 `role`——是否需要 `role="status"`（如"数据服务启动中"）由调用方
 * 按语境决定，沿用既有做法（外层容器持有状态语义）。文案由调用方传入，
 * 组件本身不引入新文案。
 */
export function EmptyState({
  icon: Icon,
  message,
  hint,
  actionLabel,
  onAction,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-3 py-10 text-center', className)}>
      <Icon aria-hidden="true" className="size-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{message}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {actionLabel && onAction && (
        <Button type="button" variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
