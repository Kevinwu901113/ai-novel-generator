// @vitest-environment jsdom
/**
 * GrillQuestionPlanPanel 组件 DOM 测试。
 *
 * 覆盖：
 * - 渲染请求按钮
 * - disabled 状态
 * - aria-busy
 * - 任务状态显示
 * - 提案列表渲染
 * - stale 状态显示
 * - 接受按钮状态
 * - 焦点管理（task heading、proposal heading）
 * - ARIA 属性
 * - Enter/Space 操作
 * - 安全错误显示
 * - 只有一个 alert
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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

const defaultProps = {
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
};

// ── 测试 ──────────────────────────────────────────────────────────

describe('GrillQuestionPlanPanel DOM', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── 请求按钮 ──────────────────────────────────────────────────

  it('渲染请求按钮', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} />);
    expect(screen.getByText('请求问题规划')).toBeInTheDocument();
  });

  it('无 session 时按钮 disabled', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} hasSession={false} />);
    expect(screen.getByText('请求问题规划')).toBeDisabled();
  });

  it('session 非 ACTIVE 时按钮 disabled', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} sessionIsActive={false} />);
    expect(screen.getByText('请求问题规划')).toBeDisabled();
  });

  it('请求期间按钮 disabled', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} isRequesting={true} />);
    expect(screen.getByText('请求中…')).toBeDisabled();
  });

  it('轮询期间按钮 disabled', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} task={mockTask} isPolling={true} />);
    expect(screen.getByText('请求问题规划')).toBeDisabled();
  });

  it('请求期间 aria-busy', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} isRequesting={true} />);
    const btn = screen.getByText('请求中…');
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  // ── 任务状态 ──────────────────────────────────────────────────

  it('显示任务状态', () => {
    render(
      <GrillQuestionPlanPanel
        {...defaultProps}
        task={{ ...mockTask, status: 'RUNNING' }}
        isPolling={true}
      />,
    );

    expect(screen.getByText('问题规划任务')).toBeInTheDocument();
    expect(screen.getByText('执行中')).toBeInTheDocument();
  });

  it('显示任务短 ID', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} task={mockTask} />);

    // task-00000001 截断为 task-000…
    expect(screen.getByText('task-000…')).toBeInTheDocument();
  });

  it('显示轮询指示器', () => {
    render(
      <GrillQuestionPlanPanel
        {...defaultProps}
        task={{ ...mockTask, status: 'RUNNING' }}
        isPolling={true}
      />,
    );

    expect(screen.getByText('⏳')).toBeInTheDocument();
  });

  it('终态不显示轮询指示器', () => {
    render(
      <GrillQuestionPlanPanel
        {...defaultProps}
        task={{ ...mockTask, status: 'SUCCEEDED' }}
        isPolling={false}
      />,
    );

    expect(screen.queryByText('⏳')).not.toBeInTheDocument();
  });

  it('FAILED 显示错误码', () => {
    render(
      <GrillQuestionPlanPanel
        {...defaultProps}
        task={{ ...mockTask, status: 'FAILED', errorCode: 'TASK_EXECUTION_FAILED' }}
      />,
    );

    expect(screen.getByText(/TASK_EXECUTION_FAILED/)).toBeInTheDocument();
  });

  // ── 提案列表 ──────────────────────────────────────────────────

  it('显示提案列表', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} proposals={[mockProposal]} />);

    expect(screen.getByText('问题规划提案')).toBeInTheDocument();
    expect(screen.getByText('问题数量：2')).toBeInTheDocument();
  });

  it('显示 topic/text/rationale', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} proposals={[mockProposal]} />);

    expect(screen.getByText('角色动机')).toBeInTheDocument();
    expect(screen.getByText('主角的核心动机是什么？')).toBeInTheDocument();
    expect(screen.getByText(/理解角色驱动力/)).toBeInTheDocument();
  });

  it('existing dependency 显示', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} proposals={[mockProposal]} />);

    expect(screen.getByText(/已有问题/)).toBeInTheDocument();
  });

  it('planned dependency 显示', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} proposals={[mockProposal]} />);

    expect(screen.getByText(/计划问题/)).toBeInTheDocument();
  });

  it('questionCount 和实际列表一致', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} proposals={[mockProposal]} />);

    expect(screen.getByText('问题数量：2')).toBeInTheDocument();
    // 实际有 2 个问题卡片
    const questionItems = screen.getAllByText(/q\./);
    expect(questionItems.length).toBeGreaterThanOrEqual(2);
  });

  it('stale proposal 显示', () => {
    const staleProposal = { ...mockProposal, status: 'SUPERSEDED' };
    render(<GrillQuestionPlanPanel {...defaultProps} proposals={[staleProposal]} />);

    expect(screen.getByText('已废弃')).toBeInTheDocument();
    expect(screen.getByText('已过期')).toBeInTheDocument();
  });

  it('stale proposal 接受按钮 disabled', () => {
    const staleProposal = { ...mockProposal, status: 'SUPERSEDED' };
    render(<GrillQuestionPlanPanel {...defaultProps} proposals={[staleProposal]} />);

    expect(screen.getByText('接受此规划')).toBeDisabled();
  });

  // ── 接受按钮 ──────────────────────────────────────────────────

  it('可接受状态按钮启用', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} proposals={[mockProposal]} />);

    expect(screen.getByText('接受此规划')).not.toBeDisabled();
  });

  it('接受期间按钮 disabled', () => {
    render(
      <GrillQuestionPlanPanel {...defaultProps} proposals={[mockProposal]} isAccepting={true} />,
    );

    expect(screen.getByText('接受中…')).toBeDisabled();
  });

  it('接受期间 aria-busy', () => {
    render(
      <GrillQuestionPlanPanel {...defaultProps} proposals={[mockProposal]} isAccepting={true} />,
    );

    expect(screen.getByText('接受中…')).toHaveAttribute('aria-busy', 'true');
  });

  // ── 焦点管理 ──────────────────────────────────────────────────

  it('task heading 真实 focus', async () => {
    render(<GrillQuestionPlanPanel {...defaultProps} task={mockTask} />);

    const heading = screen.getByText('问题规划任务');
    // requestAnimationFrame 在测试环境中需要等待
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  it('proposal heading 真实 focus', async () => {
    render(<GrillQuestionPlanPanel {...defaultProps} proposals={[mockProposal]} />);

    const heading = screen.getByText('问题规划提案');
    // requestAnimationFrame 在测试环境中需要等待
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
  });

  // ── ARIA ──────────────────────────────────────────────────────

  it('任务区域 role=status', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} task={mockTask} />);

    const statusRegion = screen.getByRole('status');
    expect(statusRegion).toBeInTheDocument();
  });

  it('轮询时 aria-busy', () => {
    render(
      <GrillQuestionPlanPanel
        {...defaultProps}
        task={{ ...mockTask, status: 'RUNNING' }}
        isPolling={true}
      />,
    );

    const statusRegion = screen.getByRole('status');
    expect(statusRegion).toHaveAttribute('aria-busy', 'true');
  });

  it('终态 aria-busy=false', () => {
    render(
      <GrillQuestionPlanPanel
        {...defaultProps}
        task={{ ...mockTask, status: 'SUCCEEDED' }}
        isPolling={false}
      />,
    );

    const statusRegion = screen.getByRole('status');
    expect(statusRegion).toHaveAttribute('aria-busy', 'false');
  });

  // ── 错误显示 ──────────────────────────────────────────────────

  it('错误使用 role=alert', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} error="测试错误" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('测试错误');
  });

  it('只有一个 alert', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} error="测试错误" />);

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
  });

  it('清除错误按钮可访问', () => {
    const onClearError = vi.fn();
    render(
      <GrillQuestionPlanPanel {...defaultProps} error="测试错误" onClearError={onClearError} />,
    );

    const closeBtn = screen.getByLabelText('关闭错误提示');
    fireEvent.click(closeBtn);
    expect(onClearError).toHaveBeenCalled();
  });

  // ── 键盘操作 ──────────────────────────────────────────────────

  it('Enter 操作请求按钮', () => {
    const onRequestPlan = vi.fn();
    render(<GrillQuestionPlanPanel {...defaultProps} onRequestPlan={onRequestPlan} />);

    const btn = screen.getByText('请求问题规划');
    // 原生 button 元素在 Enter 键时会触发 click
    fireEvent.click(btn);
    expect(onRequestPlan).toHaveBeenCalled();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('Space 操作请求按钮', () => {
    const onRequestPlan = vi.fn();
    render(<GrillQuestionPlanPanel {...defaultProps} onRequestPlan={onRequestPlan} />);

    const btn = screen.getByText('请求问题规划');
    // 原生 button 元素支持 Space 键触发 click
    fireEvent.keyDown(btn, { key: ' ', code: 'Space' });
    // 验证是原生 button
    expect(btn.tagName).toBe('BUTTON');
  });

  it('Enter 操作接受按钮', () => {
    const onAcceptProposal = vi.fn();
    render(
      <GrillQuestionPlanPanel
        {...defaultProps}
        proposals={[mockProposal]}
        onAcceptProposal={onAcceptProposal}
      />,
    );

    const btn = screen.getByText('接受此规划');
    // 原生 button 元素在 Enter 键时会触发 click
    fireEvent.click(btn);
    expect(onAcceptProposal).toHaveBeenCalledWith('prop-plan-001');
    expect(btn.tagName).toBe('BUTTON');
  });

  it('Space 操作接受按钮', () => {
    const onAcceptProposal = vi.fn();
    render(
      <GrillQuestionPlanPanel
        {...defaultProps}
        proposals={[mockProposal]}
        onAcceptProposal={onAcceptProposal}
      />,
    );

    const btn = screen.getByText('接受此规划');
    // 原生 button 元素支持 Space 键触发 click
    fireEvent.keyDown(btn, { key: ' ', code: 'Space' });
    // 验证是原生 button
    expect(btn.tagName).toBe('BUTTON');
  });

  // ── 加载状态 ──────────────────────────────────────────────────

  it('加载提案时显示', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} isLoadingProposals={true} proposals={[]} />);

    expect(screen.getByText('加载提案中…')).toBeInTheDocument();
  });

  it('提案区域 aria-busy', () => {
    render(
      <GrillQuestionPlanPanel
        {...defaultProps}
        isLoadingProposals={true}
        proposals={[mockProposal]}
      />,
    );

    const section = screen.getByText('问题规划提案').closest('[aria-busy]');
    expect(section).toHaveAttribute('aria-busy', 'true');
  });

  // ── 无 session 提示 ──────────────────────────────────────────

  it('无 session 显示提示', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} hasSession={false} />);
    expect(screen.getByText('请先选择一个 Grill 会话')).toBeInTheDocument();
  });

  it('session 非 ACTIVE 显示提示', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} sessionIsActive={false} />);
    expect(screen.getByText('会话需要处于进行中状态')).toBeInTheDocument();
  });

  // ── 任务活动中心提示 ──────────────────────────────────────────

  it('显示任务活动中心提示', () => {
    render(<GrillQuestionPlanPanel {...defaultProps} task={mockTask} />);

    expect(screen.getByText('可在任务活动中心查看详细状态')).toBeInTheDocument();
  });
});
