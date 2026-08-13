// @vitest-environment jsdom
/**
 * ChapterRegion 组件测试（B10）：章节列表 → 发起生成 → 进度 → 候选查看 →
 * 确认决策（含改写意见真的随请求发出）→ 升级决策 → 采用后的如实说明。
 *
 * **注意**：仅有组件级断言是不够的（B6 的教训：直接挂载组件手喂 state 会绕开 App
 * 分流）。App 级可达性由 app.test.tsx 的"frontier 到成稿阶段 → 挂载 ChapterRegion"
 * 一条覆盖。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChapterOverviewDto, ChapterRunStateDto, DesktopAPI } from '@ai-novel/contracts';
import { ChapterRegion } from './ChapterRegion';

const NOW = '2026-08-13T00:00:00.000Z';
const PROJECT_ID = 'proj-1';
const CHAPTER_ID = 'ch-1';

function overview(overrides: Partial<ChapterOverviewDto> = {}): ChapterOverviewDto {
  return {
    blueprintId: 'bp-1',
    chapters: [
      {
        blueprintChapterId: CHAPTER_ID,
        title: '第一章 远客',
        goal: '引出客栈与主角',
        runId: null,
        phase: 'idle',
        hasCandidate: false,
      },
    ],
    ...overrides,
  };
}

function runState(overrides: Partial<ChapterRunStateDto> = {}): ChapterRunStateDto {
  return {
    runId: 'run-1',
    blueprintChapterId: CHAPTER_ID,
    phase: 'awaiting_decision',
    terminalStatus: null,
    gateActive: true,
    escalationActive: false,
    candidate: {
      revisionNo: 1,
      source: 'DRAFT',
      title: '第一章 远客',
      content: '雨砸在客栈的屋檐上。\n小满把最后一只酒杯擦干。',
      createdAt: NOW,
    },
    critiques: [
      {
        dimension: 'style',
        verdict: 'needs_rewrite',
        summary: '语言有些套话',
        issues: [
          {
            severity: 'major',
            excerpt: '空气仿佛凝固',
            problem: '套话',
            suggestion: '换成具体动作',
          },
        ],
      },
    ],
    rewriteUsed: 0,
    candidateRewriteUsed: 0,
    regenerateUsed: 0,
    ...overrides,
  };
}

function setupDesktop(overrides: Record<string, unknown> = {}) {
  const chapter = {
    getOverview: vi.fn().mockResolvedValue(overview()),
    startRun: vi.fn().mockResolvedValue(runState()),
    getRunState: vi.fn().mockResolvedValue(runState()),
    submitDecision: vi.fn().mockResolvedValue(runState()),
    ...overrides,
  };
  window.desktop = { chapter } as unknown as DesktopAPI;
  return chapter;
}

async function renderRegion() {
  const view = render(<ChapterRegion projectId={PROJECT_ID} />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChapterRegion', () => {
  it('蓝图未接受 → 说明需要先接受蓝图，不给发起入口', async () => {
    setupDesktop({
      getOverview: vi.fn().mockResolvedValue({ blueprintId: null, chapters: [] }),
    });
    await renderRegion();
    await waitFor(() => {
      expect(screen.getByText(/需要先在"蓝图"阶段接受一份故事蓝图/)).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: '开始生成' })).toBeNull();
  });

  it('列出蓝图章节，未生成的章节给"开始生成"入口', async () => {
    setupDesktop();
    await renderRegion();
    await waitFor(() => {
      expect(screen.getByText('第一章 远客')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: '开始生成' })).toBeTruthy();
  });

  it('点击开始生成 → 调用 startRun 并进入单章详情', async () => {
    const api = setupDesktop();
    const user = userEvent.setup();
    await renderRegion();
    await waitFor(() => expect(screen.getByRole('button', { name: '开始生成' })).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '开始生成' }));

    await waitFor(() => {
      expect(api.startRun).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        blueprintChapterId: CHAPTER_ID,
      });
    });
  });

  it('候选正文与自查意见可查看（意见默认折叠）', async () => {
    setupDesktop({
      getOverview: vi.fn().mockResolvedValue(
        overview({
          chapters: [
            {
              blueprintChapterId: CHAPTER_ID,
              title: '第一章 远客',
              goal: '引出客栈与主角',
              runId: 'run-1',
              phase: 'awaiting_decision',
              hasCandidate: true,
            },
          ],
        }),
      ),
    });
    const user = userEvent.setup();
    await renderRegion();
    await waitFor(() => expect(screen.getByRole('button', { name: '查看' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '查看' }));

    await waitFor(() => {
      expect(screen.getByText(/雨砸在客栈的屋檐上/)).toBeTruthy();
    });
    // 自查意见默认折叠
    expect(screen.queryByText('套话')).toBeNull();
    await user.click(screen.getByRole('button', { name: /查看自查意见/ }));
    expect(screen.getByText('套话')).toBeTruthy();
  });

  it('确认环节：改写意见随请求发出（不是只写在界面上）', async () => {
    const api = setupDesktop({
      getOverview: vi.fn().mockResolvedValue(
        overview({
          chapters: [
            {
              blueprintChapterId: CHAPTER_ID,
              title: '第一章 远客',
              goal: '引出客栈与主角',
              runId: 'run-1',
              phase: 'awaiting_decision',
              hasCandidate: true,
            },
          ],
        }),
      ),
    });
    const user = userEvent.setup();
    await renderRegion();
    await waitFor(() => expect(screen.getByRole('button', { name: '查看' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '查看' }));
    await waitFor(() => expect(screen.getByLabelText(/你的修改意见/)).toBeTruthy());

    await user.type(screen.getByLabelText(/你的修改意见/), '第二场对话太客气');
    await user.click(screen.getByRole('button', { name: '按我的意见改写' }));

    await waitFor(() => {
      expect(api.submitDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          runId: 'run-1',
          kind: 'gate',
          outcome: 'request_rewrite',
          feedback: '第二场对话太客气',
        }),
      );
    });
  });

  it('采用后如实说明尚未写入稿件（不冒充"已保存"）', async () => {
    setupDesktop({
      getOverview: vi.fn().mockResolvedValue(
        overview({
          chapters: [
            {
              blueprintChapterId: CHAPTER_ID,
              title: '第一章 远客',
              goal: '引出客栈与主角',
              runId: 'run-1',
              phase: 'accepted_pending_commit',
              hasCandidate: true,
            },
          ],
        }),
      ),
      getRunState: vi
        .fn()
        .mockResolvedValue(runState({ phase: 'accepted_pending_commit', gateActive: false })),
    });
    const user = userEvent.setup();
    await renderRegion();
    await waitFor(() => expect(screen.getByRole('button', { name: '查看' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '查看' }));

    await waitFor(() => {
      expect(screen.getByText(/把它写入稿件、以及稿件编辑与导出，还在开发中/)).toBeTruthy();
    });
    // 已采用时不再给确认按钮
    expect(screen.queryByRole('button', { name: '采用这一版' })).toBeNull();
  });

  it('升级决策：四个选项都在，且能提交', async () => {
    const api = setupDesktop({
      getOverview: vi.fn().mockResolvedValue(
        overview({
          chapters: [
            {
              blueprintChapterId: CHAPTER_ID,
              title: '第一章 远客',
              goal: '引出客栈与主角',
              runId: 'run-1',
              phase: 'awaiting_escalation',
              hasCandidate: true,
            },
          ],
        }),
      ),
      getRunState: vi.fn().mockResolvedValue(
        runState({
          phase: 'awaiting_escalation',
          gateActive: false,
          escalationActive: true,
          candidateRewriteUsed: 5,
        }),
      ),
    });
    const user = userEvent.setup();
    await renderRegion();
    await waitFor(() => expect(screen.getByRole('button', { name: '查看' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '查看' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '就用现在这一版' })).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: '要改的是整体要求' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '稍后再说' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消本章生成' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '就用现在这一版' }));
    await waitFor(() => {
      expect(api.submitDecision).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'escalation', outcome: 'accept_current', feedback: null }),
      );
    });
  });

  it('读取失败 → 展示错误与重试入口', async () => {
    setupDesktop({
      getOverview: vi.fn().mockRejectedValue(new Error('worker 不可用')),
    });
    await renderRegion();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
