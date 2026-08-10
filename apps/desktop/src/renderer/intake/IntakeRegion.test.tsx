// @vitest-environment jsdom
/**
 * IntakeRegion 组件测试（B4）：相位渲染与人工决策通道调用。
 * Mock DesktopAPI 模式沿用 app.test.tsx。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import type { DesktopAPI } from '@ai-novel/contracts';
import { IntakeRegion } from './IntakeRegion';

const NOW = '2026-08-10T00:00:00.000Z';

const RUN = {
  runId: 'run-1',
  graphId: 'idea-to-novel-project-v1',
  graphVersion: 1,
  kind: 'project',
  terminalStatus: null,
  createdAt: NOW,
};

const SESSION = {
  id: 's1',
  projectId: 'p1',
  status: 'ACTIVE',
  version: 2,
  goal: '一个在赛博都市里修仙的快递员的故事',
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
  completedAt: null,
  abandonedAt: null,
};

const ASKED_QUESTION = {
  id: 'q1',
  sessionId: 's1',
  sequence: 1,
  topic: '篇幅',
  text: '预期篇幅是短篇还是长篇连载？',
  rationale: 'r',
  status: 'ASKED',
  dependsOnQuestionIds: [],
  createdAt: NOW,
  askedAt: NOW,
  answeredAt: null,
  skippedAt: null,
};

function waitingProgress(nodeId: string) {
  return {
    activeNodes: [{ nodeId, stage: 'clarify', status: 'waiting_for_human' }],
    possibleNextNodes: [],
  };
}

function mockApi(overrides: Record<string, unknown> = {}): DesktopAPI {
  return {
    graph: {
      listRuns: vi.fn().mockResolvedValue([RUN]),
      createProjectRun: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      getRunProgress: vi.fn().mockResolvedValue(waitingProgress('COLLECT_ANSWER')),
      applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
    },
    intake: {
      getActiveIntakeSession: vi.fn().mockResolvedValue(SESSION),
      propagateSpecInvalidation: vi.fn().mockResolvedValue([]),
    },
    grill: {
      listQuestions: vi.fn().mockResolvedValue([ASKED_QUESTION]),
      getCurrentAnswers: vi.fn().mockResolvedValue([]),
    },
    contract: {
      getCurrent: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  } as unknown as DesktopAPI;
}

afterEach(() => {
  cleanup();
  window.desktop = undefined as unknown as DesktopAPI;
});

describe('IntakeRegion', () => {
  it('awaiting-answer：展示想法、当前追问与回答区；回答走 intake_answer 决策', async () => {
    const api = mockApi();
    window.desktop = api;
    await act(async () => {
      render(<IntakeRegion projectId="p1" />);
    });

    await waitFor(() => {
      expect(screen.getByText('一个在赛博都市里修仙的快递员的故事')).toBeInTheDocument();
      expect(screen.getByText('预期篇幅是短篇还是长篇连载？')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/输入你的回答/)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/输入你的回答/), {
      target: { value: '长篇连载' },
    });
    await act(async () => {
      screen.getByRole('button', { name: '回答' }).click();
    });

    await waitFor(() => {
      expect(api.graph.applyHumanDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'intake_answer',
          projectId: 'p1',
          runId: 'run-1',
          nodeId: 'COLLECT_ANSWER',
          sessionId: 's1',
          questionId: 'q1',
          text: '长篇连载',
        }),
      );
    });
  });

  it('跳过 / 我说完了 分别走 intake_skip / intake_finish', async () => {
    const api = mockApi();
    window.desktop = api;
    await act(async () => {
      render(<IntakeRegion projectId="p1" />);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '跳过这个问题' })).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByRole('button', { name: '跳过这个问题' }).click();
    });
    await waitFor(() => {
      expect(api.graph.applyHumanDecision).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'intake_skip', nodeId: 'COLLECT_ANSWER' }),
      );
    });

    await act(async () => {
      screen.getByRole('button', { name: '我说完了，就这样整理' }).click();
    });
    await waitFor(() => {
      expect(api.graph.applyHumanDecision).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'intake_finish' }),
      );
    });
  });

  it('escalation：展示四选项，点击走 escalation 决策（闭合 outcome）', async () => {
    const api = mockApi({
      graph: {
        listRuns: vi.fn().mockResolvedValue([RUN]),
        createProjectRun: vi.fn(),
        getRunProgress: vi.fn().mockResolvedValue(waitingProgress('INTAKE_ESCALATION')),
        applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<IntakeRegion projectId="p1" />);
    });

    await waitFor(() => {
      expect(screen.getByText('就用当前的创作要求')).toBeInTheDocument();
      expect(screen.getByText('修改我的想法')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('就用当前的创作要求').click();
    });
    await waitFor(() => {
      expect(api.graph.applyHumanDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'escalation',
          nodeId: 'INTAKE_ESCALATION',
          outcome: 'continue_with_current_spec',
        }),
      );
    });
  });

  it('failed run：友好提示 + 重新开始访谈（新代际幂等键创建新 run，TD-022）', async () => {
    const api = mockApi({
      graph: {
        listRuns: vi.fn().mockResolvedValue([{ ...RUN, terminalStatus: 'failed' }]),
        createProjectRun: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
        getRunProgress: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
        applyHumanDecision: vi.fn(),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<IntakeRegion projectId="p1" />);
    });

    await waitFor(() => {
      expect(screen.getByText(/这次访谈中断了/)).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByRole('button', { name: '重新开始访谈' }).click();
    });
    await waitFor(() => {
      expect(api.graph.createProjectRun).toHaveBeenCalledWith({
        projectId: 'p1',
        idempotencyKey: 'intake-auto:p1:1',
      });
    });
  });

  it('extracting：SPEC_EXTRACT 在途显示整理中状态', async () => {
    const api = mockApi({
      graph: {
        listRuns: vi.fn().mockResolvedValue([RUN]),
        createProjectRun: vi.fn(),
        getRunProgress: vi.fn().mockResolvedValue({
          activeNodes: [{ nodeId: 'SPEC_EXTRACT', stage: 'idea', status: 'active' }],
          possibleNextNodes: [],
        }),
        applyHumanDecision: vi.fn(),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<IntakeRegion projectId="p1" />);
    });

    await waitFor(() => {
      expect(screen.getByText(/正在整理你的创作要求/)).toBeInTheDocument();
    });
  });
});
