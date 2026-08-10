/**
 * GE-4 Research 节点 executor（B5；设计见 docs/development/b5-research-wiring-design.md）。
 *
 * - RESEARCH_DECISION（sync）：读 idea（session goal）+ creationSpec（sections 摘要）→
 *   determineResearchDepth → outcome research_decision(none/light/deep)。
 * - RESEARCH_PLAN（sync marker）：图契约 noOut；问题计划的模型调用合并进 RESEARCH_RUN
 *   （镜像 B3 的 ASK_QUESTION 并入 SPEC_EXTRACT 先例；prompt:research-plan-v1 的独立
 *   运行时消费者暂缺，偏离记录于设计文档 D-B5-8）。
 * - RESEARCH_EXECUTE（task_backed）：prepareTask 从 snapshot 提取引导字段（depth、
 *   prior bundle、spec 版本、idea session），执行在 task-engine executeResearchRun。
 * - RESEARCH_VALIDATE（sync）：确定性校验 bundle（D-B5-4）→ outcome research_valid。
 *
 * RESEARCH_ESCALATION 是人工 Gate（parkHumanNodes + applyHumanDecision），不注册 executor。
 */

import type { ProjectDatabase } from '@ai-novel/database';
import type {
  Clock,
  IdGenerator,
  NodeExecutionInputContext,
  NodeExecutorDescriptor,
  NodeExecutorRunner,
  NodeOutput,
  NodeTaskSpec,
} from '@ai-novel/application';
import type { ExecutorRegistry } from '@ai-novel/application';
import { determineResearchDepth, isSafeSourceUrl } from '@ai-novel/research-engine';
import type { ResearchBundle } from '@ai-novel/research-engine';
import {
  RESEARCH_DECISION,
  RESEARCH_EXECUTE,
  RESEARCH_PLAN,
  RESEARCH_VALIDATE,
} from '@ai-novel/domain';

export interface ResearchExecutorContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: IdGenerator;
  clock: Clock;
}

// ── descriptors ───────────────────────────────────────────────────

export const RESEARCH_DECISION_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'research-decision-v1',
  executorVersion: 'v1',
  graphKind: 'project',
  nodeId: RESEARCH_DECISION as never,
  kind: 'sync',
  recoveryPolicy: 'replayable',
};

export const RESEARCH_PLAN_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'research-plan-v1',
  executorVersion: 'v1',
  graphKind: 'project',
  nodeId: RESEARCH_PLAN as never,
  kind: 'sync',
  recoveryPolicy: 'replayable',
};

export const RESEARCH_EXECUTE_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'research-execute-v1',
  executorVersion: 'v1',
  graphKind: 'project',
  nodeId: RESEARCH_EXECUTE as never,
  kind: 'task_backed',
  recoveryPolicy: 'settle_if_result',
};

export const RESEARCH_VALIDATE_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'research-validate-v1',
  executorVersion: 'v1',
  graphKind: 'project',
  nodeId: RESEARCH_VALIDATE as never,
  kind: 'sync',
  recoveryPolicy: 'replayable',
};

// ── snapshot 工具 ─────────────────────────────────────────────────

interface SnapshotShape {
  readonly artifacts?: Record<string, { readonly artifactId?: unknown } | null | undefined>;
  readonly outcomes?: Record<
    string,
    { readonly condition?: unknown; readonly value?: unknown } | null
  >;
}

function artifactIdFromSnapshot(snapshot: unknown, kind: string, required: boolean): string | null {
  const artifacts = (snapshot as SnapshotShape | null)?.artifacts;
  const artifactId = artifacts?.[kind]?.artifactId;
  if (typeof artifactId === 'string' && artifactId.length > 0) return artifactId;
  if (required) throw new Error(`input snapshot 缺少 ${kind} artifact ref`);
  return null;
}

function outcomeValueFromSnapshot(snapshot: unknown, nodeId: string): string {
  const outcomes = (snapshot as SnapshotShape | null)?.outcomes;
  const value = outcomes?.[nodeId]?.value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`input snapshot 缺少 ${nodeId} outcome`);
  }
  return value;
}

/**
 * creationSpec sections 摘要——仅供 determineResearchDepth 的关键词启发式。
 * 与 task-engine research-run.ts 的 summarizeSpecSections 有意不同：
 * 本函数取 premise/genre/themes/structure（题材信号，服务深度判定）；
 * 后者取 premise/genre/targetAudience/tone（写作要点，服务模型问题规划提示）。
 * 两者消费者不同，勿互相"对齐"。
 */
function specSummaryFromSections(sectionsJson: string): string {
  try {
    const s = JSON.parse(sectionsJson) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof s.premise === 'string') parts.push(s.premise);
    if (Array.isArray(s.genre)) parts.push((s.genre as string[]).join(' '));
    if (Array.isArray(s.themes)) parts.push((s.themes as string[]).join(' '));
    if (typeof s.structure === 'string') parts.push(s.structure);
    return parts.join('；');
  } catch {
    return '';
  }
}

// ── executors ─────────────────────────────────────────────────────

function researchDecisionExecute(
  ctx: ResearchExecutorContext,
  ectx: NodeExecutionInputContext,
): NodeOutput {
  const sessionId = artifactIdFromSnapshot(ectx.inputSnapshot, 'idea', true)!;
  const specVersionId = artifactIdFromSnapshot(ectx.inputSnapshot, 'creationSpec', true)!;
  const projDb = ctx.getProjectDb(ectx.projectId);
  const session = projDb.getGrillSessionRepository().getById(sessionId);
  if (!session || session.projectId !== ectx.projectId) {
    throw new Error('idea session 不存在或不属于本项目');
  }
  const specVersion = projDb
    .getCreationContractVersionRepository()
    .getById(ectx.projectId, specVersionId);
  if (!specVersion) throw new Error('creationSpec 版本不存在');

  const depth = determineResearchDepth({
    projectId: ectx.projectId,
    idea: session.goal,
    creationSpecSummary: specSummaryFromSections(specVersion.sectionsJson),
    requiresFactuality: false,
    questions: [],
  });
  return { outcome: { condition: 'research_decision', value: depth } };
}

function researchPlanExecute(): NodeOutput {
  // 图契约 noOut：问题计划由 RESEARCH_RUN 任务产出（D-B5-8）
  return {};
}

function researchExecutePrepareTask(ectx: NodeExecutionInputContext): NodeTaskSpec {
  const depth = outcomeValueFromSnapshot(ectx.inputSnapshot, RESEARCH_DECISION);
  if (depth !== 'light' && depth !== 'deep') {
    throw new Error(`RESEARCH_EXECUTE 不应在 depth=${depth} 下激活`);
  }
  const ideaSessionId = artifactIdFromSnapshot(ectx.inputSnapshot, 'idea', true)!;
  const creationSpecVersionId = artifactIdFromSnapshot(ectx.inputSnapshot, 'creationSpec', true)!;
  // D-B5-1：首次激活 researchBundle=null（全新调研）；回环激活携带上一轮 ref（复用问题计划）
  const priorBundleId = artifactIdFromSnapshot(ectx.inputSnapshot, 'researchBundle', false);
  return {
    taskType: 'RESEARCH_RUN',
    payloadJson: JSON.stringify({
      creationSpecVersionId,
      depth,
      ideaSessionId,
      priorBundleId,
    }),
  };
}

/** D-B5-4：确定性 bundle 校验规则 */
export function validateBundleDeterministic(bundle: ResearchBundle): boolean {
  if (bundle.questions.length < 1) return false;
  if (!bundle.questions.every((q) => q.sources.length >= 1)) return false;
  if (bundle.factNotes.length < 1) return false;
  for (const note of bundle.factNotes) {
    if (note.sourceUrls.length === 0) return false;
    if (!note.sourceUrls.every((u) => isSafeSourceUrl(u))) return false;
  }
  if (bundle.conclusion.trim().length === 0) return false;
  return true;
}

function researchValidateExecute(
  ctx: ResearchExecutorContext,
  ectx: NodeExecutionInputContext,
): NodeOutput {
  const bundleId = artifactIdFromSnapshot(ectx.inputSnapshot, 'researchBundle', true)!;
  const projDb = ctx.getProjectDb(ectx.projectId);
  const bundle = projDb.getResearchBundleRepository().getById(ectx.projectId, bundleId);
  if (!bundle) throw new Error('researchBundle 不存在');
  const valid = validateBundleDeterministic(bundle as ResearchBundle);
  return { outcome: { condition: 'research_valid', value: valid ? 'valid' : 'invalid' } };
}

// ── 注册 ──────────────────────────────────────────────────────────

/** 把 GE-4 Research executor 注册进生产 registry / runners（worker 启动时调用一次） */
export function registerResearchExecutors(
  registry: ExecutorRegistry,
  runners: Map<string, NodeExecutorRunner>,
  ctx: ResearchExecutorContext,
): void {
  registry.register(RESEARCH_DECISION_DESCRIPTOR);
  runners.set(RESEARCH_DECISION_DESCRIPTOR.executorId, {
    descriptor: RESEARCH_DECISION_DESCRIPTOR,
    execute: (ectx: NodeExecutionInputContext) => researchDecisionExecute(ctx, ectx),
  } as NodeExecutorRunner);

  registry.register(RESEARCH_PLAN_DESCRIPTOR);
  runners.set(RESEARCH_PLAN_DESCRIPTOR.executorId, {
    descriptor: RESEARCH_PLAN_DESCRIPTOR,
    execute: () => researchPlanExecute(),
  } as NodeExecutorRunner);

  registry.register(RESEARCH_EXECUTE_DESCRIPTOR);
  runners.set(RESEARCH_EXECUTE_DESCRIPTOR.executorId, {
    descriptor: RESEARCH_EXECUTE_DESCRIPTOR,
    prepareTask: (ectx: NodeExecutionInputContext) => researchExecutePrepareTask(ectx),
  } as NodeExecutorRunner);

  registry.register(RESEARCH_VALIDATE_DESCRIPTOR);
  runners.set(RESEARCH_VALIDATE_DESCRIPTOR.executorId, {
    descriptor: RESEARCH_VALIDATE_DESCRIPTOR,
    execute: (ectx: NodeExecutionInputContext) => researchValidateExecute(ctx, ectx),
  } as NodeExecutorRunner);
}
