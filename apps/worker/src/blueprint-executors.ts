/**
 * GE-5 BLUEPRINT_GENERATE 节点 executor（B7；设计见 docs/development/b7-blueprint-wiring-design.md）。
 *
 * BLUEPRINT_GENERATE（task_backed）：prepareTask 从 input snapshot 提取引导字段——
 * ideaSessionId / creationSpecVersionId（必需）、researchBundleId（可选，none /
 * skip_research 路径无 bundle）、researchSkippedByUser（D-B7-14）、rewriteAttempt
 * （← snapshot 里 budget.blueprintRewrite 计数，D-B7-4 最小方案）。执行在 task-engine
 * executeBlueprintGenerate。
 *
 * D-B7-14：`RESEARCH_ESCALATION` 已被追加进 `BLUEPRINT_GENERATE.input.requiresOutcomes`
 * （图契约追加声明，架构师明确授权）。用户在调研升级面板选 `skip_research` 时，即使
 * `artifacts.researchBundle` 非空（走到 escalation 时必然已有至少一次成功的
 * RESEARCH_EXECUTE），也不把该 bundle 当依据传给 executor——否则用户"跳过调研"的
 * 决定与"沿用当前调研"（use_current_research）在 prompt 层完全不可区分（BLK-2）。
 * `research_decision=none` 与 research_valid=valid 直达蓝图的路径都不经过
 * RESEARCH_ESCALATION，该 outcome 允许缺失（`computeNodeInputSnapshot` 对未产出的
 * requiresOutcomes 读 null，见 node-input.ts）。
 *
 * BLUEPRINT_USER_GATE / BLUEPRINT_ESCALATION 是人工 Gate（parkHumanNodes +
 * applyHumanDecision），不注册 executor；accept 的同事务副作用在 graph-run.ts（D-B7-1/2）。
 */

import type { ProjectDatabase } from '@ai-novel/database';
import type {
  Clock,
  IdGenerator,
  NodeExecutionInputContext,
  NodeExecutorDescriptor,
  NodeExecutorRunner,
  NodeTaskSpec,
} from '@ai-novel/application';
import type { ExecutorRegistry } from '@ai-novel/application';
import { BLUEPRINT_GENERATE, RESEARCH_ESCALATION } from '@ai-novel/domain';

export interface BlueprintExecutorContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: IdGenerator;
  clock: Clock;
}

// ── descriptor ────────────────────────────────────────────────────

export const BLUEPRINT_GENERATE_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'blueprint-generate-v1',
  executorVersion: 'v1',
  graphKind: 'project',
  nodeId: BLUEPRINT_GENERATE as never,
  kind: 'task_backed',
  recoveryPolicy: 'settle_if_result',
};

// ── snapshot 工具（照 research-executors.ts 的本地纪律：不同消费者不共享同一份）──

interface SnapshotShape {
  readonly artifacts?: Record<string, { readonly artifactId?: unknown } | null | undefined>;
  readonly budget?: Record<string, unknown>;
  readonly outcomes?: Record<string, { readonly value?: unknown } | null | undefined>;
}

function artifactIdFromSnapshot(snapshot: unknown, kind: string, required: boolean): string | null {
  const artifacts = (snapshot as SnapshotShape | null)?.artifacts;
  const artifactId = artifacts?.[kind]?.artifactId;
  if (typeof artifactId === 'string' && artifactId.length > 0) return artifactId;
  if (required) throw new Error(`input snapshot 缺少 ${kind} artifact ref`);
  return null;
}

/**
 * D-B7-14：按声明节点 id 读取 outcome 取值；该 outcome 允许缺失（对应节点这一轮未
 * 产出，例如 research_decision=none 路径根本不经过 RESEARCH_ESCALATION）——
 * `computeNodeInputSnapshot` 对未产出的 requiresOutcomes 项写 null，这里原样透传为
 * null，调用方按"未跳过"处理，不得因缺失而抛错。
 */
function outcomeValueFromSnapshot(snapshot: unknown, nodeId: string): string | null {
  const outcomes = (snapshot as SnapshotShape | null)?.outcomes;
  const entry = outcomes?.[nodeId];
  if (entry === null || entry === undefined) return null;
  const value = entry.value;
  return typeof value === 'string' ? value : null;
}

/** D-B7-4：改写次数取自 snapshot 里的 budget.blueprintRewrite（预算键计数，非独立字段） */
function budgetValueFromSnapshot(snapshot: unknown, key: string): number {
  const budget = (snapshot as SnapshotShape | null)?.budget;
  const value = budget?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

// ── executor ──────────────────────────────────────────────────────

function blueprintGeneratePrepareTask(ectx: NodeExecutionInputContext): NodeTaskSpec {
  const ideaSessionId = artifactIdFromSnapshot(ectx.inputSnapshot, 'idea', true)!;
  const creationSpecVersionId = artifactIdFromSnapshot(ectx.inputSnapshot, 'creationSpec', true)!;
  // D-B7-7：researchBundle 非必需——research_decision=none 路径没有 bundle。
  const researchBundleArtifactId = artifactIdFromSnapshot(
    ectx.inputSnapshot,
    'researchBundle',
    false,
  );
  // D-B7-14：用户在 RESEARCH_ESCALATION 显式选择 skip_research 时，即使
  // artifacts.researchBundle 非空，也不把它当作调研依据传给 executor——否则用户
  // "跳过调研"的决定不会真正生效（BLK-2）。RESEARCH_ESCALATION 未产出（none /
  // 直接 valid 路径）时读 null，按"未跳过"处理，researchBundleId 走正常逻辑。
  const researchEscalationOutcome = outcomeValueFromSnapshot(
    ectx.inputSnapshot,
    RESEARCH_ESCALATION,
  );
  const researchSkippedByUser = researchEscalationOutcome === 'skip_research';
  const researchBundleId = researchSkippedByUser ? null : researchBundleArtifactId;
  const rewriteAttempt = budgetValueFromSnapshot(ectx.inputSnapshot, 'blueprintRewrite');
  return {
    taskType: 'BLUEPRINT_GENERATE',
    payloadJson: JSON.stringify({
      creationSpecVersionId,
      ideaSessionId,
      researchBundleId,
      researchSkippedByUser,
      rewriteAttempt,
    }),
  };
}

// ── 注册 ──────────────────────────────────────────────────────────

/** 把 GE-5 BLUEPRINT_GENERATE executor 注册进生产 registry / runners（worker 启动时调用一次） */
export function registerBlueprintExecutors(
  registry: ExecutorRegistry,
  runners: Map<string, NodeExecutorRunner>,
  _ctx: BlueprintExecutorContext,
): void {
  registry.register(BLUEPRINT_GENERATE_DESCRIPTOR);
  runners.set(BLUEPRINT_GENERATE_DESCRIPTOR.executorId, {
    descriptor: BLUEPRINT_GENERATE_DESCRIPTOR,
    prepareTask: (ectx: NodeExecutionInputContext) => blueprintGeneratePrepareTask(ectx),
  } as NodeExecutorRunner);
}
