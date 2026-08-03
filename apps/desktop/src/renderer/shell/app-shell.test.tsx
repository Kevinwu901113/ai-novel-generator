// @vitest-environment jsdom
/**
 * App shell 拆分测试。
 *
 * 证明行为保持型拆分后：
 * - 各壳组件独立渲染且保持原有 DOM 契约（id / aria-label / 可访问名）；
 * - App 组合后原流程不变：无项目 → 创建/列表；打开项目 → Grill 工作台；
 * - 健康检查与任务活动（TaskCenter）区域仍在场；
 * - ProviderRegion 由 SystemStatusPanel 正确装配。
 *
 * IPC 使用 mock DesktopAPI，不连接真实 Worker。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { createRef } from 'react';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import type { DesktopAPI } from '@ai-novel/contracts';
import { App } from '../App';
import { INITIAL_PANEL_STATE } from '../panel-state';
import { AppToolbar } from './AppToolbar';
import { ProjectSidebar } from './ProjectSidebar';
import { ProjectSelectionShell } from './ProjectSelectionShell';
import { ProjectWorkspaceShell } from './ProjectWorkspaceShell';
import { SystemStatusPanel } from './SystemStatusPanel';
import { AppStatusBar } from './AppStatusBar';

// ── Mock 数据 ────────────────────────────────────────────────────────

const mockProject1 = {
  id: 'proj-00000001-aaaa-bbbb-cccc-dddddddddddd',
  name: '测试项目一',
  createdAt: '2024-01-01T00:00:00Z',
  lastOpenedAt: '2024-01-02T00:00:00Z',
  isMissing: false,
};

const mockProviderState = {
  displayName: 'OpenAI',
  model: 'gpt-4',
  providerType: 'openai',
  hasApiKey: true,
  lastTestStatus: 'never',
  lastTestErrorCode: null,
  lastTestedAt: null,
  lastTestLatencyMs: null,
};

const mockHealth = { ok: true, version: '1.0.0', timestamp: '2024-01-01T00:00:00Z' };

// ── 工具函数 ────────────────────────────────────────────────────────

function createMockDesktopAPI(overrides: Record<string, unknown> = {}) {
  return {
    healthCheck: vi.fn().mockResolvedValue(mockHealth),
    getDataServiceStatus: vi.fn().mockResolvedValue({ status: 'ready' }),
    retryDataService: vi.fn().mockResolvedValue(undefined),
    projects: {
      list: vi.fn().mockResolvedValue([mockProject1]),
      create: vi.fn().mockResolvedValue({ id: 'proj-new-0001' }),
      open: vi.fn().mockResolvedValue({
        id: 'proj-new-0001',
        name: '新项目',
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        status: 'active',
      }),
    },
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      getStats: vi.fn().mockResolvedValue({
        invocationCount: 0,
        succeededCount: 0,
        failedCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalLatencyMs: 0,
      }),
      get: vi.fn(),
      createModelInvocationTest: vi.fn(),
    },
    provider: {
      getState: vi.fn().mockResolvedValue(mockProviderState),
      saveApiKey: vi.fn().mockResolvedValue({ ...mockProviderState, hasApiKey: true }),
      deleteApiKey: vi.fn().mockResolvedValue({ ...mockProviderState, hasApiKey: false }),
      testConnection: vi.fn().mockResolvedValue(undefined),
    },
    grill: {
      listSessions: vi.fn().mockResolvedValue([]),
      createSession: vi.fn(),
      getSession: vi.fn(),
      listQuestions: vi.fn().mockResolvedValue([]),
      addQuestions: vi.fn(),
      markQuestionAsked: vi.fn(),
      answerQuestion: vi.fn(),
      skipQuestion: vi.fn(),
      supersedeQuestion: vi.fn(),
      getCurrentAnswers: vi.fn().mockResolvedValue([]),
      listAnswerHistory: vi.fn(),
      listProposals: vi.fn().mockResolvedValue([]),
      createProposal: vi.fn(),
      reviewProposal: vi.fn(),
      requestQuestionPlan: vi.fn(),
      listQuestionPlanProposals: vi.fn().mockResolvedValue([]),
      acceptQuestionPlanProposal: vi.fn(),
    },
    ...overrides,
  } as unknown as DesktopAPI;
}

function setupDesktop(api?: DesktopAPI) {
  window.desktop = api ?? createMockDesktopAPI();
  return window.desktop;
}

// ── 测试 ─────────────────────────────────────────────────────────

describe('App shell 拆分组件', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  // 1. AppToolbar 渲染标题与面板开关（DOM 契约保持）
  it('AppToolbar 渲染标题与面板开关', () => {
    const onToggle = vi.fn();
    render(
      <AppToolbar
        panelState={INITIAL_PANEL_STATE}
        dataServiceStatus="ready"
        onTogglePanel={onToggle}
      />,
    );

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'AI 小说创作代理' })).toBeInTheDocument();

    const left = screen.getByRole('button', { name: '收起项目列表' });
    expect(left).toHaveAttribute('aria-expanded', 'true');
    expect(left).toHaveAttribute('aria-controls', 'panel-left');

    const right = screen.getByRole('button', { name: '收起状态面板' });
    expect(right).toHaveAttribute('aria-expanded', 'true');
    expect(right).toHaveAttribute('aria-controls', 'panel-right');

    expect(screen.getByText('● 数据服务就绪')).toBeInTheDocument();
  });

  // 2. ProjectSidebar 渲染项目列表
  it('ProjectSidebar 渲染项目列表', () => {
    render(
      <ProjectSidebar
        dataServiceStatus="ready"
        projects={[mockProject1]}
        currentProjectId={null}
        onRetry={() => {}}
        onNewProject={() => {}}
        onOpenProject={() => {}}
      />,
    );

    expect(screen.getByRole('complementary', { name: '项目列表' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /测试项目一/ })).toBeInTheDocument();
  });

  // 3. ProjectSelectionShell 渲染新建项目表单
  it('ProjectSelectionShell 渲染新建项目表单', () => {
    render(
      <ProjectSelectionShell
        dataServiceStatus="ready"
        sectionRef={createRef<HTMLElement>()}
        onRetry={() => {}}
        onCreate={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.getByRole('region', { name: '新建项目' })).toBeInTheDocument();
    expect(screen.getByLabelText('项目名称')).toBeInTheDocument();
    expect(screen.getByLabelText('描述你想写的小说……')).toBeInTheDocument();
  });

  // 4. ProjectWorkspaceShell 渲染 Grill 工作台
  it('ProjectWorkspaceShell 渲染 Grill 工作台', async () => {
    setupDesktop();
    render(
      <ProjectWorkspaceShell projectId={mockProject1.id} sectionRef={createRef<HTMLElement>()} />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Grill 工作台')).toBeInTheDocument();
    });
    expect(screen.getByText('Grill-me 需求澄清')).toBeInTheDocument();
  });

  // 5. SystemStatusPanel 渲染工程状态区（TaskCenter / ProviderRegion 在场）
  it('SystemStatusPanel 渲染工程状态区', () => {
    setupDesktop();
    render(
      <SystemStatusPanel
        dataServiceStatus="ready"
        currentProject={null}
        providerState={mockProviderState}
        onRetry={() => {}}
        onSaveApiKey={vi.fn().mockResolvedValue(undefined)}
        onDeleteApiKey={vi.fn().mockResolvedValue(undefined)}
        onTestConnection={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByLabelText('状态面板')).toBeInTheDocument();
    expect(screen.getByText('本地存储')).toBeInTheDocument();
    expect(screen.getByText('数据服务')).toBeInTheDocument();
    expect(screen.getByText('当前阶段')).toBeInTheDocument();
    expect(screen.getByText('任务活动')).toBeInTheDocument();
    expect(screen.getByText('模型服务')).toBeInTheDocument();
    // TaskCenter 空态（未打开项目）
    expect(screen.getByText('请先打开项目')).toBeInTheDocument();
  });

  // 6. AppStatusBar 渲染健康信息
  it('AppStatusBar 渲染健康信息', () => {
    render(<AppStatusBar health={mockHealth} />);

    expect(screen.getByText('桌面服务：正常')).toBeInTheDocument();
    expect(screen.getByText('版本：1.0.0')).toBeInTheDocument();
  });

  // 7. 集成：App 组合后原流程不变 + 健康/TaskCenter 在场
  it('App 组合后原流程不变', async () => {
    setupDesktop();
    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    // 健康检查结果出现在状态栏
    await waitFor(() => {
      expect(screen.getByText('桌面服务：正常')).toBeInTheDocument();
    });

    // 无当前项目：显示项目创建/列表
    expect(screen.getByRole('region', { name: '新建项目' })).toBeInTheDocument();
    expect(screen.getByLabelText('项目名称')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
    // 任务活动区域在场
    expect(screen.getByText('任务活动')).toBeInTheDocument();

    // 打开项目：进入 Grill 工作台
    const projectBtn = screen.getByRole('button', { name: /测试项目一/ });
    await act(async () => {
      projectBtn.click();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Grill 工作台')).toBeInTheDocument();
    });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Grill-me 需求澄清' }),
    ).toBeInTheDocument();
  });
});
