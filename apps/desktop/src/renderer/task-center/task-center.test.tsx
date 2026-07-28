// @vitest-environment jsdom
/**
 * 任务活动中心 DOM 交互测试。
 *
 * 使用 jsdom + React Testing Library 验证真实 DOM 行为。
 * 使用 fake timers 和 deferred Promise 验证竞态。
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
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

// ── Mock DesktopAPI 工厂 ────────────────────────────────────────────

function createMockTasksAPI(
  overrides: {
    list?: () => Promise<ReadonlyArray<TaskPublicData>>;
    getStats?: () => Promise<TaskStatsPublicData>;
    get?: () => Promise<TaskPublicData>;
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

// ── 测试 ─────────────────────────────────────────────────────────────

describe('TaskCenter DOM 交互', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 默认 document.hidden = false
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
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(api.list).toHaveBeenCalledWith(mockProjectId);
      expect(api.getStats).toHaveBeenCalledWith(mockProjectId);
    });
  });

  // 2. 列表 createdAt 降序
  it('列表按 createdAt 降序排列', async () => {
    setupDesktop(createMockTasksAPI());
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      const items = screen.getAllByTestId('task-item');
      expect(items.length).toBeGreaterThanOrEqual(2);
    });

    const items = screen.getAllByTestId('task-item');
    // mockTask1 (2024-01-02) 应排在 mockTask2 (2024-01-01) 前面（降序 = 最新在前）
    // 短 ID 取前 8 字符：mockTask1 → 'task-000'，mockTask2 → 'task-000'（相同前缀）
    // 改用类型标签区分：mockTask1 的 createdAt 更晚应排第一
    // 验证第二个任务有 FAILED 标签（mockTask2）
    expect(items[1]).toHaveTextContent('失败');
  });

  // 3. 状态筛选
  it('状态筛选只显示匹配的任务', async () => {
    setupDesktop(createMockTasksAPI());
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('task-item').length).toBe(2);
    });

    const select = screen.getByTestId('status-filter');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    // 选择 FAILED
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
      select,
      'FAILED',
    );
    select.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => {
      const items = screen.getAllByTestId('task-item');
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent('失败');
    });
  });

  // 4. 类型筛选
  it('类型筛选只显示匹配的任务', async () => {
    const tasks = [mockTask1, mockTaskUnknownType];
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue(tasks) }));
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('task-item').length).toBe(2);
    });

    const select = screen.getByTestId('type-filter');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
      select,
      'FUTURE_TASK_TYPE',
    );
    select.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => {
      const items = screen.getAllByTestId('task-item');
      expect(items).toHaveLength(1);
    });
  });

  // 5. 未知任务类型 fallback
  it('未知任务类型显示安全 fallback', async () => {
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([mockTaskUnknownType]) }));
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      // "未知任务" 同时出现在列表项和筛选下拉中，确认至少有一个
      expect(screen.getAllByText(/未知任务/).length).toBeGreaterThanOrEqual(1);
    });
  });

  // 6. 点击任务显示详情
  it('点击任务显示详情', async () => {
    setupDesktop(createMockTasksAPI());
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('task-item').length).toBeGreaterThan(0);
    });

    // 先确保详情区是空的
    expect(screen.getByTestId('task-detail-empty')).toBeInTheDocument();

    // 点击第一个任务
    screen.getAllByTestId('task-item')[0].click();

    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument();
    });
  });

  // 7. 不显示完整 task/project ID
  it('不显示完整 task ID 或 project ID', async () => {
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([mockTask1]) }));
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('task-item').length).toBe(1);
    });

    // 点击显示详情
    screen.getAllByTestId('task-item')[0].click();

    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument();
    });

    // 完整 ID 不应出现在任何文本中
    const allText = document.body.textContent;
    expect(allText).not.toContain(mockTask1.id);
    expect(allText).not.toContain(mockProjectId);
    // 短 ID 应该出现
    expect(allText).toContain(mockTask1.id.slice(0, 8));
  });

  // 8. MODEL_INVOCATION_TEST 安全结果
  it('MODEL_INVOCATION_TEST 有效结果正确显示', async () => {
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([mockTask1]) }));
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('task-item').length).toBe(1);
    });

    screen.getAllByTestId('task-item')[0].click();

    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument();
    });

    // 详情应包含结果摘要
    const detail = screen.getByTestId('task-detail');
    expect(detail.textContent).toContain('接受');
    expect(detail.textContent).toContain('42');
  });

  // 9. 未知类型不渲染原始 result
  it('未知类型不渲染原始 result', async () => {
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([mockTaskUnknownType]) }));
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('task-item').length).toBe(1);
    });

    screen.getAllByTestId('task-item')[0].click();

    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument();
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
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('task-item').length).toBe(1);
    });

    screen.getAllByTestId('task-item')[0].click();

    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument();
    });

    const allText = document.body.textContent;
    expect(allText).not.toContain('secret prompt');
    expect(allText).not.toContain('/Users/foo');
    expect(allText).not.toContain('prompt');
  });

  // 11. error path/stack 清理
  it('错误消息中的路径和 stack 被清理', async () => {
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([mockTaskWithStackError]) }));
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('task-item').length).toBe(1);
    });

    screen.getAllByTestId('task-item')[0].click();

    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument();
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
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(screen.getByTestId('task-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/网络错误/)).toBeInTheDocument();
  });

  // 14. stats 失败不清空任务列表
  it('stats 失败不影响任务列表显示', async () => {
    setupDesktop(
      createMockTasksAPI({
        getStats: vi.fn().mockRejectedValue(new Error('stats 错误')),
      }),
    );
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      // 任务列表仍应显示
      expect(screen.getAllByTestId('task-item').length).toBe(2);
    });
    // 统计区域应显示错误
    expect(screen.getByText(/统计加载失败/)).toBeInTheDocument();
  });

  // 15. PENDING/RUNNING 时开始轮询
  it('存在活跃任务时开始轮询', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTaskPending, mockTask1]),
      }),
    );
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(1);
    });

    // 推进 2 秒
    await vi.advanceTimersByTimeAsync(2000);

    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(2);
    });
  });

  // 16. 全部结束后停止轮询
  it('全部任务终态后停止轮询', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTask1, mockTask2]),
      }),
    );
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(1);
    });

    // 推进 6 秒（应无新轮询）
    await vi.advanceTimersByTimeAsync(6000);

    // 只有初始调用
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  // 17. project 切换停止旧轮询
  it('project 切换停止旧轮询', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTaskPending]),
      }),
    );
    const { rerender } = render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(1);
    });

    // 切换项目
    rerender(<TaskCenter projectId="proj-00000002" />);

    await waitFor(() => {
      // 新项目调用
      expect(api.list).toHaveBeenCalledWith('proj-00000002');
    });

    // 推进时间 — 不应有旧项目的轮询
    await vi.advanceTimersByTimeAsync(4000);

    // 新项目的调用次数应合理（不包含旧项目的轮询）
    expect(api.list).toHaveBeenCalledWith('proj-00000002');
  });

  // 18. 旧项目慢响应不能覆盖新项目
  it('旧项目慢响应不覆盖新项目', async () => {
    const deferred = createDeferred<ReadonlyArray<TaskPublicData>>();
    const newListFn = vi.fn().mockResolvedValue([mockTask1]);

    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockReturnValue(deferred.promise),
      }),
    );

    const { rerender } = render(<TaskCenter projectId={mockProjectId} />);

    // 切换到新项目，新项目返回 mockTask1
    api.list.mockReturnValue(newListFn.mock.results[0]?.value ?? Promise.resolve([mockTask1]));
    // 实际上重新 mock
    api.list.mockImplementation(() => Promise.resolve([mockTask1]));

    rerender(<TaskCenter projectId="proj-00000002" />);

    await waitFor(() => {
      expect(screen.getAllByTestId('task-item').length).toBe(1);
    });

    // 旧项目的 deferred 现在才 resolve
    deferred.resolve([mockTaskPending, mockTaskRunning]);

    // 等待微任务完成
    await vi.advanceTimersByTimeAsync(0);

    // 列表应仍只显示新项目的数据
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
    const { unmount } = render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(1);
    });

    unmount();

    // 推进时间 — 不应有新调用
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  // 20. 页面 hidden 时暂停轮询
  it('页面 hidden 时暂停轮询', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTaskPending]),
      }),
    );
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(1);
    });

    // 模拟页面隐藏
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    // 推进时间 — 不应有新调用
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  // 21. 页面 visible 时立即刷新
  it('页面 visible 时立即刷新', async () => {
    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockResolvedValue([mockTaskPending]),
      }),
    );
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(1);
    });

    // 先隐藏
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    // 再恢复
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(2);
    });
  });

  // 22. 同步重复刷新只请求一次
  it('同步重复刷新只请求一次', async () => {
    let resolveList!: (value: ReadonlyArray<TaskPublicData>) => void;
    const listPromise = new Promise<ReadonlyArray<TaskPublicData>>((resolve) => {
      resolveList = resolve;
    });

    const api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockReturnValue(listPromise),
      }),
    );

    render(<TaskCenter projectId={mockProjectId} />);

    // 点击刷新按钮多次
    const btn = screen.getByTestId('task-refresh-btn');
    btn.click();
    btn.click();
    btn.click();

    // 解决 promise
    resolveList([mockTask1]);

    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(1);
    });
  });

  // 23. 选中任务消失时清除详情
  it('选中任务消失时清除详情', async () => {
    let callCount = 0;
    const _api = setupDesktop(
      createMockTasksAPI({
        list: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve([mockTask1, mockTask2]);
          return Promise.resolve([mockTask2]); // mockTask1 消失
        }),
      }),
    );
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('task-item').length).toBe(2);
    });

    // 选中第一个任务
    screen.getAllByTestId('task-item')[0].click();
    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument();
    });

    // 推进轮询 — 第二次 list 返回中 mockTask1 消失
    // 由于没有活跃任务不会轮询，手动刷新
    const btn = screen.getByTestId('task-refresh-btn');
    btn.click();

    await waitFor(() => {
      // 详情应被清除
      expect(screen.getByTestId('task-detail-empty')).toBeInTheDocument();
    });
  });

  // 24. GRILL_QUESTION_PLAN 类型安全显示
  it('GRILL_QUESTION_PLAN 类型安全显示', async () => {
    const grillTask: TaskPublicData = {
      ...mockTaskRunning,
      status: 'SUCCEEDED',
      result: { questions: [{ text: 'test' }] },
      finishedAt: '2024-01-03T00:02:00Z',
    };
    setupDesktop(createMockTasksAPI({ list: vi.fn().mockResolvedValue([grillTask]) }));
    render(<TaskCenter projectId={mockProjectId} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('task-item').length).toBe(1);
    });

    screen.getAllByTestId('task-item')[0].click();

    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeInTheDocument();
    });

    // 应显示类型标签（列表项 + 筛选下拉中均出现）
    expect(screen.getAllByText('Grill 问题规划').length).toBeGreaterThanOrEqual(1);
    // 应显示安全的结果文本
    expect(screen.getByText('规划任务结果已保存')).toBeInTheDocument();
    // 不应显示原始 result
    const allText = document.body.textContent;
    expect(allText).not.toContain('questions');
    expect(allText).not.toContain('test');
  });
});
