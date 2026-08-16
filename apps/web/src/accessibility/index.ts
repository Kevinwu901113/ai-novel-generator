/**
 * 无障碍工具模块。
 *
 * 导出焦点管理、Live Region 等无障碍辅助工具。
 */

export { LiveRegion } from './LiveRegion';
export { focusFirst, focusContainer, createFocusRestorer } from './focus-utils';
export { useFocusOnMount } from './useFocusOnMount';
export { useRestoreFocus } from './useRestoreFocus';
