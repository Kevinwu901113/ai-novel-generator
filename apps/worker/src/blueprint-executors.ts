/**
 * GE-5 BLUEPRINT_GENERATE 节点 executor（B7；设计见 docs/development/b7-blueprint-wiring-design.md）。
 *
 * BLUEPRINT_GENERATE（task_backed）：prepareTask 从 input snapshot 提取引导字段——
 * ideaSessionId / creationSpecVersionId（必需）、researchBundleId（可选，none /
 * skip_research 路径无 bundle）、rewriteAttempt（← snapshot 里 budget.blueprintRewrite
 * 计数，D-B7-4 最小方案）。执行在 task-engine executeBlueprintGenerate。
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
import { BLUEPRINT_GENERATE } from '@ai-novel/domain';

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
}

function artifactIdFromSnapshot(snapshot: unknown, kind: string, required: boolean): string | null {
  const artifacts = (snapshot as SnapshotShape | null)?.artifacts;
  const artifactId = artifacts?.[kind]?.artifactId;
  if (typeof artifactId === 'string' && artifactId.length > 0) return artifactId;
  if (required) throw new Error(`input snapshot 缺少 ${kind} artifact ref`);
  return null;
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
  // D-B7-7：researchBundle 非必需——research_decision=none 与 escalation 的
  // skip_research 路径没有 bundle。
  const researchBundleId = artifactIdFromSnapshot(ectx.inputSnapshot, 'researchBundle', false);
  const rewriteAttempt = budgetValueFromSnapshot(ectx.inputSnapshot, 'blueprintRewrite');
  return {
    taskType: 'BLUEPRINT_GENERATE',
    payloadJson: JSON.stringify({
      creationSpecVersionId,
      ideaSessionId,
      researchBundleId,
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
