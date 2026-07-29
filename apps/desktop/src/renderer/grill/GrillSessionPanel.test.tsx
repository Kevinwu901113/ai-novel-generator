// @vitest-environment jsdom
/**
 * GrillSessionPanel 焦点生命周期测试。
 *
 * 覆盖：
 * - questionListFocusToken 增量触发问题列表标题聚焦
 * - contextKey 切换标记旧 token 已消费（不聚焦新 session）
 * - contextKey 切换取消未执行的 RAF（cancelAnimationFrame spy）
 * - unmount 取消未执行的 RAF（cancelAnimationFrame spy）
 * - 同一 token 重复渲染不重复聚焦
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { GrillSessionPanel } from './GrillSessionPanel';
import type { GrillSessionPublicData, GrillQuestionPublicData } from '@ai-novel/contracts';

const mockSession: GrillSessionPublicData = {
  id: 'sess-00000001',
  projectId: 'proj-00000001',
  goal: '测试会话',
  status: 'ACTIVE',
  version: 2,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  startedAt: '2024-01-01T00:00:00Z',
  completedAt: null,
  abandonedAt: null,
};

const mockQuestions: ReadonlyArray<GrillQuestionPublicData> = [];

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    contextKey: 'proj-00000001:sess-00000001',
    session: mockSession,
    questions: mockQuestions,
    isLoading: false,
    onStart: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onComplete: vi.fn(),
    onAbandon: vi.fn(),
    onAddQuestions: vi.fn().mockResolvedValue(true),
    onMarkAsked: vi.fn(),
    onSkip: vi.fn(),
    onSupersede: vi.fn(),
    onSelectQuestion: vi.fn(),
    selectedQuestionId: null as string | null,
    questionListFocusToken: 0,
    ...overrides,
  };
}

function questionListHeading(): HTMLElement | null {
  return document.querySelector('.grill-questions-section h4');
}

describe('GrillSessionPanel 焦点生命周期', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('focus token 增量时聚焦问题列表标题', async () => {
    const { rerender } = render(
      <GrillSessionPanel {...defaultProps({ questionListFocusToken: 0 })} />,
    );

    rerender(<GrillSessionPanel {...defaultProps({ questionListFocusToken: 1 })} />);

    await waitFor(() => {
      expect(questionListHeading()).toHaveFocus();
    });
  });

  it('同一 token 重复渲染不重复聚焦', async () => {
    const { rerender } = render(
      <GrillSessionPanel {...defaultProps({ questionListFocusToken: 1 })} />,
    );

    await waitFor(() => {
      expect(questionListHeading()).toHaveFocus();
    });

    (document.activeElement as HTMLElement | null)?.blur();

    rerender(<GrillSessionPanel {...defaultProps({ questionListFocusToken: 1 })} />);
    await new Promise((r) => requestAnimationFrame(r));

    expect(questionListHeading()).not.toHaveFocus();
  });

  it('contextKey 切换时旧 token 标记为已消费：不聚焦新 session', async () => {
    const session2 = { ...mockSession, id: 'sess-00000002' };
    const { rerender } = render(
      <GrillSessionPanel
        {...defaultProps({
          contextKey: 'proj-00000001:sess-00000001',
          questionListFocusToken: 0,
        })}
      />,
    );

    // contextKey 与 token 同时变化：token 属于旧 context，已消费
    rerender(
      <GrillSessionPanel
        {...defaultProps({
          contextKey: 'proj-00000001:sess-00000002',
          session: session2,
          questionListFocusToken: 1,
        })}
      />,
    );

    await new Promise((r) => requestAnimationFrame(r));
    expect(questionListHeading()).not.toHaveFocus();

    // 新 context 内的新 token 增量才聚焦
    rerender(
      <GrillSessionPanel
        {...defaultProps({
          contextKey: 'proj-00000001:sess-00000002',
          session: session2,
          questionListFocusToken: 2,
        })}
      />,
    );

    await waitFor(() => {
      expect(questionListHeading()).toHaveFocus();
    });
  });

  it('contextKey 切换时取消未执行的 RAF（cancelAnimationFrame spy）', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 7);
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    const { rerender } = render(
      <GrillSessionPanel
        {...defaultProps({
          contextKey: 'proj-00000001:sess-00000001',
          questionListFocusToken: 0,
        })}
      />,
    );

    rerender(
      <GrillSessionPanel
        {...defaultProps({
          contextKey: 'proj-00000001:sess-00000001',
          questionListFocusToken: 1,
        })}
      />,
    );
    expect(rafSpy).toHaveBeenCalledTimes(1);

    // RAF 未执行（mock），contextKey 切换：cleanup 必须取消 id=7
    rerender(
      <GrillSessionPanel
        {...defaultProps({
          contextKey: 'proj-00000001:sess-00000002',
          session: { ...mockSession, id: 'sess-00000002' },
          questionListFocusToken: 1,
        })}
      />,
    );
    expect(cancelSpy).toHaveBeenCalledWith(7);
    // 新 context 不因旧 token 重新安排 RAF
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it('unmount 时取消未执行的 RAF（cancelAnimationFrame spy）', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 9);
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    const { rerender, unmount } = render(
      <GrillSessionPanel {...defaultProps({ questionListFocusToken: 0 })} />,
    );
    rerender(<GrillSessionPanel {...defaultProps({ questionListFocusToken: 1 })} />);
    expect(rafSpy).toHaveBeenCalledTimes(1);

    unmount();
    expect(cancelSpy).toHaveBeenCalledWith(9);
  });
});
