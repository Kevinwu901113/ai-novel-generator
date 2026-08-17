/**
 * 创作台按需抽屉状态。
 *
 * B19（D-B19-1）：设置改独立页面（App.settingsOpen），抽屉只剩任务活动——
 * DrawerId 收窄为 'tasks'，结构保留（后续新增伴随型抽屉时按需扩展联合类型）。
 */

export type DrawerId = 'tasks';
export type DrawerState = DrawerId | null;

export const INITIAL_DRAWER_STATE: DrawerState = null;

export function openAppDrawer(drawer: DrawerId): DrawerState {
  return drawer;
}

export function closeAppDrawer(): DrawerState {
  return null;
}

export function isAppDrawerOpen(state: DrawerState, drawer: DrawerId): boolean {
  return state === drawer;
}
