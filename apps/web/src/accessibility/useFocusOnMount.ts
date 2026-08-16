/**
 * 组件挂载时将焦点移动到指定元素。
 *
 * 使用 ref 跟踪是否已执行，避免 StrictMode 下重复焦点移动。
 * 仅在依赖变化时触发，不在普通 rerender 时抢焦点。
 */

import { useEffect, useRef } from 'react';

/**
 * 当 condition 为 true 时，将焦点移动到 ref 指向的元素。
 * 只执行一次（per condition transition）。
 */
export function useFocusOnMount<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  condition: boolean,
): void {
  const hasFocused = useRef(false);

  useEffect(() => {
    if (condition && !hasFocused.current && ref.current) {
      ref.current.focus();
      hasFocused.current = true;
    }
    if (!condition) {
      hasFocused.current = false;
    }
  }, [condition, ref]);
}
