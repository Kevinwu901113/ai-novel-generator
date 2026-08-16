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

  // TD-030-4 回归（修法同蓝图侧）：决策落地后必须调 App 收尾回调（解除
  // JourneyNav 视图锁定 + 刷新探针）——否则 modify_requirements 把 frontier 带回
  // 访谈后，视图仍锁在 ResearchRegion，用户点完"修改创作要求"像什么都没发生。
  // busy 须护航到回调 promise 落地（镜像 BlueprintRegion 的 onRefresh 护航语义）。
  it('escalation：决策落地后调用 onDecisionSettled，busy 护航到其 promise 落地', async () => {
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

    let resolveSettled: (() => void) | null = null;
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const onDecisionSettled = vi.fn(() => settledPromise);

    await act(async () => {
      render(<ResearchRegion projectId="p1" onDecisionSettled={onDecisionSettled} />);
    });
    const optionBtn = await waitFor(() => {
      const btn = screen.getByText('修改创作要求').closest('button');
      expect(btn).not.toBeNull();
      return btn!;
    });

    await act(async () => {
      optionBtn.click();
    });
    await waitFor(() => {
      expect(api.graph.applyHumanDecision).toHaveBeenCalledTimes(1);
      expect(onDecisionSettled).toHaveBeenCalledTimes(1);
    });
    // 收尾回调（视图解锁 + 探针刷新）尚未落地：busy 必须仍护航（按钮禁用），
    // 不得以旧态提前重新可点。
    expect(optionBtn).toBeDisabled();

    await act(async () => {
      resolveSettled?.();
    });
    await waitFor(() => {
      expect(optionBtn).not.toBeDisabled();
    });
  });

  // 决策后刷新被互斥锁吞掉修复（复查随行）：chooseEscalation 是
  // `await applyHumanDecision(...); await refresh();`——若这个 refresh() 撞上
  // 1.7s 轮询在途的某一轮，旧实现里互斥锁会直接把它吞掉（什么都不做，busy
  // 立刻变回 false），随后落地的在途 poll 带回的是写入前的旧态：escalation
  // 面板原样重现、按钮可点。用受控 Promise 精确复现"用户点击时 poll 恰好在途"
  // 的时序：断言点击后按钮保持禁用直到补跑那轮真正落地，且最终展示的是决策
  // 后的新状态，而不是在途 poll 带回的旧状态。
  it('escalation：决策提交撞上在途 poll 时，refresh 应等补跑落地才 resolve（不得被互斥锁吞掉）', async () => {
    vi.useFakeTimers();
    try {
      const readyBundle = bundle({ id: 'rb-1', conclusion: '决策后的资料包' });

      let listRunsCall = 0;
      let resolveSecondListRuns: ((v: (typeof RUN)[]) => void) | null = null;
      const secondListRunsPromise = new Promise<(typeof RUN)[]>((resolve) => {
        resolveSecondListRuns = resolve;
      });
      const listRuns = vi.fn().mockImplementation(() => {
        listRunsCall += 1;
        if (listRunsCall === 2) return secondListRunsPromise;
        return Promise.resolve([RUN]);
      });

      // 前两次取到的仍是决策前的旧态（escalationActive: true）；第三次起（补跑）
      // 才是决策后的新态——精确模拟"在途 poll 是在写入之前发出的，只能带回旧数据"。
      let getStateCall = 0;
      const getResearchState = vi.fn().mockImplementation(() => {
        getStateCall += 1;
        if (getStateCall <= 2) {
          return Promise.resolve(
            researchState({
              researchDecision: 'deep',
              researchValid: 'invalid',
              escalationActive: true,
            }),
          );
        }
        return Promise.resolve(
          researchState({
            researchDecision: 'deep',
            researchValid: 'valid',
            escalationActive: false,
            bundleRef: 'rb-1',
          }),
        );
      });

      const applyHumanDecision = vi
        .fn()
        .mockResolvedValue({ activeNodes: [], possibleNextNodes: [] });

      const api = mockApi({
        graph: {
          listRuns,
          getRunProgress: vi
            .fn()
            .mockResolvedValue(researchProgress('RESEARCH_ESCALATION', 'waiting_for_human')),
          applyHumanDecision,
        },
        research: {
          getResearchState,
          getBundle: vi
            .fn()
            .mockImplementation(({ bundleId }: { bundleId: string }) =>
              Promise.resolve(bundleId === 'rb-1' ? readyBundle : null),
            ),
          listBundles: vi.fn().mockResolvedValue([readyBundle]),
          setSourceExclusion: vi.fn().mockResolvedValue([]),
          listSourceExclusions: vi.fn().mockResolvedValue([]),
        },
      });
      window.desktop = api;

      // 注意：fake timers 下不能用 waitFor/findBy*（其内部轮询依赖真实时钟，
      // 与 fake timers 搭配会互相卡死）——全程用 act + advanceTimersByTimeAsync
      // 显式推进并 flush microtask 队列，之后直接同步断言（镜像上面"来源排除：
      // 轮询响应晚于写入落地"用例的 fake timers 模式）。
      await act(async () => {
        render(<ResearchRegion projectId="p1" />);
        await vi.advanceTimersByTimeAsync(0);
      });
      const optionBtn = screen.getByText('就用现在的调研结果').closest('button');
      expect(optionBtn).not.toBeNull();
      expect(optionBtn).not.toBeDisabled();

      // 推进到第二轮 poll：其 listRuns 卡在 pending（secondListRunsPromise 未
      // resolve）——模拟"用户点击的瞬间，poll 恰好在途"。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1700);
      });

      // 用户在第二轮 poll 卡住期间点击决策：applyHumanDecision 提交成功，但
      // 紧随其后的 refresh() 撞上在途 poll，应排队等待补跑，不能提前放行。
      await act(async () => {
        optionBtn?.click();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(applyHumanDecision).toHaveBeenCalledTimes(1);
      // busy 必须仍为 true（按钮仍禁用）——若被互斥锁吞掉（旧 bug），chooseEscalation
      // 的 await refresh() 会立即 resolve，busy 在这里就已经变回 false 了。
      expect(optionBtn).toBeDisabled();
      // 在途 poll 尚未落地，面板仍显示决策前的旧态。
      expect(screen.getByText('就用现在的调研结果')).toBeInTheDocument();

      // 第二轮 poll 的 listRuns 此刻才 resolve，带回写入前的旧态（第 2 次
      // getResearchState 调用仍是 escalationActive: true）；其 finally 应立即
      // 补跑第三轮，第三轮才取到决策后的新态。
      await act(async () => {
        resolveSecondListRuns?.([RUN]);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
      });

      // 断言：补跑已经落地——决策后的新状态展示出来，escalation 面板消失，
      // chooseEscalation 的 await refresh() 等到补跑落地才 resolve、busy 收尾，
      // 没有出现"旧态重现 + 按钮可点"的窗口，也没有误报提交失败。
      expect(screen.queryByText('就用现在的调研结果')).not.toBeInTheDocument();
      expect(screen.getByText('决策后的资料包')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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

  // 复查随行修复：原用例 mock 返回值与"乐观本地取反"结果恰好一致，无法证伪
  // "UI 是否真的用了后端返回值，而不是自己乐观翻转本地状态"。这里让 mock 返回
  // 与乐观结果相反的列表（点击"排除"却返回空列表，即后端并未真正记录排除），
  // 断言 UI 必须如实反映后端返回值——若实现改成本地乐观翻转，本用例会失败。
  it('来源排除：UI 必须采用后端返回的列表，而不是本地乐观翻转（证伪：mock 返回与乐观结果相反）', async () => {
    const readyBundle = bundle({
      questions: [{ id: 'q1', text: '问题一', sources: [source()] }],
    });
    // 点击"排除"（意图 excluded=true），但后端返回空列表——与乐观假设相悖。
    const setSourceExclusion = vi.fn().mockResolvedValue([]);
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

    // 后端说"没有排除"（空列表）：UI 必须仍显示未排除，不能自行假设点击即生效。
    await waitFor(() => {
      expect(screen.queryByText('已排除')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '排除此来源' })).toBeInTheDocument();
    });
  });

  // 复查随行修复：轮询回滚闪烁——poll 的 listSourceExclusions 在写入前发出、
  // 响应却在写入之后才落地，若不加区分地覆盖，会用写入前的旧列表把刚生效的
  // 排除标记盖掉（自愈但可见闪烁）。用受控 Promise 精确复现"poll 请求已发出，
  // 写入先完成"的时序，断言写入结果不被回滚。
  it('来源排除：轮询响应晚于写入落地时，不得用旧列表覆盖刚写入的标记（回滚闪烁修复）', async () => {
    vi.useFakeTimers();
    try {
      const readyBundle = bundle({
        questions: [{ id: 'q1', text: '问题一', sources: [source()] }],
      });

      let listCall = 0;
      let resolveSecondList: ((v: string[]) => void) | null = null;
      const secondListPromise = new Promise<string[]>((resolve) => {
        resolveSecondList = resolve;
      });

      const listSourceExclusions = vi.fn().mockImplementation(() => {
        listCall += 1;
        if (listCall === 1) return Promise.resolve([]);
        if (listCall === 2) return secondListPromise;
        return Promise.resolve(['https://example.com/a']);
      });
      const setSourceExclusion = vi.fn().mockResolvedValue(['https://example.com/a']);

      const api = mockApi({
        research: {
          getResearchState: vi.fn().mockResolvedValue(
            researchState({
              researchDecision: 'deep',
              researchValid: 'valid',
              bundleRef: 'rb-1',
            }),
          ),
          getBundle: vi.fn().mockResolvedValue(readyBundle),
          listBundles: vi.fn().mockResolvedValue([readyBundle]),
          setSourceExclusion,
          listSourceExclusions,
        },
      });
      window.desktop = api;

      // 注意：fake timers 下不能用 waitFor/findBy*（其内部轮询依赖真实时钟，
      // 与 fake timers 搭配会互相卡死）——全程用 act + advanceTimersByTimeAsync
      // 显式推进并 flush microtask 队列，之后直接同步断言（镜像
      // accessibility.test.tsx TaskCenter 用例组的 flushMicrotasks 模式）。
      await act(async () => {
        render(<ResearchRegion projectId="p1" />);
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        screen.getByText('展开来源（1）').click();
      });
      expect(screen.getByRole('button', { name: '排除此来源' })).toBeInTheDocument();

      // 推进到第二轮 poll：其 listSourceExclusions 卡在 pending（secondListPromise 未 resolve）。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1700);
      });

      // 用户在第二轮 poll 卡住期间点击排除，写入先于该轮 poll 落地。
      const excludeBtn = screen.getByRole('button', { name: '排除此来源' });
      await act(async () => {
        excludeBtn.click();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByRole('button', { name: '取消排除' })).toBeInTheDocument();

      // 第二轮 poll 的 listSourceExclusions 此刻才 resolve，返回写入前的旧列表（[]）。
      await act(async () => {
        resolveSecondList?.([]);
        await vi.advanceTimersByTimeAsync(0);
      });

      // 断言：不应被这份过期列表回滚覆盖。
      expect(screen.getByRole('button', { name: '取消排除' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '排除此来源' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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

  it('版本链：多 bundle 时可切看历史版本，强度徽标随所查看版本切换（复查随行修复）', async () => {
    // v1/v2 强度不同（light → deep）：徽标此前锁死在当前 bundle（deep），
    // 切到 v1 后仍显示"深度调研"，与实际查看的版本不符——修复后应随 displayed 切换。
    const v1 = bundle({
      id: 'v1',
      version: 1,
      depth: 'light',
      conclusion: 'v1 结论',
      basedOnBundleId: null,
      createdAt: NOW,
    });
    const v2 = bundle({
      id: 'v2',
      version: 2,
      depth: 'deep',
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
    expect(screen.getByText('深度调研')).toBeInTheDocument();
    expect(screen.queryByText('轻度调研')).not.toBeInTheDocument();

    const chain = screen.getByRole('navigation', { name: '资料包版本历史' });
    await act(async () => {
      within(chain).getByText('v1').click();
    });

    await waitFor(() => {
      expect(screen.getByText('v1 结论')).toBeInTheDocument();
    });
    expect(screen.queryByText('v2 结论')).not.toBeInTheDocument();
    expect(screen.getByText(/正在查看历史版本 v1/)).toBeInTheDocument();
    // 徽标必须跟随切到的历史版本（light），而不是停在当前 bundle 的 deep。
    expect(screen.getByText('轻度调研')).toBeInTheDocument();
    expect(screen.queryByText('深度调研')).not.toBeInTheDocument();

    await act(async () => {
      screen.getByText(/回到当前版本/).click();
    });

    await waitFor(() => {
      expect(screen.getByText('v2 结论')).toBeInTheDocument();
    });
    expect(screen.getByText('深度调研')).toBeInTheDocument();
    expect(screen.queryByText('轻度调研')).not.toBeInTheDocument();
  });

  it('兼容旧数据：重复版本号在版本链中附生成时间，两个 v1 可区分并可切换', async () => {
    const oldV1 = bundle({
      id: 'legacy-v1-a',
      version: 1,
      conclusion: '旧 v1 结论',
      createdAt: '2026-08-10T01:02:03.000Z',
    });
    const currentV1 = bundle({
      id: 'legacy-v1-b',
      version: 1,
      conclusion: '新 v1 结论',
      createdAt: '2026-08-11T04:05:06.000Z',
    });
    window.desktop = mockApi({
      research: {
        getResearchState: vi.fn().mockResolvedValue(
          researchState({
            researchDecision: 'deep',
            researchValid: 'valid',
            bundleRef: currentV1.id,
          }),
        ),
        getBundle: vi.fn().mockResolvedValue(currentV1),
        listBundles: vi.fn().mockResolvedValue([oldV1, currentV1]),
        setSourceExclusion: vi.fn().mockResolvedValue([]),
        listSourceExclusions: vi.fn().mockResolvedValue([]),
      },
    });

    await act(async () => {
      render(<ResearchRegion projectId="p1" />);
    });
    const chain = await screen.findByRole('navigation', { name: '资料包版本历史' });
    expect(
      within(chain).getByRole('button', { name: 'v1 · 2026-08-10 01:02:03 UTC' }),
    ).toBeInTheDocument();
    expect(
      within(chain).getByRole('button', { name: 'v1 · 2026-08-11 04:05:06 UTC' }),
    ).toHaveAttribute('aria-current', 'true');

    await act(async () => {
      within(chain).getByRole('button', { name: 'v1 · 2026-08-10 01:02:03 UTC' }).click();
    });
    expect(await screen.findByText('旧 v1 结论')).toBeInTheDocument();
    expect(screen.getByText(/正在查看历史版本 v1 · 2026-08-10 01:02:03 UTC/)).toBeInTheDocument();
  });
});
