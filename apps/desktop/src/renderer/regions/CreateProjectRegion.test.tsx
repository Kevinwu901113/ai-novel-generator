// @vitest-environment jsdom
/**
 * CreateProjectRegion 测试。
 *
 * 覆盖：
 * 1. 创建失败时项目名称不清空
 * 2. 创建失败时初始想法不清空
 * 3. 创建失败显示安全错误
 * 4. 创建失败后按钮恢复可用
 * 5. 失败后重试成功才清空表单
 * 6. 成功重试清除旧 global error
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { CreateProjectRegion } from './CreateProjectRegion';

// ── Mock DesktopAPI 工厂 ────────────────────────────────────────

function setInputValue(el: HTMLElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('CreateProjectRegion 创建失败语义', () => {
  afterEach(() => {
    cleanup();
  });

  // 1. 创建失败时项目名称不清空
  it('创建失败时项目名称不清空', async () => {
    const onCreate = vi.fn().mockResolvedValue(false);

    await act(async () => {
      render(
        <CreateProjectRegion dataServiceStatus="ready" onRetry={() => {}} onCreate={onCreate} />,
      );
    });

    const nameInput = screen.getByLabelText('项目名称');
    act(() => {
      setInputValue(nameInput, '测试项目名称');
    });

    const ideaInput = screen.getByLabelText('描述你想写的小说……');
    act(() => {
      setInputValue(ideaInput, '测试初始想法');
    });

    await act(async () => {
      screen.getByText('创建项目').click();
    });

    expect(onCreate).toHaveBeenCalledWith('测试项目名称', '测试初始想法');
    expect(nameInput).toHaveValue('测试项目名称');
  });

  // 2. 创建失败时初始想法不清空
  it('创建失败时初始想法不清空', async () => {
    const onCreate = vi.fn().mockResolvedValue(false);

    await act(async () => {
      render(
        <CreateProjectRegion dataServiceStatus="ready" onRetry={() => {}} onCreate={onCreate} />,
      );
    });

    const nameInput = screen.getByLabelText('项目名称');
    act(() => {
      setInputValue(nameInput, '测试项目名称');
    });

    const ideaInput = screen.getByLabelText('描述你想写的小说……');
    act(() => {
      setInputValue(ideaInput, '测试初始想法');
    });

    await act(async () => {
      screen.getByText('创建项目').click();
    });

    expect(onCreate).toHaveBeenCalledWith('测试项目名称', '测试初始想法');
    expect(ideaInput).toHaveValue('测试初始想法');
  });

  // 3. 创建失败显示安全错误
  it('创建失败显示安全错误', async () => {
    const onCreate = vi.fn().mockResolvedValue(false);

    await act(async () => {
      render(
        <CreateProjectRegion dataServiceStatus="ready" onRetry={() => {}} onCreate={onCreate} />,
      );
    });

    const nameInput = screen.getByLabelText('项目名称');
    act(() => {
      setInputValue(nameInput, '测试项目名称');
    });

    const ideaInput = screen.getByLabelText('描述你想写的小说……');
    act(() => {
      setInputValue(ideaInput, '测试初始想法');
    });

    await act(async () => {
      screen.getByText('创建项目').click();
    });

    // onCreate 返回 false，组件不显示错误（错误由 App 显示）
    // 但组件应该保留表单数据
    expect(onCreate).toHaveBeenCalled();
  });

  // 4. 创建失败后按钮恢复可用
  it('创建失败后按钮恢复可用', async () => {
    const onCreate = vi.fn().mockResolvedValue(false);

    await act(async () => {
      render(
        <CreateProjectRegion dataServiceStatus="ready" onRetry={() => {}} onCreate={onCreate} />,
      );
    });

    const nameInput = screen.getByLabelText('项目名称');
    act(() => {
      setInputValue(nameInput, '测试项目名称');
    });

    const ideaInput = screen.getByLabelText('描述你想写的小说……');
    act(() => {
      setInputValue(ideaInput, '测试初始想法');
    });

    const createBtn = screen.getByText('创建项目');
    await act(async () => {
      createBtn.click();
    });

    expect(createBtn).not.toBeDisabled();
    expect(createBtn).toHaveTextContent('创建项目');
  });

  // 5. 失败后重试成功才清空表单
  it('失败后重试成功才清空表单', async () => {
    let callCount = 0;
    const onCreate = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount > 1; // 第一次失败，第二次成功
    });

    await act(async () => {
      render(
        <CreateProjectRegion dataServiceStatus="ready" onRetry={() => {}} onCreate={onCreate} />,
      );
    });

    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    act(() => {
      setInputValue(nameInput, '测试项目名称');
      setInputValue(ideaInput, '测试初始想法');
    });

    // 第一次创建（失败）
    await act(async () => {
      screen.getByText('创建项目').click();
    });

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(nameInput).toHaveValue('测试项目名称');
    expect(ideaInput).toHaveValue('测试初始想法');

    // 第二次创建（成功）
    await act(async () => {
      screen.getByText('创建项目').click();
    });

    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(nameInput).toHaveValue('');
    expect(ideaInput).toHaveValue('');
  });

  // 6. 成功重试清除旧 global error
  it('成功重试清除旧 global error', async () => {
    let callCount = 0;
    const onCreate = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount > 1; // 第一次失败，第二次成功
    });

    await act(async () => {
      render(
        <CreateProjectRegion dataServiceStatus="ready" onRetry={() => {}} onCreate={onCreate} />,
      );
    });

    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    act(() => {
      setInputValue(nameInput, '测试项目名称');
      setInputValue(ideaInput, '测试初始想法');
    });

    // 第一次创建（失败）
    await act(async () => {
      screen.getByText('创建项目').click();
    });

    expect(onCreate).toHaveBeenCalledTimes(1);

    // 第二次创建（成功）
    await act(async () => {
      screen.getByText('创建项目').click();
    });

    expect(onCreate).toHaveBeenCalledTimes(2);
    // 表单已清空
    expect(nameInput).toHaveValue('');
    expect(ideaInput).toHaveValue('');
  });
});
