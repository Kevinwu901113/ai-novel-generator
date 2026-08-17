// @vitest-environment jsdom
/**
 * App 级别测试。
 *
 * 渲染真实 App 组件，mock window.desktop。
 * 测试全局行为和集成场景。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act, waitFor, fireEvent, within } from '@testing-library/react';
import type { DesktopAPI } from '@ai-novel/contracts';
import { App } from './App';

// ── Mock 数据 ────────────────────────────────────────────────────────

const mockProject1 = {
  id: 'proj-00000001-aaaa-bbbb-cccc-dddddddddddd',
  name: '测试项目一',
  createdAt: '2024-01-01T00:00:00Z',
  lastOpenedAt: '2024-01-02T00:00:00Z',
  isMissing: false,
};

const mockProviderState = {
  id: 'provider-1',
  label: 'OpenAI',
  protocol: 'openai-chat',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4',
  enabled: true,
  isDefault: true,
  hasApiKey: true,
  lastTestStatus: 'never',
  lastTestErrorCode: null,
  lastTestedAt: null,
  lastTestLatencyMs: null,
};

// ── 工具函数 ────────────────────────────────────────────────────────

function createMockDesktopAPI(overrides: Record<string, unknown> = {}) {
  return {
    healthCheck: vi
      .fn()
      .mockResolvedValue({ ok: true, version: '1.0.0', timestamp: new Date().toISOString() }),
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
      list: vi.fn().mockResolvedValue([mockProviderState]),
      create: vi.fn().mockResolvedValue(mockProviderState),
      update: vi.fn().mockResolvedValue(mockProviderState),
      remove: vi.fn().mockResolvedValue([]),
      setDefault: vi.fn().mockResolvedValue([mockProviderState]),
      saveApiKey: vi.fn().mockResolvedValue({ ...mockProviderState, hasApiKey: true }),
      deleteApiKey: vi.fn().mockResolvedValue({ ...mockProviderState, hasApiKey: false }),
      testConnection: vi.fn().mockResolvedValue({
        success: true,
        latencyMs: 10,
        errorCode: null,
        errorMessage: null,
      }),
    },
    // B4：创作旅程（IntakeRegion 打开项目时轮询这些通道）
    graph: {
      listRuns: vi.fn().mockResolvedValue([]),
      createProjectRun: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      createChapterRun: vi.fn(),
      getRunProgress: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
    },
    intake: {
      getActiveIntakeSession: vi.fn().mockResolvedValue(null),
      propagateSpecInvalidation: vi.fn().mockResolvedValue([]),
    },
    grill: {
      listQuestions: vi.fn().mockResolvedValue([]),
      getCurrentAnswers: vi.fn().mockResolvedValue([]),
    },
    contract: {
      getCurrent: vi.fn().mockResolvedValue(null),
    },
    // B6：SearchKeyPanel（右栏，与项目无关）挂载即读取，App 级测试必须提供
    search: {
      hasApiKey: vi.fn().mockResolvedValue({ hasApiKey: false }),
      saveApiKey: vi.fn().mockResolvedValue({ hasApiKey: true }),
      deleteApiKey: vi.fn().mockResolvedValue({ hasApiKey: false }),
    },
    // B6：journeyStage 在这些测试里始终停留在 idea，不会挂载 ResearchRegion，
    // 但补全以贴近真实 DesktopAPI 形状、减少 `as unknown as` 掩盖的缺口
    research: {
      getResearchState: vi.fn().mockResolvedValue({
        runId: null,
        researchDecision: null,
        researchValid: null,
        bundleRef: null,
        bundleInvalidated: false,
        escalationActive: false,
        researchRetryUsed: 0,
      }),
      getBundle: vi.fn().mockResolvedValue(null),
      listBundles: vi.fn().mockResolvedValue([]),
      setSourceExclusion: vi.fn().mockResolvedValue([]),
      listSourceExclusions: vi.fn().mockResolvedValue([]),
    },
    // B8：App 的旅程探针（useJourney）每轮读 blueprint.getState，必须提供
    blueprint: {
      getState: vi.fn().mockResolvedValue({
        runId: null,
        blueprintRef: null,
        accepted: false,
        blueprintInvalidated: false,
        gateActive: false,
        escalationActive: false,
        rewriteUsed: 0,
      }),
      getBlueprint: vi.fn().mockResolvedValue(null),
    },
    // GE-7：成稿阶段的"稿件"视图挂 ManuscriptPanel（点开才读，但补全形状）
    manuscript: {
      getWorkspace: vi.fn().mockResolvedValue({ manuscriptId: null, title: '', chapters: [] }),
      getChapter: vi.fn().mockResolvedValue(null),
      saveChapter: vi.fn(),
      exportManuscript: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([]),
      restoreVersion: vi.fn(),
    },
    // B10：manuscript 阶段挂 ChapterRegion，挂载即读 chapter.getOverview
    chapter: {
      getOverview: vi.fn().mockResolvedValue({ blueprintId: null, chapters: [] }),
      startRun: vi.fn(),
      getRunState: vi.fn().mockResolvedValue(null),
      submitDecision: vi.fn(),
    },
    ...overrides,
  } as unknown as DesktopAPI;
}

function setupDesktop(api?: DesktopAPI) {
  window.desktop = api ?? createMockDesktopAPI();
  return window.desktop;
}

function getCreateProjectButton() {
  return screen.getByRole('button', { name: '开始整理想法' });
}

async function openSettingsDrawer() {
  await act(async () => {
    screen.getByRole('button', { name: '打开设置' }).click();
  });
  await waitFor(() => {
    expect(screen.getByRole('dialog', { name: '创作服务设置' })).toBeInTheDocument();
  });
}

// B15：顶部全局错误红条（原 <div className="global-error" role="alert">）
// 改 sonner toast（D-B15 1d）。sonner 不产生 role="alert"/role="status" 元素
// ——它自己的无障碍机制是给 toast 列表容器套一个 aria-live="polite" 的
// <section>（"role="alert" 语义由 sonner 的 aria 机制承接"，D-B15-1），逐条
// toast 本身没有 role。以下两个 helper 取代原来的 screen.getByRole('alert')。
function queryGlobalErrorToasts(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-sonner-toast][data-type="error"]'),
  );
}

function getGlobalErrorToastText(): string {
  const toasts = queryGlobalErrorToasts();
  if (toasts.length === 0) throw new Error('未找到错误 toast');
  return toasts[0].querySelector('[data-title]')?.textContent ?? '';
}

// ── B6 REWORK 复查：展示阶段与推进阶段分离（D-B6-10）──────────────────
//
// 已坐实的 blocker：调研有结果的那一刻，Graph frontier 往往已经同快照推进到
// BLUEPRINT_GENERATE（sync 节点连推），此时若 App 仍按 frontierStage 互斥挂载
// Region，ResearchRegion 会被立即换成 IntakeRegion 的占位文案，调研结果永不
// 可达。下面两条测试用真实形状的 progress 数据（frontier 直接落在 blueprint，
// 不经过一次可观测的 research frontier）驱动，还原冷启动场景。

const NOW_B6 = '2026-08-11T00:00:00.000Z';

const BLUEPRINT_RUN = {
  runId: 'run-1',
  graphId: 'idea-to-novel-project-v1',
  graphVersion: '1',
  kind: 'project',
  terminalStatus: null,
  createdAt: NOW_B6,
};

function blueprintFrontierBundle() {
  return {
    id: 'rb-1',
    projectId: 'proj-new-0001',
    version: 1,
    depth: 'deep',
    questions: [
      {
        id: 'q1',
        text: '主角的目标是什么？',
        sources: [
          {
            url: 'https://example.com/a',
            title: '示例来源',
            fetchedAt: NOW_B6,
            excerpt: '摘录文本',
          },
        ],
      },
    ],
    factNotes: [{ id: 'fn1', text: '事实笔记内容', sourceUrls: ['https://example.com/a'] }],
    conclusion: '调研结论文本',
    createdAt: NOW_B6,
    basedOnBundleId: null,
  };
}

/**
 * frontier 已推进到 BLUEPRINT_GENERATE（stage='blueprint'）、调研已产出有效
 * 资料包的 mock DesktopAPI——模拟"重开项目时 Graph 已经一次性推过调研"的冷启动场景。
 */
function createBlueprintFrontierDesktopAPI() {
  const bundle = blueprintFrontierBundle();
  return createMockDesktopAPI({
    graph: {
      listRuns: vi.fn().mockResolvedValue([BLUEPRINT_RUN]),
      createProjectRun: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      createChapterRun: vi.fn(),
      getRunProgress: vi.fn().mockResolvedValue({
        activeNodes: [{ nodeId: 'BLUEPRINT_GENERATE', stage: 'blueprint', status: 'active' }],
        possibleNextNodes: [],
      }),
      applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
    },
    research: {
      getResearchState: vi.fn().mockResolvedValue({
        runId: 'run-1',
        researchDecision: 'deep',
        researchValid: 'valid',
        bundleRef: 'rb-1',
        bundleInvalidated: false,
        escalationActive: false,
        researchRetryUsed: 0,
      }),
      getBundle: vi.fn().mockResolvedValue(bundle),
      listBundles: vi.fn().mockResolvedValue([bundle]),
      setSourceExclusion: vi.fn().mockResolvedValue([]),
      listSourceExclusions: vi.fn().mockResolvedValue([]),
    },
  });
}

async function createProjectAndWaitForJourney(api: DesktopAPI) {
  setupDesktop(api);
  await act(async () => {
    render(<App />);
  });
  await waitFor(
    () => {
      expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
    },
    { timeout: 10000 },
  );
  const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
  act(() => {
    newProjectBtn.click();
  });
  const nameInput = screen.getByLabelText('项目名称');
  const ideaInput = screen.getByLabelText('描述你想写的小说……');
  fireEvent.change(nameInput, { target: { value: '测试项目' } });
  fireEvent.change(ideaInput, { target: { value: '测试想法' } });
  const createBtn = getCreateProjectButton();
  await act(async () => {
    createBtn.click();
  });
}

describe('App：展示阶段与推进阶段分离（D-B6-10 / D-B8-2，跨批次 blocker 回归）', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  // B8 起 blueprint 已有 Region：frontier 落在 blueprint 时中栏挂 BlueprintRegion，
  // 而 D-B6-10 的承诺（已产出的调研内容不因 frontier 越过 research 而不可达）
  // 由 JourneyNav 的可点回看承担。两条一起断言，避免任一侧回归。
  it('frontier 在 blueprint 时挂 BlueprintRegion；点 JourneyNav 的调研仍能回看调研内容', async () => {
    await createProjectAndWaitForJourney(createBlueprintFrontierDesktopAPI());

    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: '故事蓝图' })).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    const nav = screen.getByRole('navigation', { name: '创作旅程阶段' });
    await act(async () => {
      within(nav).getByRole('button', { name: /调研/ }).click();
    });

    await waitFor(
      () => {
        expect(screen.getByText('主角的目标是什么？')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(screen.getByText('调研结论文本')).toBeInTheDocument();

    await act(async () => {
      screen.getByText('展开来源（1）').click();
    });

    await waitFor(() => {
      expect(screen.getByText('https://example.com/a')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '排除此来源' })).toBeInTheDocument();
    });
  });

  // JourneyNav 必须能同时表达"当前进度"（frontierStage=blueprint）与
  // "正在查看"（viewStage=research，用户点回看）且两者在无障碍语义上可区分——
  // 不是同一个语义状态的两种叙述。
  it('用户点回调研后，"当前进度"仍在蓝图、"正在查看"落在调研，二者语义可区分', async () => {
    await createProjectAndWaitForJourney(createBlueprintFrontierDesktopAPI());

    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: '故事蓝图' })).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    const nav = screen.getByRole('navigation', { name: '创作旅程阶段' });
    await act(async () => {
      within(nav).getByRole('button', { name: /调研/ }).click();
    });

    await waitFor(() => {
      expect(screen.getByText('调研结论文本')).toBeInTheDocument();
    });

    const blueprintBtn = within(nav).getByRole('button', { name: /蓝图/ });
    const researchBtn = within(nav).getByRole('button', { name: /调研/ });

    // 当前进度在蓝图：aria-current=step 落在蓝图项，不在调研项
    expect(blueprintBtn).toHaveAttribute('aria-current', 'step');
    expect(researchBtn).not.toHaveAttribute('aria-current');

    // 正在查看调研：aria-pressed=true 落在调研项，不在蓝图项
    expect(researchBtn).toHaveAttribute('aria-pressed', 'true');
    expect(blueprintBtn).not.toHaveAttribute('aria-pressed', 'true');
  });
});

// ── B8：蓝图 UI 的 App 级可达性（D-B8-2/D-B8-3 blocker 回归）──────────
//
// 两条都必须先红后绿：
// 1) frontier 停在 BLUEPRINT_USER_GATE 时，蓝图正文与确认按钮可达；
// 2) run 已 completed + accepted 的**冷启动**下蓝图仍可达，且不显示
//    "重新开始访谈"——这是 D-B8-3 的回归证据。修复前：run 终态 → activeNodes
//    恒空 → 阶段派生回落 idea → 中栏挂 IntakeRegion 的 terminal 文案，且
//    JourneyNav 的蓝图项 disabled，用户永远回不到已接受的蓝图。

function blueprintDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bp-1',
    projectId: 'proj-new-0001',
    version: 1,
    premise: '一个关于星际邮差的故事前提',
    characters: [{ name: '林澈', role: '主角', description: '沉默寡言的邮差' }],
    relationships: ['林澈与调度员是旧识'],
    world: '边缘星系的通讯网',
    conflict: '送信人与收信人立场对立',
    ending: '信最终没有送达',
    plotlines: [{ name: '主线', summary: '一封信的旅程' }],
    chapters: [
      { id: 'ch-1', title: '第一封信', goal: '引入邮差与任务' },
      { id: 'ch-2', title: '折返', goal: '揭示收信人身份' },
    ],
    createdAt: NOW_B6,
    ...overrides,
  };
}

function blueprintStateDto(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    blueprintRef: 'bp-1',
    accepted: false,
    blueprintInvalidated: false,
    gateActive: false,
    escalationActive: false,
    rewriteUsed: 0,
    ...overrides,
  };
}

/** frontier 停在 BLUEPRINT_USER_GATE（等待人工确认）的 mock */
function createBlueprintGateDesktopAPI(stateOverrides: Record<string, unknown> = {}) {
  return createMockDesktopAPI({
    graph: {
      listRuns: vi.fn().mockResolvedValue([BLUEPRINT_RUN]),
      createProjectRun: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      createChapterRun: vi.fn(),
      getRunProgress: vi.fn().mockResolvedValue({
        activeNodes: [
          { nodeId: 'BLUEPRINT_USER_GATE', stage: 'blueprint', status: 'waiting_for_human' },
        ],
        possibleNextNodes: [],
      }),
      applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
    },
    blueprint: {
      getState: vi
        .fn()
        .mockResolvedValue(blueprintStateDto({ gateActive: true, ...stateOverrides })),
      getBlueprint: vi.fn().mockResolvedValue(blueprintDto()),
    },
  });
}

/** run 已 completed 且蓝图已接受的冷启动 mock（activeNodes 恒空） */
function createProjectReadyDesktopAPI() {
  return createMockDesktopAPI({
    graph: {
      listRuns: vi.fn().mockResolvedValue([{ ...BLUEPRINT_RUN, terminalStatus: 'completed' }]),
      createProjectRun: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      createChapterRun: vi.fn(),
      getRunProgress: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
    },
    blueprint: {
      getState: vi.fn().mockResolvedValue(blueprintStateDto({ accepted: true })),
      getBlueprint: vi.fn().mockResolvedValue(blueprintDto()),
    },
  });
}

describe('App：旅程探针失败可见性（B8 复查随行）', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  // D-B8-2 之后阶段派生只由探针这一条循环驱动。它静默失败的话，界面会冻在
  // "想法"阶段而用户毫无察觉——必须有可见反馈，且不能是打断式的。
  it('探针读取失败时给出可见提示，且不泄露原始错误细节', async () => {
    const api = createMockDesktopAPI();
    (api.blueprint.getState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('/Users/foo/secret.sqlite 打不开'),
    );
    await createProjectAndWaitForJourney(api);

    const notice = await screen.findByText(/正在自动重试/, undefined, { timeout: 5000 });
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).not.toContain('/Users/');
  });
});

describe('App：蓝图 UI 可达性（B8，D-B8-2/D-B8-3）', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  it('frontier 停在 BLUEPRINT_USER_GATE 时，蓝图正文与确认按钮可达', async () => {
    await createProjectAndWaitForJourney(createBlueprintGateDesktopAPI());

    await waitFor(
      () => {
        expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    expect(screen.getByText('一个关于星际邮差的故事前提')).toBeInTheDocument();
    expect(screen.getByText('第一封信')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /重新生成一版/ })).toBeEnabled();
  });

  it('蓝图已失效时禁用"接受"、只留重新生成（D-B8-4，不靠报错）', async () => {
    await createProjectAndWaitForJourney(
      createBlueprintGateDesktopAPI({ blueprintInvalidated: true }),
    );

    await waitFor(
      () => {
        expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // 失效横幅 + 旧内容仍降级展示（用户要看得到才能判断）
    expect(screen.getByText(/此蓝图已作废/)).toBeInTheDocument();
    expect(screen.getByText('一个关于星际邮差的故事前提')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /接受这份蓝图/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /重新生成一版/ })).toBeEnabled();
  });

  // D-B8-3 的回归证据：终态 run 的 activeNodes 恒空，阶段必须按已产出 artifact 回推。
  // B10（D-B10-6）行为变化：PROJECT_READY 后默认阶段推进到"成稿"（否则 B10 的章节
  // 生成界面永不可达）。已接受的蓝图仍必须可回看——本条断言的正是这条回看路径，
  // 它承载 D-B8-3 冷启动可达性承诺（只是入口从"默认展示"变成"点导航回看"）。
  it('run 已 completed + 已接受的冷启动下，点导航的蓝图仍可回看且不显示"重新开始访谈"', async () => {
    await createProjectAndWaitForJourney(createProjectReadyDesktopAPI());

    const nav = await screen.findByRole('navigation', { name: '创作旅程阶段' });
    const blueprintBtn = await waitFor(
      () => {
        const btn = within(nav).getByRole('button', { name: /蓝图/ });
        expect(btn).toBeEnabled();
        return btn;
      },
      { timeout: 5000 },
    );
    await act(async () => {
      blueprintBtn.click();
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    expect(screen.getByText('✓ 蓝图已确认，项目就绪')).toBeInTheDocument();
    expect(screen.getByText('一个关于星际邮差的故事前提')).toBeInTheDocument();
    expect(screen.queryByText('重新开始访谈')).not.toBeInTheDocument();
  });

  // D-B8-8：结局方向默认折叠（剧透保护）
  it('结局方向默认折叠，点开后才显示', async () => {
    await createProjectAndWaitForJourney(createBlueprintGateDesktopAPI());

    await waitFor(
      () => {
        expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    expect(screen.queryByText('信最终没有送达')).not.toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: '查看结局方向' }).click();
    });
    expect(screen.getByText('信最终没有送达')).toBeInTheDocument();
  });

  // B8 独立复查补齐（D5）：escalation 相位此前只有组件级手喂 state 测试，
  // 而"分层测试全绿掩盖功能不可达"正是本项目最高发缺陷族——补 App 级真分流。
  it('frontier 停在 BLUEPRINT_ESCALATION 时，四选项与待决策正文经 App 真实分流可达', async () => {
    const api = createMockDesktopAPI({
      graph: {
        listRuns: vi.fn().mockResolvedValue([BLUEPRINT_RUN]),
        createProjectRun: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
        createChapterRun: vi.fn(),
        getRunProgress: vi.fn().mockResolvedValue({
          activeNodes: [
            { nodeId: 'BLUEPRINT_ESCALATION', stage: 'blueprint', status: 'waiting_for_human' },
          ],
          possibleNextNodes: [],
        }),
        applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      },
      blueprint: {
        getState: vi
          .fn()
          .mockResolvedValue(blueprintStateDto({ escalationActive: true, rewriteUsed: 3 })),
        getBlueprint: vi.fn().mockResolvedValue(blueprintDto()),
      },
    });
    await createProjectAndWaitForJourney(api);

    await waitFor(
      () => {
        expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // 四选项 + 同屏正文（用户拍板前必须看得到他要拍板的那个东西）
    expect(screen.getByText('一个关于星际邮差的故事前提')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /就用现在这版蓝图/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /修改创作要求/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /稍后再说/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /取消/ })).toBeEnabled();
  });

  // B8 独立复查补齐（D5）：67a2e71 修的"终态 run 的已生成蓝图不可达"此前只有
  // 组件级测试兜底——补 App 级冷启动回归。
  it('run 已 cancelled 但生成过蓝图的冷启动下，终态说明 + 只读正文可达', async () => {
    const api = createMockDesktopAPI({
      graph: {
        listRuns: vi.fn().mockResolvedValue([{ ...BLUEPRINT_RUN, terminalStatus: 'cancelled' }]),
        createProjectRun: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
        createChapterRun: vi.fn(),
        getRunProgress: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
        applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      },
      blueprint: {
        getState: vi.fn().mockResolvedValue(blueprintStateDto()),
        getBlueprint: vi.fn().mockResolvedValue(blueprintDto()),
      },
    });
    await createProjectAndWaitForJourney(api);

    await waitFor(
      () => {
        expect(screen.getByTestId('blueprint-view')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    expect(screen.getByText('项目流程已取消')).toBeInTheDocument();
    expect(screen.getByText('一个关于星际邮差的故事前提')).toBeInTheDocument();
    // 只读回看：不得出现任何决策按钮
    expect(screen.queryByRole('button', { name: /接受这份蓝图/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /就用现在这版蓝图/ })).not.toBeInTheDocument();
  });
});

// ── 测试 ─────────────────────────────────────────────────────────

describe('App 级别测试', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  // 1. App 只有一个 main landmark
  it('App 只有一个 main landmark', async () => {
    setupDesktop();
    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('main')).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    const mainElements = screen.getAllByRole('main');
    expect(mainElements.length).toBe(1);
  });

  it('首页突出想法入口和最近项目，服务配置默认不占用主界面', async () => {
    setupDesktop();
    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '今天想写什么？' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: '继续创作' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /测试项目一/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始整理想法' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '创作服务设置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: '新增模型服务' })).not.toBeInTheDocument();
  });

  // 2. 全局导航与设置抽屉真实联动
  it('全局导航与设置抽屉真实联动，并在关闭后恢复触发按钮焦点', async () => {
    setupDesktop();
    await act(async () => {
      render(<App />);
    });

    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '首页' })).toHaveAttribute(
          'aria-current',
          'page',
        );
      },
      { timeout: 10000 },
    );

    const settingsButton = screen.getByRole('button', { name: '打开设置' });
    settingsButton.focus();
    await openSettingsDrawer();

    await act(async () => {
      screen.getByRole('button', { name: '关闭创作服务设置' }).click();
    });
    expect(screen.queryByRole('dialog', { name: '创作服务设置' })).not.toBeInTheDocument();
    // B15：抽屉关闭态迁 Radix Dialog（Sheet）后，焦点归还由 FocusScope 的
    // onUnmountAutoFocus 承接；该归还包在真实 setTimeout(0) 宏任务里（非
    // React 调度、非微任务），act() 不会替它推进时间，断言需要 waitFor。
    await waitFor(() => {
      expect(settingsButton).toHaveFocus();
    });
  });

  // 3. 实际 App DOM 不存在重复关键 id
  it('实际 App DOM 不存在重复关键 id', async () => {
    setupDesktop();
    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('main')).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    const allIds = Array.from(document.querySelectorAll('[id]')).map((el) => el.id);
    const uniqueIds = new Set(allIds);
    expect(allIds.length).toBe(uniqueIds.size);
  });

  // 4. 创建失败 global error 出现
  it('projects.create rejection 后 global error 出现', async () => {
    const api = createMockDesktopAPI({
      projects: {
        list: vi.fn().mockResolvedValue([mockProject1]),
        create: vi.fn().mockRejectedValue(new Error('创建失败：磁盘空间不足')),
        open: vi.fn(),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 切换到新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 填写表单
    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    fireEvent.change(nameInput, { target: { value: '测试项目' } });
    fireEvent.change(ideaInput, { target: { value: '测试想法' } });

    // 点击创建
    const createBtn = getCreateProjectButton();
    await act(async () => {
      createBtn.click();
    });

    // global error（toast）应该出现
    await waitFor(
      () => {
        expect(getGlobalErrorToastText()).toContain('创建失败');
      },
      { timeout: 5000 },
    );
  });

  // 5. global error 不含敏感信息
  it('global error 不含 /Users/、stack、Bearer、API Key', async () => {
    const api = createMockDesktopAPI({
      projects: {
        list: vi.fn().mockResolvedValue([mockProject1]),
        create: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'ENOENT: /Users/secret/.env Bearer sk-1234567890abcdef\n    at createProject (src/create.ts:42:11)',
            ),
          ),
        open: vi.fn(),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 切换到新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 填写表单
    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    fireEvent.change(nameInput, { target: { value: '测试项目' } });
    fireEvent.change(ideaInput, { target: { value: '测试想法' } });

    // 点击创建
    const createBtn = getCreateProjectButton();
    await act(async () => {
      createBtn.click();
    });

    // global error（toast）应该不包含敏感信息
    await waitFor(
      () => {
        const text = getGlobalErrorToastText();
        expect(text).not.toContain('/Users/');
        expect(text).not.toContain('Bearer');
        expect(text).not.toContain('sk-');
        expect(text).not.toContain('at createProject');
      },
      { timeout: 5000 },
    );
  });

  // 6. 创建失败后名称和初始想法仍存在
  it('创建失败后名称和初始想法仍存在', async () => {
    const api = createMockDesktopAPI({
      projects: {
        list: vi.fn().mockResolvedValue([mockProject1]),
        create: vi.fn().mockRejectedValue(new Error('创建失败')),
        open: vi.fn(),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 切换到新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 填写表单
    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    fireEvent.change(nameInput, { target: { value: '我的小说' } });
    fireEvent.change(ideaInput, { target: { value: '一个关于未来的故事' } });

    // 点击创建
    const createBtn = getCreateProjectButton();
    await act(async () => {
      createBtn.click();
    });

    // 内容应该保留
    expect(nameInput).toHaveValue('我的小说');
    expect(ideaInput).toHaveValue('一个关于未来的故事');
  });

  // 7. 第二次成功后旧 global error 消失
  it('第二次成功后旧 global error 消失', async () => {
    let callCount = 0;
    const api = createMockDesktopAPI({
      projects: {
        list: vi.fn().mockResolvedValue([mockProject1]),
        create: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error('第一次失败');
          }
          return { id: 'proj-new-0001' };
        }),
        open: vi.fn().mockResolvedValue({
          id: 'proj-new-0001',
          name: '新项目',
          createdAt: new Date().toISOString(),
          lastOpenedAt: new Date().toISOString(),
          status: 'active',
        }),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 切换到新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 填写表单
    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    fireEvent.change(nameInput, { target: { value: '测试项目' } });
    fireEvent.change(ideaInput, { target: { value: '测试想法' } });

    // 第一次创建失败
    const createBtn = getCreateProjectButton();
    await act(async () => {
      createBtn.click();
    });

    // global error（toast）出现
    await waitFor(
      () => {
        expect(queryGlobalErrorToasts().length).toBe(1);
      },
      { timeout: 5000 },
    );

    // 第二次创建成功
    await act(async () => {
      createBtn.click();
    });

    // global error（toast）应该消失
    await waitFor(
      () => {
        expect(queryGlobalErrorToasts().length).toBe(0);
      },
      { timeout: 5000 },
    );
  });

  // 8. provider.testConnection finally 调用 provider.list 并渲染失败状态
  it('testConnection finally 调用 provider.list 并渲染失败状态', async () => {
    const failedProviderState = {
      ...mockProviderState,
      lastTestStatus: 'failed',
      lastTestErrorCode: 'PROVIDER_TIMEOUT',
      lastTestedAt: '2024-01-02T00:00:00Z',
      lastTestLatencyMs: 123,
    };

    const api = createMockDesktopAPI({
      provider: {
        ...createMockDesktopAPI().provider,
        testConnection: vi.fn().mockRejectedValue(new Error('连接超时')),
        list: vi
          .fn()
          .mockResolvedValueOnce([mockProviderState])
          .mockResolvedValueOnce([failedProviderState]),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    await openSettingsDrawer();

    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    const initialCalls = api.provider.list.mock.calls.length;

    const testBtn = screen.getByRole('button', { name: '测试连接' });
    await act(async () => {
      testBtn.click();
    });

    await waitFor(
      () => {
        expect(api.provider.list.mock.calls.length).toBeGreaterThan(initialCalls);
      },
      { timeout: 5000 },
    );

    const providerSection = screen.getByRole('region', { name: '模型提供商' });
    expect(within(providerSection).getByText(/PROVIDER_TIMEOUT/)).toHaveTextContent(/连接超时/);
    const testTimeLabel = within(providerSection).getByText(/测试时间/);
    expect(testTimeLabel.closest('p')).not.toHaveTextContent('—');
    const latencyLabel = within(providerSection).getByText(/延迟/);
    expect(latencyLabel.closest('p')).toHaveTextContent('123ms');
  });

  // 9. App 同一 global error 只有一个 alert/live region
  it('App 同一 global error 只有一个 alert', async () => {
    const api = createMockDesktopAPI({
      projects: {
        list: vi.fn().mockResolvedValue([mockProject1]),
        create: vi.fn().mockRejectedValue(new Error('创建失败')),
        open: vi.fn(),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 切换到新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 填写表单
    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    fireEvent.change(nameInput, { target: { value: '测试项目' } });
    fireEvent.change(ideaInput, { target: { value: '测试想法' } });

    // 点击创建
    const createBtn = getCreateProjectButton();
    await act(async () => {
      createBtn.click();
    });

    // 只应该有一个 global error（toast）
    await waitFor(
      () => {
        expect(queryGlobalErrorToasts().length).toBe(1);
      },
      { timeout: 5000 },
    );
  });

  // 10. Provider 原始错误不泄露
  it('Provider 原始错误不泄露', async () => {
    const api = createMockDesktopAPI({
      provider: {
        ...createMockDesktopAPI().provider,
        testConnection: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'ENOENT: /Users/secret/.env Bearer sk-1234567890abcdef\n    at connect (src/provider.ts:42:11)',
            ),
          ),
        list: vi.fn().mockResolvedValue([mockProviderState]),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    await openSettingsDrawer();

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 点击测试连接
    const testBtn = screen.getByRole('button', { name: '测试连接' });
    await act(async () => {
      testBtn.click();
    });

    // 等待错误显示
    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // 错误不应该包含敏感信息
    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toContain('/Users/');
    expect(alert.textContent).not.toContain('Bearer');
    expect(alert.textContent).not.toContain('sk-');
    expect(alert.textContent).not.toContain('at connect');
  });

  // 12. 点击新建项目后名称输入获得焦点
  it('点击新建项目后名称输入获得焦点', async () => {
    setupDesktop();

    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 点击新建项目
    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    // 名称输入应该获得焦点
    await waitFor(
      () => {
        const nameInput = screen.getByLabelText('项目名称');
        expect(nameInput).toHaveFocus();
      },
      { timeout: 5000 },
    );
  });

  // 13. 创建项目成功后创作旅程标题获得焦点（B4：中栏默认入口为对话式访谈）
  it('创建项目成功后创作旅程标题获得焦点', async () => {
    setupDesktop();

    await act(async () => {
      render(<App />);
    });

    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '新建项目' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    const newProjectBtn = screen.getByRole('button', { name: '新建项目' });
    act(() => {
      newProjectBtn.click();
    });

    const nameInput = screen.getByLabelText('项目名称');
    const ideaInput = screen.getByLabelText('描述你想写的小说……');

    fireEvent.change(nameInput, { target: { value: '测试项目' } });
    fireEvent.change(ideaInput, { target: { value: '测试想法' } });

    const createBtn = getCreateProjectButton();
    await act(async () => {
      createBtn.click();
    });

    await waitFor(
      () => {
        const journey = screen.getByLabelText('创作旅程');
        const heading = within(journey).getByRole('heading', { level: 2 });
        expect(heading).toHaveFocus();
      },
      { timeout: 5000 },
    );
  });

  // 14. 删除 API Key 成功后 API Key 输入获得焦点
  it('删除 API Key 成功后 API Key 输入获得焦点', async () => {
    const api = createMockDesktopAPI({
      provider: {
        ...createMockDesktopAPI().provider,
        deleteApiKey: vi.fn().mockResolvedValue({ ...mockProviderState, hasApiKey: false }),
      },
    });
    setupDesktop(api);

    await act(async () => {
      render(<App />);
    });

    await openSettingsDrawer();

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '删除 API Key' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 点击删除
    const deleteBtn = screen.getByRole('button', { name: '删除 API Key' });
    act(() => {
      deleteBtn.click();
    });

    // 确认删除
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '确认删除 API Key' })).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    const confirmBtn = screen.getByRole('button', { name: '确认删除 API Key' });
    await act(async () => {
      confirmBtn.click();
    });

    // API Key 输入应该获得焦点
    await waitFor(
      () => {
        const apiKeyInput = screen.getByLabelText('API Key');
        expect(apiKeyInput).toHaveFocus();
      },
      { timeout: 5000 },
    );
  });
});

// ── B10：章节生成 UI 的 App 级可达性 ──────────────────────────────────
//
// 跨批次教训（B6 坐实的 blocker）：组件级测试直接挂载 Region 手喂 state 会绕开
// App 分流，"内容存在却永不可达"这一族缺陷只有 App 级测试能抓住。本节用真实形状的
// progress 驱动：project run 已 completed（PROJECT_READY），frontier 派生到
// manuscript 阶段，断言中栏真的挂上了 ChapterRegion 且章节列表可达。

const COMPLETED_PROJECT_RUN = {
  runId: 'run-1',
  graphId: 'idea-to-novel-project-v1',
  graphVersion: '1',
  kind: 'project',
  terminalStatus: 'completed',
  createdAt: NOW_B6,
};

function createChapterStageDesktopAPI() {
  return createMockDesktopAPI({
    graph: {
      listRuns: vi.fn().mockResolvedValue([COMPLETED_PROJECT_RUN]),
      createProjectRun: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      createChapterRun: vi.fn(),
      // run 已终态：activeNodes 恒空，阶段按 artifact 推导（D-B8-3）
      getRunProgress: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
      applyHumanDecision: vi.fn().mockResolvedValue({ activeNodes: [], possibleNextNodes: [] }),
    },
    blueprint: {
      getState: vi.fn().mockResolvedValue({
        runId: 'run-1',
        blueprintRef: 'bp-1',
        accepted: true,
        blueprintInvalidated: false,
        gateActive: false,
        escalationActive: false,
        rewriteUsed: 0,
      }),
      getBlueprint: vi.fn().mockResolvedValue(null),
    },
    chapter: {
      getOverview: vi.fn().mockResolvedValue({
        blueprintId: 'bp-1',
        chapters: [
          {
            blueprintChapterId: 'ch-1',
            title: '第一章 远客',
            goal: '引出客栈与主角',
            runId: null,
            phase: 'idle',
            hasCandidate: false,
          },
        ],
      }),
      startRun: vi.fn(),
      getRunState: vi.fn().mockResolvedValue(null),
      submitDecision: vi.fn(),
    },
  });
}

describe('App：成稿阶段可达性（B10）', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  it('项目就绪后点 JourneyNav 的"成稿"→ 中栏挂 ChapterRegion，章节列表与发起入口可达', async () => {
    await createProjectAndWaitForJourney(createChapterStageDesktopAPI());

    const nav = await screen.findByRole('navigation', { name: '创作旅程阶段' });
    const manuscriptBtn = await waitFor(
      () => {
        const btn = within(nav).getByRole('button', { name: /成稿/ });
        expect(btn).not.toBeDisabled();
        return btn;
      },
      { timeout: 10000 },
    );
    await act(async () => {
      manuscriptBtn.click();
    });

    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: '成稿' })).toBeInTheDocument();
        expect(screen.getByText('第一章 远客')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '开始生成' })).toBeInTheDocument();
      },
      { timeout: 10000 },
    );
  });
});

// ── B18：移动端导航收纳（D-B18-3）────────────────────────────────────

describe('App：移动端导航收纳（B18，D-B18-3）', () => {
  /**
   * 覆盖 vitest.setup 的全局 matchMedia stub（恒 matches:false）：让 App 的
   * 移动断点查询（max-width）按用例返回真/假。同名导航控件（首页/新建项目/
   * 打开设置）在任一断点下都必须唯一——双导航同时进 DOM 的重复控件问题
   * 正是本批坐实后改条件渲染的原因，这里钉住不回退。
   */
  function mockMatchMedia(mobileMatches: boolean) {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width') ? mobileMatches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    return () => {
      window.matchMedia = original;
    };
  }

  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  it('桌面（≥768px）：左侧导航栏挂载，三入口同名控件唯一', async () => {
    const restore = mockMatchMedia(false);
    try {
      setupDesktop();
      render(<App />);
      await screen.findByRole('button', { name: '开始整理想法' });
      expect(screen.getAllByRole('button', { name: '首页' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: '新建项目' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: '打开设置' })).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('移动（<768px）：导航收纳到底部，三入口可达、同名控件唯一，设置抽屉真实可开', async () => {
    const restore = mockMatchMedia(true);
    try {
      setupDesktop();
      render(<App />);
      await screen.findByRole('button', { name: '开始整理想法' });
      expect(screen.getAllByRole('button', { name: '首页' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: '新建项目' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: '打开设置' })).toHaveLength(1);

      // 底部导航的设置入口要真的能打开抽屉（不是只有视觉存在）
      await act(async () => {
        screen.getByRole('button', { name: '打开设置' }).click();
      });
      expect(await screen.findByText('创作服务设置')).toBeInTheDocument();
    } finally {
      restore();
    }
  });
});
