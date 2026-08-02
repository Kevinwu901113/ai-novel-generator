/**
 * 稿件 Main IPC 处理器测试（MV1-B）。
 *
 * 通过注入 fake ipc / fake forward 验证：
 * - 14 个 handler 以正确 channel 注册；
 * - channel → worker command 映射准确；
 * - 输入 validator 调用（无效输入拒绝且不转发）；
 * - forwardToWorker 参数（requestId + command + payload）；
 * - 输出 validator（Worker 返回非法数据 → INTERNAL_ERROR）；
 * - safe error（Worker 冲突码透传）；
 * - Worker 不可用（WORKER_UNAVAILABLE 透传）；
 * - handler cleanup（removeHandler 移除全部，重复注册不泄漏）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@ai-novel/contracts';
import { registerManuscriptIpcHandlers, type ManuscriptIpcDeps } from './manuscript-ipc.js';

const ISO = '2026-08-03T00:00:00.000Z';
const HEX64 = 'a'.repeat(64);
const MS_ID = 'ms-1';
const CH_ID = 'ch-1';
const V_ID = 'ver-1';

const MANUSCRIPT_CHANNELS = Object.keys(IPC_CHANNELS).filter((k) =>
  k.startsWith('MANUSCRIPT_'),
) as ReadonlyArray<keyof typeof IPC_CHANNELS>;

// ── 合法 fixture ───────────────────────────────────────────────────

const validManuscript = {
  id: MS_ID,
  projectId: 'p1',
  title: '未命名稿件',
  status: 'active',
  creationContractVersionId: null,
  createdAt: ISO,
  updatedAt: ISO,
};

const validVersion = {
  id: V_ID,
  projectId: 'p1',
  chapterId: CH_ID,
  versionNumber: 1,
  title: '标题',
  content: '正文',
  contentHash: HEX64,
  parentVersionId: null,
  sourceType: 'USER',
  createdByTaskId: null,
  invocationId: null,
  creationContractVersionId: null,
  createdAt: ISO,
};

const validVersionSummary = {
  id: V_ID,
  chapterId: CH_ID,
  versionNumber: 1,
  title: '标题',
  sourceType: 'USER',
  createdAt: ISO,
  parentVersionId: null,
  creationContractVersionId: null,
  contentHash: HEX64,
};

const validChapterSummary = {
  id: CH_ID,
  projectId: 'p1',
  manuscriptId: MS_ID,
  position: 2048,
  currentVersionId: null,
  status: 'active',
  currentTitle: null,
  versionCount: 0,
  createdAt: ISO,
  updatedAt: ISO,
};

const validChapter = {
  id: CH_ID,
  projectId: 'p1',
  manuscriptId: MS_ID,
  position: 2048,
  currentVersionId: null,
  status: 'active',
  currentVersion: null,
  versionCount: 0,
  createdAt: ISO,
  updatedAt: ISO,
};

function validInputFor(channel: string): unknown {
  switch (channel) {
    case IPC_CHANNELS.MANUSCRIPT_GET_OR_CREATE:
      return { projectId: 'p1' };
    case IPC_CHANNELS.MANUSCRIPT_GET:
      return { projectId: 'p1', manuscriptId: MS_ID };
    case IPC_CHANNELS.MANUSCRIPT_LIST_CHAPTERS:
      return { projectId: 'p1', manuscriptId: MS_ID };
    case IPC_CHANNELS.MANUSCRIPT_GET_CHAPTER:
      return { projectId: 'p1', manuscriptId: MS_ID, chapterId: CH_ID };
    case IPC_CHANNELS.MANUSCRIPT_GET_CURRENT_CHAPTER_VERSION:
      return { projectId: 'p1', chapterId: CH_ID };
    case IPC_CHANNELS.MANUSCRIPT_LIST_CHAPTER_VERSIONS:
      return { projectId: 'p1', chapterId: CH_ID };
    case IPC_CHANNELS.MANUSCRIPT_GET_CHAPTER_VERSION:
      return { projectId: 'p1', chapterId: CH_ID, versionId: V_ID };
    case IPC_CHANNELS.MANUSCRIPT_CREATE_CHAPTER:
      return { projectId: 'p1', manuscriptId: MS_ID, insertBeforeChapterId: null };
    case IPC_CHANNELS.MANUSCRIPT_CREATE_CHAPTER_VERSION:
      return {
        projectId: 'p1',
        chapterId: CH_ID,
        title: '标题',
        content: '',
        expectedCurrentVersionId: null,
      };
    case IPC_CHANNELS.MANUSCRIPT_PROMOTE_CHAPTER_VERSION:
      return { projectId: 'p1', chapterId: CH_ID, versionId: V_ID, expectedCurrentVersionId: null };
    case IPC_CHANNELS.MANUSCRIPT_UPDATE_CHAPTER_ORDER:
      return {
        projectId: 'p1',
        manuscriptId: MS_ID,
        chapterId: CH_ID,
        insertBeforeChapterId: null,
      };
    case IPC_CHANNELS.MANUSCRIPT_ARCHIVE_CHAPTER:
      return { projectId: 'p1', chapterId: CH_ID, expectedCurrentVersionId: null };
    case IPC_CHANNELS.MANUSCRIPT_RESTORE_CHAPTER:
      return { projectId: 'p1', chapterId: CH_ID, expectedCurrentVersionId: null };
    case IPC_CHANNELS.MANUSCRIPT_UPDATE_TITLE:
      return { projectId: 'p1', manuscriptId: MS_ID, title: '新标题', expectedUpdatedAt: ISO };
    default:
      return null;
  }
}

function validOutputFor(channel: string): unknown {
  switch (channel) {
    case IPC_CHANNELS.MANUSCRIPT_GET_OR_CREATE:
    case IPC_CHANNELS.MANUSCRIPT_GET:
    case IPC_CHANNELS.MANUSCRIPT_UPDATE_TITLE:
      return validManuscript;
    case IPC_CHANNELS.MANUSCRIPT_LIST_CHAPTERS:
    case IPC_CHANNELS.MANUSCRIPT_UPDATE_CHAPTER_ORDER:
      return [validChapterSummary];
    case IPC_CHANNELS.MANUSCRIPT_GET_CHAPTER:
    case IPC_CHANNELS.MANUSCRIPT_CREATE_CHAPTER:
    case IPC_CHANNELS.MANUSCRIPT_ARCHIVE_CHAPTER:
    case IPC_CHANNELS.MANUSCRIPT_RESTORE_CHAPTER:
      return validChapter;
    case IPC_CHANNELS.MANUSCRIPT_GET_CURRENT_CHAPTER_VERSION:
    case IPC_CHANNELS.MANUSCRIPT_GET_CHAPTER_VERSION:
    case IPC_CHANNELS.MANUSCRIPT_CREATE_CHAPTER_VERSION:
    case IPC_CHANNELS.MANUSCRIPT_PROMOTE_CHAPTER_VERSION:
      return validVersion;
    case IPC_CHANNELS.MANUSCRIPT_LIST_CHAPTER_VERSIONS:
      return [validVersionSummary];
    default:
      return null;
  }
}

// ── harness ────────────────────────────────────────────────────────

function createFakeIpc() {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  return {
    handlers,
    handle: vi.fn(
      (channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>) => {
        handlers.set(channel, listener);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
}

function makeDeps(forward: ManuscriptIpcDeps['forwardToWorker']) {
  const ipc = createFakeIpc();
  const deps: ManuscriptIpcDeps = { ipc, forwardToWorker: forward };
  return { ipc, deps };
}

describe('registerManuscriptIpcHandlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('注册 14 个 handler 且 channel 完整', () => {
    const { ipc, deps } = makeDeps(vi.fn().mockResolvedValue(validManuscript));
    registerManuscriptIpcHandlers(deps);
    expect(ipc.handle).toHaveBeenCalledTimes(14);
    expect(ipc.handlers.size).toBe(14);
    for (const key of MANUSCRIPT_CHANNELS) {
      expect(ipc.handlers.has(IPC_CHANNELS[key])).toBe(true);
    }
  });

  it.each(MANUSCRIPT_CHANNELS)('channel 映射正确命令并转发 payload：%s', async (key) => {
    const channel = IPC_CHANNELS[key];
    const forward = vi.fn().mockResolvedValue(validOutputFor(channel));
    const { ipc, deps } = makeDeps(forward);
    registerManuscriptIpcHandlers(deps);
    const input = validInputFor(channel);
    const result = await ipc.handlers.get(channel)!(undefined, input);
    expect(forward).toHaveBeenCalledTimes(1);
    const call = forward.mock.calls[0][0] as {
      requestId: string;
      command: string;
      payload: unknown;
    };
    expect(typeof call.requestId).toBe('string');
    expect(call.requestId.length).toBeGreaterThan(0);
    expect(call.command).toMatch(/^manuscript\./);
    expect(call.payload).toEqual(input);
    expect(result).toEqual(validOutputFor(channel));
  });

  it('输入 validator：无效输入拒绝且不转发', async () => {
    const forward = vi.fn();
    const { ipc, deps } = makeDeps(forward);
    registerManuscriptIpcHandlers(deps);
    // createChapterVersion 拒绝注入字段 sourceType
    await expect(
      ipc.handlers.get(IPC_CHANNELS.MANUSCRIPT_CREATE_CHAPTER_VERSION)!(undefined, {
        projectId: 'p1',
        chapterId: CH_ID,
        title: '标题',
        content: '',
        expectedCurrentVersionId: null,
        sourceType: 'USER',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(forward).not.toHaveBeenCalled();
  });

  it('输出 validator：Worker 返回非法数据 → INTERNAL_ERROR', async () => {
    const forward = vi.fn().mockResolvedValue({ id: 'broken' });
    const { ipc, deps } = makeDeps(forward);
    registerManuscriptIpcHandlers(deps);
    await expect(
      ipc.handlers.get(IPC_CHANNELS.MANUSCRIPT_GET_OR_CREATE)!(undefined, { projectId: 'p1' }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('safe error：Worker 冲突码透传', async () => {
    const forward = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('冲突'), { code: 'MANUSCRIPT_VERSION_CONFLICT' }));
    const { ipc, deps } = makeDeps(forward);
    registerManuscriptIpcHandlers(deps);
    await expect(
      ipc.handlers.get(IPC_CHANNELS.MANUSCRIPT_CREATE_CHAPTER_VERSION)!(undefined, {
        projectId: 'p1',
        chapterId: CH_ID,
        title: '标题',
        content: '',
        expectedCurrentVersionId: null,
      }),
    ).rejects.toMatchObject({ code: 'MANUSCRIPT_VERSION_CONFLICT' });
  });

  it('Worker 不可用：WORKER_UNAVAILABLE 透传', async () => {
    const forward = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('数据服务不可用'), { code: 'WORKER_UNAVAILABLE' }),
      );
    const { ipc, deps } = makeDeps(forward);
    registerManuscriptIpcHandlers(deps);
    await expect(
      ipc.handlers.get(IPC_CHANNELS.MANUSCRIPT_GET_OR_CREATE)!(undefined, { projectId: 'p1' }),
    ).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
  });

  it('cleanup 移除全部 handler，重复注册不泄漏', () => {
    const { ipc, deps } = makeDeps(vi.fn().mockResolvedValue(validManuscript));
    const cleanup = registerManuscriptIpcHandlers(deps);
    expect(ipc.handlers.size).toBe(14);
    cleanup();
    expect(ipc.removeHandler).toHaveBeenCalledTimes(14);
    expect(ipc.handlers.size).toBe(0);
    // 再次注册不抛错（cleanup 已移除旧 handler）
    expect(() => registerManuscriptIpcHandlers(deps)).not.toThrow();
    expect(ipc.handle).toHaveBeenCalledTimes(28);
  });
});
