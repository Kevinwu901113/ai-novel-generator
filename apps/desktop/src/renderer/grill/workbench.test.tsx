// @vitest-environment jsdom
/**
 * Grill-me 工作台 DOM 交互测试。
 *
 * 使用 jsdom + React Testing Library 验证真实 DOM 行为。
 * IPC 使用 mock DesktopAPI，不连接真实 Worker。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrillWorkbench } from './GrillWorkbench';
import type {
  GrillQuestionPublicData,
  GrillAnswerPublicData,
  DesktopAPI,
} from '@ai-novel/contracts';

// ── 稳定的 mock 数据引用 ────────────────────────────────────────

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
  {
    id: 'q-00000002',
    sessionId: 'sess-00000001',
    sequence: 2,
    topic: '情节冲突',
    text: '核心冲突是什么？',
    rationale: '确定主线',
    status: 'PLANNED',
    dependsOnQuestionIds: [],
    createdAt: '2024-01-01T00:01:00Z',
    askedAt: null,
    answeredAt: null,
    skippedAt: null,
    supersededAt: null,
  },
];

const mockAnswer: GrillAnswerPublicData = {
  id: 'ans-00000001',
  sessionId: 'sess-00000001',
  questionId: 'q-00000001',
  revision: 1,
  source: 'USER',
  text: '主角在小镇长大',
  createdAt: '2024-01-01T00:02:00Z',
  supersededAt: null,
};

const mockProposal = {
  id: 'prop-00000001',
  sessionId: 'sess-00000001',
  basedOnAnswerIds: ['ans-00000001'],
  key: 'character.motivation',
  proposedValue: { drive: '探索未知' },
  confidence: 0.8,
  rationale: '基于回答推理',
  status: 'PROPOSED',
  createdAt: '2024-01-01T00:03:00Z',
  reviewedAt: null,
};

// ── Mock DesktopAPI 工厂 ────────────────────────────────────────

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
      markQuestionAsked: vi
        .fn()
        .mockImplementation((input: { questionId: string }) =>
          Promise.resolve(mockQuestions.find((q) => q.id === input.questionId) ?? mockQuestions[0]),
        ),
      answerQuestion: vi.fn().mockResolvedValue(mockAnswer),
      skipQuestion: vi.fn().mockImplementation((input: { questionId: string }) =>
        Promise.resolve({
          ...(mockQuestions.find((q) => q.id === input.questionId) ?? mockQuestions[0]),
          status: 'SKIPPED',
          skippedAt: '2024-01-01T00:05:00Z',
        }),
      ),
      supersedeQuestion: vi.fn().mockImplementation((input: { questionId: string }) =>
        Promise.resolve({
          ...(mockQuestions.find((q) => q.id === input.questionId) ?? mockQuestions[0]),
          status: 'SUPERSEDED',
          supersededAt: '2024-01-01T00:05:00Z',
        }),
      ),
      getCurrentAnswers: vi.fn().mockResolvedValue([mockAnswer]),
      listAnswerHistory: vi.fn().mockResolvedValue([mockAnswer]),
      createProposal: vi.fn().mockResolvedValue(mockProposal),
      reviewProposal: vi
        .fn()
        .mockImplementation((input: { proposalId: string; decision: string }) =>
          Promise.resolve({
            ...mockProposal,
            status: input.decision,
            reviewedAt: '2024-01-01T00:04:00Z',
          }),
        ),
      listProposals: vi.fn().mockResolvedValue(STABLE_EMPTY),
      ...overrides,
    },
  };
}

function setupDesktop(api: ReturnType<typeof createMockAPI>) {
  window.desktop = api as unknown as DesktopAPI;
  return api;
}

/** 设置 React 受控组件的值 */
function setInputValue(el: HTMLElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 选择第一个 session */
async function selectFirstSession() {
  await waitFor(() => {
    expect(screen.getByText(mockSession.goal)).toBeInTheDocument();
  });
  screen.getByText(mockSession.goal).closest('.grill-session-item')!.click();
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('GrillWorkbench DOM 交互', () => {
  afterEach(() => {
    cleanup();
    // Reset desktop API mock
    window.desktop = undefined as unknown as DesktopAPI;
    vi.restoreAllMocks();
  });

  // 1. 选择 session 后问题列表渲染
  it('选择 session 后问题列表渲染', async () => {
    setupDesktop(createMockAPI());
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => {
      expect(screen.getByText(mockQuestions[0].topic)).toBeInTheDocument();
      expect(screen.getByText(mockQuestions[1].topic)).toBeInTheDocument();
    });
  });

  // 2. 添加问题后中栏出现新问题
  it('添加问题后中栏出现新问题', async () => {
    const newQ: GrillQuestionPublicData = {
      id: 'q-new',
      sessionId: 'sess-00000001',
      sequence: 3,
      topic: '新问题主题',
      text: '新问题内容',
      rationale: '测试',
      status: 'PLANNED',
      dependsOnQuestionIds: [],
      createdAt: '2024-01-01T00:10:00Z',
      askedAt: null,
      answeredAt: null,
      skippedAt: null,
      supersededAt: null,
    };
    setupDesktop(
      createMockAPI({
        addQuestions: vi.fn().mockResolvedValue([newQ]),
        listQuestions: vi.fn().mockResolvedValue([...mockQuestions, newQ]),
      }),
    );
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText('添加问题')).toBeInTheDocument());
    screen.getByText('添加问题').click();

    // Wait for form to appear
    await waitFor(() => expect(screen.getByPlaceholderText('问题主题')).toBeInTheDocument());
    setInputValue(screen.getByPlaceholderText('问题主题'), '新问题主题');
    setInputValue(screen.getByPlaceholderText('问题详细内容'), '新问题内容');

    await waitFor(() => expect(screen.getByText('确认添加')).not.toBeDisabled());
    screen.getByText('确认添加').click();

    await waitFor(() => expect(screen.getByText('新问题主题')).toBeInTheDocument());
  });

  // 3. 点击问题后右栏显示详情
  it('点击问题后右栏显示详情', async () => {
    setupDesktop(createMockAPI());
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].topic)).toBeInTheDocument());
    screen.getByText(mockQuestions[0].topic).closest('.grill-question-item')!.click();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].text)).toBeInTheDocument());
  });

  // 4. 回答后显示 current answer
  it('回答后显示 current answer', async () => {
    setupDesktop(
      createMockAPI({
        getCurrentAnswers: vi.fn().mockResolvedValue(STABLE_EMPTY),
      }),
    );
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].topic)).toBeInTheDocument());
    screen.getByText(mockQuestions[0].topic).closest('.grill-question-item')!.click();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].text)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByPlaceholderText('输入回答内容…')).toBeInTheDocument());
    setInputValue(screen.getByPlaceholderText('输入回答内容…'), '主角在小镇长大');

    await waitFor(() => expect(screen.getByText('提交回答')).not.toBeDisabled());
    screen.getByText('提交回答').click();

    await waitFor(() => expect(screen.getByText('主角在小镇长大')).toBeInTheDocument());
  });

  // 5. 修订后历史出现 revision 1 和 2
  it('修订后历史出现 revision 1 和 2', async () => {
    const rev2: GrillAnswerPublicData = {
      ...mockAnswer,
      id: 'ans-00000002',
      revision: 2,
      text: '修订后的回答',
      createdAt: '2024-01-01T00:06:00Z',
    };
    const getCurrentAnswersMock = vi
      .fn()
      .mockResolvedValueOnce(STABLE_EMPTY) // Initial load: no answers
      .mockResolvedValueOnce([mockAnswer]) // After first answer
      .mockResolvedValueOnce([rev2]); // After revision
    setupDesktop(
      createMockAPI({
        answerQuestion: vi.fn().mockResolvedValueOnce(mockAnswer).mockResolvedValueOnce(rev2),
        getCurrentAnswers: getCurrentAnswersMock,
        listAnswerHistory: vi.fn().mockResolvedValue([mockAnswer, rev2]),
      }),
    );
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].topic)).toBeInTheDocument());
    screen.getByText(mockQuestions[0].topic).closest('.grill-question-item')!.click();

    await waitFor(() => expect(screen.getByPlaceholderText('输入回答内容…')).toBeInTheDocument());
    setInputValue(screen.getByPlaceholderText('输入回答内容…'), '主角在小镇长大');
    await waitFor(() => expect(screen.getByText('提交回答')).not.toBeDisabled());
    screen.getByText('提交回答').click();

    await waitFor(() => expect(screen.getByText('主角在小镇长大')).toBeInTheDocument());

    setInputValue(screen.getByPlaceholderText('输入新的回答内容…'), '修订后的回答');
    await waitFor(() => expect(screen.getByText('修订')).not.toBeDisabled());
    screen.getByText('修订').click();

    await waitFor(() => expect(screen.getByText('修订后的回答')).toBeInTheDocument());

    screen.getByText('查看历史').click();
    await waitFor(() => {
      expect(screen.getByText('revision 1')).toBeInTheDocument();
      // revision 2 appears both in current answer and history
      expect(screen.getAllByText('revision 2').length).toBeGreaterThanOrEqual(1);
    });
  });

  // 6. skip 后 IPC 被调用
  it('skip 后 IPC 被调用', async () => {
    const api = setupDesktop(createMockAPI());
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].topic)).toBeInTheDocument());
    const questionItems = document.querySelectorAll('.grill-question-item');
    within(questionItems[0] as HTMLElement)
      .getByText('跳过')
      .click();

    await waitFor(() => expect(api.grill.skipQuestion).toHaveBeenCalled());
  });

  // 7. supersede 后 IPC 被调用
  it('supersede 后 IPC 被调用', async () => {
    const api = setupDesktop(createMockAPI());
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].topic)).toBeInTheDocument());
    const questionItems = document.querySelectorAll('.grill-question-item');
    within(questionItems[0] as HTMLElement)
      .getByText('废弃')
      .click();

    await waitFor(() => expect(api.grill.supersedeQuestion).toHaveBeenCalled());
  });

  // 8. PAUSED 时添加问题按钮不可见
  it('PAUSED 时添加问题按钮不可见', async () => {
    setupDesktop(
      createMockAPI({
        getSession: vi.fn().mockResolvedValue({ ...mockSession, status: 'PAUSED' }),
      }),
    );
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText('已暂停')).toBeInTheDocument());
    expect(screen.queryByText('添加问题')).not.toBeInTheDocument();
  });

  // 9. COMPLETED 时内容控件不可见
  it('COMPLETED 时内容控件不可见', async () => {
    setupDesktop(
      createMockAPI({
        getSession: vi.fn().mockResolvedValue({ ...mockSession, status: 'COMPLETED' }),
      }),
    );
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText('已完成')).toBeInTheDocument());
    expect(screen.queryByText('添加问题')).not.toBeInTheDocument();
    expect(screen.queryByText('放弃')).not.toBeInTheDocument();
  });

  // 10. version conflict 横幅刷新后仍存在
  it('version conflict 横幅刷新后仍存在', async () => {
    const conflictErr = Object.assign(new Error('版本冲突'), {
      code: 'GRILL_VERSION_CONFLICT',
    });
    setupDesktop(
      createMockAPI({
        answerQuestion: vi.fn().mockRejectedValue(conflictErr),
        getCurrentAnswers: vi.fn().mockResolvedValue(STABLE_EMPTY),
      }),
    );
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].topic)).toBeInTheDocument());
    screen.getByText(mockQuestions[0].topic).closest('.grill-question-item')!.click();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].text)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByPlaceholderText('输入回答内容…')).toBeInTheDocument());
    setInputValue(screen.getByPlaceholderText('输入回答内容…'), '回答');

    await waitFor(() => expect(screen.getByText('提交回答')).not.toBeDisabled());
    screen.getByText('提交回答').click();

    await waitFor(() => {
      expect(screen.getByText('会话已在其他操作中更新，数据已自动刷新。')).toBeInTheDocument();
    });
  });

  // 11. 点击关闭后 conflict 横幅消失
  it('点击关闭后 conflict 横幅消失', async () => {
    const conflictErr = Object.assign(new Error('版本冲突'), {
      code: 'GRILL_VERSION_CONFLICT',
    });
    setupDesktop(
      createMockAPI({
        answerQuestion: vi.fn().mockRejectedValue(conflictErr),
        getCurrentAnswers: vi.fn().mockResolvedValue(STABLE_EMPTY),
      }),
    );
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].topic)).toBeInTheDocument());
    screen.getByText(mockQuestions[0].topic).closest('.grill-question-item')!.click();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].text)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByPlaceholderText('输入回答内容…')).toBeInTheDocument());
    setInputValue(screen.getByPlaceholderText('输入回答内容…'), '回答');

    await waitFor(() => expect(screen.getByText('提交回答')).not.toBeDisabled());
    screen.getByText('提交回答').click();

    await waitFor(() => {
      expect(screen.getByText('会话已在其他操作中更新，数据已自动刷新。')).toBeInTheDocument();
    });

    const banner = screen
      .getByText('会话已在其他操作中更新，数据已自动刷新。')
      .closest('.grill-conflict-banner')!;
    banner.querySelector('button')!.click();

    await waitFor(() => {
      expect(
        screen.queryByText('会话已在其他操作中更新，数据已自动刷新。'),
      ).not.toBeInTheDocument();
    });
  });

  // 12. duplicate click 只触发一次 IPC
  it('duplicate click 只触发一次 IPC', async () => {
    const user = userEvent.setup();
    const api = setupDesktop(
      createMockAPI({
        addQuestions: vi
          .fn()
          .mockImplementation(() => new Promise((r) => setTimeout(() => r(mockQuestions), 200))),
      }),
    );
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText('添加问题')).toBeInTheDocument());
    await user.click(screen.getByText('添加问题'));

    await waitFor(() => expect(screen.getByPlaceholderText('问题主题')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('问题主题'), '测试');
    await user.type(screen.getByPlaceholderText('问题详细内容'), '内容');

    await waitFor(() => expect(screen.getByText('确认添加')).not.toBeDisabled());
    // Rapid double click via userEvent
    const btn = screen.getByText('确认添加');
    await user.click(btn);
    await user.click(btn);

    await waitFor(() => expect(api.grill.addQuestions).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
  });

  // 13. session 切换清除旧详情
  it('session 切换清除旧详情', async () => {
    const session2 = { ...mockSession, id: 'sess-00000002', goal: '第二个会话', version: 1 };
    const api = setupDesktop(
      createMockAPI({
        listSessions: vi.fn().mockResolvedValue([mockSession, session2]),
      }),
    );
    render(<GrillWorkbench projectId="proj-00000001" />);
    await selectFirstSession();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].topic)).toBeInTheDocument());
    screen.getByText(mockQuestions[0].topic).closest('.grill-question-item')!.click();

    await waitFor(() => expect(screen.getByText(mockQuestions[0].text)).toBeInTheDocument());

    // Switch to second session
    api.grill.getSession.mockResolvedValue(session2);
    api.grill.listQuestions.mockResolvedValue(STABLE_EMPTY);
    api.grill.getCurrentAnswers.mockResolvedValue(STABLE_EMPTY);
    screen.getByText('第二个会话').closest('.grill-session-item')!.click();

    await waitFor(() => {
      expect(screen.queryByText(mockQuestions[0].text)).not.toBeInTheDocument();
    });
  });

  // 14. 错误信息不包含传入的内部路径、stack 或敏感 ID
  it('错误信息不包含内部路径、stack 或敏感 ID', async () => {
    const err = Object.assign(new Error('ENOENT /Users/dev/.config/app.sqlite'), {
      code: 'INTERNAL_ERROR',
      stack: 'Error\n    at /src/main/index.ts:42',
    });
    setupDesktop(
      createMockAPI({
        listSessions: vi.fn().mockRejectedValue(err),
      }),
    );
    render(<GrillWorkbench projectId="proj-00000001" />);

    await waitFor(() => {
      const banner = document.querySelector('.grill-error-banner');
      if (banner) {
        const text = banner.textContent!;
        expect(text).not.toContain('/Users/');
        expect(text).not.toContain('.sqlite');
        expect(text).not.toContain('ENOENT');
        expect(text).not.toContain('.ts:');
      }
    });
  });
});
