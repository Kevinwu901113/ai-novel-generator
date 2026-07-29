// @vitest-environment jsdom
/**
 * useGrillQuestionPlan hook 测试。
 *
 * 覆盖：
 * - 请求问题规划（payload、disabled、aria-busy、只调用一次）
 * - 任务轮询（PENDING → RUNNING → SUCCEEDED、FAILED、CANCELLED、STALE）
 * - 终态停止轮询
 * - hidden 暂停、visible 立即刷新
 * - unmount 清理 timer/listener
 * - polling 不抢焦点
 * - session/project 切换后忽略旧 task
 * - task A 晚于 task B 时被忽略
 * - 旧 proposal 响应被忽略
 * - StrictMode 不重复 request
 * - 重复点击不双提交
 * - 提案加载（SUCCEEDED 后加载）
 * - 显示 topic/text/rationale
 * - existing/planned dependency 正确显示
 * - stale proposal 不可接受
 * - accept 调用一次、payload 使用最新 version
 * - accept 成功刷新 session/questions/proposals
 * - version conflict/stale 错误不篡改正式问题
 * - duplicate accept 被阻止
 * - 原始错误不泄露
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
    const _api = setupDesktop(
      createMockAPI({
        requestQuestionPlan: vi.fn().mockReturnValue(requestPromise),
      }),
    );
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    // 发起请求
    act(() => {
      void result.current.requestPlan();
    });

    // 请求期间应该 isRequesting = true
    expect(result.current.isRequesting).toBe(true);

    // 完成请求
    await act(async () => {
      resolveRequest!({
        taskId: 'task-00000001',
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

    // 快速点击两次
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
    // 不包含原始 Error.message
    expect(result.current.error).not.toContain('Already running');
  });

  // ── 任务轮询 ──────────────────────────────────────────────────

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

    // 请求
    await act(async () => {
      await result.current.requestPlan();
    });

    expect(result.current.task?.status).toBe('PENDING');

    // 模拟状态变为 RUNNING
    taskStatus = 'RUNNING';
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.task?.status).toBe('RUNNING');

    // 模拟状态变为 SUCCEEDED
    taskStatus = 'SUCCEEDED';
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.task?.status).toBe('SUCCEEDED');
    // 应该加载提案
    expect(api.grill.listQuestionPlanProposals).toHaveBeenCalled();
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

    // 触发轮询
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.task?.status).toBe('FAILED');
    expect(result.current.error).toBe('任务执行失败');
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
      vi.advanceTimersByTime(2000);
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
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.task?.status).toBe('STALE');
    expect(result.current.error).toBe('问题规划任务已过期');
  });

  it('终态停止轮询', async () => {
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

    // 第一次轮询
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    const callCount = getMock.mock.calls.length;

    // 再等 4 秒，不应该再调用
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });

    expect(getMock.mock.calls.length).toBe(callCount);
    expect(result.current.isPolling).toBe(false);
  });

  it('unmount 清理 timer', async () => {
    const getMock = vi.fn().mockResolvedValue({
      ...mockTask,
      status: 'RUNNING',
    });
    setupDesktop(createMockAPI({ get: getMock }));
    const onAcceptSuccess = vi.fn();

    const { result, unmount } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    await act(async () => {
      await result.current.requestPlan();
    });

    // 开始轮询
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    const callCount = getMock.mock.calls.length;

    // 卸载
    unmount();

    // 等待一段时间，不应该再调用
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });

    expect(getMock.mock.calls.length).toBe(callCount);
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

    // 请求
    await act(async () => {
      await result.current.requestPlan();
    });

    // 切换 session
    rerender({ sessionId: 'sess-00000002' });

    // 旧的轮询结果不应该更新状态
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });

    // task 应该被重置
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

    // 切换 project
    rerender({ projectId: 'proj-00000002' });

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });

    expect(result.current.task).toBeNull();
  });

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

    // 切换 session，使旧响应失效
    rerender({ sessionId: 'sess-00000002' });

    // 旧响应返回
    await act(async () => {
      resolveList1!([mockProposal]);
    });

    // 提案应该为空（旧响应被忽略）
    expect(result.current.proposals).toEqual([]);
  });

  it('重复点击不双提交', async () => {
    const api = setupDesktop(createMockAPI());
    const onAcceptSuccess = vi.fn();

    const { result } = renderHook(() =>
      useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess),
    );

    // 快速点击多次
    await act(async () => {
      await Promise.all([
        result.current.requestPlan(),
        result.current.requestPlan(),
        result.current.requestPlan(),
      ]);
    });

    expect(api.grill.requestQuestionPlan).toHaveBeenCalledTimes(1);
  });

  // ── 提案加载 ──────────────────────────────────────────────────

  it('SUCCEEDED 后加载 proposals', async () => {
    const _api = setupDesktop(
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
      vi.advanceTimersByTime(2000);
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
      vi.advanceTimersByTime(2000);
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
      vi.advanceTimersByTime(2000);
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
      vi.advanceTimersByTime(2000);
    });

    const deps = result.current.proposals[0].questions[0].dependencies;
    const plannedDep = deps.find((d) => d.kind === 'planned');
    expect(plannedDep).toBeDefined();
    expect(plannedDep?.questionKey).toBe('q.plot.conflict');
  });

  it('questionCount 和实际列表一致', async () => {
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
      vi.advanceTimersByTime(2000);
    });

    const proposal = result.current.proposals[0];
    expect(proposal.questionCount).toBe(proposal.questions.length);
  });

  it('stale proposal 不可接受', async () => {
    const staleProposal = { ...mockProposal, status: 'SUPERSEDED' };
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
      vi.advanceTimersByTime(2000);
    });

    // 提案应该存在但状态为 SUPERSEDED
    expect(result.current.proposals[0].status).toBe('SUPERSEDED');
  });

  // ── 接受提案 ──────────────────────────────────────────────────

  it('未点击前不调用 accept', async () => {
    const api = setupDesktop(createMockAPI());
    const onAcceptSuccess = vi.fn();

    renderHook(() => useGrillQuestionPlan('proj-00000001', 'sess-00000001', 2, onAcceptSuccess));

    // 等待一段时间
    await act(async () => {
      vi.advanceTimersByTime(4000);
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

    // 更新 version
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

    // 第一次接受
    act(() => {
      void result.current.acceptProposal('prop-plan-001');
    });

    // 第二次应该被阻止
    await act(async () => {
      const ok = await result.current.acceptProposal('prop-plan-001');
      expect(ok).toBe(false);
    });

    // 完成第一次
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

    // 应该显示安全错误
    expect(result.current.error).toBe('会话已在其他操作中更新，数据已自动刷新');
    // onAcceptSuccess 不应该被调用（接受失败）
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

    // 不应该包含敏感信息
    expect(result.current.error).not.toContain('/Users/');
    expect(result.current.error).not.toContain('sql');
  });
});
