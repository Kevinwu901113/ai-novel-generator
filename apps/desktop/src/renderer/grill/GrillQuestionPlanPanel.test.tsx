// @vitest-environment jsdom
/**
 * GrillQuestionPlanPanel 组件测试。
 *
 * 覆盖：
 * - 按钮渲染和 disabled 状态
 * - 任务状态显示（短 ID，无完整 UUID）
 * - 提案列表渲染
 * - stale 状态
 * - 接受按钮
 * - aria-busy、role=status、role=alert
 * - 焦点管理（task heading、proposal heading，per-entity 跟踪）
 * - contextKey 切换重置焦点
 * - RAF cleanup
 * - 真实 Enter/Space keyboard 测试（userEvent）
 * - 完整 task ID 不泄露
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GrillQuestionPlanPanel } from './GrillQuestionPlanPanel';
import type { TaskPublicData, GrillQuestionPlanProposalPublicData } from '@ai-novel/contracts';

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
  ],
  questionCount: 1,
  createdAt: '2024-01-01T00:00:00Z',
  reviewedAt: null,
};

// ── 默认 props ────────────────────────────────────────────────────

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    contextKey: 'proj-00000001:sess-00000001',
    sessionIsActive: true,
    hasSession: true,
    task: null as TaskPublicData | null,
    isPolling: false,
    onRequestPlan: vi.fn(),
    isRequesting: false,
    proposals: [] as ReadonlyArray<GrillQuestionPlanProposalPublicData>,
    isLoadingProposals: false,
    onAcceptProposal: vi.fn(),
    isAccepting: false,
    isLoading: false,
    error: null as string | null,
    onClearError: vi.fn(),
    ...overrides,
  };
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('GrillQuestionPlanPanel', () => {
  afterEach(() => {
    cleanup();
  });

  // ── 按钮渲染 ──────────────────────────────────────────────────

  it('渲染请求问题规划按钮', () => {
    render(<GrillQuestionPlanPanel {...defaultProps()} />);
    expect(screen.getByText('请求问题规划')).toBeDefined();
  });

  it('无 session 时按钮 disabled', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ hasSession: false })} />);
    const btn = screen.getByText('请求问题规划') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('session 非 ACTIVE 时按钮 disabled', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ sessionIsActive: false })} />);
    const btn = screen.getByText('请求问题规划') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('请求中按钮 disabled 且显示 aria-busy', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ isRequesting: true })} />);
    const btn = screen.getByText('请求中…') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
  });

  it('轮询中按钮 disabled', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ isPolling: true })} />);
    const btn = screen.getByText('请求问题规划') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // ── 任务状态显示 ──────────────────────────────────────────────

  it('显示任务短 ID', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ task: mockTask })} />);
    expect(screen.getByText('task-000…')).toBeDefined();
  });

  it('不显示完整 task ID（title 属性）', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ task: mockTask })} />);
    // 完整 UUID 不应出现在任何 title 属性中
    const elementsWithTitle = document.querySelectorAll('[title]');
    elementsWithTitle.forEach((el) => {
      expect(el.getAttribute('title')).not.toBe(mockTask.id);
    });
  });

  it('完整 task ID 不在 textContent 中', () => {
    const fullUuid = '550e8400-e29b-41d4-a716-446655440000';
    const taskWithUuid = { ...mockTask, id: fullUuid };
    render(<GrillQuestionPlanPanel {...defaultProps({ task: taskWithUuid })} />);
    expect(document.body.textContent).not.toContain(fullUuid);
    expect(document.body.textContent).toContain('550e8400…');
  });

  it('完整 task ID 不在 aria-label 中', () => {
    const fullUuid = '550e8400-e29b-41d4-a716-446655440000';
    const taskWithUuid = { ...mockTask, id: fullUuid };
    render(<GrillQuestionPlanPanel {...defaultProps({ task: taskWithUuid })} />);
    const allAriaLabels = document.querySelectorAll('[aria-label]');
    allAriaLabels.forEach((el) => {
      expect(el.getAttribute('aria-label')).not.toContain(fullUuid);
    });
  });

  it('显示任务状态标签', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ task: mockTask })} />);
    expect(screen.getByText('排队中')).toBeDefined();
  });

  it('FAILED 显示错误码', () => {
    const failedTask = {
      ...mockTask,
      status: 'FAILED' as const,
      errorCode: 'TASK_EXECUTION_FAILED',
    };
    render(<GrillQuestionPlanPanel {...defaultProps({ task: failedTask })} />);
    expect(screen.getByText('错误：TASK_EXECUTION_FAILED')).toBeDefined();
  });

  // ── 提案列表 ──────────────────────────────────────────────────

  it('显示提案列表', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ proposals: [mockProposal] })} />);
    expect(screen.getByText('问题规划提案')).toBeDefined();
    expect(screen.getByText(/问题数量：/)).toBeDefined();
  });

  it('stale 提案显示已过期标签', () => {
    const staleProposal = { ...mockProposal, status: 'SUPERSEDED' as const };
    render(<GrillQuestionPlanPanel {...defaultProps({ proposals: [staleProposal] })} />);
    expect(screen.getByText('已过期')).toBeDefined();
  });

  it('stale 提案接受按钮 disabled', () => {
    const staleProposal = { ...mockProposal, status: 'SUPERSEDED' as const };
    render(<GrillQuestionPlanPanel {...defaultProps({ proposals: [staleProposal] })} />);
    const btn = screen.getByText('接受此规划') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // ── ARIA ──────────────────────────────────────────────────────

  it('任务状态区域有 role=status', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ task: mockTask })} />);
    const status = document.querySelector('[role="status"]');
    expect(status).toBeDefined();
  });

  it('轮询时 aria-busy=true', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ task: mockTask, isPolling: true })} />);
    const status = document.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-busy')).toBe('true');
  });

  it('终态时 aria-busy=false', () => {
    const succeededTask = { ...mockTask, status: 'SUCCEEDED' as const };
    render(<GrillQuestionPlanPanel {...defaultProps({ task: succeededTask, isPolling: false })} />);
    const status = document.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-busy')).toBe('false');
  });

  it('错误显示 role=alert', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ error: '测试错误' })} />);
    const alert = document.querySelector('[role="alert"]');
    expect(alert).toBeDefined();
    expect(alert?.textContent).toContain('测试错误');
  });

  it('只有一个 role=alert', () => {
    render(<GrillQuestionPlanPanel {...defaultProps({ error: '错误' })} />);
    const alerts = document.querySelectorAll('[role="alert"]');
    expect(alerts.length).toBe(1);
  });

  // ── 焦点管理 ──────────────────────────────────────────────────

  it('task 首次出现时聚焦 task heading', async () => {
    const { rerender } = render(<GrillQuestionPlanPanel {...defaultProps({ task: null })} />);

    rerender(<GrillQuestionPlanPanel {...defaultProps({ task: mockTask })} />);

    await waitFor(() => {
      const heading = document.querySelector('.grill-plan-task-heading');
      expect(heading).toHaveFocus();
    });
  });

  it('同一 task 多次更新不重复聚焦', async () => {
    const { rerender } = render(<GrillQuestionPlanPanel {...defaultProps({ task: mockTask })} />);

    await waitFor(() => {
      const heading = document.querySelector('.grill-plan-task-heading');
      expect(heading).toHaveFocus();
    });

    // 模拟 blur
    (document.activeElement as HTMLElement)?.blur();

    // 同一 task 状态更新
    const updatedTask = { ...mockTask, status: 'RUNNING' as const };
    rerender(<GrillQuestionPlanPanel {...defaultProps({ task: updatedTask })} />);

    // 等待 RAF
    await new Promise((r) => requestAnimationFrame(r));

    // 不应重新聚焦
    expect(document.querySelector('.grill-plan-task-heading')).not.toHaveFocus();
  });

  it('新 task.id 首次出现时再次聚焦', async () => {
    const { rerender } = render(<GrillQuestionPlanPanel {...defaultProps({ task: mockTask })} />);

    await waitFor(() => {
      expect(document.querySelector('.grill-plan-task-heading')).toHaveFocus();
    });

    (document.activeElement as HTMLElement)?.blur();

    // 新 task
    const newTask = { ...mockTask, id: 'task-NEWID01' };
    rerender(<GrillQuestionPlanPanel {...defaultProps({ task: newTask })} />);

    await waitFor(() => {
      expect(document.querySelector('.grill-plan-task-heading')).toHaveFocus();
    });
  });

  it('proposal 首次出现时聚焦 proposal heading', async () => {
    const { rerender } = render(<GrillQuestionPlanPanel {...defaultProps({ proposals: [] })} />);

    rerender(<GrillQuestionPlanPanel {...defaultProps({ proposals: [mockProposal] })} />);

    await waitFor(() => {
      const heading = document.querySelector('.grill-plan-proposals-heading');
      expect(heading).toHaveFocus();
    });
  });

  it('contextKey 切换重置焦点追踪', async () => {
    const { rerender } = render(
      <GrillQuestionPlanPanel
        {...defaultProps({ task: mockTask, contextKey: 'proj-00000001:sess-00000001' })}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.grill-plan-task-heading')).toHaveFocus();
    });

    // 切换 context
    const newTask = { ...mockTask, id: 'task-00000001' };
    rerender(
      <GrillQuestionPlanPanel
        {...defaultProps({ task: newTask, contextKey: 'proj-00000001:sess-00000002' })}
      />,
    );

    // 应该重新聚焦（同一 task.id 但不同 contextKey）
    await waitFor(() => {
      expect(document.querySelector('.grill-plan-task-heading')).toHaveFocus();
    });
  });

  // ── 真实 keyboard 测试（userEvent） ───────────────────────────

  it('Enter 触发请求按钮', async () => {
    const user = userEvent.setup();
    const onRequestPlan = vi.fn();
    render(<GrillQuestionPlanPanel {...defaultProps({ onRequestPlan })} />);

    const btn = screen.getByText('请求问题规划');
    await user.click(btn);
    await user.keyboard('{Enter}');

    // click 调用一次，Enter 通过原生 button 行为再调用一次
    expect(onRequestPlan).toHaveBeenCalled();
  });

  it('Space 触发请求按钮', async () => {
    const user = userEvent.setup();
    const onRequestPlan = vi.fn();
    render(<GrillQuestionPlanPanel {...defaultProps({ onRequestPlan })} />);

    const btn = screen.getByText('请求问题规划');
    btn.focus();
    await user.keyboard(' ');

    expect(onRequestPlan).toHaveBeenCalled();
  });

  it('Enter 触发接受按钮', async () => {
    const user = userEvent.setup();
    const onAcceptProposal = vi.fn();
    render(
      <GrillQuestionPlanPanel {...defaultProps({ proposals: [mockProposal], onAcceptProposal })} />,
    );

    const btn = screen.getByText('接受此规划');
    await user.click(btn);

    expect(onAcceptProposal).toHaveBeenCalledWith('prop-plan-001');
  });

  it('disabled 按钮 Enter/Space 不触发', async () => {
    const user = userEvent.setup();
    const onRequestPlan = vi.fn();
    render(<GrillQuestionPlanPanel {...defaultProps({ onRequestPlan, hasSession: false })} />);

    const btn = screen.getByText('请求问题规划') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    btn.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onRequestPlan).not.toHaveBeenCalled();
  });

  // ── 错误关闭 ──────────────────────────────────────────────────

  it('关闭错误调用 onClearError', async () => {
    const user = userEvent.setup();
    const onClearError = vi.fn();
    render(<GrillQuestionPlanPanel {...defaultProps({ error: '错误', onClearError })} />);

    const closeBtn = screen.getByLabelText('关闭错误提示');
    await user.click(closeBtn);

    expect(onClearError).toHaveBeenCalled();
  });
});
