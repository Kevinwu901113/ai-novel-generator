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
 * 阶段派生（B8/D-B8-2 起）不在本 hook：已上提到 App 的旅程探针
 * （journey/useJourney），本 hook 不再读 graph.getRunProgress、也不再有
 * onStageChange 回报。仍读 graph.listRuns 是因为升级决策要拿 runId。
 *
 * 轮询设计镜像 useTaskCenter（generationRef 竞态防护 + inFlightGenerationRef
 * 互斥锁 + document.hidden 可见性门控）与 useIntake（自递归 setTimeout，请求批量
 * 较重时不产生 setInterval 式请求堆叠）。
 *
 * 来源排除轮询回滚闪烁修复（复查随行）：poll 的 listSourceExclusions 在写入
 * 前发出、其 setExclusions 却在写入响应之后落地，会用旧列表覆盖刚更新的标记。
 * exclusionWriteSeqRef 在每次 setSourceExclusion 调用时自增；refresh() 在发起
 * listSourceExclusions 前记下当时的序号，Promise.all 落地后若序号已变
 * （说明期间有写入介入），则丢弃本轮 poll 取到的（可能过期的）列表，交给下一轮
 * poll 自然拿到写入后的正确列表，不产生"先对再错回再对"的闪烁。
 *
 * 决策后刷新被互斥锁吞掉修复（复查随行，镜像 journey/useJourney.ts 的
 * pendingRefreshRef 范式）：chooseEscalation 是 `await applyHumanDecision(...);
 * await refresh();`——若此刻 1.7s 轮询的某轮恰在途，旧实现里 refresh() 撞上
 * inFlightGenerationRef 互斥锁会直接 return，什么都不做；随后落地的在途 poll
 * 带回的是写入前的旧态，escalation 面板原样重现、按钮可点，用户以为没点上再点
 * 一次导致后端拒绝。修复：撞锁时不再直接放弃，而是把 resolve 函数存进
 * pendingRefreshWaitersRef 排队；在途请求收尾（finally）时若队列非空，立即补跑
 * 一轮并在补跑完成后才 resolve 队列里所有等待者。useJourney 同期也已改为
 * 同款排队 Promise（useBlueprint 的决策 busy 护航依赖其"落地后才 resolve"
 * 语义），两处实现保持镜像。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphRunSummaryDto, ResearchBundleDto, ResearchStateDto } from '@ai-novel/contracts';
import { deriveResearchPhase, type ResearchPhase } from './research-logic';
import { latestProjectRun } from '../intake/intake-logic';
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

export function useResearch(projectId: string): UseResearchReturn {
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

  // 竞态防护：projectId 切换时递增（同 useTaskCenter）
  const generationRef = useRef(0);
  const inFlightGenerationRef = useRef<number | null>(null);
  // 决策后刷新被互斥锁吞掉修复：撞上在途 poll 的 refresh() 调用方在此排队，
  // 在途请求收尾时补跑一轮，补跑完成后才 resolve 队列里的所有等待者
  // （而不是撞锁那一刻就放行——见文件头注释）。
  const pendingRefreshWaitersRef = useRef<Array<() => void>>([]);

  // 来源排除写入序号：每次 setSourceExclusion 调用自增，供 refresh() 判断
  // "本轮 poll 取到的 listSourceExclusions 响应是否可能已经过期"（回滚闪烁修复）。
  const exclusionWriteSeqRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const currentGen = generationRef.current;
    if (inFlightGenerationRef.current === currentGen) {
      // 在途请求是撞锁之前发出的，其响应必然反映不了本次调用之前刚发生的写入。
      // 排队等待——在途请求 finally 收尾时会补跑一轮，只有补跑落地后才 resolve。
      return new Promise<void>((resolve) => {
        pendingRefreshWaitersRef.current.push(resolve);
      });
    }
    inFlightGenerationRef.current = currentGen;

    try {
      setLoading(true);

      // 升级决策需要 runId（阶段派生已上提到 App 探针，D-B8-2）。
      const runs = await window.desktop.graph.listRuns({ projectId });
      if (generationRef.current !== currentGen) return;
      runRef.current = latestProjectRun(runs);

      // 回滚闪烁修复：在发起 listSourceExclusions 之前记下写入序号——如果
      // 这次 Promise.all 等待期间发生了一次 setSourceExclusion 写入，序号会
      // 变化，届时应丢弃本轮取到的（相对写入而言过期的）exclusionList。
      const exclusionSeqAtStart = exclusionWriteSeqRef.current;

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
      // 复查随行修复：任务已 FAILED 但节点尚未 settle 的瞬时窗口，兜底相位
      // 不应误报"尚未开始调研"（见 deriveResearchPhase 的 unsettled 分支）。
      const hasFailedResearchTask = taskList.some(
        (t) => t.taskType === 'RESEARCH_RUN' && t.status === 'FAILED',
      );

      setState(researchState);
      setBundles(allBundles);
      setBundle(currentBundle);
      if (exclusionWriteSeqRef.current === exclusionSeqAtStart) {
        setExclusions(exclusionList);
      }
      setHasApiKey(keyState.hasApiKey);
      setPhase(
        deriveResearchPhase(
          researchState,
          keyState.hasApiKey,
          pendingResearchTask,
          hasFailedResearchTask,
        ),
      );
      setError(null);
    } catch (err) {
      if (generationRef.current === currentGen) {
        setError(toSafeUserError(err, '加载调研状态失败').message);
      }
    } finally {
      if (generationRef.current === currentGen) {
        setLoading(false);
        inFlightGenerationRef.current = null;
        if (pendingRefreshWaitersRef.current.length > 0) {
          const waiters = pendingRefreshWaitersRef.current;
          pendingRefreshWaitersRef.current = [];
          // 补跑一轮；用 ref 转一手避免 refresh 在自身定义体内自引用（同
          // useJourney 的 refreshRef 写法）。补跑落地（含它自身可能触发的再次
          // 补跑，因为补跑本身也会先设置好互斥锁再执行）后才 resolve 队列。
          void refreshRef.current().finally(() => {
            waiters.forEach((resolve) => resolve());
          });
        }
      }
    }
  }, [projectId]);

  // refresh 需要在自身 finally 里再次调用自己（补跑被合并掉的那些请求），用 ref
  // 转一手避免 useCallback 自引用（镜像 useJourney.ts）。
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // projectId 切换：清空旧数据、递增 generation 使旧 in-flight 响应失效。
  // 必须先于下方轮询 effect 声明——React 按声明顺序提交 effect，本 effect 的
  // setup 需要在新一轮 poll() 发起 refresh() 之前完成 generation 递增，
  // 否则新请求捕获的 currentGen 会被本效应之后才发生的递增判定为过期而被丢弃。
  useEffect(() => {
    generationRef.current += 1;
    inFlightGenerationRef.current = null;
    runRef.current = null;
    exclusionWriteSeqRef.current = 0;
    // projectId 切出：旧 generation 的在途请求已判过期（finally 里的 generation
    // 检查会跳过补跑分支），排队等待补跑的调用方不会再被自然唤醒——在此兜底
    // resolve，避免 chooseEscalation 等调用方的 await refresh() 悬挂不返回。
    if (pendingRefreshWaitersRef.current.length > 0) {
      const waiters = pendingRefreshWaitersRef.current;
      pendingRefreshWaitersRef.current = [];
      waiters.forEach((resolve) => resolve());
    }
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
      // 卸载同理：排队的 promise 不唤醒会永远挂起（镜像 useJourney）。
      const unmountWaiters = pendingRefreshWaitersRef.current;
      pendingRefreshWaitersRef.current = [];
      unmountWaiters.forEach((resolve) => resolve());
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
      // 回滚闪烁修复：先自增写入序号，让任何已在途的 poll refresh() 之后落地
      // 时能识别出"我取到的列表可能比这次写入更旧"，从而放弃覆盖。
      exclusionWriteSeqRef.current += 1;
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
