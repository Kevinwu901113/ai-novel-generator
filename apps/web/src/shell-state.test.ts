import { describe, expect, it } from 'vitest';
import {
  INITIAL_DRAWER_STATE,
  closeAppDrawer,
  isAppDrawerOpen,
  openAppDrawer,
} from './shell-state';

describe('创作台抽屉状态', () => {
  it('初始不打开任何抽屉', () => {
    expect(INITIAL_DRAWER_STATE).toBeNull();
  });

  it('可以打开设置抽屉', () => {
    expect(openAppDrawer('settings')).toBe('settings');
  });

  it('可以打开任务抽屉', () => {
    expect(openAppDrawer('tasks')).toBe('tasks');
  });

  it('打开设置时设置抽屉为真', () => {
    expect(isAppDrawerOpen('settings', 'settings')).toBe(true);
  });

  it('打开设置时任务抽屉为假', () => {
    expect(isAppDrawerOpen('settings', 'tasks')).toBe(false);
  });

  it('打开任务时任务抽屉为真', () => {
    expect(isAppDrawerOpen('tasks', 'tasks')).toBe(true);
  });

  it('无抽屉时设置抽屉为假', () => {
    expect(isAppDrawerOpen(null, 'settings')).toBe(false);
  });

  it('无抽屉时任务抽屉为假', () => {
    expect(isAppDrawerOpen(null, 'tasks')).toBe(false);
  });

  it('关闭后回到无抽屉状态', () => {
    expect(closeAppDrawer()).toBeNull();
  });
});
