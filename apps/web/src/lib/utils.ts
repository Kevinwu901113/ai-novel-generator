import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn/ui 标准 className 合并工具（B14 基建）。
 * clsx 处理条件拼接，twMerge 消解 Tailwind 类冲突（如同时传入两个 padding 类时
 * 保留后者）。B15 起随 shadcn 组件落地使用，本批仅打地基。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
