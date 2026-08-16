/**
 * 章节生成数据 hook（B10）。
 *
 * D-B10-4：章节 run 与 project run 是两条独立的 run，App 的旅程探针（useJourney）
 * 只跟踪 project run，**不能**用来观察章节生成进度。故本 hook 自持一条轮询：
 * - `chapter.getOverview`：蓝图章节列表 + 每章最新 run 的阶段（列表页始终需要）；
 * - `chapter.getRunState`：当前选中章节的完整状态（有选中 run 时才拉）。
 *
 * 轮询只在"有进行中的后台工作"时保持较快节奏；停在人工 Gate 或终态时降速——
 * 生成一章是分钟级操作，恒定高频轮询没有收益（与 B6/B8 探针同一取舍）。
 *
 * 写操作（发起生成 / 提交决策）成功后立即刷新一次，并把 busy 护航到新状态落地为止
 * （B8 独立复查坐实的 blocker：提前放开 busy 会让按钮以旧态重新可点）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChapterOverviewDto, ChapterRunStateDto } from '@ai-novel/contracts';
import { toSafeUserError } from '../safety/safe-error';
import { isChapterWorking } from './chapter-logic';

/** 有后台工作时的轮询间隔；空闲（等人 / 终态）时放慢到 6 秒 */
const ACTIVE_POLL_MS = 1700;
const IDLE_POLL_MS = 6000;

export interface ChapterActions {
  /** 选中某一章（列表点击）；null 表示回到列表 */
  select(blueprintChapterId: string | null): void;
  /** 发起（或继续）该章的生成 */
  startRun(blueprintChapterId: string): Promise<void>;
  /** 候选确认决策；feedback 只在 request_rewrite 时允许非空 */
  submitGate(outcome: string, feedback: string | null): Promise<void>;
  /** 升级决策（四选项） */
  submitEscalation(outcome: string): Promise<void>;
  /** 手动刷新（错误后的重试入口） */
  refresh(): Promise<void>;
}

export interface UseChapterReturn {
  readonly overview: ChapterOverviewDto | null;
  readonly selectedChapterId: string | null;
  readonly runState: ChapterRunStateDto | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** 写操作错误（与读取错误分开展示，随面板一起消失） */
  readonly actionError: string | null;
  readonly busy: boolean;
  readonly actions: ChapterActions;
}

export function useChapter(projectId: string): UseChapterReturn {
  const [overview, setOverview] = useState<ChapterOverviewDto | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [runState, setRunState] = useState<ChapterRunStateDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 竞态防护：projectId / 选中章节变化时递增，使旧 in-flight 响应失效
  const generationRef = useRef(0);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedChapterId;

  const fetchOnce = useCallback(async (): Promise<void> => {
    const currentGen = generationRef.current;
    try {
      const nextOverview = await window.desktop.chapter.getOverview({ projectId });
      if (generationRef.current !== currentGen) return;
      setOverview(nextOverview);
      const chapterId = selectedRef.current;
      const item = chapterId
        ? nextOverview.chapters.find((c) => c.blueprintChapterId === chapterId)
        : undefined;
      if (item?.runId) {
        const state = await window.desktop.chapter.getRunState({ projectId, runId: item.runId });
        if (generationRef.current !== currentGen) return;
        setRunState(state);
      } else {
        setRunState(null);
      }
      setError(null);
    } catch (err) {
      if (generationRef.current !== currentGen) return;
      setError(toSafeUserError(err, '加载章节状态失败').message);
    } finally {
      if (generationRef.current === currentGen) setLoading(false);
    }
  }, [projectId]);

  // 项目切换：清空并重新拉取（旧 in-flight 响应作废）
  useEffect(() => {
    generationRef.current += 1;
    setOverview(null);
    setRunState(null);
    setSelectedChapterId(null);
    setError(null);
    setActionError(null);
    setLoading(true);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      await fetchOnce();
      if (cancelled) return;
      const working =
        runState !== null
          ? isChapterWorking(runState.phase)
          : (overview?.chapters.some((c) => isChapterWorking(c.phase)) ?? false);
      timer = setTimeout(
        () => {
          void tick();
        },
        working ? ACTIVE_POLL_MS : IDLE_POLL_MS,
      );
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // 依赖说明：
    // - selectedChapterId 进入依赖，是为了让"点开某一章"立刻拉一次该章状态——
    //   否则要等下一个轮询周期（空闲 6 秒）才出内容，界面会长时间停在"正在加载"；
    // - runState.phase / 章节数进入依赖，让轮询节奏跟随最新阶段自适应；
    // cancelled 守卫保证旧循环不会与新循环并存。
  }, [fetchOnce, selectedChapterId, runState?.phase, overview?.chapters.length]);

  const select = useCallback((blueprintChapterId: string | null) => {
    generationRef.current += 1;
    setSelectedChapterId(blueprintChapterId);
    setRunState(null);
    setActionError(null);
  }, []);

  const runWrite = useCallback(
    async (fn: () => Promise<ChapterRunStateDto>, failMessage: string): Promise<void> => {
      setBusy(true);
      setActionError(null);
      try {
        const next = await fn();
        setRunState(next);
        // 写入成功后立即刷新一次总览（列表上的阶段随之更新）
        await fetchOnce();
      } catch (err) {
        setActionError(toSafeUserError(err, failMessage).message);
      } finally {
        setBusy(false);
      }
    },
    [fetchOnce],
  );

  const startRun = useCallback(
    async (blueprintChapterId: string): Promise<void> => {
      setSelectedChapterId(blueprintChapterId);
      selectedRef.current = blueprintChapterId;
      await runWrite(
        () => window.desktop.chapter.startRun({ projectId, blueprintChapterId }),
        '发起本章生成失败',
      );
    },
    [projectId, runWrite],
  );

  const submitDecision = useCallback(
    async (
      kind: 'gate' | 'escalation',
      outcome: string,
      feedback: string | null,
      failMessage: string,
    ): Promise<void> => {
      const runId = runState?.runId;
      if (!runId) return;
      await runWrite(
        () =>
          window.desktop.chapter.submitDecision({
            projectId,
            runId,
            kind,
            outcome,
            feedback,
            idempotencyKey: crypto.randomUUID(),
          }),
        failMessage,
      );
    },
    [projectId, runState?.runId, runWrite],
  );

  const submitGate = useCallback(
    (outcome: string, feedback: string | null) =>
      submitDecision('gate', outcome, feedback, '提交确认失败'),
    [submitDecision],
  );

  const submitEscalation = useCallback(
    (outcome: string) => submitDecision('escalation', outcome, null, '提交选择失败'),
    [submitDecision],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    await fetchOnce();
  }, [fetchOnce]);

  return {
    overview,
    selectedChapterId,
    runState,
    loading,
    error,
    actionError,
    busy,
    actions: { select, startRun, submitGate, submitEscalation, refresh },
  };
}
