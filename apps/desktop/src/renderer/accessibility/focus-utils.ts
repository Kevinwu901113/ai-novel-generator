/**
 * 焦点管理工具函数。
 *
 * 提供稳定的焦点移动和恢复能力，不引入全局状态框架。
 */

/** 将焦点移动到匹配选择器的首个可聚焦元素 */
export function focusFirst(container: HTMLElement, selector?: string): boolean {
  const target = selector
    ? container.querySelector<HTMLElement>(selector)
    : container.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
  if (target) {
    target.focus();
    return true;
  }
  return false;
}

/** 将焦点移动到容器本身（需 tabIndex={-1}） */
export function focusContainer(container: HTMLElement): void {
  container.focus();
}

/**
 * 创建一个恢复焦点的清理函数。
 * 返回一个函数，调用时将焦点恢复到之前聚焦的元素。
 */
export function createFocusRestorer(): () => void {
  const previous = document.activeElement as HTMLElement | null;
  return () => {
    if (previous && typeof previous.focus === 'function') {
      previous.focus();
    }
  };
}
