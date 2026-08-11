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
 *    `graph.applyHumanDecision`，成功后调用 onSettled 让 App 探针立即刷新
 *    （不等下一轮 poll，避免按钮点完仍显示旧态）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoryBlueprintDto } from '@ai-novel/contracts';
import { toSafeUserError } from '../safety/safe-error';

export interface BlueprintActions {
  /** BLUEPRINT_USER_GATE 决策（outcome ∈ accept | request_rewrite） */
  chooseGate(outcome: string): Promise<void>;
  /** BLUEPRINT_ESCALATION 决策（outcome 取 BLUEPRINT_ESCALATION_OPTIONS 之一） */
  chooseEscalation(outcome: string): Promise<void>;
}

export interface UseBlueprintReturn {
  readonly blueprint: StoryBlueprintDto | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly actions: BlueprintActions;
}

export function useBlueprint(
  projectId: string,
  blueprintRef: string | null,
  runId: string | null,
  onSettled: () => void,
): UseBlueprintReturn {
  const [blueprint, setBlueprint] = useState<StoryBlueprintDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  }, [projectId, blueprintRef]);

  const applyDecision = useCallback(
    async (kind: 'gate' | 'escalation', nodeId: string, outcome: string, failMessage: string) => {
      if (runId === null) return;
      setBusy(true);
      setError(null);
      try {
        await window.desktop.graph.applyHumanDecision({
          kind,
          projectId,
          runId,
          nodeId,
          outcome,
          idempotencyKey: crypto.randomUUID(),
        });
        onSettledRef.current();
      } catch (err) {
        setError(toSafeUserError(err, failMessage).message);
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

  return { blueprint, loading, error, busy, actions: { chooseGate, chooseEscalation } };
}
