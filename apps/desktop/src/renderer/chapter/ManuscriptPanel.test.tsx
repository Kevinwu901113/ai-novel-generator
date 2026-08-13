// @vitest-environment jsdom
/**
 * 稿件工作区组件测试（GE-7）：章节列表 → 编辑 → 保存（CAS 基线随请求发出）→
 * 冲突时保留用户输入并给出出路 → 导出反馈。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  DesktopAPI,
  ManuscriptChapterDetailDto,
  ManuscriptWorkspaceDto,
} from '@ai-novel/contracts';
import { ManuscriptPanel } from './ManuscriptPanel';

const PROJECT_ID = 'proj-1';

function workspace(overrides: Partial<ManuscriptWorkspaceDto> = {}): ManuscriptWorkspaceDto {
  return {
    manuscriptId: 'ms-1',
    title: '位面客栈',
    chapters: [
      {
        chapterId: 'ch-1',
        title: '第一章 远客',
        position: 1000,
        currentVersionId: 'ver-1',
        wordCount: 12,
        blueprintChapterId: 'bp-ch-1',
      },
    ],
    ...overrides,
  };
}

function detail(overrides: Partial<ManuscriptChapterDetailDto> = {}): ManuscriptChapterDetailDto {
  return {
    chapterId: 'ch-1',
    title: '第一章 远客',
    content: '雨砸在屋檐上。',
    currentVersionId: 'ver-1',
    versionNumber: 1,
    versionCount: 1,
    ...overrides,
  };
}

function setupDesktop(overrides: Record<string, unknown> = {}) {
  const manuscript = {
    getWorkspace: vi.fn().mockResolvedValue(workspace()),
    getChapter: vi.fn().mockResolvedValue(detail()),
    saveChapter: vi.fn().mockResolvedValue(detail({ versionNumber: 2, versionCount: 2 })),
    listVersions: vi.fn().mockResolvedValue([
      {
        versionId: 'ver-2',
        versionNumber: 2,
        title: '第一章 远客',
        source: 'USER',
        createdAt: '2026-08-13T00:00:00.000Z',
        isCurrent: true,
      },
      {
        versionId: 'ver-1',
        versionNumber: 1,
        title: '第一章 远客',
        source: 'AI_GENERATION',
        createdAt: '2026-08-13T00:00:00.000Z',
        isCurrent: false,
      },
    ]),
    restoreVersion: vi.fn().mockResolvedValue(detail({ currentVersionId: 'ver-1' })),
    exportManuscript: vi.fn().mockResolvedValue({
      saved: true,
      fileName: '位面客栈.txt',
      filePath: '/tmp/位面客栈.txt',
      chapterCount: 1,
    }),
    ...overrides,
  };
  window.desktop = { manuscript } as unknown as DesktopAPI;
  return manuscript;
}

async function renderPanel() {
  const view = render(<ManuscriptPanel projectId={PROJECT_ID} />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ManuscriptPanel', () => {
  it('稿件为空 → 说明正文来自"生成并采用"，不给编辑器', async () => {
    setupDesktop({
      getWorkspace: vi.fn().mockResolvedValue({ manuscriptId: null, title: '', chapters: [] }),
    });
    await renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/在"生成"里写完一章并采用后/)).toBeTruthy();
    });
    expect(screen.queryByLabelText('正文')).toBeNull();
  });

  it('点开一章 → 加载正文并可编辑；保存回传 CAS 基线', async () => {
    const api = setupDesktop();
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '编辑' }));

    await waitFor(() => expect(screen.getByLabelText('正文')).toBeTruthy());
    // 未修改时保存按钮禁用（避免产生一个内容完全相同的新版本）
    expect(screen.getByRole('button', { name: '保存为新版本' })).toBeDisabled();

    await user.type(screen.getByLabelText('正文'), '补一句。');
    await user.click(screen.getByRole('button', { name: '保存为新版本' }));

    await waitFor(() => {
      expect(api.saveChapter).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          chapterId: 'ch-1',
          expectedCurrentVersionId: 'ver-1',
        }),
      );
    });
  });

  it('保存冲突 → 保留用户输入并给出"重新加载"出路', async () => {
    setupDesktop({
      saveChapter: vi.fn().mockRejectedValue(new Error('版本冲突')),
    });
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await waitFor(() => expect(screen.getByLabelText('正文')).toBeTruthy());

    await user.type(screen.getByLabelText('正文'), '我的修改');
    await user.click(screen.getByRole('button', { name: '保存为新版本' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // 用户输入没有被丢掉
    expect((screen.getByLabelText('正文') as HTMLTextAreaElement).value).toContain('我的修改');
    expect(screen.getByRole('button', { name: '放弃本地修改并重新加载' })).toBeTruthy();
  });

  it('导出成功 → 明确告知存到哪；取消导出不报错', async () => {
    const api = setupDesktop();
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '导出 TXT' })).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '导出 TXT' }));
    await waitFor(() => {
      expect(screen.getByText(/已导出 1 章到 \/tmp\/位面客栈.txt/)).toBeTruthy();
    });
    expect(api.exportManuscript).toHaveBeenCalledWith({ projectId: PROJECT_ID, format: 'txt' });

    api.exportManuscript.mockResolvedValueOnce({
      saved: false,
      fileName: '位面客栈.md',
      filePath: null,
      chapterCount: 1,
    });
    await user.click(screen.getByRole('button', { name: '导出 Markdown' }));
    await waitFor(() => expect(screen.getByText('已取消导出')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('版本历史：展开可见来源标注；恢复带 CAS 基线且说明不会删除任何版本', async () => {
    const api = setupDesktop();
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await waitFor(() => expect(screen.getByLabelText('正文')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: /查看版本历史/ }));
    await waitFor(() => expect(screen.getByText(/第 1 版 · AI 生成/)).toBeTruthy());
    expect(screen.getByText(/第 2 版 · 你写的 · 当前/)).toBeTruthy();
    expect(screen.getByText(/任何一版都不会被删除/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '恢复到这一版' }));
    await waitFor(() => {
      expect(api.restoreVersion).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        chapterId: 'ch-1',
        versionId: 'ver-1',
        expectedCurrentVersionId: 'ver-1',
      });
    });
  });
});
