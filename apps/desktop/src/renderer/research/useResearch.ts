/**
 * Web Research 数据 hook（B6）。
 *
 * 数据源（D-B6-3）：research.getResearchState 驱动相位（经 deriveResearchPhase）；
 * research.listBundles / research.getBundle(当前 bundleRef) 供版本查看；
 * research.listSourceExclusions 供来源排除标记；search.hasApiKey 供 key-missing 判定；
 * tasks.list 判定是否存在在途 RESEARCH_RUN 任务（无专用"是否在途"通道，按
 * taskType === 'RESEARCH_RUN' 且 isTaskActive(status) 过滤，taskType 常量见
 * apps/worker/src/graph-task-runner.ts）。
 *
 * 阶段回退检测（D-B6-7）：额外读 graph.listRuns + graph.getRunProgress（与
 * useIntake 同源），用 deriveResearchJourneyStage 推导当前 frontier 的旅程阶段并经
 * onStageChange 回报——RESEARCH_ESCALATION 的 5 个出口并非都停在 research 阶段
 * （modify_requirements 回环到 clarify、use_current_research/skip_research 前进到
 * blueprint、cancel/continue_later/预算耗尽落终态)，一旦 frontier 不再是 research，
 * App 换回 IntakeRegion，由其自身相位机器接管（awaiting-answer/extracting/
 * beyond-intake/terminal 均已有对应处理，本 hook 不重复实现）。
 *
 * 轮询设计镜像 useTaskCenter（generationRef 竞态防护 + inFlightGenerationRef
 * 互斥锁 + document.hidden 可见性门控）与 useIntake（自递归 setTimeout，请求批量
 * 较重时不产生 setInterval 式请求堆叠）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphRunSummaryDto, ResearchBundleDto, ResearchStateDto } from '@ai-novel/contracts';
import {
  deriveResearchJourneyStage,
  deriveResearchPhase,
  type ResearchPhase,
} from './research-logic';
import { latestProjectRun, type JourneyStage } from '../intake/intake-logic';
import { isTaskActive } from '../task-center/task-labels';
import { toSafeUserError } from '../safety/safe-error';

const POLL_INTERVAL_MS = 1700;

export interface ResearchActions {
  /** RESEARCH_ESCALATION 人工决策（nodeId 固定，outcome 取 RESEARCH_ESCALATION_OPTIONS 之一） */
  chooseEscalation(outcome: string): Promise<void>;
  /** 单条来源排除开关；用返回列表更新本地标记（D-B6-2） */
  setSourceExclusion(url: string, excluded: boolean): Promise<void>;
}

export interface UseResearchReturn {
  readonly phase: ResearchPhase;
  readonly state: ResearchStateDto | null;
  readonly bundle: ResearchBundleDto | null;
  readonly bundles: ReadonlyArray<ResearchBundleDto>;
  readonly exclusions: ReadonlyArray<string>;
  readonly hasApiKey: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly refresh: () => void;
  readonly actions: ResearchActions;
}

export function useResearch(
  projectId: string,
  onStageChange?: (stage: JourneyStage) => void,
): UseResearchReturn {
  const [phase, setPhase] = useState<ResearchPhase>({ kind: 'no-run' });
  const [state, setState] = useState<ResearchStateDto | null>(null);
  const [bundle, setBundle] = useState<ResearchBundleDto | null>(null);
  const [bundles, setBundles] = useState<ReadonlyArray<ResearchBundleDto>>([]);
  const [exclusions, setExclusions] = useState<ReadonlyArray<string>>([]);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(() => !document.hidden);

  const runRef = useRef<GraphRunSummaryDto | null>(null);
  const onStageChangeRef = useRef(onStageChange);
  onStageChangeRef.current = onStageChange;

  // 竞态防护：projectId 切换时递增（同 useTaskCenter）
  const generationRef = useRef(0);
  const inFlightGenerationRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const currentGen = generationRef.current;
    if (inFlightGenerationRef.current === currentGen) return;
    inFlightGenerationRef.current = currentGen;

    try {
      setLoading(true);

      // 阶段回退检测（D-B6-7）：与 useIntake 同源的 run + progress 读取。
      const runs = await window.desktop.graph.listRuns({ projectId });
      if (generationRef.current !== currentGen) return;
      const run = latestProjectRun(runs);
      runRef.current = run;

      const progress = run
        ? await window.desktop.graph.getRunProgress({ projectId, runId: run.runId })
        : null;
      if (generationRef.current !== currentGen) return;

      const frontierStage = deriveResearchJourneyStage(run, progress);
      if (frontierStage) onStageChangeRef.current?.(frontierStage);

      const [researchState, allBundles, taskList, keyState, exclusionList] = await Promise.all([
        window.desktop.research.getResearchState({ projectId }),
        window.desktop.research.listBundles({ projectId }),
        window.desktop.tasks.list(projectId),
        window.desktop.search.hasApiKey(),
        window.desktop.research.listSourceExclusions({ projectId }),
      ]);
      if (generationRef.current !== currentGen) return;

      const currentBundle = researchState.bundleRef
        ? await window.desktop.research.getBundle({
            projectId,
            bundleId: researchState.bundleRef,
          })
        : null;
      if (generationRef.current !== currentGen) return;

      const pendingResearchTask = taskList.some(
        (t) => t.taskType === 'RESEARCH_RUN' && isTaskActive(t.status),
      );

      setState(researchState);
      setBundles(allBundles);
      setBundle(currentBundle);
      setExclusions(exclusionList);
      setHasApiKey(keyState.hasApiKey);
      setPhase(deriveResearchPhase(researchState, keyState.hasApiKey, pendingResearchTask));
      setError(null);
    } catch (err) {
      if (generationRef.current === currentGen) {
        setError(toSafeUserError(err, '加载调研状态失败').message);
      }
    } finally {
      if (generationRef.current === currentGen) {
        setLoading(false);
        inFlightGenerationRef.current = null;
      }
    }
  }, [projectId]);

  // projectId 切换：清空旧数据、递增 generation 使旧 in-flight 响应失效。
  // 必须先于下方轮询 effect 声明——React 按声明顺序提交 effect，本 effect 的
  // setup 需要在新一轮 poll() 发起 refresh() 之前完成 generation 递增，
  // 否则新请求捕获的 currentGen 会被本效应之后才发生的递增判定为过期而被丢弃。
  useEffect(() => {
    generationRef.current += 1;
    inFlightGenerationRef.current = null;
    runRef.current = null;
    setPhase({ kind: 'no-run' });
    setState(null);
    setBundle(null);
    setBundles([]);
    setExclusions([]);
    setHasApiKey(false);
    setError(null);
    setLoading(false);

    return () => {
      generationRef.current += 1;
    };
  }, [projectId]);

  // visibilitychange：仅切换可见性 state，实际的立即刷新由下方轮询 effect
  // 的依赖变化触发（避免与本 effect 重复触发 refresh）。
  useEffect(() => {
    function handleVisibilityChange() {
      setIsDocumentVisible(!document.hidden);
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // 轮询（自递归 setTimeout；隐藏时暂停，重新可见时 effect 重跑立即刷新）
  useEffect(() => {
    if (!isDocumentVisible) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      await refresh();
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isDocumentVisible, refresh]);

  const chooseEscalation = useCallback(
    async (outcome: string) => {
      const run = runRef.current;
      if (!run) return;
      setBusy(true);
      setError(null);
      try {
        await window.desktop.graph.applyHumanDecision({
          kind: 'escalation',
          projectId,
          runId: run.runId,
          nodeId: 'RESEARCH_ESCALATION',
          outcome,
          idempotencyKey: crypto.randomUUID(),
        });
        await refresh();
      } catch (err) {
        setError(toSafeUserError(err, '提交选择失败').message);
      } finally {
        setBusy(false);
      }
    },
    [projectId, refresh],
  );

  const setSourceExclusion = useCallback(
    async (url: string, excluded: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const next = await window.desktop.research.setSourceExclusion({
          projectId,
          url,
          excluded,
        });
        setExclusions(next);
      } catch (err) {
        setError(toSafeUserError(err, '更新来源排除失败').message);
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const manualRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  return {
    phase,
    state,
    bundle,
    bundles,
    exclusions,
    hasApiKey,
    loading,
    error,
    busy,
    refresh: manualRefresh,
    actions: { chooseEscalation, setSourceExclusion },
  };
}
