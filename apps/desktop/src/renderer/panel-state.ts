/**
 * 面板状态管理 —— 纯函数，可独立测试。
 */

/** 面板 ID */
export type PanelId = 'left' | 'right';

/** 面板状态 */
export interface PanelState {
  readonly left: boolean;
  readonly right: boolean;
}

/** 初始面板状态 */
export const INITIAL_PANEL_STATE: PanelState = {
  left: true,
  right: true,
};

/** 切换指定面板的可见性 */
export function togglePanel(state: PanelState, panel: PanelId): PanelState {
  return {
    ...state,
    [panel]: !state[panel],
  };
}

/** 判断面板是否可见 */
export function isPanelVisible(state: PanelState, panel: PanelId): boolean {
  return state[panel];
}
