import { Loader2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SpinnerProps {
  readonly size?: number;
  readonly className?: string;
  /**
   * 无障碍标签。默认「加载中」，Spinner 自带 `role="status"` 独立宣告。
   * 传 `null` 表示外层容器已经承担了状态语义（如既有的 `role="status"`
   * pill/区块），此时 Spinner 只作纯装饰图标（`aria-hidden`），避免嵌套
   * live region 导致重复播报。
   */
  readonly label?: string | null;
}

/**
 * 通用旋转加载指示器（B15，D-B15-2）。
 *
 * 替换全站手写的 `⟳` 字符旋转。尊重 `prefers-reduced-motion`——开启后降级为
 * 静态图标（`motion-reduce:animate-none`），不产生视觉眩晕。
 */
export function Spinner({ size = 16, className, label = '加载中' }: SpinnerProps) {
  const icon = (
    <Loader2Icon
      aria-hidden="true"
      className={cn('animate-spin motion-reduce:animate-none', label === null && className)}
      style={{ width: size, height: size }}
    />
  );

  if (label === null) {
    return icon;
  }

  return (
    <span role="status" className={cn('inline-flex items-center gap-2', className)}>
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}
