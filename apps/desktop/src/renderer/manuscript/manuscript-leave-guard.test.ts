// @vitest-environment jsdom
/**
 * manuscript-leave-guard 单元测试（MV1-B 独立终审修正）。
 *
 * 覆盖：register/unregister 生命周期、isDirty()、isBusy()（mutation 进行中）报告。
 */
import { describe, expect, it } from 'vitest';
import {
  manuscriptHasDirty,
  manuscriptIsBusy,
  registerManuscriptLeaveGuard,
} from './manuscript-leave-guard';

describe('manuscript-leave-guard', () => {
  it('未注册时 dirty / busy 均为 false', () => {
    expect(manuscriptHasDirty()).toBe(false);
    expect(manuscriptIsBusy()).toBe(false);
  });

  it('isBusy 报告 mutation 进行中（不可离开，不弹「放弃修改」绕过）', () => {
    const unregister = registerManuscriptLeaveGuard({ isDirty: () => false, isBusy: () => true });
    expect(manuscriptIsBusy()).toBe(true);
    expect(manuscriptHasDirty()).toBe(false);
    unregister();
    expect(manuscriptIsBusy()).toBe(false);
  });

  it('isBusy 可选；缺省视为不忙，旧版 guard 兼容', () => {
    const unregister = registerManuscriptLeaveGuard({ isDirty: () => true });
    expect(manuscriptIsBusy()).toBe(false);
    expect(manuscriptHasDirty()).toBe(true);
    unregister();
  });

  it('任一 guard dirty 即整体 dirty', () => {
    const a = registerManuscriptLeaveGuard({ isDirty: () => false });
    const b = registerManuscriptLeaveGuard({ isDirty: () => true });
    expect(manuscriptHasDirty()).toBe(true);
    a();
    b();
    expect(manuscriptHasDirty()).toBe(false);
  });
});
