// @vitest-environment jsdom
/**
 * SearchKeyPanel 组件测试（B6，D-B6-5）：全局单槽位 key 录入/删除，
 * 未配置 → 已配置的相位切换与焦点管理。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { DesktopAPI } from '@ai-novel/contracts';
import { SearchKeyPanel } from './SearchKeyPanel';

function mockApi(overrides: Record<string, unknown> = {}): DesktopAPI {
  return {
    search: {
      hasApiKey: vi.fn().mockResolvedValue({ hasApiKey: false }),
      saveApiKey: vi.fn().mockResolvedValue({ hasApiKey: true }),
      deleteApiKey: vi.fn().mockResolvedValue({ hasApiKey: false }),
    },
    ...overrides,
  } as unknown as DesktopAPI;
}

afterEach(() => {
  cleanup();
  window.desktop = undefined as unknown as DesktopAPI;
});

describe('SearchKeyPanel', () => {
  it('未就绪时不发起 IPC 调用，显示加载中', async () => {
    const api = mockApi();
    window.desktop = api;
    render(<SearchKeyPanel dataServiceStatus="starting" />);
    await act(async () => {});

    expect(screen.getByText('正在读取搜索服务配置…')).toBeInTheDocument();
    expect(api.search.hasApiKey).not.toHaveBeenCalled();
  });

  it('未配置：展示 password input（sr-only label）+ 保存按钮，保存成功后转为"已配置"并给出反馈', async () => {
    const api = mockApi();
    window.desktop = api;
    await act(async () => {
      render(<SearchKeyPanel dataServiceStatus="ready" />);
    });

    await waitFor(() => {
      expect(screen.getByLabelText('搜索服务 API Key')).toBeInTheDocument();
    });
    const input = screen.getByLabelText('搜索服务 API Key');
    expect(input).toHaveAttribute('type', 'password');

    fireEvent.change(input, { target: { value: 'tvly-test-key' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存搜索服务 API Key' }).click();
    });

    await waitFor(() => {
      expect(api.search.saveApiKey).toHaveBeenCalledWith({ apiKey: 'tvly-test-key' });
      expect(screen.getByText('已配置')).toBeInTheDocument();
      expect(screen.getByText('已保存，等待中的调研任务将自动继续')).toBeInTheDocument();
    });
  });

  it('已配置：删除需二次确认，Escape 取消，取消后焦点恢复到删除按钮', async () => {
    const api = mockApi({
      search: {
        hasApiKey: vi.fn().mockResolvedValue({ hasApiKey: true }),
        saveApiKey: vi.fn(),
        deleteApiKey: vi.fn().mockResolvedValue({ hasApiKey: false }),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<SearchKeyPanel dataServiceStatus="ready" />);
    });

    await waitFor(() => {
      expect(screen.getByText('已配置')).toBeInTheDocument();
    });

    const deleteBtn = screen.getByRole('button', { name: '删除搜索服务 API Key' });
    act(() => {
      deleteBtn.click();
    });

    const confirmGroup = await screen.findByRole('group', { name: '确认删除搜索服务 API Key' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认删除搜索服务 API Key' })).toHaveFocus();
    });

    fireEvent.keyDown(confirmGroup, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: '确认删除搜索服务 API Key' }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '删除搜索服务 API Key' })).toHaveFocus();
    });
    expect(api.search.deleteApiKey).not.toHaveBeenCalled();
  });

  it('删除确认后调用 deleteApiKey，成功后转为未配置并聚焦输入框', async () => {
    const api = mockApi({
      search: {
        hasApiKey: vi.fn().mockResolvedValue({ hasApiKey: true }),
        saveApiKey: vi.fn(),
        deleteApiKey: vi.fn().mockResolvedValue({ hasApiKey: false }),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<SearchKeyPanel dataServiceStatus="ready" />);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '删除搜索服务 API Key' })).toBeInTheDocument();
    });
    act(() => {
      screen.getByRole('button', { name: '删除搜索服务 API Key' }).click();
    });

    const confirmBtn = await screen.findByRole('button', {
      name: '确认删除搜索服务 API Key',
    });
    await act(async () => {
      confirmBtn.click();
    });

    await waitFor(() => {
      expect(api.search.deleteApiKey).toHaveBeenCalled();
      expect(screen.getByLabelText('搜索服务 API Key')).toHaveFocus();
    });
  });
});
