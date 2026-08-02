// @vitest-environment jsdom
/**
 * useContractDraft hook 测试。
 *
 * 覆盖：
 * - 请求创作契约草稿（payload、expectedContractVersion null/number、single-flight）
 * - 任务轮询（PENDING → RUNNING → SUCCEEDED、FAILED、CANCELLED、STALE）
 * - 终态停止轮询
 * - hidden 暂停、visible 立即刷新
 * - unmount 清理 timer / pending response 不 setState
 * - project / session 切换后忽略旧 task 与旧 response
 * - 提案过滤（按 baseGrillSessionId）+ 确定性最新 PROPOSED
 * - 接受提案（CAS payload、single-flight、返回版本为事实来源）
 * - 版本冲突刷新、提案过期
 * - 拒绝提案（CAS payload、成功后允许重新生成）
 * - 安全错误 / 不泄露 task errorMessage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup as rtlCleanup } from '@testing-library/react';
import { useContractDraft, selectNewestProposedProposal } from './useContractDraft';
import type {
  DesktopAPI,
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
  tone: ['治愈', '悬疑'],
  themes: ['身份', '救赎'],
  targetAudience: '喜欢慢热叙事的成年读者',
  narrativePov: 'THIRD_LIMITED',
  tense: 'PAST',
  targetLength: { unit: 'words', value: 80000 },
  structure: '三幕式：觉醒、对抗、和解',
  protagonist: {
    characterKey: 'hero',
    name: '陆沉',
    role: '主角',
    motivation: '寻找失落的记忆',
    arc: '从逃避到直面',
    traits: ['谨慎', '温柔'],
  },
  supportingCharacters: [
    {
      characterKey: 'friend',
      name: '苏晚',
      role: '挚友',
      relationship: '青梅竹马',
      traits: ['勇敢'],
    },
  ],
  relationships: [
    {
      relationshipKey: 'hero-friend',
      fromCharacterKey: 'hero',
      toCharacterKey: 'friend',
      type: '信任',
      dynamic: '逐渐加深',
    },
  ],
  worldRules: ['神明信仰会侵蚀记忆'],
  mustInclude: ['每一章至少一个记忆碎片'],
  mustAvoid: ['机械降神式结尾'],
  contentBoundaries: {
    rating: 'PG-13',
    allowedContent: ['轻度暴力'],
    prohibitedContent: ['血腥描写'],
    notes: '保持克制的氛围描写',
  },
  unresolvedQuestions: ['陆沉的记忆为何被封印？'],
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
  lockedFieldPaths: [],
  contractSnapshotHash: 'b'.repeat(64),
  provenance: [],
  createdAt: '2024-01-01T00:00:00Z',
  createdBy: 'ai-proposal-accepted',
};

const mockVersionV3: ContractVersionPublicData = {
  ...mockVersion,
  id: 'version-000003',
  version: 3,
};

const mockVersionV4: ContractVersionPublicData = {
  ...mockVersion,
  id: 'version-000004',
  version: 4,
};

// ── Mock DesktopAPI 工厂 ──────────────────────────────────────────

function createMockAPI(
  overrides: Record<string, (...args: ReadonlyArray<unknown>) => unknown> = {},
) {
  return {
    contract: {
      getCurrent: vi.fn().mockResolvedValue(null),
      listProposals: vi.fn().mockResolvedValue([]),
      requestDraft: vi.fn().mockResolvedValue({
        taskId: 'task-00000001',
        grillSessionId: 'sess-00000001',
        baseGrillSessionVersion: 2,
        baseContractVersion: null,
      }),
      acceptProposal: vi.fn().mockResolvedValue(mockVersion),
      rejectProposal: vi.fn().mockResolvedValue({ ...mockProposal, status: 'REJECTED' }),
      ...overrides,
    },
    tasks: {
      get: vi.fn().mockResolvedValue(mockTask),
      ...overrides,
    },
  };
}

function setupDesktop(api: ReturnType<typeof createMockAPI>) {
  window.desktop = api as unknown as DesktopAPI;
  return api;
}

/** 刷新 mount 后的初始加载（getCurrent + listProposals 的 microtask 结算） */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('useContractDraft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // 显式卸载所有 hook：防止上一测试的 visibility listener/timer 泄漏到下一测试
    rtlCleanup();
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function cleanup() {
    window.desktop = undefined as unknown as DesktopAPI;
  }

  // ── 无 project / 无 session ────────────────────────────────────

  it('无 project：不发起任何 API 调用', async () => {
    const api = setupDesktop(createMockAPI());

    renderHook(() => useContractDraft(null, null, 0));

    await flushAsync();

    expect(api.contract.getCurrent).not.toHaveBeenCalled();
    expect(api.contract.listProposals).not.toHaveBeenCalled();
  });

  it('有 project 但无 session：不发起加载', async () => {
    const api = setupDesktop(createMockAPI());

    renderHook(() => useContractDraft('proj-00000001', null, 0));

    await flushAsync();

    expect(api.contract.getCurrent).not.toHaveBeenCalled();
    expect(api.contract.listProposals).not.toHaveBeenCalled();
  });

  // ── 初始加载 ──────────────────────────────────────────────────

  it('初始并行加载 getCurrent + listProposals（project scope）', async () => {
    const api = setupDesktop(
      createMockAPI({
        getCurrent: vi.fn().mockResolvedValue(mockVersion),
        listProposals: vi.fn().mockResolvedValue([mockProposal]),
      }),
    );

    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    expect(api.contract.getCurrent).toHaveBeenCalledWith({ projectId: 'proj-00000001' });
    expect(api.contract.listProposals).toHaveBeenCalledWith({ projectId: 'proj-00000001' });
    expect(result.current.currentContract?.version).toBe(1);
    expect(result.current.selectedProposal?.id).toBe('prop-00000001');
  });

  // ── 请求草稿 ──────────────────────────────────────────────────

  it('请求 payload 使用 project/session/version 且 expectedContractVersion 为 null', async () => {
    const api = setupDesktop(createMockAPI());
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 3));

    await flushAsync();

    await act(async () => {
      await result.current.requestDraft();
    });

    expect(api.contract.requestDraft).toHaveBeenCalledWith({
      projectId: 'proj-00000001',
      grillSessionId: 'sess-00000001',
      expectedGrillSessionVersion: 3,
      expectedContractVersion: null,
    });
  });

  it('当前契约存在时 expectedContractVersion 使用其 version', async () => {
    const api = setupDesktop(
      createMockAPI({
        getCurrent: vi.fn().mockResolvedValue(mockVersionV3),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    await act(async () => {
      await result.current.requestDraft();
    });

    expect(api.contract.requestDraft).toHaveBeenCalledWith(
      expect.objectContaining({ expectedContractVersion: 3 }),
    );
  });

  it('重复点击请求只调用一次 IPC', async () => {
    const api = setupDesktop(createMockAPI());
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    await act(async () => {
      await Promise.all([result.current.requestDraft(), result.current.requestDraft()]);
    });

    expect(api.contract.requestDraft).toHaveBeenCalledTimes(1);
  });

  it('请求成功后合成 PENDING 任务并开始轮询', async () => {
    setupDesktop(createMockAPI());
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    await act(async () => {
      await result.current.requestDraft();
    });

    expect(result.current.task).not.toBeNull();
    expect(result.current.task?.id).toBe('task-00000001');
    expect(result.current.task?.taskType).toBe('CREATION_CONTRACT_DRAFT');
    expect(result.current.task?.status).toBe('PENDING');
    expect(result.current.isPolling).toBe(true);
  });

  it('请求失败显示安全中文标签（CONTRACT_DRAFT_ALREADY_RUNNING）', async () => {
    setupDesktop(
      createMockAPI({
        requestDraft: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('Already running'), { code: 'CONTRACT_DRAFT_ALREADY_RUNNING' }),
          ),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    await act(async () => {
      await result.current.requestDraft();
    });

    expect(result.current.error).toBe('创作契约任务已在进行中');
    expect(result.current.error).not.toContain('Already running');
  });

  // ── 任务轮询 ──────────────────────────────────────────────────

  it('PENDING → RUNNING → SUCCEEDED，终态停止轮询并重新加载提案', async () => {
    let taskStatus = 'PENDING';
    const api = setupDesktop(
      createMockAPI({
        get: vi.fn().mockImplementation(() => ({ ...mockTask, status: taskStatus })),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    await act(async () => {
      await result.current.requestDraft();
    });
    expect(result.current.task?.status).toBe('PENDING');

    taskStatus = 'RUNNING';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.task?.status).toBe('RUNNING');

    taskStatus = 'SUCCEEDED';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.task?.status).toBe('SUCCEEDED');
    expect(result.current.isPolling).toBe(false);
    expect(api.contract.listProposals).toHaveBeenCalled();
  });

  it('终态后不再调用 tasks.get', async () => {
    const getMock = vi.fn().mockResolvedValue({ ...mockTask, status: 'SUCCEEDED' });
    setupDesktop(createMockAPI({ get: getMock }));
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const callCount = getMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getMock.mock.calls.length).toBe(callCount);
    expect(result.current.isPolling).toBe(false);
  });

  it('FAILED 显示安全标签且不泄露 errorMessage', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({
          ...mockTask,
          status: 'FAILED',
          errorCode: 'TASK_EXECUTION_FAILED',
          errorMessage: 'Internal error at /var/app/secret with Bearer token abc123',
        }),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.task?.status).toBe('FAILED');
    expect(result.current.error).toBe('任务执行失败（TASK_EXECUTION_FAILED）');
    expect(result.current.error).not.toContain('secret');
    expect(result.current.error).not.toContain('Bearer');
    expect(result.current.error).not.toContain('Internal error');
  });

  it('CANCELLED 显示提示', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({ ...mockTask, status: 'CANCELLED' }),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.task?.status).toBe('CANCELLED');
    expect(result.current.error).toBe('创作契约任务已取消');
  });

  it('STALE 显示提示', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({ ...mockTask, status: 'STALE' }),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.task?.status).toBe('STALE');
    expect(result.current.error).toBe('创作契约任务已过期');
  });

  it('SUCCEEDED 后重新加载提案并选出 PROPOSED', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({ ...mockTask, status: 'SUCCEEDED' }),
        listProposals: vi.fn().mockResolvedValue([mockProposal]),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.selectedProposal?.id).toBe('prop-00000001');
  });

  // ── single-flight polling ──────────────────────────────────────

  it('single-flight：在途 poll 不发第二个请求', async () => {
    let resolvePoll!: (value: unknown) => void;
    const pollPromise = new Promise((resolve) => {
      resolvePoll = resolve;
    });
    let pollCount = 0;
    const getMock = vi.fn().mockImplementation(() => {
      pollCount++;
      if (pollCount === 1) return pollPromise;
      return { ...mockTask, status: 'RUNNING' };
    });
    setupDesktop(createMockAPI({ get: getMock }));
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePoll({ ...mockTask, status: 'RUNNING' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  // ── 提案过滤与确定性选择 ──────────────────────────────────────

  it('按 baseGrillSessionId 过滤提案', async () => {
    const otherSessionProposal = {
      ...mockProposal,
      id: 'prop-other',
      baseGrillSessionId: 'sess-00000002',
    };
    setupDesktop(
      createMockAPI({
        listProposals: vi.fn().mockResolvedValue([mockProposal, otherSessionProposal]),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    expect(result.current.proposals).toHaveLength(2);
    expect(result.current.selectedProposal?.id).toBe('prop-00000001');
  });

  it('只选 PROPOSED 提案', async () => {
    const acceptedProposal = { ...mockProposal, id: 'prop-accepted', status: 'ACCEPTED' as const };
    setupDesktop(
      createMockAPI({
        listProposals: vi.fn().mockResolvedValue([acceptedProposal]),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    expect(result.current.selectedProposal).toBeNull();
  });

  it('selectNewestProposedProposal：createdAt 最新的胜出', () => {
    const older = { ...mockProposal, id: 'prop-old', createdAt: '2024-01-01T00:00:00Z' };
    const newer = { ...mockProposal, id: 'prop-new', createdAt: '2024-01-02T00:00:00Z' };
    expect(selectNewestProposedProposal([older, newer], 'sess-00000001')?.id).toBe('prop-new');
  });

  it('selectNewestProposedProposal：createdAt 相同以 ID 降序 tie-break', () => {
    const a = { ...mockProposal, id: 'prop-a', createdAt: '2024-01-01T00:00:00Z' };
    const b = { ...mockProposal, id: 'prop-b', createdAt: '2024-01-01T00:00:00Z' };
    expect(selectNewestProposedProposal([a, b], 'sess-00000001')?.id).toBe('prop-b');
  });

  it('selectNewestProposedProposal：无候选返回 null', () => {
    expect(selectNewestProposedProposal([], 'sess-00000001')).toBeNull();
    const rejected = { ...mockProposal, status: 'REJECTED' as const };
    expect(selectNewestProposedProposal([rejected], 'sess-00000001')).toBeNull();
  });

  // ── 接受提案 ──────────────────────────────────────────────────

  it('接受 payload：CAS 字段 + operations: []', async () => {
    const api = setupDesktop(
      createMockAPI({
        getCurrent: vi.fn().mockResolvedValue(mockVersionV3),
        listProposals: vi.fn().mockResolvedValue([mockProposal]),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 4));

    await flushAsync();

    let ok = false;
    await act(async () => {
      ok = await result.current.acceptProposal('prop-00000001');
    });

    expect(ok).toBe(true);
    expect(api.contract.acceptProposal).toHaveBeenCalledWith({
      projectId: 'proj-00000001',
      proposalId: 'prop-00000001',
      expectedProposalSectionsHash: 'a'.repeat(64),
      expectedGrillSessionVersion: 4,
      expectedContractVersion: 3,
      operations: [],
    });
  });

  it('当前契约为 null 时接受 payload 的 expectedContractVersion 为 null', async () => {
    const api = setupDesktop(
      createMockAPI({ listProposals: vi.fn().mockResolvedValue([mockProposal]) }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    await act(async () => {
      await result.current.acceptProposal('prop-00000001');
    });

    expect(api.contract.acceptProposal).toHaveBeenCalledWith(
      expect.objectContaining({ expectedContractVersion: null }),
    );
  });

  it('初始 v3，Accept 前刷新返回 v4：payload 使用刷新后的 v4', async () => {
    const api = setupDesktop(
      createMockAPI({
        getCurrent: vi
          .fn()
          .mockResolvedValueOnce(mockVersionV3)
          .mockResolvedValueOnce(mockVersionV4),
        listProposals: vi.fn().mockResolvedValue([mockProposal]),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    let ok = false;
    await act(async () => {
      ok = await result.current.acceptProposal('prop-00000001');
    });

    expect(ok).toBe(true);
    // 使用本次刷新返回的 v4，而不是 currentContractRef 中仍为 v3 的旧值
    expect(api.contract.acceptProposal).toHaveBeenCalledWith(
      expect.objectContaining({ expectedContractVersion: 4 }),
    );
  });

  it('刷新失败（getCurrent reject）：不调用 Accept', async () => {
    const api = setupDesktop(
      createMockAPI({
        getCurrent: vi
          .fn()
          .mockResolvedValueOnce(mockVersionV3)
          .mockRejectedValueOnce(
            Object.assign(new Error('refresh failed at /Users/me/app'), { code: 'IPC_ERROR' }),
          ),
        listProposals: vi.fn().mockResolvedValue([mockProposal]),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    let ok = true;
    await act(async () => {
      ok = await result.current.acceptProposal('prop-00000001');
    });

    expect(ok).toBe(false);
    expect(api.contract.acceptProposal).not.toHaveBeenCalled();
    // 刷新错误被安全上报（fallback，不含原始消息/路径）
    expect(result.current.error).toBe('操作失败，请稍后重试');
  });

  it('刷新期间切换 project：不调用 Accept', async () => {
    let resolveRefresh!: (value: unknown) => void;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    const api = setupDesktop(
      createMockAPI({
        getCurrent: vi
          .fn()
          .mockResolvedValueOnce(mockVersionV3)
          .mockImplementationOnce(() => refreshPromise)
          .mockResolvedValue(mockVersionV4),
        listProposals: vi.fn().mockResolvedValue([mockProposal]),
      }),
    );
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string | null }) =>
        useContractDraft(projectId, 'sess-00000001', 2),
      { initialProps: { projectId: 'proj-00000001' } },
    );

    await flushAsync();

    act(() => {
      void result.current.acceptProposal('prop-00000001');
    });

    // 刷新在途期间切换到另一 project → generation bump → 刷新结果 stale
    rerender({ projectId: 'proj-00000002' });

    await act(async () => {
      resolveRefresh(mockVersionV4);
    });

    expect(api.contract.acceptProposal).not.toHaveBeenCalled();
  });

  it('刷新期间切换 session：不调用 Accept', async () => {
    let resolveRefresh!: (value: unknown) => void;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    const api = setupDesktop(
      createMockAPI({
        getCurrent: vi
          .fn()
          .mockResolvedValueOnce(mockVersionV3)
          .mockImplementationOnce(() => refreshPromise)
          .mockResolvedValue(mockVersionV4),
        listProposals: vi.fn().mockResolvedValue([mockProposal]),
      }),
    );
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useContractDraft('proj-00000001', sessionId, 2),
      { initialProps: { sessionId: 'sess-00000001' } },
    );

    await flushAsync();

    act(() => {
      void result.current.acceptProposal('prop-00000001');
    });

    // 刷新在途期间切换到另一 session → generation bump → 刷新结果 stale
    rerender({ sessionId: 'sess-00000002' });

    await act(async () => {
      resolveRefresh(mockVersionV4);
    });

    expect(api.contract.acceptProposal).not.toHaveBeenCalled();
  });

  it('刷新期间 proposal 被替换：不调用 Accept', async () => {
    let resolveRefresh!: (value: unknown) => void;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    const supersededProposal: ProposalPublicData = {
      ...mockProposal,
      id: 'prop-SUPERSEDED',
      sectionsHash: 'c'.repeat(64),
    };
    const api = setupDesktop(
      createMockAPI({
        getCurrent: vi
          .fn()
          .mockResolvedValueOnce(mockVersionV3)
          .mockImplementationOnce(() => refreshPromise)
          .mockResolvedValue(mockVersionV4),
        listProposals: vi
          .fn()
          .mockResolvedValueOnce([mockProposal])
          .mockResolvedValue([supersededProposal]),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    act(() => {
      void result.current.acceptProposal('prop-00000001');
    });

    // 刷新在途期间 proposals 被重载（旧提案被替换）→ 本次 accept 的 context 失效
    await act(async () => {
      await result.current.refresh();
    });

    await act(async () => {
      resolveRefresh(mockVersionV4);
    });

    expect(api.contract.acceptProposal).not.toHaveBeenCalled();
  });

  it('接受成功：acceptedVersion 使用返回的当前版本（事实来源）', async () => {
    setupDesktop(createMockAPI({ listProposals: vi.fn().mockResolvedValue([mockProposal]) }));
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    let ok = false;
    await act(async () => {
      ok = await result.current.acceptProposal('prop-00000001');
    });

    expect(ok).toBe(true);
    expect(result.current.acceptedVersion?.id).toBe('version-000001');
    expect(result.current.acceptedVersion?.version).toBe(1);
  });

  it('接受 single-flight：重复点击只调用一次', async () => {
    let resolveAccept!: (value: unknown) => void;
    const acceptPromise = new Promise((resolve) => {
      resolveAccept = resolve;
    });
    const api = setupDesktop(
      createMockAPI({
        listProposals: vi.fn().mockResolvedValue([mockProposal]),
        acceptProposal: vi.fn().mockReturnValue(acceptPromise),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    act(() => {
      void result.current.acceptProposal('prop-00000001');
    });

    let second = true;
    await act(async () => {
      second = await result.current.acceptProposal('prop-00000001');
    });
    expect(second).toBe(false);

    await act(async () => {
      resolveAccept(mockVersion);
    });

    expect(api.contract.acceptProposal).toHaveBeenCalledTimes(1);
  });

  it('接受 CONTRACT_VERSION_CONFLICT：横幅 + 自动刷新只读数据，不自动重发', async () => {
    const getCurrentMock = vi.fn().mockResolvedValue(null);
    const listProposalsMock = vi.fn().mockResolvedValue([mockProposal]);
    const api = setupDesktop(
      createMockAPI({
        getCurrent: getCurrentMock,
        listProposals: listProposalsMock,
        acceptProposal: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('Version conflict'), { code: 'CONTRACT_VERSION_CONFLICT' }),
          ),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    const getCurrentCallsBefore = getCurrentMock.mock.calls.length;
    const listCallsBefore = listProposalsMock.mock.calls.length;

    let ok = true;
    await act(async () => {
      ok = await result.current.acceptProposal('prop-00000001');
    });

    expect(ok).toBe(false);
    expect(result.current.conflictNotice).toBe(true);
    expect(result.current.error).toBeNull();
    // 刷新 getCurrent + listProposals（只读，不重发 mutation）
    expect(getCurrentMock.mock.calls.length).toBeGreaterThan(getCurrentCallsBefore);
    expect(listProposalsMock.mock.calls.length).toBeGreaterThan(listCallsBefore);
    expect(api.contract.acceptProposal).toHaveBeenCalledTimes(1);
  });

  it('接受 CONTRACT_PROPOSAL_STALE：提示重新生成，不自动重发', async () => {
    const api = setupDesktop(
      createMockAPI({
        listProposals: vi.fn().mockResolvedValue([mockProposal]),
        acceptProposal: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('Stale'), { code: 'CONTRACT_PROPOSAL_STALE' }),
          ),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    let ok = true;
    await act(async () => {
      ok = await result.current.acceptProposal('prop-00000001');
    });

    expect(ok).toBe(false);
    expect(result.current.error).toBe('创作契约提案已过期，请重新生成');
    expect(api.contract.acceptProposal).toHaveBeenCalledTimes(1);
    // 提案仍在，可点击"生成创作契约"重新生成（hook 不自动触发新草稿）
    expect(result.current.selectedProposal).not.toBeNull();
  });

  // ── 拒绝提案 ──────────────────────────────────────────────────

  it('拒绝 payload：CAS sectionsHash', async () => {
    const api = setupDesktop(
      createMockAPI({ listProposals: vi.fn().mockResolvedValue([mockProposal]) }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    let ok = false;
    await act(async () => {
      ok = await result.current.rejectProposal('prop-00000001');
    });

    expect(ok).toBe(true);
    expect(api.contract.rejectProposal).toHaveBeenCalledWith({
      projectId: 'proj-00000001',
      proposalId: 'prop-00000001',
      expectedProposalSectionsHash: 'a'.repeat(64),
    });
  });

  it('拒绝成功后清除 review 提案并允许重新生成', async () => {
    setupDesktop(
      createMockAPI({
        listProposals: vi.fn().mockResolvedValueOnce([mockProposal]).mockResolvedValue([]),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    expect(result.current.selectedProposal).not.toBeNull();

    let ok = false;
    await act(async () => {
      ok = await result.current.rejectProposal('prop-00000001');
    });

    expect(ok).toBe(true);
    expect(result.current.selectedProposal).toBeNull();
    expect(result.current.task).toBeNull();
    // 不自动触发新草稿
    expect(result.current.isRequesting).toBe(false);
  });

  // ── project / session 切换 ────────────────────────────────────

  it('session 切换后忽略旧 task', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({ ...mockTask, status: 'SUCCEEDED' }),
      }),
    );
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useContractDraft('proj-00000001', sessionId, 2),
      { initialProps: { sessionId: 'sess-00000001' } },
    );

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });

    rerender({ sessionId: 'sess-00000002' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(result.current.task).toBeNull();
  });

  it('project 切换后忽略旧 task', async () => {
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({ ...mockTask, status: 'SUCCEEDED' }),
      }),
    );
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string | null }) =>
        useContractDraft(projectId, 'sess-00000001', 2),
      { initialProps: { projectId: 'proj-00000001' } },
    );

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });

    rerender({ projectId: 'proj-00000002' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(result.current.task).toBeNull();
  });

  it('旧 proposal 响应在 session 切换后被忽略', async () => {
    let resolveList!: (value: unknown) => void;
    const listPromise = new Promise((resolve) => {
      resolveList = resolve;
    });
    setupDesktop(
      createMockAPI({
        listProposals: vi.fn().mockReturnValueOnce(listPromise).mockResolvedValue([]),
      }),
    );
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useContractDraft('proj-00000001', sessionId, 2),
      { initialProps: { sessionId: 'sess-00000001' } },
    );

    rerender({ sessionId: 'sess-00000002' });

    await act(async () => {
      resolveList([mockProposal]);
    });

    expect(result.current.proposals).toEqual([]);
  });

  it('同 session 内多次加载，最新响应覆盖旧响应', async () => {
    const newProposal = { ...mockProposal, id: 'prop-NEW', status: 'ACCEPTED' as const };
    let resolveList1!: (value: unknown) => void;
    const listPromise1 = new Promise((resolve) => {
      resolveList1 = resolve;
    });
    setupDesktop(
      createMockAPI({
        get: vi.fn().mockResolvedValue({ ...mockTask, status: 'SUCCEEDED' }),
        listProposals: vi.fn().mockReturnValueOnce(listPromise1).mockResolvedValue([newProposal]),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // 手动刷新（第二次加载）
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.proposals[0].id).toBe('prop-NEW');

    // 旧响应后返回，应被忽略
    await act(async () => {
      resolveList1([mockProposal]);
    });
    expect(result.current.proposals[0].id).toBe('prop-NEW');
  });

  // ── unmount 清理 ──────────────────────────────────────────────

  it('unmount 后 pending poll 返回不 setState、不安排 timer', async () => {
    let resolvePoll!: (value: unknown) => void;
    const pollPromise = new Promise((resolve) => {
      resolvePoll = resolve;
    });
    const getMock = vi.fn().mockReturnValue(pollPromise);
    setupDesktop(createMockAPI({ get: getMock }));
    const { result, unmount } = renderHook(() =>
      useContractDraft('proj-00000001', 'sess-00000001', 2),
    );

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getMock).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      resolvePoll({ ...mockTask, status: 'SUCCEEDED' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  // ── hidden / visible ──────────────────────────────────────────

  it('hidden 取消下一次 timer，visible 立即 poll', async () => {
    let pollCount = 0;
    const getMock = vi.fn().mockImplementation(() => {
      pollCount++;
      return { ...mockTask, status: 'RUNNING' };
    });
    setupDesktop(createMockAPI({ get: getMock }));
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pollCount).toBe(1);

    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(pollCount).toBe(1);

    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pollCount).toBe(2);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('hidden 时 requestDraft 不启动 tasks.get', async () => {
    const getMock = vi.fn().mockResolvedValue({ ...mockTask, status: 'RUNNING' });
    setupDesktop(createMockAPI({ get: getMock }));

    // 在 mount 前设置 hidden，使 previousHiddenRef 初始化为 true
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });

    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();

    await act(async () => {
      await result.current.requestDraft();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(getMock).toHaveBeenCalledTimes(0);

    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  // ── 安全错误 ──────────────────────────────────────────────────

  it('原始错误路径不泄露', async () => {
    setupDesktop(
      createMockAPI({
        requestDraft: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('/Users/secret/path.sql'), { code: 'UNKNOWN_CODE' }),
          ),
      }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });

    expect(result.current.error).not.toContain('/Users/');
    expect(result.current.error).not.toContain('sql');
  });

  // ── 派生选择器边界 ────────────────────────────────────────────

  it('请求不传 providerProfileId / model / apiKey / now / newVersionId', async () => {
    const api = setupDesktop(createMockAPI());
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    await act(async () => {
      await result.current.requestDraft();
    });

    const payload = api.contract.requestDraft.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('providerProfileId');
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('apiKey');
    expect(payload).not.toHaveProperty('now');
    expect(payload).not.toHaveProperty('newVersionId');
  });

  it('接受 payload 不传 providerProfileId / now / newVersionId / lockEventId', async () => {
    const api = setupDesktop(
      createMockAPI({ listProposals: vi.fn().mockResolvedValue([mockProposal]) }),
    );
    const { result } = renderHook(() => useContractDraft('proj-00000001', 'sess-00000001', 2));

    await flushAsync();
    await act(async () => {
      await result.current.acceptProposal('prop-00000001');
    });

    const payload = api.contract.acceptProposal.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('providerProfileId');
    expect(payload).not.toHaveProperty('now');
    expect(payload).not.toHaveProperty('newVersionId');
    expect(payload).not.toHaveProperty('lockEventId');
  });
});
