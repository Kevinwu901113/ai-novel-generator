/**
 * 无障碍 Live Region 组件。
 *
 * 提供 aria-live 区域用于动态状态公告。
 * 使用去重机制避免重复播报相同内容。
 *
 * 规则：
 * - 阻塞/失败消息：role="alert" (aria-live="assertive")
 * - 进度/成功状态：role="status" (aria-live="polite")
 * - 同一消息不重复播报
 * - 不播报空消息
 */

import { useEffect, useRef, useState } from 'react';

interface LiveRegionProps {
  /** 要播报的消息内容 */
  message: string | null;
  /** 消息的紧急程度 */
  politeness: 'assertive' | 'polite';
  /** 可选的 aria-label */
  label?: string;
}

/**
 * 无障碍 Live Region。
 *
 * 使用双重渲染技巧实现去重：
 * 1. 先清空内容
 * 2. 在下一帧设置新内容
 * 这样即使相同消息连续出现，屏幕阅读器也会重新播报。
 *
 * 但如果消息与上次完全相同，则跳过播报。
 */
export function LiveRegion({ message, politeness, label }: LiveRegionProps) {
  const [displayedMessage, setDisplayedMessage] = useState<string | null>(null);
  const lastMessageRef = useRef<string | null>(null);

  useEffect(() => {
    // 空消息不播报
    if (!message) {
      setDisplayedMessage(null);
      return;
    }

    // 相同消息不重复播报
    if (message === lastMessageRef.current) {
      return;
    }

    lastMessageRef.current = message;

    // 先清空，再设置，确保屏幕阅读器检测到变化
    setDisplayedMessage(null);
    const timer = setTimeout(() => {
      setDisplayedMessage(message);
    }, 50);

    return () => clearTimeout(timer);
  }, [message]);

  const role = politeness === 'assertive' ? 'alert' : 'status';

  return (
    <div
      role={role}
      aria-live={politeness}
      aria-label={label}
      aria-atomic="true"
      className="sr-only"
    >
      {displayedMessage}
    </div>
  );
}
