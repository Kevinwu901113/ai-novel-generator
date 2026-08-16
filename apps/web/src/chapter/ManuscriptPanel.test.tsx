// @vitest-environment jsdom
/**
 * 稿件工作区组件测试（GE-7）：章节列表 → 编辑 → 保存（CAS 基线随请求发出）→
 * 冲突时保留用户输入并给出出路 → 导出反馈。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ChapterDraftDto,
  DesktopAPI,
  ManuscriptChapterDetailDto,
  ManuscriptWorkspaceDto,
} from '@ai-novel/contracts';
import { ManuscriptPanel } from './ManuscriptPanel';
import { downloadTextFile } from './download-file';

// jsdom 没有 URL.createObjectURL，真实下载行为无法在测试环境执行；mock 后断言调用契约
vi.mock('./download-file', () => ({ downloadTextFile: vi.fn() }));

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

function draftDto(overrides: Partial<ChapterDraftDto> = {}): ChapterDraftDto {
  return {
    chapterId: 'ch-1',
    title: '草稿标题',
    content: '草稿正文',
    baseVersionId: 'ver-1',
    currentVersionId: 'ver-1',
    stale: false,
    updatedAt: '2026-08-13T00:05:00.000Z',
    ...overrides,
  };
}

function setupDesktop(overrides: Record<string, unknown> = {}) {
  const manuscript = {
    getWorkspace: vi.fn().mockResolvedValue(workspace()),
    getChapter: vi.fn().mockResolvedValue(detail()),
    saveChapter: vi.fn().mockResolvedValue(detail({ versionNumber: 2, versionCount: 2 })),
    saveDraft: vi.fn().mockResolvedValue(undefined),
    getDraft: vi.fn().mockResolvedValue(null),
    discardDraft: vi.fn().mockResolvedValue(true),
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
      fileName: '位面客栈.txt',
      content: '第一章 远客\n\n正文内容',
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
  vi.useRealTimers();
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

  it('导出成功 → 触发浏览器下载并告知文件名；导出失败给出错误', async () => {
    const api = setupDesktop();
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '导出 TXT' })).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '导出 TXT' }));
    await waitFor(() => {
      expect(screen.getByText(/已导出 1 章（位面客栈.txt）/)).toBeTruthy();
    });
    expect(api.exportManuscript).toHaveBeenCalledWith({ projectId: PROJECT_ID, format: 'txt' });
    // B12：落盘从原生对话框改为浏览器下载——内容必须真的交给下载助手
    expect(downloadTextFile).toHaveBeenCalledWith('位面客栈.txt', '第一章 远客\n\n正文内容', 'txt');

    api.exportManuscript.mockRejectedValueOnce(new Error('导出渲染失败'));
    await user.click(screen.getByRole('button', { name: '导出 Markdown' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
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

  it('自动保存：连续输入只在停止 2000ms 后发一次 saveDraft', async () => {
    vi.useFakeTimers();
    try {
      const api = setupDesktop();
      await act(async () => {
        render(<ManuscriptPanel projectId={PROJECT_ID} />);
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '编辑' }));
        await vi.advanceTimersByTimeAsync(0);
      });

      const textarea = screen.getByLabelText('正文') as HTMLTextAreaElement;
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '雨砸在屋檐上。1' } });
        fireEvent.change(textarea, { target: { value: '雨砸在屋檐上。12' } });
        fireEvent.change(textarea, { target: { value: '雨砸在屋檐上。123' } });
        await vi.advanceTimersByTimeAsync(1999);
      });

      expect(api.saveDraft).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(api.saveDraft).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('显式保存进行中（saving=true）不触发自动保存', async () => {
    vi.useFakeTimers();
    try {
      let resolveSave: ((value: ManuscriptChapterDetailDto) => void) | null = null;
      const api = setupDesktop({
        saveChapter: vi.fn().mockImplementation(
          () =>
            new Promise<ManuscriptChapterDetailDto>((resolve) => {
              resolveSave = resolve;
            }),
        ),
      });
      await act(async () => {
        render(<ManuscriptPanel projectId={PROJECT_ID} />);
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '编辑' }));
        await vi.advanceTimersByTimeAsync(0);
      });

      const textarea = screen.getByLabelText('正文') as HTMLTextAreaElement;
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '雨砸在屋檐上。手动保存' } });
        await vi.advanceTimersByTimeAsync(1999);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '保存为新版本' }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole('button', { name: '保存中…' })).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(api.saveDraft).not.toHaveBeenCalled();

      await act(async () => {
        resolveSave?.(detail({ versionNumber: 2, versionCount: 2 }));
        await vi.advanceTimersByTimeAsync(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('切换章节会取消挂起的自动保存', async () => {
    vi.useFakeTimers();
    try {
      const api = setupDesktop({
        getWorkspace: vi.fn().mockResolvedValue(
          workspace({
            chapters: [
              {
                chapterId: 'ch-1',
                title: '第一章 远客',
                position: 1000,
                currentVersionId: 'ver-1',
                wordCount: 12,
                blueprintChapterId: 'bp-ch-1',
              },
              {
                chapterId: 'ch-2',
                title: '第二章 来客',
                position: 2000,
                currentVersionId: 'ver-2',
                wordCount: 12,
                blueprintChapterId: 'bp-ch-2',
              },
            ],
          }),
        ),
        getChapter: vi.fn().mockImplementation(({ chapterId }: { chapterId: string }) =>
          Promise.resolve(
            detail({
              chapterId,
              title: chapterId === 'ch-1' ? '第一章 远客' : '第二章 来客',
            }),
          ),
        ),
      });
      await act(async () => {
        render(<ManuscriptPanel projectId={PROJECT_ID} />);
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
        await vi.advanceTimersByTimeAsync(0);
      });

      const textarea = screen.getByLabelText('正文') as HTMLTextAreaElement;
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '雨砸在屋檐上。A 章修改' } });
        await vi.advanceTimersByTimeAsync(1000);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '编辑' }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByLabelText('正文')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(api.saveDraft).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('打开章节有草稿 → 显示横幅，但编辑器仍是权威正文', async () => {
    setupDesktop({
      getDraft: vi.fn().mockResolvedValue(draftDto({ content: '草稿正文' })),
    });
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '编辑' }));

    await waitFor(() => expect(screen.getByText(/有一份未保存的草稿/)).toBeTruthy());
    expect((screen.getByLabelText('正文') as HTMLTextAreaElement).value).toBe('雨砸在屋檐上。');
    expect((screen.getByLabelText('章节标题') as HTMLInputElement).value).toBe('第一章 远客');
  });

  it('stale 草稿 → 横幅额外说明正文已被更新', async () => {
    setupDesktop({
      getDraft: vi.fn().mockResolvedValue(
        draftDto({
          content: '草稿正文',
          stale: true,
          baseVersionId: 'ver-1',
          currentVersionId: 'ver-2',
        }),
      ),
    });
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '编辑' }));

    await waitFor(() =>
      expect(
        screen.getByText(/正文在此期间已被更新（AI 写入或版本恢复），这份草稿基于更早的版本。/),
      ).toBeTruthy(),
    );
  });

  it('点「恢复到草稿」后，编辑器才变成草稿内容', async () => {
    setupDesktop({
      getDraft: vi.fn().mockResolvedValue(draftDto({ content: '草稿正文' })),
    });
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await waitFor(() => expect(screen.getByText(/有一份未保存的草稿/)).toBeTruthy());

    expect((screen.getByLabelText('正文') as HTMLTextAreaElement).value).toBe('雨砸在屋檐上。');
    await user.click(screen.getByRole('button', { name: '恢复到草稿' }));

    await waitFor(() =>
      expect((screen.getByLabelText('正文') as HTMLTextAreaElement).value).toBe('草稿正文'),
    );
  });

  it('点「丢弃草稿」调用 discardDraft 并清横幅', async () => {
    const api = setupDesktop({
      getDraft: vi.fn().mockResolvedValue(draftDto({ content: '草稿正文' })),
    });
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await waitFor(() => expect(screen.getByText(/有一份未保存的草稿/)).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '丢弃草稿' }));

    await waitFor(() =>
      expect(api.discardDraft).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        chapterId: 'ch-1',
      }),
    );
    await waitFor(() => expect(screen.queryByText(/有一份未保存的草稿/)).toBeNull());
  });

  it('显式保存成功后，本地持久化草稿横幅消失', async () => {
    setupDesktop({
      getDraft: vi.fn().mockResolvedValue(draftDto({ content: '草稿正文' })),
    });
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await waitFor(() => expect(screen.getByText(/有一份未保存的草稿/)).toBeTruthy());

    await user.type(screen.getByLabelText('正文'), '新的正文');
    await user.click(screen.getByRole('button', { name: '保存为新版本' }));

    await waitFor(() => expect(screen.queryByText(/有一份未保存的草稿/)).toBeNull());
  });

  it('自动保存失败 → 显示失败提示，保留用户输入且不阻塞显式保存', async () => {
    vi.useFakeTimers();
    try {
      const api = setupDesktop({
        saveDraft: vi.fn().mockRejectedValue(new Error('disk full')),
      });
      await act(async () => {
        render(<ManuscriptPanel projectId={PROJECT_ID} />);
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '编辑' }));
        await vi.advanceTimersByTimeAsync(0);
      });

      const textarea = screen.getByLabelText('正文') as HTMLTextAreaElement;
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '雨砸在屋檐上。不能丢' } });
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(screen.getByText(/自动保存失败：disk full/)).toBeTruthy();
      expect((screen.getByLabelText('正文') as HTMLTextAreaElement).value).toBe(
        '雨砸在屋檐上。不能丢',
      );
      expect(screen.getByRole('button', { name: '保存为新版本' })).not.toBeDisabled();
      expect(api.saveChapter).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
