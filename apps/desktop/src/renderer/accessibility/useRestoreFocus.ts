/**
 * 焦点恢复 Hook。
 *
 * 组件卸载时将焦点恢复到之前聚焦的元素。
 * 用于弹出层、确认对话框等临时 UI。
 */

import { useEffect, useRef } from 'react';

/**
 * 记录挂载时的焦点元素，卸载时恢复。
 * @param active 是否激活焦点恢复（例如确认框可见时）
 */
export function useRestoreFocus(active: boolean): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (active) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
    }
    return () => {
      if (active && previousFocusRef.current) {
        const el = previousFocusRef.current;
        // 使用 setTimeout 确保在 React DOM 更新后恢复焦点
        setTimeout(() => {
          if (typeof el.focus === 'function') {
            el.focus();
          }
        }, 0);
      }
    };
  }, [active]);
}
