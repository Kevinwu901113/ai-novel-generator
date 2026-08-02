/**
 * 稿件 preload contextBridge 测试（MV1-B）。
 *
 * 通过 mock electron 验证：
 * - window.desktop.manuscript.* 完整暴露 14 个 API 方法；
 * - 每个方法调用对应 allowlisted channel（无通用 invoke 能力）；
 * - 输入对象不被修改（原样透传）；
 * - 没有任意 channel 调用入口 / 没有 ipcRenderer 泄露；
 * - 没有 Node、filesystem 或 SQLite 对象泄露。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExpose, mockInvoke } = vi.hoisted(() => ({
  mockExpose: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mockExpose },
  ipcRenderer: { invoke: mockInvoke },
}));

// 类型导入在编译期被擦除；运行时仅依赖 mock electron
import './index.js';

interface ExposedDesktop {
  manuscript: Record<string, (...args: unknown[]) => Promise<unknown>>;
}

const METHOD_TO_CHANNEL: Readonly<Record<string, string>> = {
  getOrCreateManuscript: 'ipc:manuscript-get-or-create',
  getManuscript: 'ipc:manuscript-get',
  listChapters: 'ipc:manuscript-list-chapters',
  getChapter: 'ipc:manuscript-get-chapter',
  getCurrentChapterVersion: 'ipc:manuscript-get-current-chapter-version',
  listChapterVersions: 'ipc:manuscript-list-chapter-versions',
  getChapterVersion: 'ipc:manuscript-get-chapter-version',
  createChapter: 'ipc:manuscript-create-chapter',
  createChapterVersion: 'ipc:manuscript-create-chapter-version',
  promoteChapterVersion: 'ipc:manuscript-promote-chapter-version',
  updateChapterOrder: 'ipc:manuscript-update-chapter-order',
  archiveChapter: 'ipc:manuscript-archive-chapter',
  restoreChapter: 'ipc:manuscript-restore-chapter',
  updateManuscriptTitle: 'ipc:manuscript-update-title',
};

let exposedCache: ExposedDesktop | null = null;
function exposedDesktop(): ExposedDesktop {
  if (exposedCache) return exposedCache;
  const calls = mockExpose.mock.calls as Array<[string, ExposedDesktop]>;
  exposedCache = calls[0][1];
  return exposedCache;
}

describe('manuscript preload API', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it('暴露 14 个 manuscript API 方法', () => {
    const desktop = exposedDesktop();
    expect(desktop.manuscript).toBeDefined();
    const methodNames = Object.keys(desktop.manuscript);
    expect(methodNames.sort()).toEqual(Object.keys(METHOD_TO_CHANNEL).sort());
    expect(methodNames).toHaveLength(14);
  });

  it.each(Object.keys(METHOD_TO_CHANNEL))(
    '方法 %s 调用对应 allowlisted channel',
    async (method) => {
      const desktop = exposedDesktop();
      const input = { projectId: 'p1' };
      mockInvoke.mockResolvedValueOnce({ ok: true });
      const result = await desktop.manuscript[method](input);
      expect(result).toEqual({ ok: true });
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0][0]).toBe(METHOD_TO_CHANNEL[method]);
      expect(mockInvoke.mock.calls[0][1]).toBe(input);
    },
  );

  it('输入对象不被修改（原样透传）', async () => {
    const desktop = exposedDesktop();
    const input = Object.freeze({ projectId: 'p1', title: '标题', content: '正文' });
    mockInvoke.mockResolvedValueOnce(null);
    await desktop.manuscript.createChapterVersion(input);
    expect(Object.is(mockInvoke.mock.calls[0][1], input)).toBe(true);
  });

  it('没有任意 channel 调用入口（无通用 invoke）', () => {
    const desktop = exposedDesktop();
    // manuscript 组没有 invoke / send / on 等通用入口
    for (const key of ['invoke', 'send', 'on', 'handle']) {
      expect(key in desktop.manuscript).toBe(false);
    }
    // 顶层也不应暴露 ipcRenderer 或通用通道函数
    expect('ipcRenderer' in desktop).toBe(false);
    expect('invoke' in desktop).toBe(false);
  });

  it('没有 Node / filesystem / SQLite 对象泄露', () => {
    const desktop = exposedDesktop() as unknown as Record<string, unknown>;
    for (const key of [
      'process',
      'require',
      'module',
      'Buffer',
      '__dirname',
      'fs',
      'sqlite',
      'path',
    ]) {
      expect(key in desktop).toBe(false);
    }
    // 所有暴露值都必须是函数（方法）或分组对象，不含原始 Node API
    const values = Object.values(desktop);
    for (const value of values) {
      expect(typeof value === 'function' || (typeof value === 'object' && value !== null)).toBe(
        true,
      );
    }
  });
});
