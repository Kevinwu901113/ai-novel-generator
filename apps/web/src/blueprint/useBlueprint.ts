/**
 * 蓝图正文数据 hook（B8）。
 *
 * 与 useResearch 的分工不同：蓝图**态**（gateActive / escalationActive / accepted /
 * blueprintInvalidated / rewriteUsed）由 App 的旅程探针（useJourney）统一轮询并以
 * props 下发，本 hook 只负责两件事：
 *
 * 1. **正文按需拉取（D-B8-5）**：`blueprint.getBlueprint` 仅在 blueprintRef 变化时
 *    拉一次并缓存。理由：章节上限 200 × goal 500 字 ≈ 百 KB 量级，进轮询循环不可接受。
 * 2. **人工决策写入**：gate（accept / request_rewrite）与 escalation（四选项）都走
 *    `graph.applyHumanDecision`，成功后 await onSettled（App 侧：解除视图锁定 +
 *    刷新探针，promise 在新状态落地后 resolve），busy 全程护航到新态渲染为止。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoryBlueprintDto } from '@ai-novel/contracts';
import { toSafeUserError } from '../safety/safe-error';

export interface BlueprintActions {
  /** BLUEPRINT_USER_GATE 决策（outcome ∈ accept | request_rewrite） */
  chooseGate(outcome: string): Promise<void>;
  /** BLUEPRINT_ESCALATION 决策（outcome 取 BLUEPRINT_ESCALATION_OPTIONS 之一） */
  chooseEscalation(outcome: string): Promise<void>;
  /**
   * 重试正文拉取（B8 独立复查）：正文只在 blueprintRef 变化时拉一次，瞬时故障后
   * 若无重试入口，gate 的确认按钮（藏在内容真值分支内）在当前屏永远不可达。
   */
  retryFetch(): void;
}

export interface UseBlueprintReturn {
  readonly blueprint: StoryBlueprintDto | null;
  readonly loading: boolean;
  /** 正文拉取错误（与决策错误分离展示） */
  readonly error: string | null;
  /**
   * 人工决策提交错误。与正文错误分开持有：决策错误只应展示在决策面板旁，
   * 相位切走（如决策其实已成功、探针刷新后进 ready）时随面板一起消失——
   * 否则会出现"就绪界面顶着一条永不消失的失败横幅"（B8 独立复查坐实）。
   */
  readonly decisionError: string | null;
  readonly busy: boolean;
  readonly actions: BlueprintActions;
}

export function useBlueprint(
  projectId: string,
  blueprintRef: string | null,
  runId: string | null,
  onSettled: () => void | Promise<void>,
): UseBlueprintReturn {
  const [blueprint, setBlueprint] = useState<StoryBlueprintDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetchAttempt, setFetchAttempt] = useState(0);

  // 竞态防护：projectId / blueprintRef 变化时递增，使旧 in-flight 响应失效
  const generationRef = useRef(0);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    generationRef.current += 1;
    const currentGen = generationRef.current;

    if (blueprintRef === null) {
      setBlueprint(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const dto = await window.desktop.blueprint.getBlueprint({
          projectId,
          blueprintId: blueprintRef,
        });
        if (cancelled || generationRef.current !== currentGen) return;
        setBlueprint(dto);
        setError(null);
      } catch (err) {
        if (cancelled || generationRef.current !== currentGen) return;
        setError(toSafeUserError(err, '加载蓝图失败').message);
      } finally {
        if (!cancelled && generationRef.current === currentGen) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, blueprintRef, fetchAttempt]);

  const applyDecision = useCallback(
    async (kind: 'gate' | 'escalation', nodeId: string, outcome: string, failMessage: string) => {
      if (runId === null) return;
      setBusy(true);
      setDecisionError(null);
      try {
        await window.desktop.graph.applyHumanDecision({
          kind,
          projectId,
          runId,
          nodeId,
          outcome,
          idempotencyKey: crypto.randomUUID(),
        });
        // busy 必须护到探针的新状态落地为止（B8 独立复查坐实的 blocker）：写入
        // 成功后旧态仍在渲染，提前放开 busy 会让决策按钮以旧态重新可点——双击
        // 或"没反应再点一次"必然撞后端拒绝，且那条错误会盖在其实已成功的操作上。
        // onSettled（App 侧）返回的 promise 在探针刷新落地后才 resolve。
        await onSettledRef.current();
      } catch (err) {
        setDecisionError(toSafeUserError(err, failMessage).message);
      } finally {
        setBusy(false);
      }
    },
    [projectId, runId],
  );

  const chooseGate = useCallback(
    (outcome: string) => applyDecision('gate', 'BLUEPRINT_USER_GATE', outcome, '提交蓝图确认失败'),
    [applyDecision],
  );

  const chooseEscalation = useCallback(
    (outcome: string) =>
      applyDecision('escalation', 'BLUEPRINT_ESCALATION', outcome, '提交选择失败'),
    [applyDecision],
  );

  const retryFetch = useCallback(() => {
    setFetchAttempt((n) => n + 1);
  }, []);

  return {
    blueprint,
    loading,
    error,
    decisionError,
    busy,
    actions: { chooseGate, chooseEscalation, retryFetch },
  };
}
