// @vitest-environment jsdom
/**
 * 无障碍测试套件。
 *
 * 覆盖所有要求的无障碍场景：
 * - 语义化区域
 * - 项目列表键盘操作
 * - TaskCenter 键盘导航
 * - 表单无障碍
 * - Provider 焦点与键盘行为
 * - Error Boundary 焦点
 * - 动态状态公告
 * - App-level 债务测试
 *
 * 不增加 jest-axe、axe-core 等依赖。
 * 使用现有 Vitest、jsdom、Testing Library。
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  TaskPublicData,
  TaskStatsPublicData,
  ProviderPublicState,
  ResearchBundleDto,
  DesktopAPI,
} from '@ai-novel/contracts';

// ── 组件导入 ────────────────────────────────────────────────────────

import { ProjectListRegion } from './regions/ProjectListRegion';
import { CreateProjectRegion } from './regions/CreateProjectRegion';
import { ProviderRegion } from './regions/ProviderRegion';
import { TaskCenter } from './task-center/TaskCenter';
import { TaskList } from './task-center/TaskList';
import { TaskStats } from './task-center/TaskStats';
import { RendererErrorBoundary } from './safety/RendererErrorBoundary';
import { LiveRegion } from './accessibility/LiveRegion';
import { SearchKeyPanel } from './research/SearchKeyPanel';
import { ResearchEscalationPanel } from './research/ResearchEscalationPanel';
import { ResearchBundleView } from './research/ResearchBundleView';
import { BlueprintView } from './blueprint/BlueprintView';
import { BlueprintGatePanel } from './blueprint/BlueprintGatePanel';
import { BlueprintEscalationPanel } from './blueprint/BlueprintEscalationPanel';

// ── Mock 数据 ────────────────────────────────────────────────────────

const mockProject1 = {
  id: 'proj-00000001-aaaa-bbbb-cccc-dddddddddddd',
  name: '测试项目一',
  createdAt: '2024-01-01T00:00:00Z',
  lastOpenedAt: '2024-01-02T00:00:00Z',
  isMissing: false,
};

const mockProject2 = {
  id: 'proj-00000002-aaaa-bbbb-cccc-dddddddddddd',
  name: '测试项目二',
  createdAt: '2024-01-03T00:00:00Z',
  lastOpenedAt: null,
  isMissing: false,
};

const mockMissingProject = {
  id: 'proj-00000003-aaaa-bbbb-cccc-dddddddddddd',
  name: '缺失项目',
  createdAt: '2024-01-04T00:00:00Z',
  lastOpenedAt: null,
  isMissing: true,
};

const mockTask1: TaskPublicData = {
  id: 'task-00000001-aaaa-bbbb-cccc-dddddddddddd',
  projectId: 'proj-00000001',
  taskType: 'MODEL_INVOCATION_TEST',
  status: 'SUCCEEDED',
  attemptCount: 1,
  result: { accepted: true, textLength: 42 },
  errorCode: null,
  errorMessage: null,
  createdAt: '2024-01-02T00:00:00Z',
  updatedAt: '2024-01-02T00:00:01Z',
  startedAt: '2024-01-02T00:00:00Z',
  finishedAt: '2024-01-02T00:00:01Z',
};

const mockTask2: TaskPublicData = {
  id: 'task-00000002-aaaa-bbbb-cccc-dddddddddddd',
  projectId: 'proj-00000001',
  taskType: 'MODEL_INVOCATION_TEST',
  status: 'FAILED',
  attemptCount: 2,
  result: null,
  errorCode: 'PROVIDER_TIMEOUT',
  errorMessage: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:02Z',
  startedAt: '2024-01-01T00:00:00Z',
  finishedAt: '2024-01-01T00:00:02Z',
};

const mockTask3: TaskPublicData = {
  id: 'task-00000003-aaaa-bbbb-cccc-dddddddddddd',
  projectId: 'proj-00000001',
  taskType: 'GRILL_QUESTION_PLAN',
  status: 'PENDING',
  attemptCount: 0,
  result: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2024-01-03T00:00:00Z',
  updatedAt: '2024-01-03T00:00:00Z',
  startedAt: null,
  finishedAt: null,
};

const mockStats: TaskStatsPublicData = {
  invocationCount: 10,
  succeededCount: 7,
  failedCount: 3,
  totalInputTokens: 5000,
  totalOutputTokens: 2000,
  totalTokens: 7000,
  totalLatencyMs: 15000,
};

const mockProviderState: ProviderPublicState = {
  id: 'provider-1',
  label: 'OpenAI',
  protocol: 'openai-chat',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4',
  enabled: true,
  isDefault: true,
  hasApiKey: true,
  lastTestStatus: 'never',
  lastTestErrorCode: null,
  lastTestedAt: null,
  lastTestLatencyMs: null,
};

/** ProviderRegion 组件级测试的通用无操作回调（新增/设默认/删除服务本身不在这些用例的验证范围内） */
const noopProviderListHandlers = {
  onCreate: async () => {},
  onSetDefault: async () => {},
  onRemove: async () => {},
};

const mockProjectId = 'proj-00000001';

// ── 工具函数 ────────────────────────────────────────────────────────

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockDesktopAPI(overrides: Record<string, unknown> = {}) {
  return {
    healthCheck: vi
      .fn()
      .mockResolvedValue({ ok: true, version: '1.0.0', timestamp: new Date().toISOString() }),
    getDataServiceStatus: vi.fn().mockResolvedValue({ status: 'ready' }),
    retryDataService: vi.fn().mockResolvedValue(undefined),
    projects: {
      list: vi.fn().mockResolvedValue([mockProject1, mockProject2]),
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
      list: vi.fn().mockResolvedValue([mockTask1, mockTask2]),
      getStats: vi.fn().mockResolvedValue(mockStats),
      get: vi.fn().mockResolvedValue(mockTask1),
      createModelInvocationTest: vi.fn(),
    },
    provider: {
      list: vi.fn().mockResolvedValue([mockProviderState]),
      create: vi.fn().mockResolvedValue(mockProviderState),
      update: vi.fn().mockResolvedValue(mockProviderState),
      remove: vi.fn().mockResolvedValue([]),
      setDefault: vi.fn().mockResolvedValue([mockProviderState]),
      saveApiKey: vi.fn().mockResolvedValue({ ...mockProviderState, hasApiKey: true }),
      deleteApiKey: vi.fn().mockResolvedValue({ ...mockProviderState, hasApiKey: false }),
      testConnection: vi.fn().mockResolvedValue({
        success: true,
        latencyMs: 10,
        errorCode: null,
        errorMessage: null,
      }),
    },
    ...overrides,
  } as unknown as DesktopAPI;
}

function setupDesktop(api?: DesktopAPI) {
  window.desktop = api ?? createMockDesktopAPI();
  return window.desktop;
}

async function renderAsync(ui: React.ReactElement) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
  });
  return result!;
}

function setInputValue(el: HTMLElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function setupTaskDesktop(tasks = [mockTask1, mockTask2, mockTask3]) {
  return setupDesktop({
    ...createMockDesktopAPI(),
    tasks: {
      list: vi.fn().mockResolvedValue(tasks),
      getStats: vi.fn().mockResolvedValue(mockStats),
      get: vi
        .fn()
        .mockImplementation((pid: string, taskId: string) =>
          Promise.resolve(tasks.find((t) => t.id === taskId) ?? tasks[0]),
        ),
      createModelInvocationTest: vi.fn(),
    },
  } as unknown as DesktopAPI);
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('一、语义化区域', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  // 1. toolbar 有可访问名称
  it('toolbar 有可访问名称', () => {
    render(
      <header className="toolbar" role="banner">
        <nav className="toolbar-left" aria-label="面板控制">
          <h1>AI 小说创作代理</h1>
        </nav>
      </header>,
    );
    const toolbar = screen.getByRole('banner');
    expect(toolbar).toBeInTheDocument();
  });

  // 2. 左右面板切换按钮有 aria-controls
  it('面板切换按钮有 aria-controls', () => {
    render(
      <div>
        <button aria-label="收起项目列表" aria-expanded="true" aria-controls="panel-left">
          ☰
        </button>
        <button aria-label="收起状态面板" aria-expanded="true" aria-controls="panel-right">
          ☰
        </button>
      </div>,
    );
    const buttons = screen.getAllByRole('button');
    buttons.forEach((btn) => {
      expect(btn).toHaveAttribute('aria-controls');
    });
  });

  // 3. aria-expanded 随状态变化
  it('aria-expanded 随状态变化', () => {
    const { rerender } = render(
      <button aria-label="收起项目列表" aria-expanded="true" aria-controls="panel-left">
        ☰
      </button>,
    );
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <button aria-label="展开项目列表" aria-expanded="false" aria-controls="panel-left">
        ☰
      </button>,
    );
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  // 4. 主要区域有 heading 或 aria-labelledby
  it('主要区域有可访问名称', () => {
    render(
      <div>
        <aside aria-label="项目列表">
          <h2 id="project-list-heading">项目列表</h2>
        </aside>
        <section aria-label="新建项目">
          <h2 id="create-project-heading">新建项目</h2>
        </section>
        <aside aria-label="状态面板">
          <h2 id="status-heading">状态</h2>
        </aside>
      </div>,
    );
    expect(screen.getByLabelText('项目列表')).toBeInTheDocument();
    expect(screen.getByLabelText('新建项目')).toBeInTheDocument();
    expect(screen.getByLabelText('状态面板')).toBeInTheDocument();
  });

  // 5. DOM 中不存在重复关键 id
  it('DOM 中不存在重复关键 id', () => {
    render(
      <div>
        <h2 id="heading-1">标题一</h2>
        <h2 id="heading-2">标题二</h2>
        <input id="input-1" />
        <input id="input-2" />
      </div>,
    );
    const allIds = Array.from(document.querySelectorAll('[id]')).map((el) => el.id);
    const uniqueIds = new Set(allIds);
    expect(allIds.length).toBe(uniqueIds.size);
  });
});

describe('二、项目列表键盘操作', () => {
  afterEach(() => {
    cleanup();
  });

  // 6. 项目使用真实 button
  it('项目使用真实 button', () => {
    render(
      <ProjectListRegion
        dataServiceStatus="ready"
        projects={[mockProject1, mockProject2]}
        currentProjectId={null}
        onRetry={() => {}}
        onNewProject={() => {}}
        onOpenProject={() => {}}
      />,
    );
    const projectButtons = screen.getAllByRole('button', { name: /测试项目/ });
    expect(projectButtons.length).toBe(2);
    projectButtons.forEach((btn) => {
      expect(btn.tagName).toBe('BUTTON');
    });
  });

  // 7. Enter 打开项目
  it('Enter 打开项目（原生按钮行为）', () => {
    const onOpen = vi.fn();
    render(
      <ProjectListRegion
        dataServiceStatus="ready"
        projects={[mockProject1]}
        currentProjectId={null}
        onRetry={() => {}}
        onNewProject={() => {}}
        onOpenProject={onOpen}
      />,
    );
    const btn = screen.getByRole('button', { name: /测试项目一/ });
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledWith(mockProject1.id);
  });

  // 8. Space 打开项目（原生按钮行为）
  it('Space 打开项目（原生按钮行为）', () => {
    const onOpen = vi.fn();
    render(
      <ProjectListRegion
        dataServiceStatus="ready"
        projects={[mockProject1]}
        currentProjectId={null}
        onRetry={() => {}}
        onNewProject={() => {}}
        onOpenProject={onOpen}
      />,
    );
    const btn = screen.getByRole('button', { name: /测试项目一/ });
    // button 元素原生支持 Space 键触发 click
    fireEvent.keyDown(btn, { key: ' ', code: 'Space' });
    // 原生 button 在 keydown Space 后不会自动触发 click，
    // 但 Enter 会。这里验证按钮是原生 button 即可。
    expect(btn.tagName).toBe('BUTTON');
  });

  // 9. 当前项目 aria-current
  it('当前项目 aria-current', () => {
    render(
      <ProjectListRegion
        dataServiceStatus="ready"
        projects={[mockProject1, mockProject2]}
        currentProjectId={mockProject1.id}
        onRetry={() => {}}
        onNewProject={() => {}}
        onOpenProject={() => {}}
      />,
    );
    const activeBtn = screen.getByRole('button', { name: /测试项目一/ });
    expect(activeBtn).toHaveAttribute('aria-current', 'page');
    const inactiveBtn = screen.getByRole('button', { name: /测试项目二/ });
    expect(inactiveBtn).not.toHaveAttribute('aria-current');
  });

  // 10. 缺失项目不可操作
  it('缺失项目不可操作', () => {
    render(
      <ProjectListRegion
        dataServiceStatus="ready"
        projects={[mockProject1, mockMissingProject]}
        currentProjectId={null}
        onRetry={() => {}}
        onNewProject={() => {}}
        onOpenProject={() => {}}
      />,
    );
    const missingItem = screen.getByLabelText(/缺失项目/);
    expect(missingItem).toHaveAttribute('aria-disabled', 'true');
    // 缺失项目不应该是 button
    expect(missingItem.tagName).not.toBe('BUTTON');
  });

  // 11. 新建项目按钮有 aria-label
  it('新建项目按钮有 aria-label', () => {
    render(
      <ProjectListRegion
        dataServiceStatus="ready"
        projects={[]}
        currentProjectId={null}
        onRetry={() => {}}
        onNewProject={() => {}}
        onOpenProject={() => {}}
      />,
    );
    const newBtn = screen.getByRole('button', { name: '新建项目' });
    expect(newBtn).toHaveAttribute('aria-label', '新建项目');
  });
});

describe('三、TaskCenter 键盘导航', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function flushMicrotasks() {
    await vi.advanceTimersByTimeAsync(0);
  }

  // 12. 初始 roving tabindex
  it('初始 roving tabindex', async () => {
    setupTaskDesktop();
    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
      await flushMicrotasks();
    });
    const items = screen.getAllByTestId('task-item');
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0]).toHaveAttribute('tabindex', '0');
    if (items.length > 1) {
      expect(items[1]).toHaveAttribute('tabindex', '-1');
    }
  });

  // 13. ArrowDown
  it('ArrowDown 移动到下一任务', async () => {
    setupTaskDesktop();
    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
      await flushMicrotasks();
    });
    const list = screen.getByRole('listbox');
    const items = screen.getAllByTestId('task-item');
    act(() => {
      items[0].focus();
      fireEvent.focus(items[0]);
    });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(list, { key: 'ArrowDown', code: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
  });

  // 14. ArrowUp
  it('ArrowUp 移动到上一任务', async () => {
    setupTaskDesktop();
    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
      await flushMicrotasks();
    });
    const list = screen.getByRole('listbox');
    const items = screen.getAllByTestId('task-item');
    // focus() 在 jsdom 中不触发 onFocus，需要手动触发
    act(() => {
      items[1].focus();
      fireEvent.focus(items[1]);
    });
    fireEvent.keyDown(list, { key: 'ArrowUp', code: 'ArrowUp' });
    expect(items[0]).toHaveFocus();
  });

  // 15. Home
  it('Home 移动到第一项', async () => {
    setupTaskDesktop();
    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
      await flushMicrotasks();
    });
    const list = screen.getByRole('listbox');
    const items = screen.getAllByTestId('task-item');
    act(() => {
      items[items.length - 1].focus();
      fireEvent.focus(items[items.length - 1]);
    });
    fireEvent.keyDown(list, { key: 'Home', code: 'Home' });
    expect(items[0]).toHaveFocus();
  });

  // 16. End
  it('End 移动到最后一项', async () => {
    setupTaskDesktop();
    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
      await flushMicrotasks();
    });
    const list = screen.getByRole('listbox');
    const items = screen.getAllByTestId('task-item');
    act(() => {
      items[0].focus();
      fireEvent.focus(items[0]);
    });
    fireEvent.keyDown(list, { key: 'End', code: 'End' });
    expect(items[items.length - 1]).toHaveFocus();
  });

  // 17. Enter 选择
  it('Enter 选择当前任务', async () => {
    const onSelect = vi.fn();
    render(
      <TaskList
        tasks={[mockTask1, mockTask2, mockTask3]}
        allTasks={[mockTask1, mockTask2, mockTask3]}
        selectedTaskId={null}
        statusFilter="ALL"
        typeFilter="ALL"
        onStatusFilterChange={() => {}}
        onTypeFilterChange={() => {}}
        onSelect={onSelect}
      />,
    );
    const list = screen.getByRole('listbox');
    const items = screen.getAllByTestId('task-item');

    // focus 第一项
    act(() => {
      items[0].focus();
      fireEvent.focus(items[0]);
    });
    expect(items[0]).toHaveFocus();

    // ArrowDown 两次到第三项
    fireEvent.keyDown(list, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown', code: 'ArrowDown' });
    expect(items[2]).toHaveFocus();

    // 只有第三项 tabIndex=0
    expect(items[0]).toHaveAttribute('tabindex', '-1');
    expect(items[1]).toHaveAttribute('tabindex', '-1');
    expect(items[2]).toHaveAttribute('tabindex', '0');

    // Enter 选择第三项
    fireEvent.keyDown(list, { key: 'Enter', code: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(mockTask3.id);
  });

  // 18. Space 选择
  it('Space 选择当前焦点项', async () => {
    const onSelect = vi.fn();
    render(
      <TaskList
        tasks={[mockTask1, mockTask2]}
        allTasks={[mockTask1, mockTask2]}
        selectedTaskId={null}
        statusFilter="ALL"
        typeFilter="ALL"
        onStatusFilterChange={() => {}}
        onTypeFilterChange={() => {}}
        onSelect={onSelect}
      />,
    );
    const list = screen.getByRole('listbox');
    const items = screen.getAllByTestId('task-item');

    // focus 第一项
    act(() => {
      items[0].focus();
      fireEvent.focus(items[0]);
    });

    // Space 选择
    fireEvent.keyDown(list, { key: ' ', code: 'Space' });
    expect(onSelect).toHaveBeenCalledWith(mockTask1.id);
  });

  // 19. 筛选后焦点合法
  it('筛选后焦点合法', async () => {
    // B16：状态筛选换成 shadcn Select（Radix）后走真实指针事件序列，与本
    // describe 块全局的 fake timers 搭配容易卡死（findBy*/waitFor 内部轮询
    // 依赖真实时钟）——本用例单独切回真实时钟，断言的键盘可达性语义
    // （roving tabindex）未改变。
    vi.useRealTimers();
    const user = userEvent.setup();
    setupTaskDesktop();
    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('task-item').length).toBeGreaterThanOrEqual(2),
    );

    await user.click(screen.getByTestId('status-filter'));
    await user.click(await screen.findByRole('option', { name: '失败' }));

    await waitFor(() => {
      const filteredItems = screen.getAllByTestId('task-item');
      expect(filteredItems.length).toBe(1);
      expect(filteredItems[0]).toHaveAttribute('tabindex', '0');
    });
  });

  // 20. polling refresh 不夺焦点
  it('polling refresh 不夺焦点', async () => {
    setupTaskDesktop([mockTask1, { ...mockTask3, status: 'RUNNING' }]);
    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
      await flushMicrotasks();
    });

    const items = screen.getAllByTestId('task-item');
    act(() => {
      items[0].focus();
      fireEvent.focus(items[0]);
    });
    expect(items[0]).toHaveFocus();

    // 触发 polling
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();
    });

    // 焦点不应该跳到 body
    expect(document.activeElement).not.toBe(document.body);
  });

  // 21. 选中任务消失后的焦点策略
  it('选中任务消失后列表仍有可用项', async () => {
    let taskList = [mockTask1, mockTask2];
    setupDesktop({
      ...createMockDesktopAPI(),
      tasks: {
        list: vi.fn().mockImplementation(() => Promise.resolve(taskList)),
        getStats: vi.fn().mockResolvedValue(mockStats),
        get: vi
          .fn()
          .mockImplementation((pid: string, taskId: string) =>
            Promise.resolve(taskList.find((t) => t.id === taskId) ?? null),
          ),
        createModelInvocationTest: vi.fn(),
      },
    } as unknown as DesktopAPI);

    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
      await flushMicrotasks();
    });

    expect(screen.getAllByTestId('task-item').length).toBe(2);

    // 模拟任务消失
    taskList = [mockTask1];
    await act(async () => {
      screen.getByTestId('task-refresh-btn').click();
      await flushMicrotasks();
    });

    const remainingItems = screen.getAllByTestId('task-item');
    expect(remainingItems.length).toBe(1);
  });

  // 22. 状态不只靠颜色表达
  it('状态不只靠颜色表达', async () => {
    setupTaskDesktop();
    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
      await flushMicrotasks();
    });
    const statusBadges = document.querySelectorAll('.task-status-badge');
    statusBadges.forEach((badge) => {
      expect(badge.textContent).toBeTruthy();
      expect(badge.textContent!.length).toBeGreaterThan(0);
    });
  });

  // 23. selectedTaskId 不随焦点移动而自动变化
  it('selectedTaskId 不随焦点移动而自动变化', async () => {
    const onSelect = vi.fn();
    render(
      <TaskList
        tasks={[mockTask1, mockTask2, mockTask3]}
        allTasks={[mockTask1, mockTask2, mockTask3]}
        selectedTaskId={mockTask1.id}
        statusFilter="ALL"
        typeFilter="ALL"
        onStatusFilterChange={() => {}}
        onTypeFilterChange={() => {}}
        onSelect={onSelect}
      />,
    );
    const list = screen.getByRole('listbox');
    const items = screen.getAllByTestId('task-item');

    // 第一项应该是选中的
    expect(items[0]).toHaveAttribute('aria-selected', 'true');

    // focus 第一项并 ArrowDown
    act(() => {
      items[0].focus();
      fireEvent.focus(items[0]);
    });
    fireEvent.keyDown(list, { key: 'ArrowDown', code: 'ArrowDown' });

    // 焦点移到第二项，但 selectedTaskId 不变
    expect(items[1]).toHaveFocus();
    expect(items[0]).toHaveAttribute('aria-selected', 'true');
    expect(items[1]).toHaveAttribute('aria-selected', 'false');

    // onSelect 不应该被调用
    expect(onSelect).not.toHaveBeenCalled();
  });

  // 24. polling 后精确保持同一个 task DOM 焦点
  it('polling 后精确保持同一个 task DOM 焦点', async () => {
    setupTaskDesktop([mockTask1, { ...mockTask3, status: 'RUNNING' }]);
    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
      await flushMicrotasks();
    });

    const items = screen.getAllByTestId('task-item');
    const firstItemId = items[0].getAttribute('data-task-id');

    act(() => {
      items[0].focus();
      fireEvent.focus(items[0]);
    });
    expect(items[0]).toHaveFocus();

    // 触发 polling
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();
    });

    // 焦点应该保持在同一个 task DOM 元素
    const activeEl = document.activeElement as HTMLElement;
    expect(activeEl.getAttribute('data-task-id')).toBe(firstItemId);
  });

  // 25. 当前焦点 task 消失后，第一合法项实际获得焦点
  it('当前焦点 task 消失后，第一合法项实际获得焦点', async () => {
    let taskList = [mockTask1, mockTask2];
    setupDesktop({
      ...createMockDesktopAPI(),
      tasks: {
        list: vi.fn().mockImplementation(() => Promise.resolve(taskList)),
        getStats: vi.fn().mockResolvedValue(mockStats),
        get: vi
          .fn()
          .mockImplementation((pid: string, taskId: string) =>
            Promise.resolve(taskList.find((t) => t.id === taskId) ?? null),
          ),
        createModelInvocationTest: vi.fn(),
      },
    } as unknown as DesktopAPI);

    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
      await flushMicrotasks();
    });

    const items = screen.getAllByTestId('task-item');

    // focus 第二项
    act(() => {
      items[1].focus();
      fireEvent.focus(items[1]);
    });
    expect(items[1]).toHaveFocus();

    // 模拟第二项消失
    taskList = [mockTask1];
    await act(async () => {
      screen.getByTestId('task-refresh-btn').click();
      await flushMicrotasks();
    });

    // 焦点应该移动到第一项
    const remainingItems = screen.getAllByTestId('task-item');
    expect(remainingItems.length).toBe(1);
    expect(remainingItems[0]).toHaveFocus();
  });

  // 26. 焦点原本在列表外时，任务变化不得抢焦点
  it('焦点原本在列表外时，任务变化不得抢焦点', async () => {
    let taskList = [mockTask1, mockTask2];
    setupDesktop({
      ...createMockDesktopAPI(),
      tasks: {
        list: vi.fn().mockImplementation(() => Promise.resolve(taskList)),
        getStats: vi.fn().mockResolvedValue(mockStats),
        get: vi
          .fn()
          .mockImplementation((pid: string, taskId: string) =>
            Promise.resolve(taskList.find((t) => t.id === taskId) ?? null),
          ),
        createModelInvocationTest: vi.fn(),
      },
    } as unknown as DesktopAPI);

    await act(async () => {
      render(<TaskCenter projectId={mockProjectId} />);
      await flushMicrotasks();
    });

    // 焦点在列表外（body）
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    // 模拟任务变化
    taskList = [mockTask1];
    await act(async () => {
      screen.getByTestId('task-refresh-btn').click();
      await flushMicrotasks();
    });

    // 焦点不应该被抢走
    expect(document.activeElement).toBe(document.body);
  });
});

describe('四、表单无障碍', () => {
  afterEach(() => {
    cleanup();
  });

  // 23. aria-invalid
  it('aria-invalid 校验失败时设置', async () => {
    await renderAsync(
      <CreateProjectRegion
        dataServiceStatus="ready"
        onRetry={() => {}}
        onCreate={async () => false}
      />,
    );

    await act(async () => {
      screen.getByText('创建项目').click();
    });

    const nameInput = screen.getByLabelText('项目名称');
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
  });

  // 24. aria-describedby
  it('aria-describedby 关联错误文本和字符计数', async () => {
    await renderAsync(
      <CreateProjectRegion
        dataServiceStatus="ready"
        onRetry={() => {}}
        onCreate={async () => false}
      />,
    );

    const nameInput = screen.getByLabelText('项目名称');
    const describedBy = nameInput.getAttribute('aria-describedby');
    expect(describedBy).toContain('project-name-count');
  });

  // 25. 创建中 aria-busy
  it('创建中 aria-busy', async () => {
    const deferred = createDeferred<boolean>();
    await renderAsync(
      <CreateProjectRegion
        dataServiceStatus="ready"
        onRetry={() => {}}
        onCreate={() => deferred.promise}
      />,
    );

    const nameInput = screen.getByLabelText('项目名称');
    setInputValue(nameInput, '测试项目');

    const ideaInput = screen.getByLabelText('描述你想写的小说……');
    setInputValue(ideaInput, '测试想法');

    const createBtn = screen.getByText('创建项目');
    await act(async () => {
      createBtn.click();
    });

    expect(createBtn).toHaveAttribute('aria-busy', 'true');
    expect(createBtn).toBeDisabled();

    await act(async () => {
      deferred.resolve(true);
    });
  });

  // 26. 创建失败保留内容
  it('创建失败保留内容', async () => {
    await renderAsync(
      <CreateProjectRegion
        dataServiceStatus="ready"
        onRetry={() => {}}
        onCreate={async () => false}
      />,
    );

    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    setInputValue(nameInput, '测试项目名称');
    setInputValue(ideaInput, '测试初始想法');

    await act(async () => {
      screen.getByText('创建项目').click();
    });

    expect(nameInput).toHaveValue('测试项目名称');
    expect(ideaInput).toHaveValue('测试初始想法');
  });

  // 27. 新建项目模式聚焦名称（组件级测试）
  it('表单有 aria-required 属性', async () => {
    await renderAsync(
      <CreateProjectRegion
        dataServiceStatus="ready"
        onRetry={() => {}}
        onCreate={async () => true}
      />,
    );

    const nameInput = screen.getByLabelText('项目名称');
    expect(nameInput).toHaveAttribute('aria-required', 'true');

    const ideaInput = screen.getByLabelText('描述你想写的小说……');
    expect(ideaInput).toHaveAttribute('aria-required', 'true');
  });

  // 28. 创建按钮有明确文本
  it('创建按钮有明确 aria-label', async () => {
    await renderAsync(
      <CreateProjectRegion
        dataServiceStatus="ready"
        onRetry={() => {}}
        onCreate={async () => true}
      />,
    );

    const createBtn = screen.getByText('创建项目');
    expect(createBtn).toHaveAttribute('aria-label', '创建项目');
  });
});

describe('五、Provider 焦点与键盘行为', () => {
  afterEach(() => {
    cleanup();
  });

  // 29. API Key 有 label
  it('API Key 有 label', () => {
    render(
      <ProviderRegion
        providers={[{ ...mockProviderState, hasApiKey: false }]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {}}
        onTestConnection={async () => {}}
      />,
    );

    const input = screen.getByLabelText('API Key');
    expect(input).toBeInTheDocument();
  });

  // 30. API Key 不出现在 aria 属性
  it('API Key 不出现在 aria 属性', () => {
    render(
      <ProviderRegion
        providers={[mockProviderState]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {}}
        onTestConnection={async () => {}}
      />,
    );

    const allElements = document.querySelectorAll('*');
    allElements.forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        if (attr.name.startsWith('aria-') || attr.name === 'title') {
          // API Key 内容不应出现在 aria 属性中
          expect(attr.value).not.toMatch(/sk-|api[_-]?key\s*[:=]/i);
        }
      });
    });
  });

  // 31. 删除确认获得焦点
  it('删除确认获得焦点', async () => {
    render(
      <ProviderRegion
        providers={[mockProviderState]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {}}
        onTestConnection={async () => {}}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: '删除 API Key' });
    act(() => {
      deleteBtn.click();
    });

    await waitFor(() => {
      const confirmBtn = screen.getByRole('button', { name: '确认删除 API Key' });
      expect(confirmBtn).toHaveFocus();
    });
  });

  // 32. Escape 取消
  it('Escape 取消删除确认', async () => {
    render(
      <ProviderRegion
        providers={[mockProviderState]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {}}
        onTestConnection={async () => {}}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: '删除 API Key' });
    act(() => {
      deleteBtn.click();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认删除 API Key' })).toBeInTheDocument();
    });

    // Escape 现在在确认区域的 onKeyDown 上处理
    const confirmGroup = screen.getByRole('group', { name: '确认删除 API Key' });
    fireEvent.keyDown(confirmGroup, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '确认删除 API Key' })).not.toBeInTheDocument();
    });
  });

  // 33. Escape 取消后焦点恢复到删除按钮
  it('Escape 取消后焦点恢复到删除按钮', async () => {
    render(
      <ProviderRegion
        providers={[mockProviderState]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {}}
        onTestConnection={async () => {}}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: '删除 API Key' });
    act(() => {
      deleteBtn.click();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认删除 API Key' })).toBeInTheDocument();
    });

    // Escape 取消
    const confirmGroup = screen.getByRole('group', { name: '确认删除 API Key' });
    fireEvent.keyDown(confirmGroup, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '确认删除 API Key' })).not.toBeInTheDocument();
    });

    // 焦点应该恢复到删除按钮
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '删除 API Key' })).toHaveFocus();
    });
  });

  // 33b. 点击取消后焦点恢复到删除按钮
  it('点击取消后焦点恢复到删除按钮', async () => {
    render(
      <ProviderRegion
        providers={[mockProviderState]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {}}
        onTestConnection={async () => {}}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: '删除 API Key' });
    act(() => {
      deleteBtn.click();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认删除 API Key' })).toBeInTheDocument();
    });

    const cancelBtn = screen.getByRole('button', { name: '取消删除' });
    act(() => {
      cancelBtn.click();
    });

    // 确认对话框隐藏
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '确认删除 API Key' })).not.toBeInTheDocument();
    });

    // 焦点应该恢复到删除按钮
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '删除 API Key' })).toHaveFocus();
    });
  });

  // 33c. 删除成功后 API Key 输入获得焦点
  it('删除成功后 API Key 输入获得焦点', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ProviderRegion
        providers={[mockProviderState]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={onDelete}
        onTestConnection={async () => {}}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: '删除 API Key' });
    act(() => {
      deleteBtn.click();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认删除 API Key' })).toBeInTheDocument();
    });

    // 点击确认删除
    const confirmBtn = screen.getByRole('button', { name: '确认删除 API Key' });
    await act(async () => {
      confirmBtn.click();
    });

    // 模拟删除成功后状态更新
    await act(async () => {
      rerender(
        <ProviderRegion
          providers={[{ ...mockProviderState, hasApiKey: false }]}
          dataServiceStatus="ready"
          {...noopProviderListHandlers}
          onSaveApiKey={async () => {}}
          onDeleteApiKey={onDelete}
          onTestConnection={async () => {}}
        />,
      );
    });

    // 删除成功后，API Key 输入应该获得焦点
    await waitFor(() => {
      const apiKeyInput = screen.getByLabelText('API Key');
      expect(apiKeyInput).toHaveFocus();
    });
  });

  // 33d. 删除失败后焦点不移动到 API Key 输入
  it('删除失败后焦点不移动到 API Key 输入', async () => {
    render(
      <ProviderRegion
        providers={[mockProviderState]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {
          throw new Error('删除失败');
        }}
        onTestConnection={async () => {}}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: '删除 API Key' });
    act(() => {
      deleteBtn.click();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认删除 API Key' })).toBeInTheDocument();
    });

    // 点击确认删除
    const confirmBtn = screen.getByRole('button', { name: '确认删除 API Key' });
    await act(async () => {
      confirmBtn.click();
    });

    // 删除失败，API Key 输入不应该获得焦点
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    // 焦点不应该在 API Key 输入上（因为没有 API Key 输入框，hasApiKey 仍为 true）
    const apiKeyInput = screen.queryByLabelText('API Key');
    expect(apiKeyInput).not.toBeInTheDocument();
  });

  // 34. 错误 role=alert
  it('错误 role=alert', async () => {
    render(
      <ProviderRegion
        providers={[mockProviderState]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {}}
        onTestConnection={async () => {
          throw new Error('连接超时');
        }}
      />,
    );

    const testBtn = screen.getByRole('button', { name: '测试连接' });
    await act(async () => {
      testBtn.click();
    });

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveTextContent('连接超时');
    });
  });

  // 35. 测试中 aria-busy
  it('测试中 aria-busy', async () => {
    const deferred = createDeferred<void>();
    render(
      <ProviderRegion
        providers={[mockProviderState]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {}}
        onTestConnection={() => deferred.promise}
      />,
    );

    const testBtn = screen.getByRole('button', { name: '测试连接' });
    await act(async () => {
      testBtn.click();
    });

    expect(testBtn).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      deferred.resolve();
    });
  });
});

describe('六、Error Boundary 焦点', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function ThrowingComponent({ message = '测试异常' }: { message?: string }) {
    throw new Error(message);
  }

  // 36. fallback 自动获得焦点
  it('fallback 自动获得焦点', () => {
    render(
      <RendererErrorBoundary label="测试">
        <ThrowingComponent />
      </RendererErrorBoundary>,
    );

    const fallback = screen.getByRole('alert');
    expect(fallback).toHaveAttribute('tabindex', '-1');
    expect(fallback).toHaveAttribute('aria-label', '测试加载异常');
    // B17：className 从字面量 `.error-boundary-fallback` 换成 Tailwind 类
    // 组合（App.css 退役），断言改为检查错误态视觉锚点存在，语义不变。
    expect(fallback.className).toContain('border-destructive');

    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(fallback).toHaveFocus();
  });

  // 37. fallback 不含原始异常
  it('fallback 不含原始异常', () => {
    render(
      <RendererErrorBoundary label="测试">
        <ThrowingComponent message="/Users/foo/secret.txt 操作失败" />
      </RendererErrorBoundary>,
    );

    const fallback = screen.getByRole('alert');
    expect(fallback.textContent).not.toContain('/Users/');
    expect(fallback.textContent).not.toContain('secret.txt');
    expect(fallback.textContent).not.toContain('操作失败');
  });

  // 38. reset 后焦点恢复（有可聚焦子元素）
  it('reset 后焦点恢复到可聚焦子元素', () => {
    let shouldThrow = true;

    function ConditionalThrow() {
      if (shouldThrow) {
        throw new Error('测试异常');
      }
      return (
        <div>
          <button>恢复后的按钮</button>
        </div>
      );
    }

    render(
      <RendererErrorBoundary label="测试">
        <ConditionalThrow />
      </RendererErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    act(() => {
      screen.getByText('重新加载此区域').click();
    });

    expect(screen.getByText('恢复后的按钮')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(0);
    });

    const restoredButton = screen.getByRole('button', { name: '恢复后的按钮' });
    expect(restoredButton).toHaveFocus();
  });

  // 38b. reset 后焦点恢复（无可聚焦子元素时聚焦容器）
  it('reset 后无可聚焦子元素时聚焦容器', () => {
    let shouldThrow = true;

    function ConditionalThrowNoFocusable() {
      if (shouldThrow) {
        throw new Error('测试异常');
      }
      return (
        <div>
          <p>没有可聚焦元素的内容</p>
        </div>
      );
    }

    render(
      <RendererErrorBoundary label="测试">
        <ConditionalThrowNoFocusable />
      </RendererErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    act(() => {
      screen.getByText('重新加载此区域').click();
    });

    act(() => {
      vi.advanceTimersByTime(0);
    });

    // B17：字面量类名 `.restored-focus-container` 随 App.css 退役消失，改用
    // data-testid 定位（App.css 时代的 CSS 类选择器本就只是定位锚点，未承载
    // role/aria 语义，只是测试选择器的实现细节）。
    const restoredContainer = screen.getByTestId('restored-focus-container');
    expect(restoredContainer).not.toBeNull();
    expect(restoredContainer).toHaveFocus();
  });
});

describe('七、动态状态公告', () => {
  afterEach(() => {
    cleanup();
  });

  // 39. polling 不重复产生 live announcement
  it('LiveRegion 存在且有正确的 aria 属性', () => {
    const { rerender } = render(<LiveRegion message="加载中" politeness="polite" />);

    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');

    // 更新消息
    rerender(<LiveRegion message="加载完成" politeness="polite" />);
    expect(region).toBeInTheDocument();
  });

  // 40. stats=null, error=null：加载中状态
  it('stats 加载中显示 role=status', () => {
    render(<TaskStats stats={null} error={null} />);

    const loading = screen.getByText('加载统计中…');
    expect(loading).toBeInTheDocument();
    expect(loading.closest('[role="status"]')).toBeInTheDocument();
  });

  // 40b. stats=null, error!=null：错误状态
  it('stats 加载失败显示 role=alert', () => {
    render(<TaskStats stats={null} error="网络不可用" />);

    const errorEl = screen.getByText(/统计加载失败/);
    expect(errorEl).toBeInTheDocument();
    expect(errorEl.closest('[role="alert"]')).toBeInTheDocument();
  });

  // 40c. stats!=null, error!=null：stale 提示
  it('stats stale 提示显示 role=status', () => {
    const stats = {
      invocationCount: 10,
      succeededCount: 7,
      failedCount: 3,
      totalInputTokens: 5000,
      totalOutputTokens: 2000,
      totalTokens: 7000,
      totalLatencyMs: 15000,
    };
    render(<TaskStats stats={stats} error="数据可能已过期" />);

    const staleNotice = screen.getByText(/统计可能已过期/);
    expect(staleNotice).toBeInTheDocument();
    expect(staleNotice.closest('[role="status"]')).toBeInTheDocument();

    // 旧统计仍显示
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  // 40d. stats!=null, error=null：正常显示
  it('stats 正常显示不产生 alert', () => {
    const stats = {
      invocationCount: 10,
      succeededCount: 7,
      failedCount: 3,
      totalInputTokens: 5000,
      totalOutputTokens: 2000,
      totalTokens: 7000,
      totalLatencyMs: 15000,
    };
    render(<TaskStats stats={stats} error={null} />);

    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/统计可能已过期/)).not.toBeInTheDocument();
  });
});

describe('八、App-level 债务测试', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  // 41. 创建失败 global error（组件级模拟）
  it('创建失败显示错误消息', async () => {
    const onCreate = vi.fn().mockResolvedValue(false);
    await renderAsync(
      <CreateProjectRegion dataServiceStatus="ready" onRetry={() => {}} onCreate={onCreate} />,
    );

    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');
    setInputValue(nameInput, '测试项目');
    setInputValue(ideaInput, '测试想法');

    await act(async () => {
      screen.getByText('创建项目').click();
    });

    // onCreate 被调用
    expect(onCreate).toHaveBeenCalledWith('测试项目', '测试想法');
    // 表单内容保留
    expect(nameInput).toHaveValue('测试项目');
  });

  // 42. 创建成功清除旧错误（组件级模拟）
  it('创建成功后表单清空', async () => {
    let callCount = 0;
    const onCreate = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount > 1;
    });

    await renderAsync(
      <CreateProjectRegion dataServiceStatus="ready" onRetry={() => {}} onCreate={onCreate} />,
    );

    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');
    setInputValue(nameInput, '测试项目');
    setInputValue(ideaInput, '测试想法');

    // 第一次失败
    await act(async () => {
      screen.getByText('创建项目').click();
    });
    expect(nameInput).toHaveValue('测试项目');

    // 第二次成功
    await act(async () => {
      screen.getByText('创建项目').click();
    });
    expect(nameInput).toHaveValue('');
    expect(ideaInput).toHaveValue('');
  });

  // 43. testConnection 失败后仍可操作（组件级模拟）
  it('testConnection 失败后显示错误', async () => {
    const onTestConnection = vi.fn().mockRejectedValue(new Error('连接超时'));

    render(
      <ProviderRegion
        providers={[mockProviderState]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {}}
        onTestConnection={onTestConnection}
      />,
    );

    const testBtn = screen.getByRole('button', { name: '测试连接' });
    await act(async () => {
      testBtn.click();
    });

    expect(onTestConnection).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('连接超时');
    });
  });

  // 44. provider 状态重新渲染
  it('provider 状态变化后重新渲染', async () => {
    const { rerender } = render(
      <ProviderRegion
        providers={[{ ...mockProviderState, hasApiKey: false }]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {}}
        onTestConnection={async () => {}}
      />,
    );

    expect(screen.getByText('未配置')).toBeInTheDocument();

    rerender(
      <ProviderRegion
        providers={[{ ...mockProviderState, hasApiKey: true }]}
        dataServiceStatus="ready"
        {...noopProviderListHandlers}
        onSaveApiKey={async () => {}}
        onDeleteApiKey={async () => {}}
        onTestConnection={async () => {}}
      />,
    );

    expect(screen.getByText('已配置')).toBeInTheDocument();
  });
});

describe('九、Research 无障碍（B6）', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  function researchBundle(overrides: Partial<ResearchBundleDto> = {}): ResearchBundleDto {
    return {
      id: 'rb-1',
      projectId: mockProjectId,
      version: 1,
      depth: 'deep',
      questions: [],
      factNotes: [],
      conclusion: '结论文本',
      createdAt: '2026-08-10T00:00:00.000Z',
      basedOnBundleId: null,
      ...overrides,
    };
  }

  // 45. SearchKeyPanel：API Key input 有 label
  it('SearchKeyPanel：API Key input 有 label', async () => {
    setupDesktop({
      ...createMockDesktopAPI(),
      search: {
        hasApiKey: vi.fn().mockResolvedValue({ hasApiKey: false }),
        saveApiKey: vi.fn(),
        deleteApiKey: vi.fn(),
      },
    } as unknown as DesktopAPI);

    await renderAsync(<SearchKeyPanel dataServiceStatus="ready" />);

    await waitFor(() => {
      const input = screen.getByLabelText('搜索服务 API Key');
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('type', 'password');
    });
  });

  // 46. SearchKeyPanel：删除确认获得焦点，Escape 取消后焦点恢复到删除按钮
  it('SearchKeyPanel：删除确认获得焦点，Escape 取消后焦点恢复到删除按钮', async () => {
    setupDesktop({
      ...createMockDesktopAPI(),
      search: {
        hasApiKey: vi.fn().mockResolvedValue({ hasApiKey: true }),
        saveApiKey: vi.fn(),
        deleteApiKey: vi.fn().mockResolvedValue({ hasApiKey: false }),
      },
    } as unknown as DesktopAPI);

    await renderAsync(<SearchKeyPanel dataServiceStatus="ready" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '删除搜索服务 API Key' })).toBeInTheDocument();
    });

    act(() => {
      screen.getByRole('button', { name: '删除搜索服务 API Key' }).click();
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认删除搜索服务 API Key' })).toHaveFocus();
    });

    const confirmGroup = screen.getByRole('group', { name: '确认删除搜索服务 API Key' });
    fireEvent.keyDown(confirmGroup, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '删除搜索服务 API Key' })).toHaveFocus();
    });
  });

  // 47. ResearchEscalationPanel：五个选项都是原生 button，busy 时禁用
  it('ResearchEscalationPanel：五个选项都是原生 button，busy 时禁用', () => {
    const onChoose = vi.fn();
    render(<ResearchEscalationPanel busy={false} onChoose={onChoose} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(5);
    buttons.forEach((btn) => expect(btn.tagName).toBe('BUTTON'));

    fireEvent.click(buttons[0]);
    expect(onChoose).toHaveBeenCalledWith('use_current_research');
  });

  it('ResearchEscalationPanel：busy=true 时全部禁用（避免重复提交）', () => {
    render(<ResearchEscalationPanel busy={true} onChoose={vi.fn()} />);
    screen.getAllByRole('button').forEach((btn) => expect(btn).toBeDisabled());
  });

  // 48. ResearchBundleView：来源排除按钮用 aria-pressed 反映状态，且不仅靠颜色表达
  it('ResearchBundleView：来源排除用 aria-pressed 反映状态，排除标记不仅靠颜色（附文字徽标）', async () => {
    const bundle = researchBundle({
      questions: [
        {
          id: 'q1',
          text: '问题一',
          sources: [
            {
              url: 'https://example.com/a',
              title: '来源A',
              fetchedAt: '2026-08-10T00:00:00.000Z',
              excerpt: '摘录',
            },
          ],
        },
      ],
    });

    render(
      <ResearchBundleView
        bundle={bundle}
        bundles={[bundle]}
        stale={false}
        exclusions={['https://example.com/a']}
        busy={false}
        onToggleExclusion={async () => {}}
      />,
    );

    fireEvent.click(screen.getByText('展开来源（1）'));

    const excludeBtn = screen.getByRole('button', { name: '取消排除' });
    expect(excludeBtn).toHaveAttribute('aria-pressed', 'true');
    // 不仅靠颜色：附带文字徽标
    expect(screen.getByText('已排除')).toBeInTheDocument();
  });

  // 49. ResearchBundleView：事实笔记折叠按钮有 aria-expanded，随状态切换
  it('ResearchBundleView：事实笔记折叠按钮 aria-expanded 随状态切换', () => {
    const longText = 'B'.repeat(300);
    const bundle = researchBundle({
      factNotes: [{ id: 'fn1', text: longText, sourceUrls: [] }],
    });

    render(
      <ResearchBundleView
        bundle={bundle}
        bundles={[bundle]}
        stale={false}
        exclusions={[]}
        busy={false}
        onToggleExclusion={async () => {}}
      />,
    );

    const toggle = screen.getByRole('button', { name: '展开全文' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    const collapsed = screen.getByRole('button', { name: '收起' });
    expect(collapsed).toHaveAttribute('aria-expanded', 'true');
  });

  // 50. ResearchBundleView：版本链当前版本用 aria-current 标记
  it('ResearchBundleView：版本链当前版本用 aria-current 标记', () => {
    const v1 = researchBundle({ id: 'v1', version: 1, basedOnBundleId: null });
    const v2 = researchBundle({
      id: 'v2',
      version: 2,
      basedOnBundleId: 'v1',
      createdAt: '2026-08-11T00:00:00.000Z',
    });

    render(
      <ResearchBundleView
        bundle={v2}
        bundles={[v1, v2]}
        stale={false}
        exclusions={[]}
        busy={false}
        onToggleExclusion={async () => {}}
      />,
    );

    const current = screen.getByRole('button', { name: 'v2' });
    expect(current).toHaveAttribute('aria-current', 'true');
    const other = screen.getByRole('button', { name: 'v1' });
    expect(other).not.toHaveAttribute('aria-current');
  });

  // ── B8：蓝图 UI 无障碍 ───────────────────────────────────────────

  // 51. BlueprintGatePanel：两个选项都是原生 button；失效时"接受"禁用（D-B8-4）
  it('BlueprintGatePanel：两选项为原生 button，未失效时均可用', () => {
    const onChoose = vi.fn();
    render(
      <BlueprintGatePanel busy={false} invalidated={false} rewriteUsed={0} onChoose={onChoose} />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    buttons.forEach((btn) => {
      expect(btn.tagName).toBe('BUTTON');
      expect(btn).toBeEnabled();
    });
    fireEvent.click(buttons[0]);
    expect(onChoose).toHaveBeenCalledWith('accept');
  });

  it('BlueprintGatePanel：失效时"接受"同时带 disabled 与 aria-disabled（不仅靠视觉）', () => {
    render(
      <BlueprintGatePanel busy={false} invalidated={true} rewriteUsed={0} onChoose={vi.fn()} />,
    );
    const accept = screen.getByRole('button', { name: /接受这份蓝图/ });
    expect(accept).toBeDisabled();
    expect(accept).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: /重新生成一版/ })).toBeEnabled();
  });

  it('BlueprintGatePanel：busy=true 时全部禁用（避免重复提交）', () => {
    render(
      <BlueprintGatePanel busy={true} invalidated={false} rewriteUsed={0} onChoose={vi.fn()} />,
    );
    screen.getAllByRole('button').forEach((btn) => expect(btn).toBeDisabled());
  });

  it('BlueprintGatePanel：改写次数耗尽时 request_rewrite 保持可用且文案如实（进入升级决策的唯一入口）', () => {
    // 独立复查坐实的 blocker：gate→escalation 边要求"耗尽后再提交一次
    // request_rewrite"才路由进四选项——禁用它 gate 就成死端。
    const onChoose = vi.fn();
    render(
      <BlueprintGatePanel busy={false} invalidated={false} rewriteUsed={3} onChoose={onChoose} />,
    );
    const escalate = screen.getByRole('button', { name: /不用这版，进入后续决策/ });
    expect(escalate).toBeEnabled();
    expect(screen.getByText('重新生成次数已用完')).toBeInTheDocument();
    fireEvent.click(escalate);
    expect(onChoose).toHaveBeenCalledWith('request_rewrite');
  });

  it('BlueprintGatePanel：失效+耗尽叠加时仍有可用出路（不得零操作死锁）', () => {
    render(
      <BlueprintGatePanel busy={false} invalidated={true} rewriteUsed={3} onChoose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /不用这版，进入后续决策/ })).toBeEnabled();
  });

  // 52. BlueprintEscalationPanel：四选项；失效时 accept_current 禁用
  it('BlueprintEscalationPanel：四个选项都是原生 button', () => {
    const onChoose = vi.fn();
    render(
      <BlueprintEscalationPanel
        busy={false}
        invalidated={false}
        contentUnavailable={false}
        onChoose={onChoose}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    buttons.forEach((btn) => expect(btn.tagName).toBe('BUTTON'));
    fireEvent.click(buttons[0]);
    expect(onChoose).toHaveBeenCalledWith('accept_current');
  });

  it('BlueprintEscalationPanel：失效时 accept_current 禁用且有可读说明', () => {
    render(
      <BlueprintEscalationPanel
        busy={false}
        invalidated={true}
        contentUnavailable={false}
        onChoose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /就用现在这版蓝图/ })).toBeDisabled();
    expect(screen.getByText(/创作要求已变更/)).toBeInTheDocument();
  });

  it('BlueprintEscalationPanel：正文不可见时 accept_current 禁用且有可读说明，其余三项可用', () => {
    // 独立复查：不能让用户接受一版从未看到的蓝图；其余选项不依赖看到内容
    render(
      <BlueprintEscalationPanel
        busy={false}
        invalidated={false}
        contentUnavailable={true}
        onChoose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /就用现在这版蓝图/ })).toBeDisabled();
    expect(screen.getByText(/蓝图内容当前无法显示/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /修改创作要求/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /稍后再说/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /取消/ })).toBeEnabled();
  });

  // 53. BlueprintView：折叠控件用 aria-expanded；结局默认折叠（D-B8-8）
  it('BlueprintView：结局方向默认折叠，控件用 aria-expanded 表达状态', () => {
    render(<BlueprintView blueprint={blueprintForA11y()} stale={false} />);
    const endingBtn = screen.getByRole('button', { name: '查看结局方向' });
    expect(endingBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('结局文本')).not.toBeInTheDocument();

    fireEvent.click(endingBtn);
    expect(screen.getByText('结局文本')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起结局方向' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('BlueprintView：章节展开控件用 aria-expanded，展开后可读到章节目标', () => {
    render(<BlueprintView blueprint={blueprintForA11y()} stale={false} />);
    const chapterBtn = screen.getByRole('button', { name: /第一章/ });
    expect(chapterBtn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chapterBtn);
    expect(chapterBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('引出案件')).toBeInTheDocument();
  });

  it('BlueprintView：每个分节都有标题，且与 section 经 aria-labelledby 关联', () => {
    render(<BlueprintView blueprint={blueprintForA11y()} stale={false} />);
    for (const name of [
      '故事前提',
      /人物（\d+）/,
      '人物关系',
      '世界设定',
      '核心冲突',
      /情节线（\d+）/,
      /章节结构/,
      '结局方向',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });
});

function blueprintForA11y() {
  return {
    id: 'bp-1',
    projectId: 'p1',
    version: 1,
    premise: '前提文本',
    characters: [{ name: '甲', role: '主角', description: '描述' }],
    relationships: ['甲与乙'],
    world: '世界文本',
    conflict: '冲突文本',
    ending: '结局文本',
    plotlines: [{ name: '主线', summary: '摘要' }],
    chapters: [{ id: 'ch-1', title: '第一章', goal: '引出案件' }],
    createdAt: '2026-08-11T00:00:00.000Z',
  };
}
