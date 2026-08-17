import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface InlineErrorProps {
  readonly children: ReactNode;
  readonly id?: string;
  readonly className?: string;
  /** 提供时渲染一个关闭按钮（原 `.provider-error` 的 ✕）。 */
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  /**
   * banner（默认）：独立错误块，边框 + 底色；field：字段级小字号提示，
   * 随父级 flex 行内排列（如字符计数并排的 `.form-error`）。
   */
  readonly variant?: 'banner' | 'field';
}

/**
 * Region 内联错误统一呈现（B16）。`role="alert"` 保留——原 `.intake-error` /
 * `.spec-error` / `.provider-error` / `.form-error` 等 30 处内联错误块的
 * 呈现层收编到一处，样式只用 `--destructive` token。
 */
export function InlineError({
  children,
  id,
  className,
  onDismiss,
  dismissLabel = '关闭错误提示',
  variant = 'banner',
}: InlineErrorProps) {
  if (variant === 'field') {
    return (
      <span id={id} role="alert" className={cn('text-xs text-destructive', className)}>
        {children}
      </span>
    );
  }

  return (
    <div
      id={id}
      role="alert"
      className={cn(
        'flex items-start justify-between gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive',
        className,
      )}
    >
      <div className="space-y-1">{children}</div>
      {onDismiss && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="shrink-0 text-destructive hover:bg-destructive/15 hover:text-destructive"
        >
          <X size={14} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
