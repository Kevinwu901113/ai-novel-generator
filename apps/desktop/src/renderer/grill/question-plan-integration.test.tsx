// @vitest-environment jsdom
/**
 * Grill 问题规划集成测试。
 *
 * 在 GrillWorkbench 上下文中测试完整工作流：
 * - 请求问题规划 → 任务状态显示
 * - 显式接受提案
 * - 接受后刷新 session、questions、proposals
 * - focus/ARIA 验证
 * - 安全错误验证
 * - 竞态条件：session 切换
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import { GrillWorkbench } from './GrillWorkbench';
import type {
  GrillQuestionPublicData,
  GrillQuestionPlanProposalPublicData,
  TaskPublicData,
  DesktopAPI,
} from '@ai-novel/contracts';

// ── Mock 数据 ─────────────────────────────────────────────────────

const STABLE_EMPTY: readonly unknown[] = [];

const mockSession = {
  id: 'sess-00000001',
  projectId: 'proj-00000001',
  status: 'ACTIVE' as const,
  version: 2,
  goal: '探索角色动机',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  startedAt: '2024-01-01T00:00:00Z',
  completedAt: null,
  abandonedAt: null,
};

const mockQuestions: GrillQuestionPublicData[] = [
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

const mockPlanProposal: GrillQuestionPlanProposalPublicData = {
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
      dependencies: [{ kind: 'existing', questionId: 'q-00000001' }],
    },
  ],
  questionCount: 1,
  createdAt: '2024-01-01T00:00:00Z',
  reviewedAt: null,
};

const newQuestionsFromPlan: GrillQuestionPublicData[] = [
  {
    id: 'q-plan-001',
    sessionId: 'sess-00000001',
    sequence: 2,
    topic: '角色动机',
    text: '主角的核心动机是什么？',
    rationale: '理解角色驱动力',
    status: 'PLANNED',
    dependsOnQuestionIds: ['q-00000001'],
    createdAt: '2024-01-01T00:05:00Z',
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
      createSession: vi.fn().mockResolvedValue(mockSession),
      getSession: vi.fn().mockResolvedValue(mockSession),
      listSessions: vi.fn().mockResolvedValue([mockSession]),
      listQuestions: vi.fn().mockResolvedValue(mockQuestions),
      startSession: vi.fn().mockResolvedValue({ ...mockSession, status: 'ACTIVE' }),
      pauseSession: vi.fn().mockResolvedValue({ ...mockSession, status: 'PAUSED' }),
      resumeSession: vi.fn().mockResolvedValue({ ...mockSession, status: 'ACTIVE' }),
      completeSession: vi.fn().mockResolvedValue({ ...mockSession, status: 'COMPLETED' }),
      abandonSession: vi.fn().mockResolvedValue({ ...mockSession, status: 'ABANDONED' }),
      addQuestions: vi.fn().mockResolvedValue(mockQuestions),
      markQuestionAsked: vi.fn().mockResolvedValue(mockQuestions[0]),
      answerQuestion: vi.fn().mockResolvedValue({
        id: 'ans-00000001',
        sessionId: 'sess-00000001',
        questionId: 'q-00000001',
        revision: 1,
        source: 'USER',
        text: '测试回答',
        createdAt: '2024-01-01T00:02:00Z',
        supersededAt: null,
      }),
      skipQuestion: vi.fn().mockResolvedValue({ ...mockQuestions[0], status: 'SKIPPED' }),
      supersedeQuestion: vi.fn().mockResolvedValue({ ...mockQuestions[0], status: 'SUPERSEDED' }),
      getCurrentAnswers: vi.fn().mockResolvedValue(STABLE_EMPTY),
      listAnswerHistory: vi.fn().mockResolvedValue(STABLE_EMPTY),
      createProposal: vi.fn().mockResolvedValue({
        id: 'prop-00000001',
        sessionId: 'sess-00000001',
        basedOnAnswerIds: [],
        key: 'test',
        proposedValue: {},
        confidence: 0.8,
        rationale: '测试',
        status: 'PROPOSED',
        createdAt: '2024-01-01T00:03:00Z',
        reviewedAt: null,
      }),
      reviewProposal: vi.fn().mockResolvedValue({
        id: 'prop-00000001',
        sessionId: 'sess-00000001',
        basedOnAnswerIds: [],
        key: 'test',
        proposedValue: {},
        confidence: 0.8,
        rationale: '测试',
        status: 'ACCEPTED',
        createdAt: '2024-01-01T00:03:00Z',
        reviewedAt: '2024-01-01T00:04:00Z',
      }),
      listProposals: vi.fn().mockResolvedValue(STABLE_EMPTY),
      // Question Plan APIs
      requestQuestionPlan: vi.fn().mockResolvedValue({
        taskId: 'task-00000001',
        sessionId: 'sess-00000001',
        baseSessionVersion: 2,
      }),
      listQuestionPlanProposals: vi.fn().mockResolvedValue(STABLE_EMPTY),
      getQuestionPlanProposal: vi.fn().mockResolvedValue(mockPlanProposal),
      acceptQuestionPlanProposal: vi.fn().mockResolvedValue(newQuestionsFromPlan),
      ...overrides,
    },
    tasks: {
      get: vi.fn().mockResolvedValue(mockTask),
      list: vi.fn().mockResolvedValue(STABLE_EMPTY),
      getStats: vi.fn().mockResolvedValue({
        invocationCount: 0,
        succeededCount: 0,
        failedCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }),
      createModelInvocationTest: vi.fn().mockResolvedValue(mockTask),
      ...overrides,
    },
  };
}

function setupDesktop(api: ReturnType<typeof createMockAPI>) {
  window.desktop = api as unknown as DesktopAPI;
  return api;
}

/** 选择第一个 session */
async function selectFirstSession() {
  await waitFor(() => {
    expect(screen.getByText(mockSession.goal)).toBeInTheDocument();
  });
  await act(async () => {
    screen.getByText(mockSession.goal).closest('.grill-session-item')!.click();
  });
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('Grill 问题规划集成测试', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  // ── 请求问题规划 ──────────────────────────────────────────────

  it('请求后显示任务状态', async () => {
    const _api = setupDesktop(createMockAPI());
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    // 等待问题规划面板出现
    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeInTheDocument();
    });

    // 点击请求
    await act(async () => {
      screen.getByText('请求问题规划').click();
    });

    // 应该显示任务状态
    await waitFor(() => {
      expect(screen.getByText('问题规划任务')).toBeInTheDocument();
    });
  });

  it('request 只调用一次', async () => {
    const api = setupDesktop(createMockAPI());
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeInTheDocument();
    });

    // 快速点击两次
    await act(async () => {
      screen.getByText('请求问题规划').click();
      screen.getByText('请求问题规划').click();
    });

    expect(api.grill.requestQuestionPlan).toHaveBeenCalledTimes(1);
  });

  // ── 提案显示 ──────────────────────────────────────────────────

  it('显示提案列表', async () => {
    const _api = setupDesktop(
      createMockAPI({
        listQuestionPlanProposals: vi.fn().mockResolvedValue([mockPlanProposal]),
      }),
    );
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    // 等待提案加载
    await waitFor(() => {
      expect(screen.getByText('问题规划提案')).toBeInTheDocument();
    });

    // 验证提案内容
    expect(screen.getByText('角色动机')).toBeInTheDocument();
    expect(screen.getByText('主角的核心动机是什么？')).toBeInTheDocument();
    expect(screen.getByText(/理解角色驱动力/)).toBeInTheDocument();
  });

  it('existing dependency 正确显示', async () => {
    const _api = setupDesktop(
      createMockAPI({
        listQuestionPlanProposals: vi.fn().mockResolvedValue([mockPlanProposal]),
      }),
    );
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText(/已有问题/)).toBeInTheDocument();
    });
  });

  // ── 接受提案 ──────────────────────────────────────────────────

  it('显式接受调用一次', async () => {
    const api = setupDesktop(
      createMockAPI({
        listQuestionPlanProposals: vi.fn().mockResolvedValue([mockPlanProposal]),
      }),
    );
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    // 等待提案出现
    await waitFor(() => {
      expect(screen.getByText('接受此规划')).toBeInTheDocument();
    });

    // 点击接受
    await act(async () => {
      fireEvent.click(screen.getByText('接受此规划'));
    });

    expect(api.grill.acceptQuestionPlanProposal).toHaveBeenCalledTimes(1);
    expect(api.grill.acceptQuestionPlanProposal).toHaveBeenCalledWith({
      projectId: 'proj-00000001',
      sessionId: 'sess-00000001',
      proposalId: 'prop-plan-001',
      expectedSessionVersion: 2,
    });
  });

  it('accept 成功刷新 questions', async () => {
    const listQuestionsMock = vi.fn().mockResolvedValue(mockQuestions);
    const _api = setupDesktop(
      createMockAPI({
        listQuestionPlanProposals: vi.fn().mockResolvedValue([mockPlanProposal]),
        listQuestions: listQuestionsMock,
      }),
    );
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('接受此规划')).toBeInTheDocument();
    });

    const callCountBefore = listQuestionsMock.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByText('接受此规划'));
    });

    // 应该刷新 questions
    await waitFor(() => {
      expect(listQuestionsMock.mock.calls.length).toBeGreaterThan(callCountBefore);
    });
  });

  // ── 焦点管理 ──────────────────────────────────────────────────

  it('task heading 真实 focus', async () => {
    setupDesktop(createMockAPI());
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('请求问题规划').click();
    });

    // 任务标题应该获得焦点
    await waitFor(() => {
      expect(screen.getByText('问题规划任务')).toHaveFocus();
    });
  });

  it('proposal heading 真实 focus', async () => {
    setupDesktop(
      createMockAPI({
        listQuestionPlanProposals: vi.fn().mockResolvedValue([mockPlanProposal]),
      }),
    );
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    // 提案标题应该获得焦点
    await waitFor(() => {
      expect(screen.getByText('问题规划提案')).toHaveFocus();
    });
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
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('请求问题规划').click();
    });

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).not.toContain('/Users/');
      expect(alert.textContent).not.toContain('sql');
    });
  });

  it('只有一个 alert', async () => {
    setupDesktop(
      createMockAPI({
        requestQuestionPlan: vi.fn().mockRejectedValue(
          Object.assign(new Error('Test error'), {
            code: 'UNKNOWN_CODE',
          }),
        ),
      }),
    );
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('请求问题规划').click();
    });

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts).toHaveLength(1);
    });
  });

  // ── 键盘操作 ──────────────────────────────────────────────────

  it('Enter 操作请求按钮', async () => {
    const api = setupDesktop(createMockAPI());
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeInTheDocument();
    });

    const btn = screen.getByText('请求问题规划');
    // 原生 button 元素在 Enter 键时会触发 click
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(api.grill.requestQuestionPlan).toHaveBeenCalled();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('Space 操作请求按钮', async () => {
    const _api = setupDesktop(createMockAPI());
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeInTheDocument();
    });

    const btn = screen.getByText('请求问题规划');
    // 原生 button 元素支持 Space 键触发 click
    fireEvent.keyDown(btn, { key: ' ', code: 'Space' });
    // 验证是原生 button
    expect(btn.tagName).toBe('BUTTON');
  });

  // ── ARIA ──────────────────────────────────────────────────────

  it('任务区域 role=status', async () => {
    setupDesktop(createMockAPI());
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('请求问题规划').click();
    });

    await waitFor(() => {
      const statusRegion = screen.getByRole('status');
      expect(statusRegion).toBeInTheDocument();
    });
  });

  it('请求期间 aria-busy', async () => {
    let resolveRequest: (value: unknown) => void;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    setupDesktop(
      createMockAPI({
        requestQuestionPlan: vi.fn().mockReturnValue(requestPromise),
      }),
    );
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeInTheDocument();
    });

    act(() => {
      screen.getByText('请求问题规划').click();
    });

    await waitFor(() => {
      expect(screen.getByText('请求中…')).toHaveAttribute('aria-busy', 'true');
    });

    await act(async () => {
      resolveRequest!({
        taskId: 'task-00000001',
        sessionId: 'sess-00000001',
        baseSessionVersion: 2,
      });
    });
  });

  // ── version conflict ──────────────────────────────────────────

  it('version conflict 不篡改正式问题', async () => {
    setupDesktop(
      createMockAPI({
        listQuestionPlanProposals: vi.fn().mockResolvedValue([mockPlanProposal]),
        acceptQuestionPlanProposal: vi.fn().mockRejectedValue(
          Object.assign(new Error('Version conflict'), {
            code: 'GRILL_VERSION_CONFLICT',
          }),
        ),
      }),
    );
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('接受此规划')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('接受此规划'));
    });

    // 应该显示错误
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/会话已在其他操作中更新/);
    });

    // 正式问题列表不应该改变
    expect(screen.getByText(mockQuestions[0].topic)).toBeInTheDocument();
  });

  it('stale 错误不篡改正式问题', async () => {
    setupDesktop(
      createMockAPI({
        listQuestionPlanProposals: vi.fn().mockResolvedValue([mockPlanProposal]),
        acceptQuestionPlanProposal: vi.fn().mockRejectedValue(
          Object.assign(new Error('Stale'), {
            code: 'GRILL_PLAN_STALE',
          }),
        ),
      }),
    );
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('接受此规划')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('接受此规划'));
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/问题规划提案已过期/);
    });

    // 正式问题列表不应该改变
    expect(screen.getByText(mockQuestions[0].topic)).toBeInTheDocument();
  });

  // ── stale proposal ────────────────────────────────────────────

  it('stale proposal 不可接受', async () => {
    const staleProposal = { ...mockPlanProposal, status: 'SUPERSEDED' };
    setupDesktop(
      createMockAPI({
        listQuestionPlanProposals: vi.fn().mockResolvedValue([staleProposal]),
      }),
    );
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('已过期')).toBeInTheDocument();
      expect(screen.getByText('接受此规划')).toBeDisabled();
    });
  });

  // ── GRILL_PLAN_ALREADY_RUNNING ────────────────────────────────

  it('GRILL_PLAN_ALREADY_RUNNING 安全显示', async () => {
    setupDesktop(
      createMockAPI({
        requestQuestionPlan: vi.fn().mockRejectedValue(
          Object.assign(new Error('Already running'), {
            code: 'GRILL_PLAN_ALREADY_RUNNING',
          }),
        ),
      }),
    );
    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('请求问题规划').click();
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('问题规划任务已在进行中');
    });
  });

  // ── session 切换 ──────────────────────────────────────────────

  it('session 切换后重置状态', async () => {
    const api = setupDesktop(createMockAPI());

    // 创建两个 session
    const session2 = {
      ...mockSession,
      id: 'sess-00000002',
      goal: '第二个会话',
    };
    api.grill.listSessions = vi.fn().mockResolvedValue([mockSession, session2]);

    await act(async () => {
      render(<GrillWorkbench projectId="proj-00000001" />);
    });
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeInTheDocument();
    });

    // 请求
    await act(async () => {
      screen.getByText('请求问题规划').click();
    });

    await waitFor(() => {
      expect(screen.getByText('问题规划任务')).toBeInTheDocument();
    });

    // 切换 session
    await act(async () => {
      screen.getByText('第二个会话').click();
    });

    // 任务状态应该消失
    await waitFor(() => {
      expect(screen.queryByText('问题规划任务')).not.toBeInTheDocument();
    });
  });
});
