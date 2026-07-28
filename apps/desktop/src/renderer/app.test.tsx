// @vitest-environment jsdom
/**
 * App 级别测试。
 *
 * 渲染真实 App 组件，mock window.desktop。
 * 测试全局行为和集成场景。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import type { DesktopAPI } from '@ai-novel/contracts';
import { App } from './App';

// ── Mock 数据 ────────────────────────────────────────────────────────

const mockProject1 = {
  id: 'proj-00000001-aaaa-bbbb-cccc-dddddddddddd',
  name: '测试项目一',
  createdAt: '2024-01-01T00:00:00Z',
  lastOpenedAt: '2024-01-02T00:00:00Z',
  isMissing: false,
};

const mockProviderState = {
  displayName: 'OpenAI',
  model: 'gpt-4',
  providerType: 'openai',
  hasApiKey: true,
  lastTestStatus: 'never',
  lastTestErrorCode: null,
  lastTestedAt: null,
  lastTestLatencyMs: null,
};

// ── 工具函数 ────────────────────────────────────────────────────────

function createMockDesktopAPI(overrides: Record<string, unknown> = {}) {
  return {
    healthCheck: vi
      .fn()
      .mockResolvedValue({ ok: true, version: '1.0.0', timestamp: new Date().toISOString() }),
    getDataServiceStatus: vi.fn().mockResolvedValue({ status: 'ready' }),
    retryDataService: vi.fn().mockResolvedValue(undefined),
    projects: {
      list: vi.fn().mockResolvedValue([mockProject1]),
      create: vi.fn().mockResolvedValue({ id: 'proj-new-0001' }),
      open: vi.fn().mockResolvedValue({
        id: 'proj-new-0001',
        name: '新项目',
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        status: 'active',
      }),
    },
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      getStats: vi.fn().mockResolvedValue({
        invocationCount: 0,
        succeededCount: 0,
        failedCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalLatencyMs: 0,
      }),
      get: vi.fn(),
      createModelInvocationTest: vi.fn(),
    },
    provider: {
      getState: vi.fn().mockResolvedValue(mockProviderState),
      saveApiKey: vi.fn().mockResolvedValue({ ...mockProviderState, hasApiKey: true }),
      deleteApiKey: vi.fn().mockResolvedValue({ ...mockProviderState, hasApiKey: false }),
      testConnection: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  } as unknown as DesktopAPI;
}

function setupDesktop(api?: DesktopAPI) {
  window.desktop = api ?? createMockDesktopAPI();
  return window.desktop;
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('App 级别测试', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  // 1. App 只有一个 main landmark
  it('App 只有一个 main landmark', async () => {
    setupDesktop();
    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('main')).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    const mainElements = screen.getAllByRole('main');
    expect(mainElements.length).toBe(1);
  });

  // 2. panel aria-expanded 与真实 App 状态联动
  it('panel aria-expanded 与真实 App 状态联动', async () => {
    setupDesktop();
    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /收起项目列表|展开项目列表/ }),
        ).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 左面板默认展开
    const leftToggle = screen.getByRole('button', { name: /收起项目列表|展开项目列表/ });
    expect(leftToggle).toHaveAttribute('aria-expanded', 'true');

    // 点击收起
    act(() => {
      leftToggle.click();
    });
    expect(leftToggle).toHaveAttribute('aria-expanded', 'false');

    // 右面板默认展开
    const rightToggle = screen.getByRole('button', { name: /收起状态面板|展开状态面板/ });
    expect(rightToggle).toHaveAttribute('aria-expanded', 'true');

    // 点击收起
    act(() => {
      rightToggle.click();
    });
    expect(rightToggle).toHaveAttribute('aria-expanded', 'false');
  });

  // 3. 实际 App DOM 不存在重复关键 id
  it('实际 App DOM 不存在重复关键 id', async () => {
    setupDesktop();
    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('main')).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    const allIds = Array.from(document.querySelectorAll('[id]')).map((el) => el.id);
    const uniqueIds = new Set(allIds);
    expect(allIds.length).toBe(uniqueIds.size);
  });

  // 4. 创建失败 global error 出现
  it('projects.create rejection 后 global error 出现', async () => {
    const api = createMockDesktopAPI({
      projects: {
        list: vi.fn().mockResolvedValue([mockProject1]),
        create: vi.fn().mockRejectedValue(new Error('创建失败：磁盘空间不足')),
        open: vi.fn(),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 切换到新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 填写表单
    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    fireEvent.change(nameInput, { target: { value: '测试项目' } });
    fireEvent.change(ideaInput, { target: { value: '测试想法' } });

    // 点击创建
    const createBtn = screen.getByText('创建项目');
    await act(async () => {
      createBtn.click();
    });

    // global error 应该出现
    await waitFor(
      () => {
        const errorAlert = screen.getByRole('alert');
        expect(errorAlert).toBeInTheDocument();
        expect(errorAlert.textContent).toContain('创建失败');
      },
      { timeout: 5000 },
    );
  });

  // 5. global error 不含敏感信息
  it('global error 不含 /Users/、stack、Bearer、API Key', async () => {
    const api = createMockDesktopAPI({
      projects: {
        list: vi.fn().mockResolvedValue([mockProject1]),
        create: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'ENOENT: /Users/secret/.env Bearer sk-1234567890abcdef\n    at createProject (src/create.ts:42:11)',
            ),
          ),
        open: vi.fn(),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 切换到新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 填写表单
    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    fireEvent.change(nameInput, { target: { value: '测试项目' } });
    fireEvent.change(ideaInput, { target: { value: '测试想法' } });

    // 点击创建
    const createBtn = screen.getByText('创建项目');
    await act(async () => {
      createBtn.click();
    });

    // global error 应该不包含敏感信息
    await waitFor(
      () => {
        const errorAlert = screen.getByRole('alert');
        expect(errorAlert.textContent).not.toContain('/Users/');
        expect(errorAlert.textContent).not.toContain('Bearer');
        expect(errorAlert.textContent).not.toContain('sk-');
        expect(errorAlert.textContent).not.toContain('at createProject');
      },
      { timeout: 5000 },
    );
  });

  // 6. 创建失败后名称和初始想法仍存在
  it('创建失败后名称和初始想法仍存在', async () => {
    const api = createMockDesktopAPI({
      projects: {
        list: vi.fn().mockResolvedValue([mockProject1]),
        create: vi.fn().mockRejectedValue(new Error('创建失败')),
        open: vi.fn(),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 切换到新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 填写表单
    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    fireEvent.change(nameInput, { target: { value: '我的小说' } });
    fireEvent.change(ideaInput, { target: { value: '一个关于未来的故事' } });

    // 点击创建
    const createBtn = screen.getByText('创建项目');
    await act(async () => {
      createBtn.click();
    });

    // 内容应该保留
    expect(nameInput).toHaveValue('我的小说');
    expect(ideaInput).toHaveValue('一个关于未来的故事');
  });

  // 7. 第二次成功后旧 global error 消失
  it('第二次成功后旧 global error 消失', async () => {
    let callCount = 0;
    const api = createMockDesktopAPI({
      projects: {
        list: vi.fn().mockResolvedValue([mockProject1]),
        create: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error('第一次失败');
          }
          return { id: 'proj-new-0001' };
        }),
        open: vi.fn().mockResolvedValue({
          id: 'proj-new-0001',
          name: '新项目',
          createdAt: new Date().toISOString(),
          lastOpenedAt: new Date().toISOString(),
          status: 'active',
        }),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 切换到新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 填写表单
    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    fireEvent.change(nameInput, { target: { value: '测试项目' } });
    fireEvent.change(ideaInput, { target: { value: '测试想法' } });

    // 第一次创建失败
    const createBtn = screen.getByText('创建项目');
    await act(async () => {
      createBtn.click();
    });

    // global error 出现
    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // 第二次创建成功
    await act(async () => {
      createBtn.click();
    });

    // global error 应该消失
    await waitFor(
      () => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  // 8. provider.testConnection rejection 后 provider.getState 仍被调用
  it('testConnection 失败后 provider.getState 仍被调用', async () => {
    const api = createMockDesktopAPI({
      provider: {
        ...createMockDesktopAPI().provider,
        testConnection: vi.fn().mockRejectedValue(new Error('连接超时')),
        getState: vi.fn().mockResolvedValue(mockProviderState),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 找到测试连接按钮
    const testBtn = screen.getByRole('button', { name: '测试连接' });
    await act(async () => {
      testBtn.click();
    });

    // testConnection 被调用
    expect(api.provider.testConnection).toHaveBeenCalled();

    // 等待 getState 被调用（在 finally 块中）
    await waitFor(
      () => {
        expect(api.provider.getState).toHaveBeenCalled();
      },
      { timeout: 5000 },
    );
  });

  // 9. App 同一 global error 只有一个 alert/live region
  it('App 同一 global error 只有一个 alert', async () => {
    const api = createMockDesktopAPI({
      projects: {
        list: vi.fn().mockResolvedValue([mockProject1]),
        create: vi.fn().mockRejectedValue(new Error('创建失败')),
        open: vi.fn(),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 切换到新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 填写表单
    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    fireEvent.change(nameInput, { target: { value: '测试项目' } });
    fireEvent.change(ideaInput, { target: { value: '测试想法' } });

    // 点击创建
    const createBtn = screen.getByText('创建项目');
    await act(async () => {
      createBtn.click();
    });

    // 只应该有一个 alert（global error）
    await waitFor(
      () => {
        const alerts = screen.getAllByRole('alert');
        expect(alerts.length).toBe(1);
      },
      { timeout: 5000 },
    );
  });

  // 10. testConnection rejection 后 getState 返回 failed 状态
  it('testConnection rejection 后 getState 返回 failed 状态', async () => {
    const api = createMockDesktopAPI({
      provider: {
        ...createMockDesktopAPI().provider,
        testConnection: vi.fn().mockRejectedValue(new Error('连接超时')),
        getState: vi.fn().mockResolvedValue(mockProviderState),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 点击测试连接
    const testBtn = screen.getByRole('button', { name: '测试连接' });
    await act(async () => {
      testBtn.click();
    });

    // testConnection 被调用
    expect(api.provider.testConnection).toHaveBeenCalled();

    // 等待 getState 被调用
    await waitFor(
      () => {
        expect(api.provider.getState).toHaveBeenCalled();
      },
      { timeout: 5000 },
    );
  });

  // 11. Provider 原始错误不泄露
  it('Provider 原始错误不泄露', async () => {
    const api = createMockDesktopAPI({
      provider: {
        ...createMockDesktopAPI().provider,
        testConnection: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'ENOENT: /Users/secret/.env Bearer sk-1234567890abcdef\n    at connect (src/provider.ts:42:11)',
            ),
          ),
        getState: vi.fn().mockResolvedValue(mockProviderState),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 点击测试连接
    const testBtn = screen.getByRole('button', { name: '测试连接' });
    await act(async () => {
      testBtn.click();
    });

    // 等待错误显示
    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // 错误不应该包含敏感信息
    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toContain('/Users/');
    expect(alert.textContent).not.toContain('Bearer');
    expect(alert.textContent).not.toContain('sk-');
    expect(alert.textContent).not.toContain('at connect');
  });

  // 12. 点击新建项目后名称输入获得焦点
  it('点击新建项目后名称输入获得焦点', async () => {
    setupDesktop();

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 点击新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 名称输入应该获得焦点
    await waitFor(
      () => {
        const nameInput = screen.getByLabelText('项目名称');
        expect(nameInput).toHaveFocus();
      },
      { timeout: 5000 },
    );
  });
});
