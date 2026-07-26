import { describe, it, expect } from 'vitest';
import { INITIAL_PANEL_STATE, togglePanel, isPanelVisible, type PanelState } from './panel-state';

describe('INITIAL_PANEL_STATE', () => {
  it('左栏默认可见', () => {
    expect(INITIAL_PANEL_STATE.left).toBe(true);
  });

  it('右栏默认可见', () => {
    expect(INITIAL_PANEL_STATE.right).toBe(true);
  });
});

describe('togglePanel', () => {
  it('应该切换左栏可见性', () => {
    const result = togglePanel(INITIAL_PANEL_STATE, 'left');
    expect(result.left).toBe(false);
    expect(result.right).toBe(true);
  });

  it('应该切换右栏可见性', () => {
    const result = togglePanel(INITIAL_PANEL_STATE, 'right');
    expect(result.left).toBe(true);
    expect(result.right).toBe(false);
  });

  it('应该能够连续切换回原始状态', () => {
    const toggled = togglePanel(INITIAL_PANEL_STATE, 'left');
    const restored = togglePanel(toggled, 'left');
    expect(restored).toEqual(INITIAL_PANEL_STATE);
  });

  it('不应该修改原始状态', () => {
    const original: PanelState = { left: true, right: true };
    togglePanel(original, 'left');
    expect(original.left).toBe(true);
  });
});

describe('isPanelVisible', () => {
  it('应该返回左栏可见性', () => {
    expect(isPanelVisible(INITIAL_PANEL_STATE, 'left')).toBe(true);
  });

  it('应该返回右栏可见性', () => {
    expect(isPanelVisible(INITIAL_PANEL_STATE, 'right')).toBe(true);
  });

  it('应该正确反映隐藏状态', () => {
    const hidden: PanelState = { left: false, right: false };
    expect(isPanelVisible(hidden, 'left')).toBe(false);
    expect(isPanelVisible(hidden, 'right')).toBe(false);
  });
});
