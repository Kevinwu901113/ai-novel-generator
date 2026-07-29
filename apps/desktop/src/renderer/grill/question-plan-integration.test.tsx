// @vitest-environment jsdom
/**
 * Grill 问题规划集成测试。
 *
 * 在 GrillWorkbench 上下文中测试完整工作流：
 * - 请求 → 任务状态 → 提案列表 → 接受
 * - 接受后刷新 session/questions
 * - 焦点管理（task heading、proposal heading、question list heading）
 * - 安全错误
 * - ARIA
 * - version conflict 不篡改正式问题
 * - stale proposal 不可接受
 * - session 切换重置状态
 * - 完整 task ID 不泄露
 * - accept → question list focus
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrillWorkbench } from './GrillWorkbench';
import type {
  DesktopAPI,
  GrillSessionPublicData,
  GrillQuestionPublicData,
  GrillQuestionPlanProposalPublicData,
  TaskPublicData,
} from '@ai-novel/contracts';

// ── Mock 数据 ─────────────────────────────────────────────────────

const mockSession: GrillSessionPublicData = {
  id: 'sess-00000001',
  projectId: 'proj-00000001',
  goal: '测试会话',
  status: 'ACTIVE',
  version: 2,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  startedAt: '2024-01-01T00:00:00Z',
  completedAt: null,
  abandonedAt: null,
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
  ],
  questionCount: 1,
  createdAt: '2024-01-01T00:00:00Z',
  reviewedAt: null,
};

const mockTask: TaskPublicData = {
  id: 'task-00000001',
  projectId: 'proj-00000001',
  taskType: 'GRILL_QUESTION_PLAN',
  status: 'SUCCEEDED',
  attemptCount: 0,
  result: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  startedAt: null,
  finishedAt: null,
};

// ── Helper ────────────────────────────────────────────────────────

async function selectSession() {
  const sessionItem = await screen.findByText('测试会话');
  await act(async () => {
    sessionItem.click();
  });
  await waitFor(() => {
    expect(screen.getByText('请求问题规划')).toBeDefined();
  });
}

// ── Mock DesktopAPI 工厂 ──────────────────────────────────────────

function createMockAPI(
  overrides: Record<string, (...args: ReadonlyArray<unknown>) => unknown> = {},
) {
  return {
    grill: {
      listSessions: vi.fn().mockResolvedValue([mockSession]),
      getSession: vi.fn().mockResolvedValue(mockSession),
      createSession: vi.fn().mockResolvedValue(mockSession),
      startSession: vi.fn().mockResolvedValue(mockSession),
      pauseSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn().mockResolvedValue(mockSession),
      completeSession: vi.fn().mockResolvedValue(mockSession),
      abandonSession: vi.fn().mockResolvedValue(mockSession),
      listQuestions: vi.fn().mockResolvedValue(mockQuestions),
      addQuestions: vi.fn().mockResolvedValue(mockQuestions),
      answerQuestion: vi.fn().mockResolvedValue({ id: 'ans-001' }),
      markQuestionAsked: vi.fn().mockResolvedValue(undefined),
      skipQuestion: vi.fn().mockResolvedValue(undefined),
      supersedeQuestion: vi.fn().mockResolvedValue(undefined),
      listProposals: vi.fn().mockResolvedValue([]),
      getProposal: vi.fn().mockResolvedValue(null),
      createProposal: vi.fn().mockResolvedValue(null),
      reviewProposal: vi.fn().mockResolvedValue(null),
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

describe('问题规划集成测试', () => {
  beforeEach(() => {
    setupDesktop(createMockAPI());
  });

  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
    vi.restoreAllMocks();
  });

  // ── 基础渲染 ──────────────────────────────────────────────────

  it('请求按钮可见', async () => {
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectSession();
  });

  // ── 请求 → 任务状态 → 提案 ───────────────────────────────────

  it('请求后显示任务状态和提案', async () => {
    const user = userEvent.setup();
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    // task should appear (tasks.get returns SUCCEEDED immediately)
    await waitFor(() => {
      expect(screen.getByText('问题规划任务')).toBeDefined();
    });

    // proposals should load after SUCCEEDED
    await waitFor(() => {
      expect(screen.getByText('问题规划提案')).toBeDefined();
    });
  });

  it('请求只调用一次', async () => {
    const user = userEvent.setup();
    const api = setupDesktop(createMockAPI());
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      expect(api.grill.requestQuestionPlan).toHaveBeenCalledTimes(1);
    });
  });

  // ── 提案显示 ──────────────────────────────────────────────────

  it('显示提案列表', async () => {
    const user = userEvent.setup();
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    // Request plan to trigger polling → SUCCEEDED → load proposals
    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      expect(screen.getByText('问题规划提案')).toBeDefined();
      expect(screen.getByText(/问题数量：/)).toBeDefined();
    });
  });

  // ── 接受提案 ──────────────────────────────────────────────────

  it('接受按钮可点击', async () => {
    const user = userEvent.setup();
    const api = setupDesktop(createMockAPI());
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    // Request plan → poll → SUCCEEDED → load proposals
    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      expect(screen.getByText('接受此规划')).toBeDefined();
    });

    const acceptBtn = screen.getByText('接受此规划');
    await user.click(acceptBtn);

    await waitFor(() => {
      expect(api.grill.acceptQuestionPlanProposal).toHaveBeenCalledTimes(1);
    });
  });

  it('接受后刷新 session/questions', async () => {
    const user = userEvent.setup();
    const api = setupDesktop(createMockAPI());
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      expect(screen.getByText('接受此规划')).toBeDefined();
    });

    const acceptBtn = screen.getByText('接受此规划');
    await user.click(acceptBtn);

    await waitFor(() => {
      expect(api.grill.listQuestionPlanProposals).toHaveBeenCalled();
    });
  });

  // ── 焦点管理 ──────────────────────────────────────────────────

  it('task 出现时聚焦 task heading', async () => {
    const user = userEvent.setup();
    // Spy on requestAnimationFrame to ensure it fires
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });

    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      const heading = document.querySelector('.grill-plan-task-heading');
      expect(heading).toHaveFocus();
    });

    rafSpy.mockRestore();
  });

  it('proposal 出现时聚焦 proposal heading', async () => {
    const user = userEvent.setup();
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      const heading = document.querySelector('.grill-plan-proposals-heading');
      expect(heading).toHaveFocus();
    });
  });

  it('accept 成功后聚焦问题列表标题', async () => {
    const user = userEvent.setup();
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      expect(screen.getByText('接受此规划')).toBeDefined();
    });

    const acceptBtn = screen.getByText('接受此规划');
    await user.click(acceptBtn);

    await waitFor(() => {
      const questionListHeading = document.querySelector('.grill-questions-section h4');
      expect(questionListHeading).toHaveFocus();
    });
  });

  // ── 安全错误 ──────────────────────────────────────────────────

  it('错误不包含敏感信息', async () => {
    setupDesktop(
      createMockAPI({
        requestQuestionPlan: vi.fn().mockRejectedValue(
          Object.assign(new Error('/Users/secret/path.sql'), {
            code: 'UNKNOWN_CODE',
          }),
        ),
      }),
    );
    const user = userEvent.setup();
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert).toBeDefined();
      expect(alert?.textContent).not.toContain('/Users/');
      expect(alert?.textContent).not.toContain('sql');
    });
  });

  // ── ARIA ──────────────────────────────────────────────────────

  it('错误有 role=alert', async () => {
    setupDesktop(
      createMockAPI({
        requestQuestionPlan: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('err'), { code: 'GRILL_PLAN_ALREADY_RUNNING' }),
          ),
      }),
    );
    const user = userEvent.setup();
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      expect(alerts.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── version conflict ──────────────────────────────────────────

  it('version conflict 不篡改正式问题', async () => {
    setupDesktop(
      createMockAPI({
        acceptQuestionPlanProposal: vi.fn().mockRejectedValue(
          Object.assign(new Error('conflict'), {
            code: 'GRILL_VERSION_CONFLICT',
          }),
        ),
      }),
    );
    const user = userEvent.setup();
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      expect(screen.getByText('接受此规划')).toBeDefined();
    });

    const acceptBtn = screen.getByText('接受此规划');
    await user.click(acceptBtn);

    await waitFor(() => {
      expect(screen.getByText('角色背景')).toBeDefined();
    });
  });

  // ── stale proposal ────────────────────────────────────────────

  it('stale proposal 接受按钮 disabled', async () => {
    const staleProposal = { ...mockProposal, status: 'SUPERSEDED' as const };
    setupDesktop(
      createMockAPI({
        listQuestionPlanProposals: vi.fn().mockResolvedValue([staleProposal]),
      }),
    );
    const user = userEvent.setup();
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      const btn = screen.getByText('接受此规划') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
  });

  // ── 完整 task ID 不泄露 ───────────────────────────────────────

  it('完整 task ID 不在 DOM 中', async () => {
    const fullUuid = '550e8400-e29b-41d4-a716-446655440000';
    const taskWithUuid = { ...mockTask, id: fullUuid };
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue(taskWithUuid),
      }),
    );
    const user = userEvent.setup();
    render(<GrillWorkbench projectId="proj-00000001" />);

    await selectSession();

    const requestBtn = screen.getByText('请求问题规划');
    await user.click(requestBtn);

    await waitFor(() => {
      expect(document.body.textContent).not.toContain(fullUuid);
    });
  });

  // ── session 切换 ──────────────────────────────────────────────

  it('session 切换重置状态', async () => {
    const session2 = { ...mockSession, id: 'sess-00000002', goal: '第二个会话' };
    setupDesktop(
      createMockAPI({
        listSessions: vi.fn().mockResolvedValue([mockSession, session2]),
      }),
    );
    render(<GrillWorkbench projectId="proj-00000001" />);

    // 选择第一个 session
    const sessionItem1 = await screen.findByText('测试会话');
    await act(async () => {
      sessionItem1.click();
    });

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeDefined();
    });

    // 切换到第二个 session
    const sessionItem2 = screen.getByText('第二个会话');
    await act(async () => {
      sessionItem2.click();
    });

    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeDefined();
    });
  });

  // ── accept 刷新链四阶段 context race ──────────────────────────

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function callsWith(mock: ReturnType<typeof vi.fn>, needle: string): number {
    return mock.mock.calls.filter((c) => JSON.stringify(c).includes(needle)).length;
  }

  const session2 = { ...mockSession, id: 'sess-00000002', goal: '第二个会话' };

  async function acceptFlowSetup(api: ReturnType<typeof createMockAPI>) {
    const user = userEvent.setup();
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectSession();
    await user.click(screen.getByText('请求问题规划'));
    await waitFor(() => {
      expect(screen.getByText('接受此规划')).toBeDefined();
    });
    return { user, api };
  }

  async function switchToSession2() {
    const sessionItem2 = screen.getAllByText('第二个会话')[0];
    await act(async () => {
      sessionItem2.click();
    });
    await waitFor(() => {
      expect(screen.getByText('请求问题规划')).toBeDefined();
    });
  }

  it('accept RPC pending 时切换 session：旧 context 刷新链完全不执行', async () => {
    const acceptDeferred = deferred<unknown>();
    const api = setupDesktop(
      createMockAPI({
        listSessions: vi.fn().mockResolvedValue([mockSession, session2]),
        getSession: vi
          .fn()
          .mockImplementation((...args: ReadonlyArray<unknown>) =>
            JSON.stringify(args).includes('sess-00000002')
              ? Promise.resolve(session2)
              : Promise.resolve(mockSession),
          ),
        acceptQuestionPlanProposal: vi.fn().mockReturnValue(acceptDeferred.promise),
      }),
    );
    const { user } = await acceptFlowSetup(api);

    await user.click(screen.getByText('接受此规划'));

    await switchToSession2();

    const getSessionOld = callsWith(
      api.grill.getSession as ReturnType<typeof vi.fn>,
      'sess-00000001',
    );
    const planProposalsOld = callsWith(
      api.grill.listQuestionPlanProposals as ReturnType<typeof vi.fn>,
      'sess-00000001',
    );

    await act(async () => {
      acceptDeferred.resolve(mockQuestions);
      await new Promise((r) => setTimeout(r, 0));
    });

    // 旧 context 的 session/question-plan 刷新不得执行
    expect(callsWith(api.grill.getSession as ReturnType<typeof vi.fn>, 'sess-00000001')).toBe(
      getSessionOld,
    );
    expect(
      callsWith(api.grill.listQuestionPlanProposals as ReturnType<typeof vi.fn>, 'sess-00000001'),
    ).toBe(planProposalsOld);
    // focus token 不得推进
    expect(document.querySelector('.grill-questions-section h4')).not.toHaveFocus();
  });

  it('session refresh pending 时切换 session：后续 questions 刷新中止', async () => {
    const refreshDeferred = deferred<unknown>();
    let gate = false;
    const api = setupDesktop(
      createMockAPI({
        listSessions: vi.fn().mockResolvedValue([mockSession, session2]),
        getSession: vi.fn().mockImplementation((...args: ReadonlyArray<unknown>) => {
          const s = JSON.stringify(args);
          if (s.includes('sess-00000002')) return Promise.resolve(session2);
          if (gate) return refreshDeferred.promise;
          return Promise.resolve(mockSession);
        }),
      }),
    );
    const { user } = await acceptFlowSetup(api);

    gate = true;
    await user.click(screen.getByText('接受此规划'));

    await switchToSession2();

    const listQuestionsOld = callsWith(
      api.grill.listQuestions as ReturnType<typeof vi.fn>,
      'sess-00000001',
    );

    await act(async () => {
      refreshDeferred.resolve(mockSession);
      await new Promise((r) => setTimeout(r, 0));
    });

    // 旧 context 的 questions 刷新不得执行
    expect(callsWith(api.grill.listQuestions as ReturnType<typeof vi.fn>, 'sess-00000001')).toBe(
      listQuestionsOld,
    );
    expect(document.querySelector('.grill-questions-section h4')).not.toHaveFocus();
  });

  it('questions refresh pending 时切换 session：后续 proposals 刷新中止', async () => {
    const questionsDeferred = deferred<unknown>();
    let gate = false;
    const api = setupDesktop(
      createMockAPI({
        listSessions: vi.fn().mockResolvedValue([mockSession, session2]),
        getSession: vi
          .fn()
          .mockImplementation((...args: ReadonlyArray<unknown>) =>
            JSON.stringify(args).includes('sess-00000002')
              ? Promise.resolve(session2)
              : Promise.resolve(mockSession),
          ),
        listQuestions: vi.fn().mockImplementation((...args: ReadonlyArray<unknown>) => {
          const s = JSON.stringify(args);
          if (s.includes('sess-00000002')) return Promise.resolve([]);
          if (gate) return questionsDeferred.promise;
          return Promise.resolve(mockQuestions);
        }),
      }),
    );
    const { user } = await acceptFlowSetup(api);

    gate = true;
    await user.click(screen.getByText('接受此规划'));

    await switchToSession2();

    const listProposalsOld = callsWith(
      api.grill.listProposals as ReturnType<typeof vi.fn>,
      'sess-00000001',
    );

    await act(async () => {
      questionsDeferred.resolve(mockQuestions);
      await new Promise((r) => setTimeout(r, 0));
    });

    // 旧 context 的 normal proposals 刷新不得执行
    expect(callsWith(api.grill.listProposals as ReturnType<typeof vi.fn>, 'sess-00000001')).toBe(
      listProposalsOld,
    );
    expect(document.querySelector('.grill-questions-section h4')).not.toHaveFocus();
  });

  it('proposals refresh pending 时切换 session：question-plan 提案刷新中止且 focus token 不推进', async () => {
    const proposalsDeferred = deferred<unknown>();
    let gate = false;
    const api = setupDesktop(
      createMockAPI({
        listSessions: vi.fn().mockResolvedValue([mockSession, session2]),
        getSession: vi
          .fn()
          .mockImplementation((...args: ReadonlyArray<unknown>) =>
            JSON.stringify(args).includes('sess-00000002')
              ? Promise.resolve(session2)
              : Promise.resolve(mockSession),
          ),
        listProposals: vi.fn().mockImplementation((...args: ReadonlyArray<unknown>) => {
          const s = JSON.stringify(args);
          if (s.includes('sess-00000002')) return Promise.resolve([]);
          if (gate) return proposalsDeferred.promise;
          return Promise.resolve([]);
        }),
      }),
    );
    const { user } = await acceptFlowSetup(api);

    gate = true;
    await user.click(screen.getByText('接受此规划'));

    await switchToSession2();

    const planProposalsOld = callsWith(
      api.grill.listQuestionPlanProposals as ReturnType<typeof vi.fn>,
      'sess-00000001',
    );

    await act(async () => {
      proposalsDeferred.resolve([]);
      await new Promise((r) => setTimeout(r, 0));
    });

    // 旧 context 的 question-plan 提案刷新不得执行
    expect(
      callsWith(api.grill.listQuestionPlanProposals as ReturnType<typeof vi.fn>, 'sess-00000001'),
    ).toBe(planProposalsOld);
    // focus token 不得推进
    expect(document.querySelector('.grill-questions-section h4')).not.toHaveFocus();
  });
});
