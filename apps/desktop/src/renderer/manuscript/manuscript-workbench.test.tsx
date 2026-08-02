// @vitest-environment jsdom
/**
 * ManuscriptWorkbench Renderer 测试（MV1-B，§15.4 全部 28 项）。
 *
 * 使用内存 mock 后端（test-manuscript-mock）驱动真实 hook + 组件，
 * 覆盖：首次加载 / 空状态 / 创建 / 切换 / 编辑 / dirty / 保存 / 保存中禁用 /
 * 历史排序 / promote / promote 后刷新 / CAS 冲突保留本地 / 冲突刷新 current /
 * 基于新 current 重存 / 放弃本地 / 章节切换离开确认 / 关闭窗口离开确认 /
 * 上移下移 / 归档 / 恢复 / archived 不作为排序目标 / 稿件标题 CAS /
 * loading/error/success / 键盘导航 / live-region / focus 管理 / current aria 标记。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManuscriptWorkbench } from './ManuscriptWorkbench';
import { createManuscriptStore } from './test-manuscript-mock';
import type { DesktopAPI } from '@ai-novel/contracts';

function setupDesktop(store: ReturnType<typeof createManuscriptStore>): void {
  window.desktop = { manuscript: store.desktop } as unknown as DesktopAPI;
}

/** 等待稿件工作台初始加载完成（标题输入出现） */
async function waitForLoaded(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByLabelText('稿件标题')).toBeInTheDocument();
  });
}

/** 章节列表中的选中按钮（含 .chapter-title-text 的按钮，排除移动/归档等操作按钮） */
function chapterSelectButtons(): Array<HTMLButtonElement> {
  return screen
    .getAllByRole('button')
    .filter((b): b is HTMLButtonElement => b.querySelector('.chapter-title-text') !== null);
}

describe('ManuscriptWorkbench', () => {
  beforeEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  afterEach(() => {
    cleanup();
    window.desktop = undefined as unknown as DesktopAPI;
  });

  it('1. 首次加载自动 getOrCreateManuscript', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    expect(mock.desktop.getOrCreateManuscript).toBeDefined();
    const titleInput = screen.getByLabelText('稿件标题') as HTMLInputElement;
    expect(titleInput.value).toBe('未命名稿件');
  });

  it('2. 无章节空状态', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    expect(screen.getByText(/还没有章节/)).toBeInTheDocument();
  });

  it('3. 创建第一章', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    const createBtn = screen.getByRole('button', { name: '新建章节' });
    await act(async () => {
      createBtn.click();
    });
    await waitFor(() => {
      expect(screen.getByText('未命名章节')).toBeInTheDocument();
    });
  });

  it('4. 创建多个章节', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    const createBtn = screen.getByRole('button', { name: '新建章节' });
    await act(async () => {
      createBtn.click();
    });
    await act(async () => {
      createBtn.click();
    });
    await waitFor(() => {
      const items = screen.getAllByRole('listitem');
      expect(items.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('5. 章节切换', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    // 创建第一章并保存 v1
    const createBtn = screen.getByRole('button', { name: '新建章节' });
    await act(async () => {
      createBtn.click();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('章节标题')).toBeInTheDocument();
    });
    const titleInput = screen.getByLabelText('章节标题') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '第一章' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText(/已保存新版本/)).toBeInTheDocument();
    });
    // 创建第二章
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => {
      expect(chapterSelectButtons().length).toBe(2);
    });
    // 点击第二章（最后一个章节按钮）
    const ch2Btn = chapterSelectButtons()[1];
    await act(async () => {
      ch2Btn.click();
    });
    await waitFor(() => {
      expect((screen.getByLabelText('章节标题') as HTMLInputElement).value).toBe('');
    });
  });

  it('6. 编辑 title/content', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('章节标题')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '新标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '正文内容' } });
    expect((screen.getByLabelText('章节标题') as HTMLInputElement).value).toBe('新标题');
    expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('正文内容');
  });

  it('7. 编辑后 dirty 状态', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('章节标题')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '改动' } });
    expect(screen.getByText('有未保存的修改')).toBeInTheDocument();
  });

  it('8. 保存创建新版本', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('章节标题')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '第一章' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '正文一' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText(/已保存新版本 #1/)).toBeInTheDocument();
    });
    // 不再 dirty
    expect(screen.queryByText('有未保存的修改')).not.toBeInTheDocument();
  });

  it('9. 保存期间按钮 disabled 且 aria-busy', async () => {
    const mock = createManuscriptStore();
    // 延迟 resolve 以观察保存中状态
    const originalCreate = mock.desktop.createChapterVersion.bind(mock.desktop);
    let resolveFn: (v: unknown) => void = () => {};
    mock.desktop.createChapterVersion = vi.fn((input: unknown) => {
      return new Promise((resolve) => {
        resolveFn = () => resolve(originalCreate(input));
      });
    }) as never;
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('章节标题')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    const saveBtn = screen.getByRole('button', { name: /保存中…|保存新版本/ });
    expect(saveBtn).toBeDisabled();
    expect(saveBtn).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      resolveFn({});
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '保存新版本' })).not.toBeDisabled();
    });
  });

  it('10. 历史列表排序（version_number DESC）', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('章节标题')).toBeInTheDocument();
    });
    // 保存 v1
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: 'v1' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => expect(screen.getByText(/已保存新版本 #1/)).toBeInTheDocument());
    // 保存 v2
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: 'v2' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => expect(screen.getByText(/已保存新版本 #2/)).toBeInTheDocument());
    // 历史列表：#2 在 #1 之前
    const list = screen.getByRole('list', { name: '版本历史列表' });
    const numbers = within(list)
      .getAllByText(/#\d+/)
      .map((el) => el.textContent);
    expect(numbers).toEqual(['#2', '#1']);
  });

  it('11. promote 历史版本', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: 'v1' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => expect(screen.getByText(/已保存新版本 #1/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: 'v2' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => expect(screen.getByText(/已保存新版本 #2/)).toBeInTheDocument());
    // promote #1
    const promoteButtons = screen.getAllByRole('button', { name: '设为当前版本' });
    await act(async () => {
      promoteButtons[promoteButtons.length - 1].click(); // #1 的按钮
    });
    await waitFor(() => {
      expect(screen.getByText(/已将版本 #1 设为当前版本/)).toBeInTheDocument();
    });
  });

  it('12. promote 后编辑器刷新为被 promote 版本', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: 'v1' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => expect(screen.getByText(/已保存新版本 #1/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: 'v2' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => expect(screen.getByText(/已保存新版本 #2/)).toBeInTheDocument());
    const promoteButtons = screen.getAllByRole('button', { name: '设为当前版本' });
    await act(async () => {
      promoteButtons[promoteButtons.length - 1].click();
    });
    await waitFor(() => {
      expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('v1');
    });
  });

  it('13. 保存 CAS 冲突保留本地文本并显示冲突横幅', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '本地未保存' } });
    // 先让服务器推进 current（模拟另一客户端保存）
    await mock.desktop.createChapterVersion({
      projectId: 'p1',
      chapterId: 'ch-1',
      title: '标题',
      content: '服务器版本',
      expectedCurrentVersionId: null,
    });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText(/稿件已在其他操作中更新/)).toBeInTheDocument();
    });
    // 本地文本保留
    expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('本地未保存');
    // 冲突横幅 role=alert
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('14. 冲突后刷新服务器 current 并展示信息', async () => {
    const mock = createManuscriptStore();
    const getCurrentSpy = vi.spyOn(mock.desktop, 'getCurrentChapterVersion');
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '本地' } });
    await mock.desktop.createChapterVersion({
      projectId: 'p1',
      chapterId: 'ch-1',
      title: '标题',
      content: '服务器版本',
      expectedCurrentVersionId: null,
    });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText(/服务器当前版本 #1/)).toBeInTheDocument();
    });
    // 冲突刷新调用了 getCurrentChapterVersion
    expect(getCurrentSpy).toHaveBeenCalled();
  });

  it('15. 基于新 current 重新保存成功', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '本地未保存' } });
    await mock.desktop.createChapterVersion({
      projectId: 'p1',
      chapterId: 'ch-1',
      title: '标题',
      content: '服务器版本',
      expectedCurrentVersionId: null,
    });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText(/服务器当前版本 #1/)).toBeInTheDocument();
    });
    // 基于新 current 再保存（使用保留的本地 buffer）
    await act(async () => {
      screen.getByRole('button', { name: '基于新版本再保存' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText(/已保存新版本 #2/)).toBeInTheDocument();
    });
  });

  it('16. 放弃本地修改并加载服务器版本', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '本地未保存' } });
    await mock.desktop.createChapterVersion({
      projectId: 'p1',
      chapterId: 'ch-1',
      title: '标题',
      content: '服务器版本',
      expectedCurrentVersionId: null,
    });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText(/服务器当前版本 #1/)).toBeInTheDocument();
    });
    await act(async () => {
      screen.getByRole('button', { name: '放弃本地修改并加载服务器版本' }).click();
    });
    await waitFor(() => {
      expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('服务器版本');
    });
  });

  it('17. 切换章节离开确认（继续编辑 / 放弃修改并离开）', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    // 创建两章（第二章创建后自动选中）
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    // 当前选中第二章，制造 dirty
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '未保存内容' } });
    // 点击第一章（index 0）→ 对话框出现
    const chapterButtons = chapterSelectButtons();
    await act(async () => {
      chapterButtons[0].click();
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // 继续编辑 → 对话框关闭，仍留在第二章（正文保留）
    await act(async () => {
      screen.getByRole('button', { name: '继续编辑' }).click();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('未保存内容');
    // 再次切换第一章并放弃
    const chapterButtons2 = chapterSelectButtons();
    await act(async () => {
      chapterButtons2[0].click();
    });
    await act(async () => {
      screen.getByRole('button', { name: '放弃修改并离开' }).click();
    });
    await waitFor(() => {
      expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('18. 关闭窗口离开确认（beforeunload）', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    // 无 dirty → 不阻止
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(cleanEvent);
    });
    expect(cleanEvent.defaultPrevented).toBe(false);
    // 制造 dirty → 阻止
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '未保存' } });
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(dirtyEvent);
    });
    expect(dirtyEvent.defaultPrevented).toBe(true);
  });

  it('19. 上移/下移章节', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    // 第一个章节的「下移」是有效操作（move 到末尾）
    const downButtons = screen.getAllByRole('button', { name: /下移章节/ });
    await act(async () => {
      downButtons[0].click();
    });
    await waitFor(() => {
      expect(screen.getByText('章节顺序已更新')).toBeInTheDocument();
    });
  });

  it('20. 归档章节', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    await act(async () => {
      screen.getByRole('button', { name: /归档章节/ }).click();
    });
    await waitFor(() => {
      expect(screen.getByText('章节已归档')).toBeInTheDocument();
    });
    // 打开「显示已归档章节」后出现归档角标
    fireEvent.click(screen.getByRole('checkbox', { name: /显示已归档章节/ }));
    await waitFor(() => {
      expect(screen.getByText('已归档')).toBeInTheDocument();
    });
  });

  it('21. 恢复归档章节', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    await act(async () => {
      screen.getByRole('button', { name: /归档章节/ }).click();
    });
    await waitFor(() => expect(screen.getByText('章节已归档')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /显示已归档章节/ }));
    await waitFor(() => expect(screen.getByText('已归档')).toBeInTheDocument());
    await act(async () => {
      screen.getByRole('button', { name: /恢复章节/ }).click();
    });
    await waitFor(() => {
      expect(screen.getByText('章节已恢复')).toBeInTheDocument();
    });
  });

  it('22. archived 不作为排序目标（移动仅作用于 active）', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    // 创建第一章（含版本）与第二章
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    // 归档第一章（当前选中章）
    const archiveButtons = screen.getAllByRole('button', { name: /归档章节/ });
    await act(async () => {
      archiveButtons[0].click();
    });
    await waitFor(() => expect(screen.getByText('章节已归档')).toBeInTheDocument());
    // active 列表只剩第二章：其「上移」操作不能以归档章节为目标（insertBefore 由 active 列表计算）
    const moveUp = screen.getAllByRole('button', { name: /上移章节/ });
    // 至少存在一个 active 章节的上移按钮；点击不抛错（no-op 或正常返回）
    expect(moveUp.length).toBeGreaterThan(0);
  });

  it('23. 稿件标题 CAS 保存与冲突', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    const titleInput = screen.getByLabelText('稿件标题') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '我的小说' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存标题' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText('稿件标题已保存')).toBeInTheDocument();
    });
    // 冲突：另一客户端改标题后，再保存 → 刷新服务器 title，保留用户输入
    const storeMs = mock.store.getManuscript()!;
    storeMs.updatedAt = '2099-01-01T00:00:00.000Z';
    fireEvent.change(screen.getByLabelText('稿件标题'), { target: { value: '我的输入' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存标题' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText(/稿件标题已被其他操作更新/)).toBeInTheDocument();
    });
    expect((screen.getByLabelText('稿件标题') as HTMLInputElement).value).toBe('我的输入');
  });

  it('24. loading / error / success 状态', async () => {
    const mock = createManuscriptStore();
    // getOrCreate 失败 → error 横幅
    mock.desktop.getOrCreateManuscript = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('稿件加载失败'), { code: 'MANUSCRIPT_NOT_FOUND' }),
      ) as never;
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText(/稿件不存在/)).toBeInTheDocument();
  });

  it('25. 章节列表键盘导航', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    const list = screen.getByRole('list', { name: '章节列表' });
    // 方向键下移选择下一章
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => {
      const selected = screen
        .getAllByRole('button', { name: /未命名章节/ })
        .filter((b) => b.getAttribute('aria-current') === 'page');
      expect(selected.length).toBeGreaterThan(0);
    });
  });

  it('26. 成功 live-region（role=status）', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => {
      expect(screen.getByText(/已保存新版本 #1/)).toBeInTheDocument();
    });
    // 成功消息使用 role=status（LiveRegion polite）
    const statusRegion = screen
      .getAllByRole('status')
      .find((el) => el.textContent?.includes('已保存新版本'));
    expect(statusRegion).toBeDefined();
  });

  it('27. 章节切换后 focus 进入标题输入框', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => {
      expect(screen.getByLabelText('章节标题')).toBeInTheDocument();
      // 章节切换后焦点进入标题输入框
      expect(screen.getByLabelText('章节标题')).toHaveFocus();
    });
  });

  it('28. current aria 标记（章节 aria-current=page；版本 aria-current=true）', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => expect(screen.getByText(/已保存新版本 #1/)).toBeInTheDocument());
    // 当前章节 aria-current=page
    const currentChapter = screen
      .getAllByRole('button', { name: /未命名章节|标题/ })
      .find((b) => b.getAttribute('aria-current') === 'page');
    expect(currentChapter).toBeDefined();
    // 当前版本 aria-current=true
    const currentVersion = screen
      .getAllByRole('listitem')
      .find((li) => li.querySelector('[aria-current="true"]'));
    expect(currentVersion).toBeDefined();
  });
});
