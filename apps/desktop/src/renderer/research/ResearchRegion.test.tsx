// @vitest-environment jsdom
/**
 * ResearchRegion 组件测试（B6）：相位渲染、escalation 决策通道调用、
 * 来源排除、事实笔记折叠/展开、版本链切换。
 * Mock DesktopAPI 模式沿用 IntakeRegion.test.tsx。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, within } from '@testing-library/react';
import type {
  DesktopAPI,
  ResearchBundleDto,
  ResearchStateDto,
  ResearchSourceRecordDto,
} from '@ai-novel/contracts';
import { ResearchRegion } from './ResearchRegion';

const NOW = '2026-08-10T00:00:00.000Z';

const RUN = {
  runId: 'run-1',
  graphId: 'idea-to-novel-project-v1',
  graphVersion: '1',
  kind: 'project',
  terminalStatus: null,
  createdAt: NOW,
};

function researchProgress(nodeId: string, status: string, stage = 'research') {
  return { activeNodes: [{ nodeId, stage, status }], possibleNextNodes: [] };
}

function researchState(overrides: Partial<ResearchStateDto> = {}): ResearchStateDto {
  return {
    runId: 'run-1',
    researchDecision: null,
    researchValid: null,
    bundleRef: null,
    bundleInvalidated: false,
    escalationActive: false,
    researchRetryUsed: 0,
    ...overrides,
  };
}

function source(overrides: Partial<ResearchSourceRecordDto> = {}): ResearchSourceRecordDto {
  return {
    url: 'https://example.com/a',
    title: '示例来源',
    fetchedAt: NOW,
    excerpt: '摘录文本',
    ...overrides,
  };
}

function bundle(overrides: Partial<ResearchBundleDto> = {}): ResearchBundleDto {
  return {
    id: 'rb-1',
    projectId: 'p1',
    version: 1,
    depth: 'deep',
    questions: [],
    factNotes: [],
    conclusion: '结论文本',
    createdAt: NOW,
    basedOnBundleId: null,
    ...overrides,
  };
}

function mockApi(overrides: Record<string, unknown> = {}): DesktopAPI {
  return {
    graph: {
      listRuns: vi.fn().mockResolvedValue([RUN]),
      getRunProgress: vi.fn().mockResolvedValue(researchProgress('RESEARCH_DECISION', 'active')),
      applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
    },
    research: {
      getResearchState: vi.fn().mockResolvedValue(researchState()),
      getBundle: vi.fn().mockResolvedValue(null),
      listBundles: vi.fn().mockResolvedValue([]),
      setSourceExclusion: vi.fn().mockResolvedValue([]),
      listSourceExclusions: vi.fn().mockResolvedValue([]),
    },
    search: {
      hasApiKey: vi.fn().mockResolvedValue({ hasApiKey: true }),
      saveApiKey: vi.fn().mockResolvedValue({ hasApiKey: true }),
      deleteApiKey: vi.fn().mockResolvedValue({ hasApiKey: false }),
    },
    tasks: {
      list: vi.fn().mockResolvedValue([]),
      getStats: vi.fn(),
      get: vi.fn(),
      createModelInvocationTest: vi.fn(),
    },
    ...overrides,
  } as unknown as DesktopAPI;
}

afterEach(() => {
  cleanup();
  window.desktop = undefined as unknown as DesktopAPI;
});

describe('ResearchRegion', () => {
  it('light/deep 强度徽标正确展示', async () => {
    const deepBundle = bundle({ depth: 'deep' });
    const api = mockApi({
      research: {
        getResearchState: vi
          .fn()
          .mockResolvedValue(
            researchState({ researchDecision: 'deep', researchValid: 'valid', bundleRef: 'rb-1' }),
          ),
        getBundle: vi.fn().mockResolvedValue(deepBundle),
        listBundles: vi.fn().mockResolvedValue([deepBundle]),
        setSourceExclusion: vi.fn().mockResolvedValue([]),
        listSourceExclusions: vi.fn().mockResolvedValue([]),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<ResearchRegion projectId="p1" />);
    });

    await waitFor(() => {
      expect(screen.getByText('深度调研')).toBeInTheDocument();
    });
  });

  it('researchDecision=none → "无需调研"说明卡（非空态）；researchDecision=null → "尚未调研"，二者可区分', async () => {
    const apiNone = mockApi({
      research: {
        getResearchState: vi.fn().mockResolvedValue(researchState({ researchDecision: 'none' })),
        getBundle: vi.fn().mockResolvedValue(null),
        listBundles: vi.fn().mockResolvedValue([]),
        setSourceExclusion: vi.fn().mockResolvedValue([]),
        listSourceExclusions: vi.fn().mockResolvedValue([]),
      },
    });
    window.desktop = apiNone;
    const { unmount } = render(<ResearchRegion projectId="p1" />);
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getByText('本项目无需调研，将直接进入蓝图阶段。')).toBeInTheDocument();
    });
    expect(screen.queryByText('尚未开始调研。')).not.toBeInTheDocument();
    unmount();

    const apiNull = mockApi();
    window.desktop = apiNull;
    render(<ResearchRegion projectId="p1" />);
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getByText('尚未开始调研。')).toBeInTheDocument();
    });
    expect(screen.queryByText('本项目无需调研，将直接进入蓝图阶段。')).not.toBeInTheDocument();
  });

  it('stale：作废横幅显著展示，且与现行内容不混淆（D-B6-9）', async () => {
    const staleBundle = bundle({ id: 'rb-1', conclusion: '旧结论' });
    const api = mockApi({
      research: {
        getResearchState: vi.fn().mockResolvedValue(
          researchState({
            researchDecision: 'deep',
            researchValid: 'valid',
            bundleRef: 'rb-1',
            bundleInvalidated: true,
          }),
        ),
        getBundle: vi.fn().mockResolvedValue(staleBundle),
        listBundles: vi.fn().mockResolvedValue([staleBundle]),
        setSourceExclusion: vi.fn().mockResolvedValue([]),
        listSourceExclusions: vi.fn().mockResolvedValue([]),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<ResearchRegion projectId="p1" />);
    });

    await waitFor(() => {
      expect(screen.getByText('此资料包已作废（创作要求已变更），将重新调研')).toBeInTheDocument();
    });
    // 作废横幅与内容同时出现——不是把作废内容当现行 ready 直接展示（无横幅）
    expect(screen.getByText('旧结论')).toBeInTheDocument();
    const view = screen.getByTestId('research-bundle-view');
    expect(view.className).toContain('research-bundle-view-stale');
  });

  it('key-missing：显著提示缺少搜索服务 key', async () => {
    const api = mockApi({
      research: {
        getResearchState: vi.fn().mockResolvedValue(researchState({ researchDecision: 'deep' })),
        getBundle: vi.fn().mockResolvedValue(null),
        listBundles: vi.fn().mockResolvedValue([]),
        setSourceExclusion: vi.fn().mockResolvedValue([]),
        listSourceExclusions: vi.fn().mockResolvedValue([]),
      },
      search: {
        hasApiKey: vi.fn().mockResolvedValue({ hasApiKey: false }),
        saveApiKey: vi.fn(),
        deleteApiKey: vi.fn(),
      },
      tasks: {
        list: vi.fn().mockResolvedValue([
          {
            id: 'task-1',
            projectId: 'p1',
            taskType: 'RESEARCH_RUN',
            status: 'PENDING',
            attemptCount: 0,
            result: null,
            errorCode: null,
            errorMessage: null,
            createdAt: NOW,
            updatedAt: NOW,
            startedAt: null,
            finishedAt: null,
          },
        ]),
        getStats: vi.fn(),
        get: vi.fn(),
        createModelInvocationTest: vi.fn(),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<ResearchRegion projectId="p1" />);
    });

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('还没有配置搜索服务 API Key');
    });
  });

  it('escalation：展示五选项，点击走 escalation 决策（nodeId=RESEARCH_ESCALATION，outcome 正确，含 idempotencyKey）', async () => {
    const api = mockApi({
      graph: {
        listRuns: vi.fn().mockResolvedValue([RUN]),
        getRunProgress: vi
          .fn()
          .mockResolvedValue(researchProgress('RESEARCH_ESCALATION', 'waiting_for_human')),
        applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      },
      research: {
        getResearchState: vi.fn().mockResolvedValue(
          researchState({
            researchDecision: 'deep',
            researchValid: 'invalid',
            escalationActive: true,
          }),
        ),
        getBundle: vi.fn().mockResolvedValue(null),
        listBundles: vi.fn().mockResolvedValue([]),
        setSourceExclusion: vi.fn().mockResolvedValue([]),
        listSourceExclusions: vi.fn().mockResolvedValue([]),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<ResearchRegion projectId="p1" />);
    });

    await waitFor(() => {
      expect(screen.getByText('就用现在的调研结果')).toBeInTheDocument();
      expect(screen.getByText('跳过调研，继续下一步')).toBeInTheDocument();
      expect(screen.getByText('修改创作要求')).toBeInTheDocument();
      expect(screen.getByText('稍后再说')).toBeInTheDocument();
      expect(screen.getByText('取消这个项目的调研')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('就用现在的调研结果').click();
    });

    await waitFor(() => {
      expect(api.graph.applyHumanDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'escalation',
          projectId: 'p1',
          runId: 'run-1',
          nodeId: 'RESEARCH_ESCALATION',
          outcome: 'use_current_research',
          idempotencyKey: expect.any(String),
        }),
      );
    });
  });

  it('来源排除：点击排除按钮调用 setSourceExclusion，用返回列表更新标记', async () => {
    const readyBundle = bundle({
      questions: [{ id: 'q1', text: '问题一', sources: [source()] }],
    });
    const setSourceExclusion = vi.fn().mockResolvedValue(['https://example.com/a']);
    const api = mockApi({
      research: {
        getResearchState: vi
          .fn()
          .mockResolvedValue(
            researchState({ researchDecision: 'deep', researchValid: 'valid', bundleRef: 'rb-1' }),
          ),
        getBundle: vi.fn().mockResolvedValue(readyBundle),
        listBundles: vi.fn().mockResolvedValue([readyBundle]),
        setSourceExclusion,
        listSourceExclusions: vi.fn().mockResolvedValue([]),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<ResearchRegion projectId="p1" />);
    });

    await waitFor(() => {
      expect(screen.getByText('展开来源（1）')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('展开来源（1）').click();
    });

    const excludeBtn = await screen.findByRole('button', { name: '排除此来源' });
    await act(async () => {
      excludeBtn.click();
    });

    await waitFor(() => {
      expect(setSourceExclusion).toHaveBeenCalledWith({
        projectId: 'p1',
        url: 'https://example.com/a',
        excluded: true,
      });
    });

    await waitFor(() => {
      expect(screen.getByText('已排除')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '取消排除' })).toBeInTheDocument();
    });
  });

  it('事实笔记：长文默认截断，可展开看全文', async () => {
    const longText = 'A'.repeat(300);
    const readyBundle = bundle({
      factNotes: [{ id: 'fn1', text: longText, sourceUrls: ['https://example.com/a'] }],
    });
    const api = mockApi({
      research: {
        getResearchState: vi
          .fn()
          .mockResolvedValue(
            researchState({ researchDecision: 'deep', researchValid: 'valid', bundleRef: 'rb-1' }),
          ),
        getBundle: vi.fn().mockResolvedValue(readyBundle),
        listBundles: vi.fn().mockResolvedValue([readyBundle]),
        setSourceExclusion: vi.fn().mockResolvedValue([]),
        listSourceExclusions: vi.fn().mockResolvedValue([]),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<ResearchRegion projectId="p1" />);
    });

    await waitFor(() => {
      expect(screen.getByText('展开全文')).toBeInTheDocument();
    });
    expect(screen.queryByText(longText)).not.toBeInTheDocument();

    await act(async () => {
      screen.getByText('展开全文').click();
    });

    await waitFor(() => {
      expect(screen.getByText(longText)).toBeInTheDocument();
      expect(screen.getByText('收起')).toBeInTheDocument();
    });
  });

  it('版本链：多 bundle 时可切看历史版本', async () => {
    const v1 = bundle({
      id: 'v1',
      version: 1,
      conclusion: 'v1 结论',
      basedOnBundleId: null,
      createdAt: NOW,
    });
    const v2 = bundle({
      id: 'v2',
      version: 2,
      conclusion: 'v2 结论',
      basedOnBundleId: 'v1',
      createdAt: '2026-08-11T00:00:00.000Z',
    });
    const api = mockApi({
      research: {
        getResearchState: vi
          .fn()
          .mockResolvedValue(
            researchState({ researchDecision: 'deep', researchValid: 'valid', bundleRef: 'v2' }),
          ),
        getBundle: vi.fn().mockResolvedValue(v2),
        listBundles: vi.fn().mockResolvedValue([v1, v2]),
        setSourceExclusion: vi.fn().mockResolvedValue([]),
        listSourceExclusions: vi.fn().mockResolvedValue([]),
      },
    });
    window.desktop = api;
    await act(async () => {
      render(<ResearchRegion projectId="p1" />);
    });

    await waitFor(() => {
      expect(screen.getByText('v2 结论')).toBeInTheDocument();
    });

    const chain = screen.getByRole('navigation', { name: '资料包版本历史' });
    await act(async () => {
      within(chain).getByText('v1').click();
    });

    await waitFor(() => {
      expect(screen.getByText('v1 结论')).toBeInTheDocument();
    });
    expect(screen.queryByText('v2 结论')).not.toBeInTheDocument();
    expect(screen.getByText(/正在查看历史版本 v1/)).toBeInTheDocument();

    await act(async () => {
      screen.getByText(/回到当前版本/).click();
    });

    await waitFor(() => {
      expect(screen.getByText('v2 结论')).toBeInTheDocument();
    });
  });
});
