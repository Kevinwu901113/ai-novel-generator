/**
 * App 级旅程探针（B8，D-B8-2）。
 *
 * 由 App 自持一条轻量循环读取 Graph 位置与蓝图态，独立于任何 Region 计算
 * frontierStage——Region 不再经 onStageChange 回报阶段（结构性消除"没有 Region
 * 该被挂载时阶段无人回报"这一类 bug，见 journey-logic.deriveFrontierStage 注释）。
 *
 * 读取内容（每轮）：
 * - graph.listRuns → 最新 project run（各 Region 的写操作也需要 runId）；
 * - graph.getRunProgress → 活跃节点（非终态时的 frontier 依据）；
 * - blueprint.getState → 蓝图态（同时供 BlueprintRegion 以 props 消费，
 *   故 BlueprintRegion 自身不再轮询状态，只在 blueprintRef 变化时拉一次正文，D-B8-5）。
 *
 * 终态且无蓝图 artifact 时**额外**读一次 research.getResearchState，用于 D-B8-3
 * 的 artifact 回推（终态 activeNodes 恒空）。该分支只在终态命中，非终态零成本。
 *
 * 轮询开销的如实说明（对 D-B8-2 设计预期的偏离）：设计原本预期"Region 不再重复
 * 拉 run/progress，故总量不增"。实际实现里 useIntake 仍需 progress 派生自己的
 * 访谈相位、useResearch 仍需 run 提交升级决策，把它们改成纯 props 驱动是一次
 * 跨 B4/B6 的大改，风险高于收益。因此实际是：viewStage 为 idea/research 时
 * 净增约一轮 blueprint.getState；viewStage 为 blueprint 时反而更少（BlueprintRegion
 * 不轮询）。D-B6-7"任一时刻只有一条 Region 轮询循环"的约束不变。
 *
 * 竞态防护镜像 useResearch/useTaskCenter：generationRef + inFlightGenerationRef
 * 互斥 + document.hidden 门控。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BlueprintStateDto,
  GraphProgressProjectionDto,
  GraphRunSummaryDto,
} from '@ai-novel/contracts';
import { latestProjectRun, type JourneyStage } from '../intake/intake-logic';
import { deriveFrontierStage } from './journey-logic';
import { toSafeUserError } from '../safety/safe-error';

const POLL_INTERVAL_MS = 1700;

export interface UseJourneyReturn {
  readonly run: GraphRunSummaryDto | null;
  readonly progress: GraphProgressProjectionDto | null;
  readonly blueprintState: BlueprintStateDto | null;
  /**
   * 推进阶段（Graph 真实位置）。瞬时态（progress 未取到 / 无活跃节点）保留上一次
   * 已知阶段，不回退——避免节点间过渡导致的阶段闪烁。
   */
  readonly frontierStage: JourneyStage;
  readonly loading: boolean;
  readonly error: string | null;
  /**
   * 立即刷新。返回的 promise 在**本次刷新的状态真正落地后**才 resolve——若撞上
   * 在途 poll（其结果必然是写入前的旧态），会排队等补跑那轮完成。调用方
   * （useBlueprint 的决策 busy 护航）依赖这一语义，不得提前 resolve。
   */
  readonly refresh: () => Promise<void>;
}

export function useJourney(projectId: string | null): UseJourneyReturn {
  const [run, setRun] = useState<GraphRunSummaryDto | null>(null);
  const [progress, setProgress] = useState<GraphProgressProjectionDto | null>(null);
  const [blueprintState, setBlueprintState] = useState<BlueprintStateDto | null>(null);
  const [frontierStage, setFrontierStage] = useState<JourneyStage>('idea');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDocumentVisible, setIsDocumentVisible] = useState(() => !document.hidden);

  const generationRef = useRef(0);
  const inFlightGenerationRef = useRef<number | null>(null);
  // 写入后的刷新请求若撞上在途 poll，会被互斥锁直接丢掉——而那条在途请求是在
  // 写入之前发出的，拿回来的必然是旧态，用户点完按钮要等满一个轮询周期才看到
  // 变化。故排队等待：在途请求收尾时立即补跑一轮，排队的 promise 在**补跑那轮
  // 落地后**才 resolve（useBlueprint 的决策 busy 护航依赖该语义）。
  const pendingWaitersRef = useRef<Array<() => void>>([]);

  const refresh = useCallback(async (): Promise<void> => {
    if (projectId === null) return;
    const currentGen = generationRef.current;
    if (inFlightGenerationRef.current === currentGen) {
      return new Promise<void>((resolve) => {
        pendingWaitersRef.current.push(resolve);
      });
    }
    inFlightGenerationRef.current = currentGen;

    try {
      setLoading(true);
      const runs = await window.desktop.graph.listRuns({ projectId });
      if (generationRef.current !== currentGen) return;
      const latest = latestProjectRun(runs);

      const [runProgress, bpState] = await Promise.all([
        latest
          ? window.desktop.graph.getRunProgress({ projectId, runId: latest.runId })
          : Promise.resolve(null),
        window.desktop.blueprint.getState({ projectId }),
      ]);
      if (generationRef.current !== currentGen) return;

      // D-B8-3 的 artifact 回推只在终态、且无蓝图 artifact 时才需要调研态
      // （有蓝图就已经能定阶段），故这次读取不是每轮开销。
      const needsResearchFallback = latest?.terminalStatus != null && bpState.blueprintRef === null;
      const researchState = needsResearchFallback
        ? await window.desktop.research.getResearchState({ projectId })
        : null;
      if (generationRef.current !== currentGen) return;

      setRun(latest);
      setProgress(runProgress);
      setBlueprintState(bpState);

      const nextStage = deriveFrontierStage({
        run: latest,
        progress: runProgress,
        hasBlueprintArtifact: bpState.blueprintRef !== null,
        hasResearchArtifact: researchState?.bundleRef != null,
        blueprintAccepted: bpState.accepted,
      });
      // null = 瞬时态，保留上一次已知阶段
      if (nextStage !== null) setFrontierStage(nextStage);
      setError(null);
    } catch (err) {
      if (generationRef.current === currentGen) {
        setError(toSafeUserError(err, '加载创作旅程状态失败').message);
      }
    } finally {
      if (generationRef.current === currentGen) {
        setLoading(false);
        inFlightGenerationRef.current = null;
        if (pendingWaitersRef.current.length > 0) {
          // 排队者要的是"写入后的新态"，本轮（写入前发出）满足不了——补跑一轮，
          // 落地后（无论成败）唤醒当时已在排队的这批；补跑期间新加入的排队者
          // 会在补跑那轮的 finally 里再触发下一轮。
          const waiters = pendingWaitersRef.current;
          pendingWaitersRef.current = [];
          void refreshRef.current().finally(() => {
            for (const wake of waiters) wake();
          });
        }
      }
    }
  }, [projectId]);

  // refresh 需要在自身 finally 里再次调用自己（补跑被合并掉的那次），用 ref
  // 转一手避免 useCallback 自引用。
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // projectId 切换：清空旧数据并递增 generation 使旧 in-flight 响应失效。
  // 必须先于轮询 effect 声明（同 useResearch：effect 按声明顺序提交）。
  useEffect(() => {
    generationRef.current += 1;
    inFlightGenerationRef.current = null;
    // 项目切换/卸载时旧 generation 的 finally 不会再执行补跑，排队者若不在这里
    // 唤醒会永远挂起（await 它的决策 busy 就永远收不了尾）。直接唤醒：调用方的
    // generation 守卫会自行丢弃过期结果。
    const staleWaiters = pendingWaitersRef.current;
    pendingWaitersRef.current = [];
    for (const wake of staleWaiters) wake();
    setRun(null);
    setProgress(null);
    setBlueprintState(null);
    setFrontierStage('idea');
    setError(null);
    setLoading(false);
    return () => {
      generationRef.current += 1;
      // 卸载同理：不唤醒的话排队的 promise 会永远挂起。
      const unmountWaiters = pendingWaitersRef.current;
      pendingWaitersRef.current = [];
      for (const wake of unmountWaiters) wake();
    };
  }, [projectId]);

  useEffect(() => {
    function handleVisibilityChange() {
      setIsDocumentVisible(!document.hidden);
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (projectId === null) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      await refresh();
      // 冷启动/切项目时即使窗口暂在后台也必须至少读取一次，否则已完成项目会一直
      // 假停在“想法”，且后续阶段全部不可点击。后台只暂停后续轮询；窗口恢复可见
      // 后 isDocumentVisible 变化会重建 effect 并立即再读一轮。
      if (!cancelled && isDocumentVisible) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, isDocumentVisible, refresh]);

  const manualRefresh = useCallback(() => refresh(), [refresh]);

  return { run, progress, blueprintState, frontierStage, loading, error, refresh: manualRefresh };
}
