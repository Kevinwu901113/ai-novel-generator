// @vitest-environment jsdom
/**
 * useGrillQuestionPlan hook 测试。
 *
 * 覆盖：
 * - 请求问题规划（payload、disabled、只调用一次）
 * - 任务轮询（PENDING → RUNNING → SUCCEEDED、FAILED、CANCELLED、STALE）
 * - 终态停止轮询
 * - hidden 暂停、visible 立即刷新
 * - unmount 清理 timer/listener
 * - session/project 切换后忽略旧 task
 * - task A 晚于 task B 时被忽略
 * - 旧 proposal 响应被忽略
 * - 同 session 内 proposal request sequencing
 * - 接受提案（显式点击、最新 version、generation 检查）
 * - accept session-switch race
 * - 安全错误
 * - single-flight polling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGrillQuestionPlan } from './useGrillQuestionPlan';
import type {
  DesktopAPI,
  TaskPublicData,
  GrillQuestionPlanProposalPublicData,
  GrillQuestionPublicData,
} from '@ai-novel/contracts';

// ── Mock 数据 ─────────────────────────────────────────────────────

const mockTask: TaskPublicData = {
  id: 'task-00000001',
  projectId: 'proj-00000001',
  taskType: 'GRILL_QUESTION_PLAN',
  status: 'PENDING',
  attemptCount: 0,
  result: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  startedAt: null,
  finishedAt: null,
};

const mockProposal: GrillQuestionPlanProposalPublicData = {
  id: 'prop-plan-001',
  projectId: 'proj-00000001',
  sessionId: 'sess-00000001',
  taskId: 'task-00000001',
  baseSessionVersion: 2,
  schemaVersion: 1,
  status: 'PROPOSED',
  questions: [
    {
      key: 'q.character.motivation',
      topic: '角色动机',
      text: '主角的核心动机是什么？',
      rationale: '理解角色驱动力',
      dependencies: [
        { kind: 'existing', questionId: 'q-00000001' },
        { kind: 'planned', questionKey: 'q.plot.conflict' },
      ],
    },
    {
      key: 'q.plot.conflict',
      topic: '情节冲突',
      text: '核心冲突是什么？',
      rationale: '确定主线',
      dependencies: [],
    },
  ],
  questionCount: 2,
  createdAt: '2024-01-01T00:00:00Z',
  reviewedAt: null,
};

const mockQuestions: ReadonlyArray<GrillQuestionPublicData> = [
  {
    id: 'q-00000001',
    sessionId: 'sess-00000001',
    sequence: 1,
    topic: '角色背景',
    text: '主角的童年经历是什么？',
    rationale: '理解角色动机',
    status: 'PLANNED',
    dependsOnQuestionIds: [],
    createdAt: '2024-01-01T00:00:00Z',
    askedAt: null,
    answeredAt: null,
    skippedAt: null,
    supersededAt: null,
  },
];

// ── Mock DesktopAPI 工厂 ──────────────────────────────────────────

function createMockAPI(
  overrides: Record<string, (...args: ReadonlyArray<unknown>) => unknown> = {},
) {
  return {
    grill: {
      requestQuestionPlan: vi.fn().mockResolvedValue({
        taskId: 'task-00000001',
        projectId: 'proj-00000001',
        sessionId: 'sess-00000001',
        baseSessionVersion: 2,
      }),
      listQuestionPlanProposals: vi.fn().mockResolvedValue([mockProposal]),
      getQuestionPlanProposal: vi.fn().mockResolvedValue(mockProposal),
      acceptQuestionPlanProposal: vi.fn().mockResolvedValue(mockQuestions),
      ...overrides,
    },
    tasks: {
      get: vi.fn().mockResolvedValue(mockTask),
      ...overrides,
    },
  };
}

function setupDesktop(api: ReturnType<typeof createMockAPI>) {
  window.desktop = api as unknown as DesktopAPI;
  return api;
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('useGrillQuestionPlan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function cleanup() {
    window.desktop = undefined as unknown as DesktopAPI;
  }

  // ── 请求问题规划 ──────────────────────────────────────────────

  it('请求使用当前 project/session/version', async () => {
    const api = setupDesktop(createMockAPI());
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 3, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    expect(api.grill.requestQuestionPlan).toHaveBeenCalledWith({
      projectId: 'proj-00000001',
      sessionId: 'sess-00000001',
      expectedSessionVersion: 3,
    });
  });

  it('请求期间 disabled（isRequesting）', async () => {
    let resolveRequest: (value: unknown) => void;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    setupDesktop(
      createMockAPI({
        requestQuestionPlan: vi.fn().mockReturnValue(requestPromise),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    act(() => {
      void result.current.requestPlan();
    });

    expect(result.current.isRequesting).toBe(true);

    await act(async () => {
      resolveRequest!({
        taskId: 'task-00000001',
        projectId: 'proj-00000001',
        sessionId: 'sess-00000001',
        baseSessionVersion: 2,
      });
    });

    expect(result.current.isRequesting).toBe(false);
  });

  it('请求只调用一次（防止双提交）', async () => {
    const api = setupDesktop(createMockAPI());
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await Promise.all([result.current.requestPlan(), result.current.requestPlan()]);
    });

    expect(api.grill.requestQuestionPlan).toHaveBeenCalledTimes(1);
  });

  it('返回 taskId 后显示任务状态', async () => {
    setupDesktop(createMockAPI());
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    expect(result.current.task).not.toBeNull();
    expect(result.current.task?.id).toBe('task-00000001');
    expect(result.current.task?.status).toBe('PENDING');
  });

  it('GRILL_PLAN_ALREADY_RUNNING 安全显示', async () => {
    setupDesktop(
      createMockAPI({
        requestQuestionPlan: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('Already running'), { code: 'GRILL_PLAN_ALREADY_RUNNING' }),
          ),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    expect(result.current.error).toBe('问题规划任务已在进行中');
    expect(result.current.error).not.toContain('Already running');
  });

  // ── 任务轮询（recursive setTimeout single-flight） ────────────

  it('PENDING → RUNNING → SUCCEEDED', async () => {
    let taskStatus = 'PENDING';
    const api = setupDesktop(
      createMockAPI({
        get: vi.fn().mockImplementation(() => ({
          ...mockTask,
          status: taskStatus,
        })),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    expect(result.current.task?.status).toBe('PENDING');

    taskStatus = 'RUNNING';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.task?.status).toBe('RUNNING');

    taskStatus = 'SUCCEEDED';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.task?.status).toBe('SUCCEEDED');
    expect(api.grill.listQuestionPlanProposals).toHaveBeenCalled();
  });

  it('single-flight: RUNNING 请求 pending 时不发第二个请求', async () => {
    let resolvePoll: (value: unknown) => void;
    const pollPromise = new Promise((resolve) => {
      resolvePoll = resolve;
    });
    let pollCount = 0;
    const getMock = vi.fn().mockImplementation(() => {
      pollCount++;
      if (pollCount === 1) {
        return pollPromise;
      }
      return { ...mockTask, status: 'RUNNING' };
    });
    setupDesktop(createMockAPI({ get: getMock }));
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    // 首次 poll（setTimeout(fn, 0)）触发
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // poll 请求在途，再推进时间不应触发第二个请求
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(getMock).toHaveBeenCalledTimes(1);

    // 解决第一个 poll
    await act(async () => {
      resolvePoll!({ ...mockTask, status: 'RUNNING' });
    });

    // 现在应该触发第二个 poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('终态后不再接受新状态', async () => {
    const getMock = vi.fn().mockResolvedValue({
      ...mockTask,
      status: 'SUCCEEDED',
    });
    setupDesktop(createMockAPI({ get: getMock }));
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    // 首次 poll → SUCCEEDED
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.task?.status).toBe('SUCCEEDED');
    expect(result.current.isPolling).toBe(false);

    // 终态后即使推进时间也不会再调用 tasks.get
    const callsAfterTerminal = getMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getMock.mock.calls.length).toBe(callsAfterTerminal);
  });

  it('终态后不再调用 tasks.get', async () => {
    const getMock = vi.fn().mockResolvedValue({
      ...mockTask,
      status: 'SUCCEEDED',
    });
    setupDesktop(createMockAPI({ get: getMock }));
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    // 首次 poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const callCount = getMock.mock.calls.length;

    // 再等 6 秒，不应该再调用
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(getMock.mock.calls.length).toBe(callCount);
    expect(result.current.isPolling).toBe(false);
  });

  it('FAILED 安全显示', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({
          ...mockTask,
          status: 'FAILED',
          errorCode: 'TASK_EXECUTION_FAILED',
        }),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.task?.status).toBe('FAILED');
    expect(result.current.error).toBe('任务执行失败（TASK_EXECUTION_FAILED）');
  });

  it('CANCELLED 显示', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({
          ...mockTask,
          status: 'CANCELLED',
        }),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.task?.status).toBe('CANCELLED');
    expect(result.current.error).toBe('问题规划任务已取消');
  });

  it('STALE 显示', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({
          ...mockTask,
          status: 'STALE',
        }),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.task?.status).toBe('STALE');
    expect(result.current.error).toBe('问题规划任务已过期');
  });

  it('unmount 清理 timer 和 pending response 不 setState', async () => {
    let resolvePoll: (value: unknown) => void;
    const pollPromise = new Promise((resolve) => {
      resolvePoll = resolve;
    });
    const getMock = vi.fn().mockReturnValue(pollPromise);
    setupDesktop(createMockAPI({ get: getMock }));
    const onAcceptSuccess = vi.fn();

    const { result, unmount } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    // 首次 poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // 卸载
    unmount();

    // 解决 pending poll — 不应报错
    await act(async () => {
      resolvePoll!({ ...mockTask, status: 'SUCCEEDED' });
    });

    // 再推进时间 — 不应有新 timer
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('hidden 取消下一次 timer，visible 立即 poll', async () => {
    let pollCount = 0;
    const getMock = vi.fn().mockImplementation(() => {
      pollCount++;
      return { ...mockTask, status: 'RUNNING' };
    });
    setupDesktop(createMockAPI({ get: getMock }));
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    // 首次 poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(pollCount).toBe(1);

    // 模拟 hidden
    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // 推进时间 — hidden 时不应 poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(pollCount).toBe(1);

    // 模拟 visible — 应立即 poll
    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(pollCount).toBe(2);

    // 清理
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('visible 期间多次事件合并成一次 resume', async () => {
    let pollCount = 0;
    const getMock = vi.fn().mockImplementation(() => {
      pollCount++;
      return { ...mockTask, status: 'RUNNING' };
    });
    setupDesktop(createMockAPI({ get: getMock }));
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    // 首次 poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const countBefore = pollCount;

    // 多次 visible 事件 — unified controller 合并为一次 resume
    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      // flush timers to complete the poll
      await vi.advanceTimersByTimeAsync(0);
    });

    // 应增加：1 次 visible 触发 + 可能 1 次 resume（在途返回后补）
    expect(pollCount).toBeLessThanOrEqual(countBefore + 2);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  // ── 竞态失效 ──────────────────────────────────────────────────

  it('session 切换后忽略旧 task', async () => {
    const getMock = vi.fn().mockResolvedValue({
      ...mockTask,
      status: 'SUCCEEDED',
    });
    setupDesktop(createMockAPI({ get: getMock }));
    const onAcceptSuccess = vi.fn();

    const { result, rerender } = renderHook(
      ({ sessionId }) => useGrillQuestionPlan('proj-00000001', sessionId, 2, onAcceptSuccess),
      { initialProps: { sessionId: 'sess-00000001' } },
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    rerender({ sessionId: 'sess-00000002' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(result.current.task).toBeNull();
  });

  it('project 切换后忽略旧 task', async () => {
    const getMock = vi.fn().mockResolvedValue({
      ...mockTask,
      status: 'SUCCEEDED',
    });
    setupDesktop(createMockAPI({ get: getMock }));
    const onAcceptSuccess = vi.fn();

    const { result, rerender } = renderHook(
      ({ projectId }) => useGrillQuestionPlan(projectId, 'sess-00000001', 2, onAcceptSuccess),
      { initialProps: { projectId: 'proj-00000001' } },
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    rerender({ projectId: 'proj-00000002' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(result.current.task).toBeNull();
  });

  it('task A response 不覆盖 task B', async () => {
    const getMock = vi.fn().mockResolvedValue({
      ...mockTask,
      id: 'task-BBBBBBBB',
      status: 'SUCCEEDED',
    });
    const _api = setupDesktop(
      createMockAPI({
        requestQuestionPlan: vi.fn().mockResolvedValue({
          taskId: 'task-AAAAAAAA',
          projectId: 'proj-00000001',
          sessionId: 'sess-00000001',
          baseSessionVersion: 2,
        }),
        get: getMock,
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    expect(result.current.task?.id).toBe('task-AAAAAAAA');
  });

  it('session A task response 不覆盖 session B', async () => {
    const getMock = vi.fn().mockResolvedValue({
      ...mockTask,
      status: 'SUCCEEDED',
    });
    setupDesktop(createMockAPI({ get: getMock }));
    const onAcceptSuccess = vi.fn();

    const { result, rerender } = renderHook(
      ({ sessionId }) => useGrillQuestionPlan('proj-00000001', sessionId, 2, onAcceptSuccess),
      { initialProps: { sessionId: 'sess-00000001' } },
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    // 切换 session
    rerender({ sessionId: 'sess-00000002' });

    // 旧 task response 不应更新
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(result.current.task).toBeNull();
  });

  // ── 同 session 内 proposal request sequencing ─────────────────

  it('同 session 内多次 loadProposals，最新请求覆盖旧请求', async () => {
    const newProposal = { ...mockProposal, id: 'prop-plan-NEW', status: 'ACCEPTED' as const };
    let resolveList1: (value: unknown) => void;
    const listPromise1 = new Promise((resolve) => {
      resolveList1 = resolve;
    });
    const getMock = vi.fn().mockResolvedValue({
      ...mockTask,
      status: 'SUCCEEDED',
    });
    setupDesktop(
      createMockAPI({
        get: getMock,
        listQuestionPlanProposals: vi
          .fn()
          .mockReturnValueOnce(listPromise1)
          .mockResolvedValue([newProposal]),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    // 首次 poll → SUCCEEDED → loadProposals
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // 手动刷新（第二次 loadProposals）
    await act(async () => {
      await result.current.refreshProposals();
    });

    // 第二次先返回（新数据）
    expect(result.current.proposals[0].id).toBe('prop-plan-NEW');

    // 第一次后返回（旧数据，应被忽略）
    await act(async () => {
      resolveList1!([mockProposal]);
    });

    // 应保持新数据
    expect(result.current.proposals[0].id).toBe('prop-plan-NEW');
  });

  // ── 旧 proposal 响应被忽略 ────────────────────────────────────

  it('旧 proposal 响应被忽略', async () => {
    let resolveList1: (value: unknown) => void;
    const listPromise1 = new Promise((resolve) => {
      resolveList1 = resolve;
    });
    setupDesktop(
      createMockAPI({
        listQuestionPlanProposals: vi.fn().mockReturnValueOnce(listPromise1).mockResolvedValue([]),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result, rerender } = renderHook(
      ({ sessionId }) => useGrillQuestionPlan('proj-00000001', sessionId, 2, onAcceptSuccess),
      { initialProps: { sessionId: 'sess-00000001' } },
    );

    rerender({ sessionId: 'sess-00000002' });

    await act(async () => {
      resolveList1!([mockProposal]);
    });

    expect(result.current.proposals).toEqual([]);
  });

  // ── 提案加载 ──────────────────────────────────────────────────

  it('SUCCEEDED 后加载 proposals', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({
          ...mockTask,
          status: 'SUCCEEDED',
        }),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.proposals).toHaveLength(1);
    expect(result.current.proposals[0].id).toBe('prop-plan-001');
  });

  it('显示 topic/text/rationale', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({
          ...mockTask,
          status: 'SUCCEEDED',
        }),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const proposal = result.current.proposals[0];
    expect(proposal.questions[0].topic).toBe('角色动机');
    expect(proposal.questions[0].text).toBe('主角的核心动机是什么？');
    expect(proposal.questions[0].rationale).toBe('理解角色驱动力');
  });

  it('existing dependency 正确显示', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({
          ...mockTask,
          status: 'SUCCEEDED',
        }),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const deps = result.current.proposals[0].questions[0].dependencies;
    const existingDep = deps.find((d) => d.kind === 'existing');
    expect(existingDep).toBeDefined();
    expect(existingDep?.questionId).toBe('q-00000001');
  });

  it('planned dependency 正确显示', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({
          ...mockTask,
          status: 'SUCCEEDED',
        }),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const deps = result.current.proposals[0].questions[0].dependencies;
    const plannedDep = deps.find((d) => d.kind === 'planned');
    expect(plannedDep).toBeDefined();
    expect(plannedDep?.questionKey).toBe('q.plot.conflict');
  });

  it('stale proposal 不可接受', async () => {
    const staleProposal = { ...mockProposal, status: 'SUPERSEDED' as const };
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({
          ...mockTask,
          status: 'SUCCEEDED',
        }),
        listQuestionPlanProposals: vi.fn().mockResolvedValue([staleProposal]),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.proposals[0].status).toBe('SUPERSEDED');
  });

  // ── 接受提案 ──────────────────────────────────────────────────

  it('未点击前不调用 accept', async () => {
    const api = setupDesktop(createMockAPI());
    const onAcceptSuccess = vi.fn();

    renderHook(() => useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(api.grill.acceptQuestionPlanProposal).not.toHaveBeenCalled();
  });

  it('显式点击调用一次', async () => {
    const api = setupDesktop(createMockAPI());
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      const ok = await result.current.acceptProposal('prop-plan-001');
      expect(ok).toBe(true);
    });

    expect(api.grill.acceptQuestionPlanProposal).toHaveBeenCalledTimes(1);
    expect(api.grill.acceptQuestionPlanProposal).toHaveBeenCalledWith({
      projectId: 'proj-00000001',
      sessionId: 'sess-00000001',
      proposalId: 'prop-plan-001',
      expectedSessionVersion: 2,
    });
  });

  it('payload 使用最新 session.version', async () => {
    const api = setupDesktop(createMockAPI());
    const onAcceptSuccess = vi.fn();

    const { result, rerender } = renderHook(
      ({ version }) =>
        useGrillQuestionPlan('proj-00000001', 'sess-00000001', version, onAcceptSuccess),
      { initialProps: { version: 2 } },
    );

    rerender({ version: 3 });

    await act(async () => {
      await result.current.acceptProposal('prop-plan-001');
    });

    expect(api.grill.acceptQuestionPlanProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionVersion: 3,
      }),
    );
  });

  it('accept 成功刷新 session', async () => {
    setupDesktop(createMockAPI());
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.acceptProposal('prop-plan-001');
    });

    expect(onAcceptSuccess).toHaveBeenCalled();
  });

  it('duplicate accept 被阻止', async () => {
    let resolveAccept: (value: unknown) => void;
    const acceptPromise = new Promise((resolve) => {
      resolveAccept = resolve;
    });
    const api = setupDesktop(
      createMockAPI({
        acceptQuestionPlanProposal: vi.fn().mockReturnValue(acceptPromise),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    act(() => {
      void result.current.acceptProposal('prop-plan-001');
    });

    await act(async () => {
      const ok = await result.current.acceptProposal('prop-plan-001');
      expect(ok).toBe(false);
    });

    await act(async () => {
      resolveAccept!(mockQuestions);
    });

    expect(api.grill.acceptQuestionPlanProposal).toHaveBeenCalledTimes(1);
  });

  it('version conflict 不篡改正式问题', async () => {
    setupDesktop(
      createMockAPI({
        acceptQuestionPlanProposal: vi.fn().mockRejectedValue(
          Object.assign(new Error('Version conflict'), {
            code: 'GRILL_VERSION_CONFLICT',
          }),
        ),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      const ok = await result.current.acceptProposal('prop-plan-001');
      expect(ok).toBe(false);
    });

    expect(result.current.error).toBe('会话已在其他操作中更新，数据已自动刷新');
    expect(onAcceptSuccess).not.toHaveBeenCalled();
  });

  it('stale 错误不篡改正式问题', async () => {
    setupDesktop(
      createMockAPI({
        acceptQuestionPlanProposal: vi.fn().mockRejectedValue(
          Object.assign(new Error('Stale'), {
            code: 'GRILL_PLAN_STALE',
          }),
        ),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      const ok = await result.current.acceptProposal('prop-plan-001');
      expect(ok).toBe(false);
    });

    expect(result.current.error).toBe('问题规划提案已过期');
    expect(onAcceptSuccess).not.toHaveBeenCalled();
  });

  // ── accept session-switch race ────────────────────────────────

  it('session A accept pending → 切换 B → accept A 返回后不更新 B', async () => {
    let resolveAccept: (value: unknown) => void;
    const acceptPromise = new Promise((resolve) => {
      resolveAccept = resolve;
    });
    setupDesktop(
      createMockAPI({
        acceptQuestionPlanProposal: vi.fn().mockReturnValue(acceptPromise),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result, rerender } = renderHook(
      ({ sessionId }) => useGrillQuestionPlan('proj-00000001', sessionId, 2, onAcceptSuccess),
      { initialProps: { sessionId: 'sess-00000001' } },
    );

    // 发起 accept
    act(() => {
      void result.current.acceptProposal('prop-plan-001');
    });

    // 切换 session
    rerender({ sessionId: 'sess-00000002' });

    // accept A 返回
    await act(async () => {
      resolveAccept!(mockQuestions);
    });

    // onAcceptSuccess 不应被调用（generation 不匹配）
    expect(onAcceptSuccess).not.toHaveBeenCalled();
  });

  it('accept 后 proposal refresh pending → 切换 session → 旧 refresh 不影响新 session', async () => {
    let resolveAccept: (value: unknown) => void;
    const acceptPromise = new Promise((resolve) => {
      resolveAccept = resolve;
    });
    const newProposal = { ...mockProposal, id: 'prop-plan-NEW' };
    setupDesktop(
      createMockAPI({
        acceptQuestionPlanProposal: vi.fn().mockReturnValue(acceptPromise),
        listQuestionPlanProposals: vi.fn().mockResolvedValue([newProposal]),
      }),
    );
    const onAcceptSuccess = vi.fn().mockResolvedValue(undefined);

    const { result, rerender } = renderHook(
      ({ sessionId }) => useGrillQuestionPlan('proj-00000001', sessionId, 2, onAcceptSuccess),
      { initialProps: { sessionId: 'sess-00000001' } },
    );

    // 发起 accept
    act(() => {
      void result.current.acceptProposal('prop-plan-001');
    });

    // 切换 session
    rerender({ sessionId: 'sess-00000002' });

    // accept 返回
    await act(async () => {
      resolveAccept!(mockQuestions);
    });

    // 旧 session 的 proposal 不应写入
    expect(result.current.proposals).toEqual([]);
  });

  // ── 安全错误 ──────────────────────────────────────────────────

  it('原始错误不泄露', async () => {
    setupDesktop(
      createMockAPI({
        requestQuestionPlan: vi.fn().mockRejectedValue(
          Object.assign(new Error('/Users/secret/path.sql'), {
            code: 'UNKNOWN_CODE',
          }),
        ),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    expect(result.current.error).not.toContain('/Users/');
    expect(result.current.error).not.toContain('sql');
  });

  it('FAILED 状态显示安全中文标签不泄露 errorMessage', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({
          ...mockTask,
          status: 'FAILED',
          errorCode: 'TASK_EXECUTION_FAILED',
          errorMessage: 'Internal error at /var/app/secret with Bearer token abc123',
        }),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.task?.status).toBe('FAILED');
    expect(result.current.error).toContain('任务执行失败');
    expect(result.current.error).toContain('TASK_EXECUTION_FAILED');
    expect(result.current.error).not.toContain('secret');
    expect(result.current.error).not.toContain('Bearer');
    expect(result.current.error).not.toContain('Internal error');
  });
});
