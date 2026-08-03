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
import {
  useManuscriptWorkbench,
  type UseManuscriptWorkbenchResult,
} from './useManuscriptWorkbench';
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

/** hook 级测试 harness：把 useManuscriptWorkbench 结果暴露到全局 wb 引用 */
let wb: UseManuscriptWorkbenchResult | null = null;
function WorkbenchHarness() {
  const result = useManuscriptWorkbench('p1');
  wb = result;
  return null;
}

/**
 * 按给定顺序 A/X/B/C 播种章节（A active、X archived、B/C active），
 * 并给 active 章节保存版本以获得可区分标题（甲/乙/丙）。
 * position：A=1000、X=1500、B=2000、C=3000。
 */
async function seedOrderedChapters(
  mock: ReturnType<typeof createManuscriptStore>,
  order: Array<'A' | 'X' | 'B' | 'C'>,
): Promise<{ A: string; X: string; B: string; C: string }> {
  await mock.desktop.getOrCreateManuscript({ projectId: 'p1' });
  const created: string[] = [];
  for (let i = 0; i < order.length; i++) {
    const ch = await mock.desktop.createChapter({
      projectId: 'p1',
      manuscriptId: 'ms-1',
      insertBeforeChapterId: null,
    });
    created.push(ch.id);
  }
  const ids: { A: string; X: string; B: string; C: string } = { A: '', X: '', B: '', C: '' };
  const titles: Record<string, string> = { A: '甲', X: '戌', B: '乙', C: '丙' };
  order.forEach((name, i) => {
    const ch = mock.store.chapters[i];
    ch.position = (i + 1) * 1000 + (name === 'X' ? 500 : 0);
    ch.status = name === 'X' ? 'archived' : 'active';
    ids[name] = ch.id;
  });
  for (const name of order) {
    if (name === 'X') continue;
    const ch = mock.store.chapters.find((c) => c.id === ids[name])!;
    await mock.desktop.createChapterVersion({
      projectId: 'p1',
      chapterId: ch.id,
      title: titles[name],
      content: `正文${name}`,
      expectedCurrentVersionId: null,
    });
  }
  return ids;
}

/** DOM 中可见章节顺序（按显示标题反查 chapter id；标题由 currentVersion 派生） */
function visibleChapterIds(mock: ReturnType<typeof createManuscriptStore>): string[] {
  const titleToId = new Map<string, string>();
  for (const c of mock.store.chapters) {
    const v = mock.store.versions.find((x) => x.id === c.currentVersionId);
    const title = v?.title ?? '未命名章节';
    titleToId.set(title, c.id);
  }
  return chapterSelectButtons().map((b) => {
    const t = b.querySelector('.chapter-title-text')?.textContent?.trim() ?? '';
    return titleToId.get(t) ?? '';
  });
}

/** 后端刷新后的完整全序列（按 position 排序） */
function expectedFullOrder(mock: ReturnType<typeof createManuscriptStore>): string[] {
  return [...mock.store.chapters]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((c) => c.id);
}

/** 播种单章节 ch-1 并保存 v1/v2（current = v2），供 promote 测试使用 */
async function setupChapterWithTwoVersions(
  mock: ReturnType<typeof createManuscriptStore>,
): Promise<void> {
  await mock.desktop.getOrCreateManuscript({ projectId: 'p1' });
  await mock.desktop.createChapter({
    projectId: 'p1',
    manuscriptId: 'ms-1',
    insertBeforeChapterId: null,
  });
  await mock.desktop.createChapterVersion({
    projectId: 'p1',
    chapterId: 'ch-1',
    title: '标题',
    content: 'v1',
    expectedCurrentVersionId: null,
  });
  await mock.desktop.createChapterVersion({
    projectId: 'p1',
    chapterId: 'ch-1',
    title: '标题',
    content: 'v2',
    expectedCurrentVersionId: 'ver-1',
  });
}

/** 触发一次 CAS 冲突（本地 buffer 版本冲突），返回可控的 getCurrentChapterVersion resolve */
function makeConflictRefreshControllable(mock: ReturnType<typeof createManuscriptStore>): {
  resolveRefresh: (v: unknown) => void;
} {
  const origGet = mock.desktop.getCurrentChapterVersion.bind(mock.desktop);
  let resolveRefresh!: (v: unknown) => void;
  mock.desktop.getCurrentChapterVersion = vi.fn((input: unknown) => {
    return new Promise((resolve) => {
      resolveRefresh = () => resolve(origGet(input));
    });
  }) as never;
  // 返回闭包而非值捕获，确保引用到执行期赋值后的 resolveRefresh
  return { resolveRefresh: (v: unknown) => resolveRefresh(v) };
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

  it('22. archived 不作为排序目标（B上移时 target 只能是 active A）', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    const ids = await seedOrderedChapters(mock, ['A', 'X', 'B', 'C']);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    // 打开「显示已归档章节」（archived X 进入展示，但不得参与 move 计算）
    fireEvent.click(screen.getByRole('checkbox', { name: /显示已归档章节/ }));
    await waitFor(() => expect(screen.getByText('已归档')).toBeInTheDocument());
    const orderSpy = vi.spyOn(mock.desktop, 'updateChapterOrder');
    // B 上移：target 只能是 active A，绝不能是 archived X
    await act(async () => {
      screen.getByRole('button', { name: '上移章节：乙' }).click();
    });
    await waitFor(() => expect(screen.getByText('章节顺序已更新')).toBeInTheDocument());
    expect(orderSpy).toHaveBeenCalledTimes(1);
    const payload = orderSpy.mock.calls[0][0] as {
      chapterId: string;
      insertBeforeChapterId: string | null;
    };
    expect(payload.chapterId).toBe(ids.B);
    expect(payload.insertBeforeChapterId).toBe(ids.A);
    expect(payload.insertBeforeChapterId).not.toBe(ids.X);
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

  it('29. dirty时点击新建，不调用createChapter', async () => {
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
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '未保存内容' } });
    expect(screen.getByText('有未保存的修改')).toBeInTheDocument();
    const createSpy = vi.spyOn(mock.desktop, 'createChapter');
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    // 弹出离开确认，不调用后端
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('30. 点击继续编辑，正文和标题保持', async () => {
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
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '新标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '正文内容' } });
    const createSpy = vi.spyOn(mock.desktop, 'createChapter');
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: '继续编辑' }).click();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect((screen.getByLabelText('章节标题') as HTMLInputElement).value).toBe('新标题');
    expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('正文内容');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('31. 点击放弃修改并离开，只创建一次', async () => {
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
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '未保存内容' } });
    const createSpy = vi.spyOn(mock.desktop, 'createChapter');
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: '放弃修改并离开' }).click();
    });
    // 只创建一次，并切换到新章节（editor 清空为未命名空章节）
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(chapterSelectButtons().length).toBe(2));
    await waitFor(() => {
      expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('32. 创建失败不丢本地buffer', async () => {
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
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '旧标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '旧正文' } });
    // 创建后端改为失败（仅对后续创建生效）
    mock.desktop.createChapter = vi.fn().mockRejectedValue(new Error('创建章节失败')) as never;
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: '放弃修改并离开' }).click();
    });
    await waitFor(() => expect(screen.getByText(/创建章节失败/)).toBeInTheDocument());
    // 原章节 buffer 保留（不切换、不覆盖）
    expect((screen.getByLabelText('章节标题') as HTMLInputElement).value).toBe('旧标题');
    expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('旧正文');
  });

  it('33. clean状态创建不弹窗', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    const createSpy = vi.spyOn(mock.desktop, 'createChapter');
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    // clean 状态创建：直接创建，无确认对话框
    await waitFor(() => expect(chapterSelectButtons().length).toBe(1));
  });

  it('34. 稿件标题dirty时创建也弹窗', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    fireEvent.change(screen.getByLabelText('稿件标题'), { target: { value: '未保存的稿件标题' } });
    const createSpy = vi.spyOn(mock.desktop, 'createChapter');
    await act(async () => {
      screen.getByRole('button', { name: '新建章节' }).click();
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('35. archived重排：A下移不得使用X作为target', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    const ids = await seedOrderedChapters(mock, ['A', 'X', 'B', 'C']);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    fireEvent.click(screen.getByRole('checkbox', { name: /显示已归档章节/ }));
    await waitFor(() => expect(screen.getByText('已归档')).toBeInTheDocument());
    const orderSpy = vi.spyOn(mock.desktop, 'updateChapterOrder');
    // A（第一个 active）下移：target 必须是 active 序列的 C，绝不能用 archived X
    await act(async () => {
      screen.getByRole('button', { name: '下移章节：甲' }).click();
    });
    await waitFor(() => expect(screen.getByText('章节顺序已更新')).toBeInTheDocument());
    const payload = orderSpy.mock.calls[0][0] as {
      chapterId: string;
      insertBeforeChapterId: string | null;
    };
    expect(payload.chapterId).toBe(ids.A);
    expect(payload.insertBeforeChapterId).toBe(ids.C);
    expect(payload.insertBeforeChapterId).not.toBe(ids.X);
  });

  it('36. archived重排：C上移target为B', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    const ids = await seedOrderedChapters(mock, ['A', 'X', 'B', 'C']);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    fireEvent.click(screen.getByRole('checkbox', { name: /显示已归档章节/ }));
    await waitFor(() => expect(screen.getByText('已归档')).toBeInTheDocument());
    const orderSpy = vi.spyOn(mock.desktop, 'updateChapterOrder');
    await act(async () => {
      screen.getByRole('button', { name: '上移章节：丙' }).click();
    });
    await waitFor(() => expect(screen.getByText('章节顺序已更新')).toBeInTheDocument());
    const payload = orderSpy.mock.calls[0][0] as {
      chapterId: string;
      insertBeforeChapterId: string | null;
    };
    expect(payload.chapterId).toBe(ids.C);
    expect(payload.insertBeforeChapterId).toBe(ids.B);
  });

  it('37. archived重排：成功后完整列表顺序以后端刷新为准（含archived位置）', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await seedOrderedChapters(mock, ['A', 'X', 'B', 'C']);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    fireEvent.click(screen.getByRole('checkbox', { name: /显示已归档章节/ }));
    await waitFor(() => expect(screen.getByText('已归档')).toBeInTheDocument());
    const listSpy = vi.spyOn(mock.desktop, 'listChapters');
    await act(async () => {
      screen.getByRole('button', { name: '上移章节：乙' }).click();
    });
    await waitFor(() => expect(screen.getByText('章节顺序已更新')).toBeInTheDocument());
    // 成功后重新拉取完整列表（includeArchived=true）
    expect(listSpy).toHaveBeenCalled();
    const lastCall = listSpy.mock.calls[listSpy.mock.calls.length - 1][0] as {
      includeArchived?: boolean;
    };
    expect(lastCall.includeArchived).toBe(true);
    // DOM 顺序 = 后端刷新后的完整全序列（而非 [...newOrder, ...archived] 本地拼接）
    await waitFor(() => {
      expect(visibleChapterIds(mock)).toEqual(expectedFullOrder(mock));
    });
  });

  it('38. archived重排：边界上移/下移为no-op且不调用后端', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await seedOrderedChapters(mock, ['A', 'X', 'B', 'C']);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    fireEvent.click(screen.getByRole('checkbox', { name: /显示已归档章节/ }));
    await waitFor(() => expect(screen.getByText('已归档')).toBeInTheDocument());
    const orderSpy = vi.spyOn(mock.desktop, 'updateChapterOrder');
    // A 是第一个 active：上移为 no-op
    await act(async () => {
      screen.getByRole('button', { name: '上移章节：甲' }).click();
    });
    expect(orderSpy).not.toHaveBeenCalled();
    // C 是最后一个 active：下移为 no-op
    await act(async () => {
      screen.getByRole('button', { name: '下移章节：丙' }).click();
    });
    expect(orderSpy).not.toHaveBeenCalled();
  });

  it('39. archived重排：updateChapterOrder payload 从不出现 archived ID', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    const ids = await seedOrderedChapters(mock, ['A', 'X', 'B', 'C']);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    fireEvent.click(screen.getByRole('checkbox', { name: /显示已归档章节/ }));
    await waitFor(() => expect(screen.getByText('已归档')).toBeInTheDocument());
    const orderSpy = vi.spyOn(mock.desktop, 'updateChapterOrder');
    await act(async () => {
      screen.getByRole('button', { name: '上移章节：乙' }).click();
    });
    await waitFor(() => expect(orderSpy.mock.calls.length).toBe(1));
    await act(async () => {
      screen.getByRole('button', { name: '下移章节：甲' }).click();
    });
    await waitFor(() => expect(orderSpy.mock.calls.length).toBe(2));
    for (const call of orderSpy.mock.calls) {
      const payload = call[0] as { chapterId: string; insertBeforeChapterId: string | null };
      expect(payload.chapterId).not.toBe(ids.X);
      expect(payload.insertBeforeChapterId).not.toBe(ids.X);
    }
  });

  it('40. 冲突loading期间重存/放弃按钮disabled且本地保留', async () => {
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
    // 服务器推进 current
    await mock.desktop.createChapterVersion({
      projectId: 'p1',
      chapterId: 'ch-1',
      title: '标题',
      content: '服务器版本',
      expectedCurrentVersionId: null,
    });
    // 延迟冲突刷新
    const origGet = mock.desktop.getCurrentChapterVersion.bind(mock.desktop);
    let resolveRefresh!: (v: unknown) => void;
    mock.desktop.getCurrentChapterVersion = vi.fn((input: unknown) => {
      return new Promise((resolve) => {
        resolveRefresh = () => resolve(origGet(input));
      });
    }) as never;
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => expect(screen.getByText('正在刷新服务器当前版本…')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '基于新版本再保存' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '放弃本地修改并加载服务器版本' })).toBeDisabled();
    // loading 期间本地 title/content 保留
    expect((screen.getByLabelText('章节标题') as HTMLInputElement).value).toBe('标题');
    expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('本地未保存');
    await act(async () => {
      resolveRefresh({});
    });
    await waitFor(() => expect(screen.getByText(/服务器当前版本 #1/)).toBeInTheDocument());
  });

  it('41. 冲突刷新成功为version时使用新version ID', async () => {
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
    await waitFor(() => expect(screen.getByText(/服务器当前版本 #1/)).toBeInTheDocument());
    const createSpy = vi.spyOn(mock.desktop, 'createChapterVersion');
    await act(async () => {
      screen.getByRole('button', { name: '基于新版本再保存' }).click();
    });
    await waitFor(() => expect(screen.getByText(/已保存新版本 #2/)).toBeInTheDocument());
    const payload = createSpy.mock.calls[createSpy.mock.calls.length - 1][0] as {
      expectedCurrentVersionId: string | null;
    };
    // strict 使用刷新后的服务器 current ID（ver-1）
    expect(payload.expectedCurrentVersionId).toBe('ver-1');
  });

  it('42. 刷新成功且服务器current合法为null时使用expected=null', async () => {
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
    // 模拟另一客户端：服务器 currentVersionId 指向不存在的版本 → 刷新结果合法为 null
    mock.store.chapters[0].currentVersionId = 'ghost-ver';
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '本地新内容' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => expect(screen.getByText(/服务器当前版本为空/)).toBeInTheDocument());
    const createSpy = vi.spyOn(mock.desktop, 'createChapterVersion');
    await act(async () => {
      screen.getByRole('button', { name: '基于新版本再保存' }).click();
    });
    const payload = createSpy.mock.calls[createSpy.mock.calls.length - 1][0] as {
      expectedCurrentVersionId: string | null;
    };
    // 不得 fallback 到旧 current（ver-1）；服务器 current 为 null 时 expected 必须为 null
    expect(payload.expectedCurrentVersionId).toBeNull();
  });

  it('43. 刷新失败时不fallback旧current且createChapterVersion次数不增加', async () => {
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
    // 冲突刷新失败
    mock.desktop.getCurrentChapterVersion = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('网络错误'), { code: 'NETWORK' })) as never;
    const createSpy = vi.spyOn(mock.desktop, 'createChapterVersion');
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() =>
      expect(screen.getByText('服务器版本刷新失败，请重试。')).toBeInTheDocument(),
    );
    // 触发冲突的那一次保存调用
    expect(createSpy).toHaveBeenCalledTimes(1);
    // error 态本地 buffer 保留
    expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('本地未保存');
    // 编辑器「保存新版本」点击不得 fallback 旧 current 提交 IPC
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    // 冲突横幅按钮 disabled
    expect(screen.getByRole('button', { name: '基于新版本再保存' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '放弃本地修改并加载服务器版本' })).toBeDisabled();
  });

  it('44. 手动重新刷新成功后才可保存', async () => {
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
    // 第一次刷新失败，后续成功
    const origGet = mock.desktop.getCurrentChapterVersion.bind(mock.desktop);
    let attempt = 0;
    mock.desktop.getCurrentChapterVersion = vi.fn((input: unknown) => {
      attempt++;
      if (attempt === 1) {
        return Promise.reject(Object.assign(new Error('网络错误'), { code: 'NETWORK' }));
      }
      return origGet(input);
    }) as never;
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() =>
      expect(screen.getByText('服务器版本刷新失败，请重试。')).toBeInTheDocument(),
    );
    // 手动重新刷新服务器版本
    await act(async () => {
      screen.getByRole('button', { name: '重新刷新服务器版本' }).click();
    });
    await waitFor(() => expect(screen.getByText(/服务器当前版本 #1/)).toBeInTheDocument());
    // 刷新成功后才可基于新 current 保存
    await act(async () => {
      screen.getByRole('button', { name: '基于新版本再保存' }).click();
    });
    await waitFor(() => expect(screen.getByText(/已保存新版本 #2/)).toBeInTheDocument());
  });

  it('45. 冲突刷新失败后横幅不永久停留在「正在刷新」', async () => {
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
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '本地' } });
    await mock.desktop.createChapterVersion({
      projectId: 'p1',
      chapterId: 'ch-1',
      title: '标题',
      content: '服务器版本',
      expectedCurrentVersionId: null,
    });
    mock.desktop.getCurrentChapterVersion = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('网络错误'), { code: 'NETWORK' })) as never;
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() =>
      expect(screen.getByText('服务器版本刷新失败，请重试。')).toBeInTheDocument(),
    );
    expect(screen.queryByText('正在刷新服务器当前版本…')).not.toBeInTheDocument();
  });

  it('46. 冲突全程保留本地title/content（loading→ready→error）', async () => {
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
    const origGet = mock.desktop.getCurrentChapterVersion.bind(mock.desktop);
    let resolveRefresh!: (v: unknown) => void;
    mock.desktop.getCurrentChapterVersion = vi.fn((input: unknown) => {
      return new Promise((resolve) => {
        resolveRefresh = () => resolve(origGet(input));
      });
    }) as never;
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => expect(screen.getByText('正在刷新服务器当前版本…')).toBeInTheDocument());
    expect((screen.getByLabelText('章节标题') as HTMLInputElement).value).toBe('标题');
    expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('本地未保存');
    // ready 后仍保留
    await act(async () => {
      resolveRefresh({});
    });
    await waitFor(() => expect(screen.getByText(/服务器当前版本 #1/)).toBeInTheDocument());
    expect((screen.getByLabelText('章节标题') as HTMLInputElement).value).toBe('标题');
    expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('本地未保存');
  });

  it('47. save进行中章节按钮disabled', async () => {
    const mock = createManuscriptStore();
    const original = mock.desktop.createChapterVersion.bind(mock.desktop);
    let resolveFn: (v: unknown) => void = () => {};
    mock.desktop.createChapterVersion = vi.fn((input: unknown) => {
      return new Promise((resolve) => {
        resolveFn = () => resolve(original(input));
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
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '未保存' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    // mutation 进行中：章节选择按钮全部 disabled
    for (const b of chapterSelectButtons()) {
      expect(b).toBeDisabled();
    }
    await act(async () => {
      resolveFn({});
    });
  });

  it('48. save进行中新建章节disabled', async () => {
    const mock = createManuscriptStore();
    const original = mock.desktop.createChapterVersion.bind(mock.desktop);
    let resolveFn: (v: unknown) => void = () => {};
    mock.desktop.createChapterVersion = vi.fn((input: unknown) => {
      return new Promise((resolve) => {
        resolveFn = () => resolve(original(input));
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
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '未保存' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    expect(screen.getByRole('button', { name: '新建章节' })).toBeDisabled();
    await act(async () => {
      resolveFn({});
    });
  });

  it('49. save进行中版本promote disabled', async () => {
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
    // 延迟下一次保存
    const original = mock.desktop.createChapterVersion.bind(mock.desktop);
    let resolveFn: (v: unknown) => void = () => {};
    mock.desktop.createChapterVersion = vi.fn((input: unknown) => {
      return new Promise((resolve) => {
        resolveFn = () => resolve(original(input));
      });
    }) as never;
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: 'v3' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    // mutation 进行中：promote 按钮全部 disabled
    const promoteButtons = screen.getAllByRole('button', { name: '设为当前版本' });
    expect(promoteButtons.length).toBeGreaterThan(0);
    for (const b of promoteButtons) {
      expect(b).toBeDisabled();
    }
    await act(async () => {
      resolveFn({});
    });
  });

  it('51. 模拟绕过UI导致selected chapter改变后，旧save完成不得污染新章节editor', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await mock.desktop.getOrCreateManuscript({ projectId: 'p1' });
    const chA = await mock.desktop.createChapter({
      projectId: 'p1',
      manuscriptId: 'ms-1',
      insertBeforeChapterId: null,
    });
    const chB = await mock.desktop.createChapter({
      projectId: 'p1',
      manuscriptId: 'ms-1',
      insertBeforeChapterId: null,
    });
    const original = mock.desktop.createChapterVersion.bind(mock.desktop);
    let resolveSave!: (v: unknown) => void;
    mock.desktop.createChapterVersion = vi.fn((input: unknown) => {
      return new Promise((resolve) => {
        resolveSave = () => resolve(original(input));
      });
    }) as never;
    await act(async () => {
      render(<WorkbenchHarness />);
    });
    await waitFor(() => expect(wb).not.toBeNull());
    await waitFor(() => expect(wb!.allChapters.length).toBe(2));
    expect(wb!.selectedChapterId).toBe(chA.id);
    await act(async () => {
      wb!.setEditorTitle('A标题');
      wb!.setEditorContent('A未保存内容');
    });
    expect(wb!.dirty).toBe(true);
    // 保存 A（延迟），此时 mutation 进行中
    const savePromise = wb!.saveChapterVersion();
    // 绕过 UI 直接切换章节（dirty → 先出现离开确认）
    await act(async () => {
      wb!.selectChapter(chB.id);
    });
    expect(wb!.pendingLeave).not.toBeNull();
    await act(async () => {
      wb!.confirmLeave();
    });
    await waitFor(() => expect(wb!.selectedChapterId).toBe(chB.id));
    // B 加载为空
    expect(wb!.editorContent).toBe('');
    // 旧 save 完成
    await act(async () => {
      resolveSave({});
    });
    const result = await savePromise;
    expect(result).toBe(false);
    // A 的保存结果不得写入 B 的 editor buffer
    expect(wb!.editorContent).toBe('');
    expect(wb!.editorTitle).toBe('');
  });

  it('52. 重复点击只产生一次后端mutation', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await mock.desktop.getOrCreateManuscript({ projectId: 'p1' });
    await mock.desktop.createChapter({
      projectId: 'p1',
      manuscriptId: 'ms-1',
      insertBeforeChapterId: null,
    });
    const original = mock.desktop.createChapterVersion.bind(mock.desktop);
    let resolveSave!: (v: unknown) => void;
    let calls = 0;
    mock.desktop.createChapterVersion = vi.fn((input: unknown) => {
      calls++;
      return new Promise((resolve) => {
        resolveSave = () => resolve(original(input));
      });
    }) as never;
    await act(async () => {
      render(<WorkbenchHarness />);
    });
    await waitFor(() => expect(wb).not.toBeNull());
    await waitFor(() => expect(wb!.allChapters.length).toBe(1));
    await act(async () => {
      wb!.setEditorTitle('标题');
      wb!.setEditorContent('内容');
    });
    let p1: Promise<boolean> | undefined;
    await act(async () => {
      p1 = wb!.saveChapterVersion();
    });
    // mutation 锁已生效：第二次保存立即返回 false，不产生第二次后端调用
    let r2 = false;
    await act(async () => {
      r2 = await wb!.saveChapterVersion();
    });
    expect(r2).toBe(false);
    expect(calls).toBe(1);
    await act(async () => {
      resolveSave({});
    });
    const r1 = await p1!;
    expect(r1).toBe(true);
    expect(calls).toBe(1);
  });

  it('53. mutation失败后全部锁恢复', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await mock.desktop.getOrCreateManuscript({ projectId: 'p1' });
    await mock.desktop.createChapter({
      projectId: 'p1',
      manuscriptId: 'ms-1',
      insertBeforeChapterId: null,
    });
    let attempts = 0;
    const original = mock.desktop.createChapterVersion.bind(mock.desktop);
    mock.desktop.createChapterVersion = vi.fn((input: unknown) => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(Object.assign(new Error('数据库错误'), { code: 'DATABASE' }));
      }
      return original(input);
    }) as never;
    await act(async () => {
      render(<WorkbenchHarness />);
    });
    await waitFor(() => expect(wb).not.toBeNull());
    await waitFor(() => expect(wb!.allChapters.length).toBe(1));
    await act(async () => {
      wb!.setEditorTitle('标题');
      wb!.setEditorContent('内容');
    });
    // 第一次保存失败
    let r1: boolean | null = null;
    await act(async () => {
      r1 = await wb!.saveChapterVersion();
    });
    expect(r1).toBe(false);
    expect(wb!.error).toContain('数据库错误');
    // 锁已恢复：第二次保存可正常执行
    let r2: boolean | null = null;
    await act(async () => {
      r2 = await wb!.saveChapterVersion();
    });
    expect(r2).toBe(true);
    expect(attempts).toBe(2);
  });

  it('58. save期间章节标题和正文disabled', async () => {
    const mock = createManuscriptStore();
    const original = mock.desktop.createChapterVersion.bind(mock.desktop);
    let resolveFn: (v: unknown) => void = () => {};
    mock.desktop.createChapterVersion = vi.fn((input: unknown) => {
      return new Promise((resolve) => {
        resolveFn = () => resolve(original(input));
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
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '正文' } });
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    // save 进行中：章节标题与正文输入不可编辑
    expect(screen.getByLabelText('章节标题')).toBeDisabled();
    expect(screen.getByLabelText('正文编辑')).toBeDisabled();
    await act(async () => {
      resolveFn({});
    });
  });

  it('59. promote期间章节标题和正文disabled', async () => {
    const mock = createManuscriptStore();
    await setupChapterWithTwoVersions(mock);
    const original = mock.desktop.promoteChapterVersion.bind(mock.desktop);
    let resolveFn: (v: unknown) => void = () => {};
    mock.desktop.promoteChapterVersion = vi.fn((input: unknown) => {
      return new Promise((resolve) => {
        resolveFn = () => resolve(original(input));
      });
    }) as never;
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    await act(async () => {
      screen.getByRole('button', { name: '设为当前版本' }).click();
    });
    // promote 进行中：章节标题与正文输入不可编辑
    expect(screen.getByLabelText('章节标题')).toBeDisabled();
    expect(screen.getByLabelText('正文编辑')).toBeDisabled();
    await act(async () => {
      resolveFn({});
    });
  });

  it('60. save期间程序化修改buffer后，save成功不覆盖新buffer且dirty保持true', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await mock.desktop.getOrCreateManuscript({ projectId: 'p1' });
    await mock.desktop.createChapter({
      projectId: 'p1',
      manuscriptId: 'ms-1',
      insertBeforeChapterId: null,
    });
    const original = mock.desktop.createChapterVersion.bind(mock.desktop);
    let resolveSave!: (v: unknown) => void;
    mock.desktop.createChapterVersion = vi.fn((input: unknown) => {
      return new Promise((resolve) => {
        resolveSave = () => resolve(original(input));
      });
    }) as never;
    await act(async () => {
      render(<WorkbenchHarness />);
    });
    await waitFor(() => expect(wb).not.toBeNull());
    await waitFor(() => expect(wb!.allChapters.length).toBe(1));
    await act(async () => {
      wb!.setEditorTitle('原标题');
      wb!.setEditorContent('原正文');
    });
    const savePromise = wb!.saveChapterVersion();
    // 请求期间用户（程序化 setter）继续编辑 → revision 递增
    await act(async () => {
      wb!.setEditorContent('新的正文');
    });
    await act(async () => {
      resolveSave({});
    });
    const result = await savePromise;
    expect(result).toBe(true);
    // 较新的本地 buffer 未被覆盖
    expect(wb!.editorTitle).toBe('原标题');
    expect(wb!.editorContent).toBe('新的正文');
    // currentVersion 对应已保存版本
    expect(wb!.currentVersion).not.toBeNull();
    expect(wb!.currentVersion?.title).toBe('原标题');
    expect(wb!.currentVersion?.content).toBe('原正文');
    // lastSnapshot 已更新为已保存版本 → dirty 保持 true
    expect(wb!.dirty).toBe(true);
    // 安全反馈
    expect(wb!.successMessage).toContain('本地修改');
  });

  it('61. 正常无并发编辑时save后dirty=false', async () => {
    const mock = createManuscriptStore();
    setupDesktop(mock);
    await mock.desktop.getOrCreateManuscript({ projectId: 'p1' });
    await mock.desktop.createChapter({
      projectId: 'p1',
      manuscriptId: 'ms-1',
      insertBeforeChapterId: null,
    });
    const original = mock.desktop.createChapterVersion.bind(mock.desktop);
    let resolveSave!: (v: unknown) => void;
    mock.desktop.createChapterVersion = vi.fn((input: unknown) => {
      return new Promise((resolve) => {
        resolveSave = () => resolve(original(input));
      });
    }) as never;
    await act(async () => {
      render(<WorkbenchHarness />);
    });
    await waitFor(() => expect(wb).not.toBeNull());
    await waitFor(() => expect(wb!.allChapters.length).toBe(1));
    await act(async () => {
      wb!.setEditorTitle('标题');
      wb!.setEditorContent('正文');
    });
    const savePromise = wb!.saveChapterVersion();
    await act(async () => {
      resolveSave({});
    });
    const result = await savePromise;
    expect(result).toBe(true);
    // 无并发编辑：editor 与快照一致 → dirty=false
    expect(wb!.dirty).toBe(false);
    expect(wb!.currentVersion?.content).toBe('正文');
  });

  it('62. dirty时点击promote不调用IPC并显示离开确认', async () => {
    const mock = createManuscriptStore();
    await setupChapterWithTwoVersions(mock);
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    // 制造 dirty
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '未保存修改' } });
    const promoteSpy = vi.spyOn(mock.desktop, 'promoteChapterVersion');
    await act(async () => {
      screen.getByRole('button', { name: '设为当前版本' }).click();
    });
    // 离开确认出现，不调用后端
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(promoteSpy).not.toHaveBeenCalled();
  });

  it('63. 继续编辑保留title/content且不promote', async () => {
    const mock = createManuscriptStore();
    await setupChapterWithTwoVersions(mock);
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '新标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '未保存修改' } });
    const promoteSpy = vi.spyOn(mock.desktop, 'promoteChapterVersion');
    await act(async () => {
      screen.getByRole('button', { name: '设为当前版本' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: '继续编辑' }).click();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect((screen.getByLabelText('章节标题') as HTMLInputElement).value).toBe('新标题');
    expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('未保存修改');
    expect(promoteSpy).not.toHaveBeenCalled();
  });

  it('64. 放弃修改并离开后才执行promote（只调用一次）', async () => {
    const mock = createManuscriptStore();
    await setupChapterWithTwoVersions(mock);
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '未保存修改' } });
    const promoteSpy = vi.spyOn(mock.desktop, 'promoteChapterVersion');
    await act(async () => {
      screen.getByRole('button', { name: '设为当前版本' }).click();
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: '放弃修改并离开' }).click();
    });
    await waitFor(() => expect(promoteSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/已将版本 #1 设为当前版本/)).toBeInTheDocument());
  });

  it('65. promote失败保留本地buffer和dirty', async () => {
    const mock = createManuscriptStore();
    await setupChapterWithTwoVersions(mock);
    mock.desktop.promoteChapterVersion = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('数据库错误'), { code: 'DATABASE' })) as never;
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '本地标题' } });
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '本地正文' } });
    await act(async () => {
      screen.getByRole('button', { name: '设为当前版本' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: '放弃修改并离开' }).click();
    });
    await waitFor(() => expect(screen.getByText(/数据库错误/)).toBeInTheDocument());
    // 本地 buffer 与 dirty 保留
    expect((screen.getByLabelText('章节标题') as HTMLInputElement).value).toBe('本地标题');
    expect((screen.getByLabelText('正文编辑') as HTMLTextAreaElement).value).toBe('本地正文');
    expect(screen.getByText('有未保存的修改')).toBeInTheDocument();
  });

  it('66. clean时promote不弹确认', async () => {
    const mock = createManuscriptStore();
    await setupChapterWithTwoVersions(mock);
    setupDesktop(mock);
    await act(async () => {
      render(<ManuscriptWorkbench projectId="p1" />);
    });
    await waitForLoaded();
    await waitFor(() => expect(screen.getByLabelText('章节标题')).toBeInTheDocument());
    const promoteSpy = vi.spyOn(mock.desktop, 'promoteChapterVersion');
    await act(async () => {
      screen.getByRole('button', { name: '设为当前版本' }).click();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(promoteSpy).toHaveBeenCalledTimes(1));
  });

  it('67. promote进行中重复点击只调用一次', async () => {
    const mock = createManuscriptStore();
    await setupChapterWithTwoVersions(mock);
    const original = mock.desktop.promoteChapterVersion.bind(mock.desktop);
    let resolvePromote!: (v: unknown) => void;
    let calls = 0;
    mock.desktop.promoteChapterVersion = vi.fn((input: unknown) => {
      calls++;
      return new Promise((resolve) => {
        resolvePromote = () => resolve(original(input));
      });
    }) as never;
    setupDesktop(mock);
    await act(async () => {
      render(<WorkbenchHarness />);
    });
    await waitFor(() => expect(wb).not.toBeNull());
    await waitFor(() => expect(wb!.allChapters.length).toBe(1));
    // 加载版本历史
    await waitFor(() => expect(wb!.chapterVersions.length).toBe(2));
    const v1 = mock.store.versions[0];
    // 第一次 promote（延迟）
    await act(async () => {
      wb!.promoteChapterVersion(v1.id);
    });
    // mutation 锁已生效：第二次请求立即拒绝（busy），不调用后端
    await act(async () => {
      wb!.promoteChapterVersion(v1.id);
    });
    expect(calls).toBe(1);
    await act(async () => {
      resolvePromote({});
    });
    expect(calls).toBe(1);
  });

  it('68. 冲突横幅没有关闭按钮', async () => {
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
    await waitFor(() => expect(screen.getByText(/服务器当前版本 #1/)).toBeInTheDocument());
    // 冲突横幅不可直接关闭（不得回到旧 expected 路径）
    expect(screen.queryByRole('button', { name: '关闭冲突提示' })).not.toBeInTheDocument();
    expect(screen.getByText('稿件已在其他操作中更新。')).toBeInTheDocument();
  });

  it('69. 冲突error态仅允许重新刷新（无关闭、重存/放弃disabled）', async () => {
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
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '本地' } });
    await mock.desktop.createChapterVersion({
      projectId: 'p1',
      chapterId: 'ch-1',
      title: '标题',
      content: '服务器版本',
      expectedCurrentVersionId: null,
    });
    mock.desktop.getCurrentChapterVersion = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('网络错误'), { code: 'NETWORK' })) as never;
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() =>
      expect(screen.getByText('服务器版本刷新失败，请重试。')).toBeInTheDocument(),
    );
    // error 态：仅允许重新刷新；重存/放弃 disabled；无关闭按钮
    expect(screen.getByRole('button', { name: '重新刷新服务器版本' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '基于新版本再保存' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '放弃本地修改并加载服务器版本' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '关闭冲突提示' })).not.toBeInTheDocument();
  });

  it('70. 冲突不能通过dismiss回到旧expected路径（无dismiss控件，横幅持续）', async () => {
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
    fireEvent.change(screen.getByLabelText('正文编辑'), { target: { value: '本地' } });
    await mock.desktop.createChapterVersion({
      projectId: 'p1',
      chapterId: 'ch-1',
      title: '标题',
      content: '服务器版本',
      expectedCurrentVersionId: null,
    });
    const { resolveRefresh } = makeConflictRefreshControllable(mock);
    await act(async () => {
      screen.getByRole('button', { name: '保存新版本' }).click();
    });
    await waitFor(() => expect(screen.getByText('正在刷新服务器当前版本…')).toBeInTheDocument());
    await act(async () => {
      resolveRefresh({});
    });
    await waitFor(() => expect(screen.getByText(/服务器当前版本 #1/)).toBeInTheDocument());
    // 无 dismiss 控件：点击其他非冲突操作（切换 archived 开关）不会关闭冲突
    fireEvent.click(screen.getByRole('checkbox', { name: /显示已归档章节/ }));
    expect(screen.getByText(/服务器当前版本 #1/)).toBeInTheDocument();
    // 仍无关闭按钮，冲突只能通过「基于新版本再保存」或「放弃本地修改」结束
    expect(screen.queryByRole('button', { name: '关闭冲突提示' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '基于新版本再保存' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '放弃本地修改并加载服务器版本' })).toBeEnabled();
  });
});
