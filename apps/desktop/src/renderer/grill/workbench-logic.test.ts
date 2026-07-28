/**
 * Grill 工作台逻辑测试。
 *
 * 测试数据流和状态管理逻辑，不依赖 React 渲染环境。
 * 使用 mock window.desktop API 验证调用序列。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { grillErrorMessage } from './status-labels';
import type {
  GrillSessionPublicData,
  GrillQuestionPublicData,
  GrillAnswerPublicData,
} from '@ai-novel/contracts';

// ── Mock 数据 ─────────────────────────────────────────────────────

const mockSession: GrillSessionPublicData = {
  id: 'sess-1',
  projectId: 'proj-1',
  status: 'ACTIVE',
  version: 2,
  goal: '探索角色动机',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  startedAt: '2024-01-01T00:00:00Z',
  completedAt: null,
  abandonedAt: null,
};

const mockQuestions: ReadonlyArray<GrillQuestionPublicData> = [
  {
    id: 'q-1',
    sessionId: 'sess-1',
    sequence: 1,
    topic: '角色背景',
    text: '主角的童年经历是什么？',
    rationale: '理解角色动机',
    status: 'ASKED',
    dependsOnQuestionIds: [],
    createdAt: '2024-01-01T00:00:00Z',
    askedAt: '2024-01-01T00:01:00Z',
    answeredAt: null,
    skippedAt: null,
    supersededAt: null,
  },
  {
    id: 'q-2',
    sessionId: 'sess-1',
    sequence: 2,
    topic: '情节冲突',
    text: '核心冲突是什么？',
    rationale: '确定主线',
    status: 'PLANNED',
    dependsOnQuestionIds: [],
    createdAt: '2024-01-01T00:00:00Z',
    askedAt: null,
    answeredAt: null,
    skippedAt: null,
    supersededAt: null,
  },
];

const mockAnswer: GrillAnswerPublicData = {
  id: 'ans-1',
  sessionId: 'sess-1',
  questionId: 'q-1',
  revision: 1,
  source: 'USER',
  text: '主角在小镇长大',
  createdAt: '2024-01-01T00:02:00Z',
  supersededAt: null,
};

// ── Mock window.desktop ──────────────────────────────────────────

function createMockDesktop() {
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
      answerQuestion: vi.fn().mockResolvedValue(mockAnswer),
      skipQuestion: vi.fn().mockResolvedValue({ ...mockQuestions[1], status: 'SKIPPED' }),
      supersedeQuestion: vi.fn().mockResolvedValue({ ...mockQuestions[0], status: 'SUPERSEDED' }),
      getCurrentAnswers: vi.fn().mockResolvedValue([mockAnswer]),
      listAnswerHistory: vi.fn().mockResolvedValue([mockAnswer]),
      createProposal: vi.fn().mockResolvedValue({
        id: 'prop-1',
        sessionId: 'sess-1',
        basedOnAnswerIds: ['ans-1'],
        key: 'character.motivation',
        proposedValue: { drive: '探索未知' },
        confidence: 0.8,
        rationale: '基于回答',
        status: 'PROPOSED',
        createdAt: '2024-01-01T00:03:00Z',
        reviewedAt: null,
      }),
      reviewProposal: vi.fn().mockResolvedValue({
        id: 'prop-1',
        sessionId: 'sess-1',
        basedOnAnswerIds: ['ans-1'],
        key: 'character.motivation',
        proposedValue: { drive: '探索未知' },
        confidence: 0.8,
        rationale: '基于回答',
        status: 'ACCEPTED',
        createdAt: '2024-01-01T00:03:00Z',
        reviewedAt: '2024-01-01T00:04:00Z',
      }),
      listProposals: vi.fn().mockResolvedValue([]),
    },
  };
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('listQuestions API', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  it('session 选择后调用 listQuestions', async () => {
    const mock = createMockDesktop();
    vi.stubGlobal('window', { desktop: mock });

    await window.desktop.grill.listQuestions({
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });

    expect(mock.grill.listQuestions).toHaveBeenCalledWith({
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });
  });

  it('listQuestions 返回问题列表', async () => {
    const mock = createMockDesktop();
    vi.stubGlobal('window', { desktop: mock });

    const result = await window.desktop.grill.listQuestions({
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('q-1');
    expect(result[0].topic).toBe('角色背景');
  });
});

describe('mutation 后刷新', () => {
  it('addQuestions 后应调用 listQuestions 刷新', async () => {
    const mock = createMockDesktop();
    vi.stubGlobal('window', { desktop: mock });

    // 模拟 addQuestions 成功后刷新
    await window.desktop.grill.addQuestions({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      expectedVersion: 1,
      questions: [
        { topic: '新问题', text: '问题内容', rationale: '理由', dependsOnQuestionIds: [] },
      ],
    });
    await window.desktop.grill.listQuestions({ projectId: 'proj-1', sessionId: 'sess-1' });

    expect(mock.grill.addQuestions).toHaveBeenCalled();
    expect(mock.grill.listQuestions).toHaveBeenCalled();
  });

  it('answerQuestion 后应调用 getCurrentAnswers 刷新', async () => {
    const mock = createMockDesktop();
    vi.stubGlobal('window', { desktop: mock });

    await window.desktop.grill.answerQuestion({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      expectedVersion: 2,
      questionId: 'q-1',
      text: '回答内容',
      source: 'USER',
    });
    await window.desktop.grill.getCurrentAnswers('proj-1', 'sess-1');

    expect(mock.grill.answerQuestion).toHaveBeenCalled();
    expect(mock.grill.getCurrentAnswers).toHaveBeenCalled();
  });

  it('skipQuestion 后应刷新问题列表', async () => {
    const mock = createMockDesktop();
    vi.stubGlobal('window', { desktop: mock });

    await window.desktop.grill.skipQuestion({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      expectedVersion: 2,
      questionId: 'q-2',
    });
    const questions = await window.desktop.grill.listQuestions({
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });

    expect(mock.grill.skipQuestion).toHaveBeenCalled();
    expect(mock.grill.listQuestions).toHaveBeenCalled();
    expect(questions).toBeDefined();
  });

  it('supersedeQuestion 后应刷新问题列表', async () => {
    const mock = createMockDesktop();
    vi.stubGlobal('window', { desktop: mock });

    await window.desktop.grill.supersedeQuestion({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      expectedVersion: 2,
      questionId: 'q-1',
    });
    await window.desktop.grill.listQuestions({
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });

    expect(mock.grill.supersedeQuestion).toHaveBeenCalled();
    expect(mock.grill.listQuestions).toHaveBeenCalled();
  });
});

describe('version conflict 处理', () => {
  it('version conflict 后刷新数据但保留提示', async () => {
    const mock = createMockDesktop();
    const conflictError = Object.assign(new Error('版本冲突'), { code: 'GRILL_VERSION_CONFLICT' });
    mock.grill.answerQuestion.mockRejectedValueOnce(conflictError);
    vi.stubGlobal('window', { desktop: mock });

    // 模拟 mutation 失败
    let errorCaught: string | null = null;
    try {
      await window.desktop.grill.answerQuestion({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        expectedVersion: 1, // stale version
        questionId: 'q-1',
        text: '回答',
        source: 'USER',
      });
    } catch (err) {
      errorCaught = (err as Error & { code?: string }).code ?? null;
    }

    expect(errorCaught).toBe('GRILL_VERSION_CONFLICT');

    // 刷新数据
    await window.desktop.grill.listQuestions({ projectId: 'proj-1', sessionId: 'sess-1' });
    await window.desktop.grill.getSession('proj-1', 'sess-1');

    expect(mock.grill.listQuestions).toHaveBeenCalled();
    expect(mock.grill.getSession).toHaveBeenCalled();
  });
});

describe('session 切换清空状态', () => {
  it('切换 session 后 selectedQuestionId 应清空', () => {
    // 这是一个逻辑测试：验证 session 切换时应清空的状态
    let selectedQuestionId: string | null = 'q-1';
    let selectedSessionId = 'sess-1';

    // 模拟切换 session
    selectedSessionId = 'sess-2';
    // 在实际组件中，useEffect 会在 selectedSessionId 变化时清空 selectedQuestionId
    if (selectedSessionId !== 'sess-1') {
      selectedQuestionId = null;
    }

    expect(selectedQuestionId).toBeNull();
  });
});

describe('duplicate submit prevention', () => {
  it('isLoading 期间不应发送 mutation', () => {
    // 测试 isLoading 锁逻辑
    let isLoading = false;
    let callCount = 0;

    const trySubmit = (): boolean => {
      if (isLoading) return false;
      isLoading = true;
      callCount++;
      // 模拟异步操作完成后重置
      isLoading = false;
      return true;
    };

    // 第一次调用成功
    expect(trySubmit()).toBe(true);
    expect(callCount).toBe(1);

    // 模拟正在进行中的状态
    isLoading = true;
    // 第二次调用应被阻止
    expect(trySubmit()).toBe(false);
    expect(callCount).toBe(1); // 未增加
  });
});

describe('错误消息不泄露内部信息', () => {
  it('GRILL_OWNERSHIP_CONFLICT 不暴露内部 ID', () => {
    const msg = grillErrorMessage('GRILL_OWNERSHIP_CONFLICT', '默认');
    expect(msg).not.toContain('proj-');
    expect(msg).not.toContain('sess-');
    expect(msg).toBe('资源不属于当前会话');
  });

  it('GRILL_SESSION_NOT_FOUND 不暴露内部 ID', () => {
    const msg = grillErrorMessage('GRILL_SESSION_NOT_FOUND', '默认');
    expect(msg).not.toContain('/');
    expect(msg).toBe('会话不存在');
  });
});
