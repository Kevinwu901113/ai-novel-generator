// @vitest-environment jsdom
/**
 * 任务活动中心 DOM 交互测试。
 *
 * 使用 jsdom + React Testing Library 验证真实 DOM 行为。
 * 使用 fake timers 和 deferred Promise 验证竞态。
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { TaskCenter } from './TaskCenter';
import type { TaskPublicData, TaskStatsPublicData, DesktopAPI } from '@ai-novel/contracts';

// ── Mock 数据 ────────────────────────────────────────────────────────

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

const mockTaskPending: TaskPublicData = {
  id: 'task-00000003-aaaa-bbbb-cccc-dddddddddddd',
  projectId: 'proj-00000001',
  taskType: 'MODEL_INVOCATION_TEST',
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

const mockTaskRunning: TaskPublicData = {
  id: 'task-00000004-aaaa-bbbb-cccc-dddddddddddd',
  projectId: 'proj-00000001',
  taskType: 'GRILL_QUESTION_PLAN',
  status: 'RUNNING',
  attemptCount: 1,
  result: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2024-01-03T00:01:00Z',
  updatedAt: '2024-01-03T00:01:00Z',
  startedAt: '2024-01-03T00:01:00Z',
  finishedAt: null,
};

const mockTaskWithUnsafeResult: TaskPublicData = {
  id: 'task-00000005-aaaa-bbbb-cccc-dddddddddddd',
  projectId: 'proj-00000001',
  taskType: 'MODEL_INVOCATION_TEST',
  status: 'SUCCEEDED',
  attemptCount: 1,
  result: { accepted: true, textLength: 100, prompt: 'secret prompt', path: '/Users/foo' },
  errorCode: null,
  errorMessage: null,
  createdAt: '2024-01-04T00:00:00Z',
  updatedAt: '2024-01-04T00:00:01Z',
  startedAt: '2024-01-04T00:00:00Z',
  finishedAt: '2024-01-04T00:00:01Z',
};

const mockTaskUnknownType: TaskPublicData = {
  id: 'task-00000006-aaaa-bbbb-cccc-dddddddddddd',
  projectId: 'proj-00000001',
  taskType: 'FUTURE_TASK_TYPE',
  status: 'SUCCEEDED',
  attemptCount: 1,
  result: { data: 'some result' },
  errorCode: null,
  errorMessage: null,
  createdAt: '2024-01-05T00:00:00Z',
  updatedAt: '2024-01-05T00:00:01Z',
  startedAt: '2024-01-05T00:00:00Z',
  finishedAt: '2024-01-05T00:00:01Z',
};

const mockTaskWithStackError: TaskPublicData = {
  id: 'task-00000007-aaaa-bbbb-cccc-dddddddddddd',
  projectId: 'proj-00000001',
  taskType: 'MODEL_INVOCATION_TEST',
  status: 'FAILED',
  attemptCount: 1,
  result: null,
  errorCode: null,
  errorMessage: 'Error: fail\n    at Object.<anonymous> (/Users/foo/bar.ts:10:5)',
  createdAt: '2024-01-06T00:00:00Z',
  updatedAt: '2024-01-06T00:00:01Z',
  startedAt: '2024-01-06T00:00:00Z',
  finishedAt: '2024-01-06T00:00:01Z',
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

const mockProjectId = 'proj-00000001';

// ── Deferred Promise 工具 ────────────────────────────────────────────

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 异步渲染组件并等待所有状态更新完成。
 * 使用 act() 包裹 render 和 flushMicrotasks 以避免 act warnings。
 */
async function renderAsync(ui: React.ReactElement) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
    await flushMicrotasks();
  });
  return result!;
}

// ── Mock DesktopAPI 工厂 ────────────────────────────────────────────

function createMockTasksAPI(
  overrides: {
    list?: (...args: ReadonlyArray<unknown>) => Promise<ReadonlyArray<TaskPublicData>>;
    getStats?: (...args: ReadonlyArray<unknown>) => Promise<TaskStatsPublicData>;
    get?: (...args: ReadonlyArray<unknown>) => Promise<TaskPublicData>;
  } = {},
) {
  return {
    list: overrides.list ?? vi.fn().mockResolvedValue([mockTask1, mockTask2]),
    get: overrides.get ?? vi.fn().mockResolvedValue(mockTask1),
    getStats: overrides.getStats ?? vi.fn().mockResolvedValue(mockStats),
    createModelInvocationTest: vi.fn(),
  };
}

function setupDesktop(tasksAPI: ReturnType<typeof createMockTasksAPI>) {
  window.desktop = { tasks: tasksAPI } as unknown as DesktopAPI;
  return tasksAPI;
}

/**
 * 将 document.hidden 设置为指定值并触发 visibilitychange。
 * 使用 act() 确保 React 状态更新和效果清理完成。
 */
function setDocumentHidden(hidden: boolean) {
  act(() => {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/**
 * 刷新微任务，让 React 状态更新和效果完成。
 * 不推进 fake timer 时钟。
 */
async function flushMicrotasks() {
  await vi.advanceTimersByTimeAsync(0);
}

// ── 测试 ─────────────────────────────────────────────────────────────

describe('TaskCenter DOM 交互', () => {
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

  // 1. 当前项目加载 tasks.list 和 getStats
  it('加载时调用 tasks.list 和 getStats', async () => {
    const api = setupDesktop(createMockTasksAPI());
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(api.list).toHaveBeenCalledWith(mockProjectId);
    expect(api.getStats).toHaveBeenCalledWith(mockProjectId);
  });

  // 2. 列表 createdAt 降序
  it('列表按 createdAt 降序排列', async () => {
    setupDesktop(createMockTasksAPI());
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    const items = screen.getAllByTestId('task-item');
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[1]).toHaveTextContent('失败');
  });

  // 3. 状态筛选
  it('状态筛选只显示匹配的任务', async () => {
    setupDesktop(createMockTasksAPI());
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(screen.getAllByTestId('task-item').length).toBe(2);

    const select = screen.getByTestId('status-filter');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
      select,
      'FAILED',
    );
    act(() => {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const items = screen.getAllByTestId('task-item');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('失败');
  });

  // 4. 类型筛选
  it('类型筛选只显示匹配的任务', async () => {
    const tasks = [mockTask1, mockTaskUnknownType];
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue(tasks) }));
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(screen.getAllByTestId('task-item').length).toBe(2);

    const select = screen.getByTestId('type-filter');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
      select,
      'FUTURE_TASK_TYPE',
    );
    act(() => {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(screen.getAllByTestId('task-item')).toHaveLength(1);
  });

  // 5. 未知任务类型 fallback
  it('未知任务类型显示安全 fallback', async () => {
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([mockTaskUnknownType]) }));
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(screen.getAllByText(/未知任务/).length).toBeGreaterThanOrEqual(1);
  });

  // 6. 点击任务显示详情
  it('点击任务显示详情', async () => {
    setupDesktop(createMockTasksAPI());
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(screen.getAllByTestId('task-item').length).toBeGreaterThan(0);
    expect(screen.getByTestId('task-detail-empty')).toBeInTheDocument();

    act(() => {
      screen.getAllByTestId('task-item')[0].click();
    });

    expect(screen.getByTestId('task-detail')).toBeInTheDocument();
  });

  // 7. 不显示完整 task/project ID
  it('不显示完整 task ID 或 project ID', async () => {
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([mockTask1]) }));
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    act(() => {
      screen.getAllByTestId('task-item')[0].click();
    });

    expect(screen.getByTestId('task-detail')).toBeInTheDocument();

    const allText = document.body.textContent;
    expect(allText).not.toContain(mockTask1.id);
    expect(allText).not.toContain(mockProjectId);
    expect(allText).toContain(mockTask1.id.slice(0, 8));
  });

  // 8. MODEL_INVOCATION_TEST 安全结果
  it('MODEL_INVOCATION_TEST 有效结果正确显示', async () => {
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([mockTask1]) }));
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    act(() => {
      screen.getAllByTestId('task-item')[0].click();
    });

    const detail = screen.getByTestId('task-detail');
    expect(detail.textContent).toContain('接受');
    expect(detail.textContent).toContain('42');
  });

  // 9. 未知类型不渲染原始 result
  it('未知类型不渲染原始 result', async () => {
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([mockTaskUnknownType]) }));
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    act(() => {
      screen.getAllByTestId('task-item')[0].click();
    });

    const detail = screen.getByTestId('task-detail');
    expect(detail.textContent).toContain('任务结果已保存');
    expect(detail.textContent).not.toContain('some result');
    expect(detail.textContent).not.toContain('data');
  });

  // 10. result 中的 prompt/path/secret 不进入 DOM
  it('result 中的敏感字段不进入 DOM', async () => {
    setupDesktop(
      createMockTasksAPI({ list: vi.fn().mockResolvedValue([mockTaskWithUnsafeResult]) }),
    );
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    act(() => {
      screen.getAllByTestId('task-item')[0].click();
    });

    const allText = document.body.textContent;
    expect(allText).not.toContain('secret prompt');
    expect(allText).not.toContain('/Users/foo');
    expect(allText).not.toContain('prompt');
  });

  // 11. error path/stack 清理
  it('错误消息中的路径和 stack 被清理', async () => {
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([mockTaskWithStackError]) }));
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    act(() => {
      screen.getAllByTestId('task-item')[0].click();
    });

    const allText = document.body.textContent;
    expect(allText).not.toContain('/Users/');
    expect(allText).not.toContain('at Object');
    expect(allText).toContain('任务执行出现错误');
  });

  // 12. 空状态
  it('未打开项目时显示空状态', () => {
    setupDesktop(createMockTasksAPI());
    render(<TaskCenter projectId={null} />);

    expect(screen.getByTestId('task-center-empty')).toBeInTheDocument();
    expect(screen.getByText('请先打开项目')).toBeInTheDocument();
  });

  // 13. list 失败状态
  it('list 失败时显示错误', async () => {
    setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockRejectedValue(new Error('网络错误')),
      }),
    );
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(screen.getByTestId('task-error')).toBeInTheDocument();
    expect(screen.getByText(/网络错误/)).toBeInTheDocument();
  });

  // 14. stats 失败不清空任务列表
  it('stats 失败不影响任务列表显示', async () => {
    setupDesktop(
      createMockTasksAPI({
        getStats: vi.fn().mockRejectedValue(new Error('stats 错误')),
      }),
    );
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(screen.getAllByTestId('task-item').length).toBe(2);
    expect(screen.getByText(/统计加载失败/)).toBeInTheDocument();
  });

  // 15. active task 时建立 2 秒轮询
  it('存在活跃任务时建立 2 秒轮询', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTaskPending, mockTask1]),
      }),
    );
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(api.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(2);
  });

  // 16. 全部结束后停止轮询
  it('全部任务终态后停止轮询', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTask1, mockTask2]),
      }),
    );
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(api.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(1);
  });

  // 17. project 切换停止旧轮询
  it('project 切换停止旧轮询', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTaskPending]),
      }),
    );
    let rerender: ReturnType<typeof render>['rerender'];
    await act(async () => {
      const result = render(<TaskCenter projectId={mockProjectId} />);
      rerender = result.rerender;
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(<TaskCenter projectId="proj-00000002" />);
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledWith('proj-00000002');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledWith('proj-00000002');
  });

  // 18. 旧项目慢响应不能覆盖新项目
  it('旧项目慢响应不覆盖新项目', async () => {
    const deferred = createDeferred<ReadonlyArray<TaskPublicData>>();

    // 根据 projectId 返回不同结果
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockImplementation((pid: string) => {
          if (pid === mockProjectId) return deferred.promise;
          return Promise.resolve([mockTask1]);
        }),
      }),
    );

    let rerender: ReturnType<typeof render>['rerender'];
    await act(async () => {
      const result = render(<TaskCenter projectId={mockProjectId} />);
      rerender = result.rerender;
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(1);

    // 切换到新项目
    await act(async () => {
      rerender(<TaskCenter projectId="proj-00000002" />);
      await flushMicrotasks();
    });

    // 新项目应显示 mockTask1
    expect(screen.getAllByTestId('task-item').length).toBe(1);

    // 旧项目的 deferred 现在才 resolve — 不应覆盖新项目数据
    deferred.resolve([mockTaskPending, mockTaskRunning]);
    await flushMicrotasks();

    const items = screen.getAllByTestId('task-item');
    expect(items).toHaveLength(1);
  });

  // 19. unmount 清理 timer
  it('unmount 清理轮询 timer', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTaskPending]),
      }),
    );
    let unmount: ReturnType<typeof render>['unmount'];
    await act(async () => {
      const result = render(<TaskCenter projectId={mockProjectId} />);
      unmount = result.unmount;
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(1);
  });

  // 20. hidden 后停止轮询
  it('hidden 后停止轮询', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTaskPending]),
      }),
    );
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(api.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      setDocumentHidden(true);
      await flushMicrotasks();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(1);
  });

  // 21. visible 后立即 refresh 并继续轮询
  it('visible 后立即 refresh 并继续轮询', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTaskPending]),
      }),
    );
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(api.list).toHaveBeenCalledTimes(1);

    // 隐藏
    setDocumentHidden(true);
    await flushMicrotasks();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(1);

    // 恢复可见 → 立即刷新
    await act(async () => {
      setDocumentHidden(false);
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(2);

    // 再推进 2 秒 → 继续轮询
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(3);
  });

  // 22. 反复 hidden/visible 不产生多个 interval
  it('反复 hidden/visible 不产生多个 interval', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTaskPending]),
      }),
    );
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(api.list).toHaveBeenCalledTimes(1);

    // 反复切换 3 次
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        setDocumentHidden(true);
        await flushMicrotasks();
        setDocumentHidden(false);
        await flushMicrotasks();
      });
    }

    const countBefore = api.list.mock.calls.length;

    // 推进 2 秒 — 应只有一次轮询触发
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();
    });

    expect(api.list.mock.calls.length).toBe(countBefore + 1);
  });

  // 23. 项目 A 请求 deferred，切换 B，A 返回不能解除 B 的 refresh lock
  it('A 请求 deferred → 切换 B → A 返回不能解除 B 的 lock', async () => {
    const deferredA = createDeferred<ReadonlyArray<TaskPublicData>>();
    const deferredB = createDeferred<ReadonlyArray<TaskPublicData>>();

    let bCallCount = 0;
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockImplementation((pid: string) => {
          if (pid === mockProjectId) return deferredA.promise;
          bCallCount++;
          if (bCallCount === 1) return deferredB.promise;
          return Promise.resolve([mockTask1]);
        }),
        getStats: vi.fn().mockResolvedValue(mockStats),
      }),
    );

    let rerender: ReturnType<typeof render>['rerender'];
    await act(async () => {
      const result = render(<TaskCenter projectId={mockProjectId} />);
      rerender = result.rerender;
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(1);

    // 切换到项目 B
    await act(async () => {
      rerender(<TaskCenter projectId="proj-00000002" />);
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(2);

    // A 请求返回 — 不应解除 B 的 lock
    await act(async () => {
      deferredA.resolve([mockTaskPending]);
      await flushMicrotasks();
    });

    // B 请求返回
    await act(async () => {
      deferredB.resolve([mockTask1]);
      await flushMicrotasks();
    });

    expect(screen.getAllByTestId('task-item').length).toBe(1);

    // 再次刷新应可以正常工作（B 的 lock 已解除）
    await act(async () => {
      screen.getByTestId('task-refresh-btn').click();
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(3);
  });

  // 24. B 请求未完成时重复刷新只调用一次
  it('B 请求未完成时重复刷新只调用一次', async () => {
    const deferredB = createDeferred<ReadonlyArray<TaskPublicData>>();

    let callIndex = 0;
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockImplementation(() => {
          callIndex++;
          if (callIndex === 1) return Promise.resolve([mockTaskPending]);
          return deferredB.promise;
        }),
      }),
    );

    let rerender: ReturnType<typeof render>['rerender'];
    await act(async () => {
      const result = render(<TaskCenter projectId={mockProjectId} />);
      rerender = result.rerender;
      await flushMicrotasks();
    });

    expect(api.list).toHaveBeenCalledTimes(1);

    // 切换到 B，触发新的 refresh
    act(() => {
      rerender(<TaskCenter projectId="proj-00000002" />);
    });
    await flushMicrotasks();

    expect(api.list).toHaveBeenCalledTimes(2);

    // 重复点击刷新 — B 的请求仍在进行中
    const btn = screen.getByTestId('task-refresh-btn');
    await act(async () => {
      btn.click();
      btn.click();
      btn.click();
      await flushMicrotasks();
    });

    // 仍然只有 2 次调用
    expect(api.list).toHaveBeenCalledTimes(2);

    await act(async () => {
      deferredB.resolve([mockTask1]);
      await flushMicrotasks();
    });
  });

  // 25. list rejection 含 /Users/... 时 DOM 不泄露
  it('list rejection 含路径时 DOM 不泄露', async () => {
    setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockRejectedValue(new Error('query failed at /Users/foo/db.sqlite')),
      }),
    );
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(screen.getByTestId('task-error')).toBeInTheDocument();

    const allText = document.body.textContent;
    expect(allText).not.toContain('/Users/');
    expect(allText).not.toContain('.sqlite');
    expect(allText).toContain('加载任务列表失败');
  });

  // 26. stats rejection 含 stack/.sqlite 时 DOM 不泄露
  it('stats rejection 含 stack/.sqlite 时 DOM 不泄露', async () => {
    setupDesktop(
      createMockTasksAPI({
        getStats: vi
          .fn()
          .mockRejectedValue(new Error('Error\n    at Object.<anonymous> (data.sqlite)')),
      }),
    );
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    expect(screen.getByText(/统计加载失败/)).toBeInTheDocument();

    const allText = document.body.textContent;
    expect(allText).not.toContain('/Users/');
    expect(allText).not.toContain('.sqlite');
    expect(allText).not.toContain('at Object');
  });

  // 27. 切换项目重置 status/type filter
  it('切换项目重置 status/type filter', async () => {
    const api = setupDesktop(createMockTasksAPI());
    let rerender: ReturnType<typeof render>['rerender'];
    await act(async () => {
      const result = render(<TaskCenter projectId={mockProjectId} />);
      rerender = result.rerender;
      await flushMicrotasks();
    });

    expect(screen.getAllByTestId('task-item').length).toBe(2);

    // 设置筛选
    const statusSelect = screen.getByTestId('status-filter');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
      statusSelect,
      'FAILED',
    );
    act(() => {
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(screen.getAllByTestId('task-item').length).toBe(1);

    // 切换项目
    api.list.mockResolvedValue([mockTask1]);
    await act(async () => {
      rerender(<TaskCenter projectId="proj-00000002" />);
      await flushMicrotasks();
    });

    expect(screen.getByTestId('status-filter')).toHaveValue('ALL');
  });

  // 28. GRILL_QUESTION_PLAN 类型安全显示
  it('GRILL_QUESTION_PLAN 类型安全显示', async () => {
    const grillTask: TaskPublicData = {
      ...mockTaskRunning,
      status: 'SUCCEEDED',
      result: { questions: [{ text: 'test' }] },
      finishedAt: '2024-01-03T00:02:00Z',
    };
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([grillTask]) }));
    await renderAsync(<TaskCenter projectId={mockProjectId} />);

    act(() => {
      screen.getAllByTestId('task-item')[0].click();
    });

    expect(screen.getByTestId('task-detail')).toBeInTheDocument();
    expect(screen.getAllByText('Grill 问题规划').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('规划任务结果已保存')).toBeInTheDocument();
    const allText = document.body.textContent;
    expect(allText).not.toContain('questions');
    expect(allText).not.toContain('test');
  });
});
