/**
 * 创作台按需抽屉状态。
 *
 * 抽屉互斥：任一时刻至多打开设置或任务活动中的一个。
 */

export type DrawerId = 'settings' | 'tasks';
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
