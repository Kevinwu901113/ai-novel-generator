// @vitest-environment jsdom
/**
 * ContractDraftPanel 组件测试。
 *
 * 覆盖：
 * - 请求按钮渲染与 disabled 状态（非 COMPLETED、请求中、轮询中、加载中）
 * - 任务状态显示（role=status、aria-busy、短 ID、不泄露完整 ID/errorMessage）
 * - 错误 / 冲突横幅（role=alert，可关闭）
 * - 提案结构化展示 + 接受/拒绝按钮（相互禁用、aria-busy、double-click 保护）
 * - Current Version 面板（版本 / 锁定字段 / 来源）
 * - 当前契约紧凑提示
 * - 焦点管理（task / proposal / current heading RAF-focus，轮询不抢焦点）
 * - 真实 keyboard 测试（userEvent）
 * - 拒绝成功后焦点恢复
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContractDraftPanel } from './ContractDraftPanel';
import type {
  TaskPublicData,
  ProposalPublicData,
  ContractVersionPublicData,
  CreationContractSectionsPublicData,
} from '@ai-novel/contracts';

// ── Mock 数据 ─────────────────────────────────────────────────────

const mockTask: TaskPublicData = {
  id: 'task-00000001',
  projectId: 'proj-00000001',
  taskType: 'CREATION_CONTRACT_DRAFT',
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

const mockSections: CreationContractSectionsPublicData = {
  premise: '一个被遗忘的神明在人间重新崛起的故事',
  genre: ['都市', '奇幻'],
  tone: ['治愈'],
  targetAudience: '喜欢慢热叙事的成年读者',
  narrativePov: 'THIRD_LIMITED',
  tense: 'PAST',
  protagonist: {
    characterKey: 'hero',
    name: '陆沉',
    role: '主角',
    motivation: '寻找失落的记忆',
    traits: ['谨慎', '温柔'],
  },
};

const mockProposal: ProposalPublicData = {
  id: 'prop-00000001',
  projectId: 'proj-00000001',
  taskId: 'task-00000001',
  invocationId: 'inv-00000001',
  status: 'PROPOSED',
  baseGrillSessionId: 'sess-00000001',
  baseGrillSessionVersion: 2,
  baseContractVersion: null,
  schemaVersion: 1,
  sections: mockSections,
  sectionsHash: 'a'.repeat(64),
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const mockVersion: ContractVersionPublicData = {
  id: 'version-000001',
  projectId: 'proj-00000001',
  version: 1,
  schemaVersion: 1,
  sourceProposalId: 'prop-00000001',
  basedOnGrillSessionId: 'sess-00000001',
  basedOnGrillSessionVersion: 2,
  sections: mockSections,
  lockedFieldPaths: ['/protagonist/name'],
  contractSnapshotHash: 'b'.repeat(64),
  provenance: [
    {
      sectionKey: 'premise',
      source: 'GRILL_ANSWER',
      grillAnswerIds: ['ans-00000001'],
      grillProposalIds: [],
      aiTaskId: null,
      modelInvocationId: null,
      sourceProposalId: null,
      previousFieldHash: null,
      rationale: '来自用户回答',
    },
  ],
  createdAt: '2024-01-01T00:00:00Z',
  createdBy: 'ai-proposal-accepted',
};

const mockVersionV3: ContractVersionPublicData = {
  ...mockVersion,
  id: 'version-000003',
  version: 3,
};

// ── 默认 props ────────────────────────────────────────────────────

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'proj-00000001',
    sessionId: 'sess-00000001',
    hasSession: true,
    sessionStatus: 'COMPLETED',
    task: null as TaskPublicData | null,
    isPolling: false,
    onRequestDraft: vi.fn(),
    isRequesting: false,
    selectedProposal: null as ProposalPublicData | null,
    isLoadingProposals: false,
    currentContract: null as ContractVersionPublicData | null,
    acceptedVersion: null as ContractVersionPublicData | null,
    onAcceptProposal: vi.fn(),
    onRejectProposal: vi.fn(),
    isAccepting: false,
    isRejecting: false,
    isLoading: false,
    error: null as string | null,
    conflictNotice: false,
    onClearError: vi.fn(),
    onClearConflictNotice: vi.fn(),
    ...overrides,
  };
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('ContractDraftPanel', () => {
  afterEach(() => {
    cleanup();
  });

  // ── 按钮渲染与 disabled ──────────────────────────────────────

  it('渲染生成创作契约按钮', () => {
    render(<ContractDraftPanel {...defaultProps()} />);
    expect(screen.getByText('生成创作契约')).toBeDefined();
  });

  it('session 非 COMPLETED 时按钮 disabled 并显示提示', () => {
    render(<ContractDraftPanel {...defaultProps({ sessionStatus: 'ACTIVE' })} />);
    const btn = screen.getByText('生成创作契约') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText('会话完成后可生成创作契约')).toBeDefined();
  });

  it('无 session 时显示提示', () => {
    render(
      <ContractDraftPanel
        {...defaultProps({ hasSession: false, sessionId: null, sessionStatus: null })}
      />,
    );
    expect(screen.getByText('请先选择一个已完成的 Grill 会话')).toBeDefined();
  });

  it('请求中按钮 disabled 且 aria-busy', () => {
    render(<ContractDraftPanel {...defaultProps({ isRequesting: true })} />);
    const btn = screen.getByText('生成中…') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
  });

  it('轮询中请求按钮 disabled', () => {
    render(<ContractDraftPanel {...defaultProps({ task: mockTask, isPolling: true })} />);
    const btn = screen.getByText('生成创作契约') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('初始加载中请求按钮 disabled', () => {
    render(<ContractDraftPanel {...defaultProps({ isLoading: true })} />);
    const btn = screen.getByText('生成创作契约') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // ── 任务状态显示 ──────────────────────────────────────────────

  it('任务状态区域有 role=status', () => {
    render(<ContractDraftPanel {...defaultProps({ task: mockTask })} />);
    expect(document.querySelector('[role="status"]')).toBeDefined();
  });

  it('轮询时 aria-busy=true', () => {
    render(<ContractDraftPanel {...defaultProps({ task: mockTask, isPolling: true })} />);
    const status = document.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-busy')).toBe('true');
  });

  it('终态时 aria-busy=false', () => {
    const succeededTask = { ...mockTask, status: 'SUCCEEDED' as const };
    render(<ContractDraftPanel {...defaultProps({ task: succeededTask, isPolling: false })} />);
    const status = document.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-busy')).toBe('false');
  });

  it('显示任务短 ID 且不泄露完整 ID', () => {
    const fullUuid = '550e8400-e29b-41d4-a716-446655440000';
    const taskWithUuid = { ...mockTask, id: fullUuid };
    render(<ContractDraftPanel {...defaultProps({ task: taskWithUuid })} />);
    expect(document.body.textContent).toContain('550e8400…');
    expect(document.body.textContent).not.toContain(fullUuid);
  });

  it('FAILED 显示安全标签且不渲染 errorMessage', () => {
    const failedTask = {
      ...mockTask,
      status: 'FAILED' as const,
      errorCode: 'TASK_EXECUTION_FAILED',
      errorMessage: 'Internal error at /var/app/secret with Bearer token abc123',
    };
    render(<ContractDraftPanel {...defaultProps({ task: failedTask })} />);
    expect(screen.getByText('错误：任务执行失败（TASK_EXECUTION_FAILED）')).toBeDefined();
    expect(document.body.textContent).not.toContain('secret');
    expect(document.body.textContent).not.toContain('Bearer');
    expect(document.body.textContent).not.toContain('Internal error');
  });

  // ── 错误 / 冲突横幅 ──────────────────────────────────────────

  it('错误显示 role=alert 且唯一', () => {
    render(<ContractDraftPanel {...defaultProps({ error: '测试错误' })} />);
    const alerts = document.querySelectorAll('[role="alert"]');
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.textContent).toContain('测试错误');
  });

  it('关闭错误调用 onClearError', async () => {
    const user = userEvent.setup();
    const onClearError = vi.fn();
    render(<ContractDraftPanel {...defaultProps({ error: '错误', onClearError })} />);
    const closeBtn = screen.getByLabelText('关闭错误提示');
    await user.click(closeBtn);
    expect(onClearError).toHaveBeenCalled();
  });

  it('冲突横幅显示 role=alert 且可关闭', async () => {
    const user = userEvent.setup();
    const onClearConflictNotice = vi.fn();
    render(
      <ContractDraftPanel {...defaultProps({ conflictNotice: true, onClearConflictNotice })} />,
    );
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('创作契约已在其他操作中更新，数据已自动刷新。');
    const closeBtn = screen.getByLabelText('关闭冲突提示');
    await user.click(closeBtn);
    expect(onClearConflictNotice).toHaveBeenCalled();
  });

  // ── 提案展示 ──────────────────────────────────────────────────

  it('提案展示结构化内容与操作按钮', () => {
    render(<ContractDraftPanel {...defaultProps({ selectedProposal: mockProposal })} />);
    expect(screen.getByText('创作契约提案')).toBeDefined();
    expect(screen.getByText('核心设定')).toBeDefined();
    expect(screen.getByText('接受提案')).toBeDefined();
    expect(screen.getByText('拒绝提案')).toBeDefined();
  });

  it('接受/拒绝按钮相互禁用且 aria-busy', () => {
    render(
      <ContractDraftPanel
        {...defaultProps({ selectedProposal: mockProposal, isAccepting: true })}
      />,
    );
    const acceptBtn = screen.getByText('接受中…') as HTMLButtonElement;
    const rejectBtn = screen.getByText('拒绝提案') as HTMLButtonElement;
    expect(acceptBtn.disabled).toBe(true);
    expect(rejectBtn.disabled).toBe(true);
    expect(acceptBtn.getAttribute('aria-busy')).toBe('true');
  });

  it('接受中点击不重复触发', async () => {
    const user = userEvent.setup();
    const onAcceptProposal = vi.fn();
    render(
      <ContractDraftPanel
        {...defaultProps({ selectedProposal: mockProposal, isAccepting: true, onAcceptProposal })}
      />,
    );
    const btn = screen.getByText('接受中…');
    await user.click(btn);
    expect(onAcceptProposal).not.toHaveBeenCalled();
  });

  it('存在当前契约且无 acceptedVersion 时显示紧凑提示', () => {
    render(
      <ContractDraftPanel
        {...defaultProps({ selectedProposal: mockProposal, currentContract: mockVersionV3 })}
      />,
    );
    expect(screen.getByText('当前契约：v3（已存在）')).toBeDefined();
  });

  // ── Current Version 面板 ─────────────────────────────────────

  it('acceptedVersion 显示当前版本、锁定字段与来源', () => {
    render(<ContractDraftPanel {...defaultProps({ acceptedVersion: mockVersion })} />);
    expect(screen.getByText('当前创作契约 v1')).toBeDefined();
    expect(screen.getByText('已锁定字段')).toBeDefined();
    expect(screen.getByText('/protagonist/name')).toBeDefined();
    expect(screen.getByText('字段来源')).toBeDefined();
    expect(screen.getByText('Grill 回答')).toBeDefined();
    expect(screen.getByText(/由 AI 提案接受/)).toBeDefined();
  });

  // ── 空状态 ────────────────────────────────────────────────────

  it('COMPLETED 会话无任务无提案时显示空状态', () => {
    render(<ContractDraftPanel {...defaultProps()} />);
    expect(screen.getByText('尚未生成创作契约')).toBeDefined();
  });

  // ── 焦点管理 ──────────────────────────────────────────────────

  it('task 首次出现时聚焦 task heading', async () => {
    const { rerender } = render(<ContractDraftPanel {...defaultProps({ task: null })} />);

    rerender(<ContractDraftPanel {...defaultProps({ task: mockTask })} />);

    await waitFor(() => {
      const heading = document.querySelector('.contract-task-heading');
      expect(heading).toHaveFocus();
    });
  });

  it('同一 task 多次更新不重复聚焦（轮询不抢焦点）', async () => {
    const { rerender } = render(<ContractDraftPanel {...defaultProps({ task: mockTask })} />);

    await waitFor(() => {
      expect(document.querySelector('.contract-task-heading')).toHaveFocus();
    });

    (document.activeElement as HTMLElement)?.blur();

    const updatedTask = { ...mockTask, status: 'RUNNING' as const };
    rerender(<ContractDraftPanel {...defaultProps({ task: updatedTask })} />);

    await new Promise((r) => requestAnimationFrame(r));

    expect(document.querySelector('.contract-task-heading')).not.toHaveFocus();
  });

  it('proposal 首次出现时聚焦 proposal heading', async () => {
    const { rerender } = render(
      <ContractDraftPanel {...defaultProps({ selectedProposal: null })} />,
    );

    rerender(<ContractDraftPanel {...defaultProps({ selectedProposal: mockProposal })} />);

    await waitFor(() => {
      const heading = document.querySelector('.contract-proposal-heading');
      expect(heading).toHaveFocus();
    });
  });

  it('accept 成功后聚焦 current version heading', async () => {
    const { rerender } = render(
      <ContractDraftPanel {...defaultProps({ acceptedVersion: null })} />,
    );

    rerender(<ContractDraftPanel {...defaultProps({ acceptedVersion: mockVersion })} />);

    await waitFor(() => {
      const heading = document.querySelector('.contract-current-version-heading');
      expect(heading).toHaveFocus();
    });
  });

  it('拒绝成功后恢复焦点到请求按钮', async () => {
    const { rerender } = render(
      <ContractDraftPanel
        {...defaultProps({ isRejecting: true, selectedProposal: mockProposal })}
      />,
    );

    rerender(
      <ContractDraftPanel {...defaultProps({ isRejecting: false, selectedProposal: null })} />,
    );

    await waitFor(() => {
      expect(screen.getByText('生成创作契约')).toHaveFocus();
    });
  });

  // ── 真实 keyboard 测试 ────────────────────────────────────────

  it('Tab 聚焦请求按钮后 Enter 恰好触发一次', async () => {
    const user = userEvent.setup();
    const onRequestDraft = vi.fn();
    render(<ContractDraftPanel {...defaultProps({ onRequestDraft })} />);

    await user.tab();
    const btn = screen.getByText('生成创作契约');
    expect(btn).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onRequestDraft).toHaveBeenCalledTimes(1);
  });

  it('Tab 聚焦请求按钮后 Space 恰好触发一次', async () => {
    const user = userEvent.setup();
    const onRequestDraft = vi.fn();
    render(<ContractDraftPanel {...defaultProps({ onRequestDraft })} />);

    await user.tab();
    const btn = screen.getByText('生成创作契约');
    expect(btn).toHaveFocus();

    await user.keyboard(' ');
    expect(onRequestDraft).toHaveBeenCalledTimes(1);
  });

  it('disabled 请求按钮 Enter/Space 触发 0 次', async () => {
    const user = userEvent.setup();
    const onRequestDraft = vi.fn();
    render(<ContractDraftPanel {...defaultProps({ onRequestDraft, sessionStatus: 'ACTIVE' })} />);

    const btn = screen.getByText('生成创作契约') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    await user.tab();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onRequestDraft).toHaveBeenCalledTimes(0);
  });

  it('Tab 导航到接受按钮后 Enter 触发一次并传递 proposalId', async () => {
    const user = userEvent.setup();
    const onAcceptProposal = vi.fn();
    render(
      <ContractDraftPanel
        {...defaultProps({ selectedProposal: mockProposal, onAcceptProposal })}
      />,
    );

    // 等待组件自动聚焦 proposal heading（RAF）完成，消除与 tab 的竞态
    await waitFor(() => {
      expect(document.querySelector('.contract-proposal-heading')).toHaveFocus();
    });

    const acceptBtn = screen.getByText('接受提案');
    await user.tab();
    expect(acceptBtn).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onAcceptProposal).toHaveBeenCalledTimes(1);
    expect(onAcceptProposal).toHaveBeenCalledWith('prop-00000001');
  });

  it('Tab 导航到拒绝按钮后 Space 触发一次并传递 proposalId', async () => {
    const user = userEvent.setup();
    const onRejectProposal = vi.fn();
    render(
      <ContractDraftPanel
        {...defaultProps({ selectedProposal: mockProposal, onRejectProposal })}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.contract-proposal-heading')).toHaveFocus();
    });

    const rejectBtn = screen.getByText('拒绝提案');
    await user.tab();
    await user.tab();
    expect(rejectBtn).toHaveFocus();

    await user.keyboard(' ');
    expect(onRejectProposal).toHaveBeenCalledTimes(1);
    expect(onRejectProposal).toHaveBeenCalledWith('prop-00000001');
  });
});
