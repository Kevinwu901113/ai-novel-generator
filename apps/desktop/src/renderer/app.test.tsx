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
    ...overrides,
  } as unknown as DesktopAPI;
}

function setupDesktop(api?: DesktopAPI) {
  window.desktop = api ?? createMockDesktopAPI();
  return window.desktop;
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
  const createBtn = screen.getByText('创建项目');
  await act(async () => {
    createBtn.click();
  });
}

describe('App：展示阶段与推进阶段分离（D-B6-10，B6 REWORK blocker 回归）', () => {
  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  // frontier 落在 blueprint（调研全链在同一快照内推进过去，未经可观测的
  // research frontier）时，调研已产出的有效资料包必须仍然可达——问题文本、
  // 来源、来源排除开关三者都要能查到。修复前：App 按 frontierStage 互斥挂载，
  // journeyStage 一到 blueprint 就换回 IntakeRegion，以下内容永不渲染。
  it('frontier 在 blueprint 时，已有调研内容仍可达（ResearchBundleView 问题/来源/排除开关）', async () => {
    await createProjectAndWaitForJourney(createBlueprintFrontierDesktopAPI());

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
  // "正在查看"（viewStage=research 回落展示），且两者在无障碍语义上可区分——
  // 不是同一个语义状态的两种叙述。
  it('frontier=blueprint 时 JourneyNav 的"当前进度"与"正在查看"在无障碍语义上可区分', async () => {
    await createProjectAndWaitForJourney(createBlueprintFrontierDesktopAPI());

    await waitFor(
      () => {
        expect(screen.getByText('调研结论文本')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    const nav = screen.getByRole('navigation', { name: '创作旅程阶段' });
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

  // 2. panel aria-expanded 与真实 App 状态联动
  it('panel aria-expanded 与真实 App 状态联动', async () => {
    setupDesktop();
    await act(async () => {
      render(<App />);
    });

    // 等待 App 完成初始渲染
    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /收起项目列表|展开项目列表/ }),
        ).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // 左面板默认展开
    const leftToggle = screen.getByRole('button', { name: /收起项目列表|展开项目列表/ });
    expect(leftToggle).toHaveAttribute('aria-expanded', 'true');

    // 点击收起
    act(() => {
      leftToggle.click();
    });
    expect(leftToggle).toHaveAttribute('aria-expanded', 'false');

    // 右面板默认展开
    const rightToggle = screen.getByRole('button', { name: /收起状态面板|展开状态面板/ });
    expect(rightToggle).toHaveAttribute('aria-expanded', 'true');

    // 点击收起
    act(() => {
      rightToggle.click();
    });
    expect(rightToggle).toHaveAttribute('aria-expanded', 'false');
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
    const createBtn = screen.getByText('创建项目');
    await act(async () => {
      createBtn.click();
    });

    // global error 应该出现
    await waitFor(
      () => {
        const errorAlert = screen.getByRole('alert');
        expect(errorAlert).toBeInTheDocument();
        expect(errorAlert.textContent).toContain('创建失败');
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
    const createBtn = screen.getByText('创建项目');
    await act(async () => {
      createBtn.click();
    });

    // global error 应该不包含敏感信息
    await waitFor(
      () => {
        const errorAlert = screen.getByRole('alert');
        expect(errorAlert.textContent).not.toContain('/Users/');
        expect(errorAlert.textContent).not.toContain('Bearer');
        expect(errorAlert.textContent).not.toContain('sk-');
        expect(errorAlert.textContent).not.toContain('at createProject');
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
    const createBtn = screen.getByText('创建项目');
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
    const createBtn = screen.getByText('创建项目');
    await act(async () => {
      createBtn.click();
    });

    // global error 出现
    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // 第二次创建成功
    await act(async () => {
      createBtn.click();
    });

    // global error 应该消失
    await waitFor(
      () => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

    const providerSection = screen.getByLabelText('模型服务');
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
    const createBtn = screen.getByText('创建项目');
    await act(async () => {
      createBtn.click();
    });

    // 只应该有一个 alert（global error）
    await waitFor(
      () => {
        const alerts = screen.getAllByRole('alert');
        expect(alerts.length).toBe(1);
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

    const createBtn = screen.getByText('创建项目');
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
