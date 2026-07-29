/**
 * 无障碍 Live Region 组件。
 *
 * 提供 aria-live 区域用于动态状态公告。
 *
 * 规则：
 * - 阻塞/失败消息：role="alert" (aria-live="assertive")
 * - 进度/成功状态：role="status" (aria-live="polite")
 * - 不播报空消息
 *
 * 实现说明：
 * - 直接渲染 message，无需内部 state 或 timer
 * - React 对完全相同的字符串不会产生 DOM 文本变化
 * - message 清空后再次出现相同内容时，会产生 blank → message 变化并重新公告
 */

interface LiveRegionProps {
  /** 要播报的消息内容 */
  message: string | null;
  /** 消息的紧急程度 */
  politeness: 'assertive' | 'polite';
  /** 可选的 aria-label */
  label?: string;
}

export function LiveRegion({ message, politeness, label }: LiveRegionProps) {
  const role = politeness === 'assertive' ? 'alert' : 'status';

  return (
    <div
      role={role}
      aria-live={politeness}
      aria-label={label}
      aria-atomic="true"
      className="sr-only"
    >
      {message ?? ''}
    </div>
  );
}
