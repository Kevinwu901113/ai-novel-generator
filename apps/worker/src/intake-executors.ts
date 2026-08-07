/**
 * GE-3 Idea Intake 节点 executor（B3；设计见 docs/development/b3-intake-wiring-design.md）。
 *
 * - IDEA_CAPTURE（sync）：读 project_metadata.initial_idea（权威源），创建并启动一个新的
 *   intake session（每次执行新建，见下），idea artifact = 该 session 行（artifactId=sessionId）。
 *   **每次执行都新建 session**：provenance (kind, artifactId) 是归属唯一闸门，跨 activation /
 *   跨 run 复用旧 session 会撞闸门；新建的代价只是可能留下未使用的 ACTIVE 会话（无害，
 *   下游一律经 artifact ref 取 session，不做"最新 ACTIVE"环境查找）。
 * - ASK_QUESTION（sync）：从 input snapshot 的 idea artifact ref 取 sessionId，取最早的
 *   PENDING 问题 markAsked；NodeOutput 为空（图契约 noOut）。模型调用已合并进 SPEC_EXTRACT。
 * - SPEC_EXTRACT（task_backed）：prepareTask 纯函数，payload 只带 {sessionId}
 *   （prompt 文本不入库，D-B3-4）；实际执行在 task-engine executeSpecExtract。
 *
 * COLLECT_ANSWER / INTAKE_ESCALATION 是人工 Gate（parkHumanNodes + applyHumanDecision），
 * 不注册 executor。
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
import {
  createGrillSession,
  markQuestionAsked,
  startGrillSession,
  type ExecutorRegistry,
} from '@ai-novel/application';
import { ASK_QUESTION, IDEA_CAPTURE, SPEC_EXTRACT } from '@ai-novel/domain';
import { buildGrillSessionDeps } from './grill-handlers.js';

export interface IntakeExecutorContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: IdGenerator;
  clock: Clock;
}

// ── descriptors ───────────────────────────────────────────────────

export const IDEA_CAPTURE_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'idea-capture-v1',
  executorVersion: 'v1',
  graphKind: 'project',
  nodeId: IDEA_CAPTURE as never,
  kind: 'sync',
  recoveryPolicy: 'replayable',
};

export const ASK_QUESTION_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'ask-question-v1',
  executorVersion: 'v1',
  graphKind: 'project',
  nodeId: ASK_QUESTION as never,
  kind: 'sync',
  recoveryPolicy: 'replayable',
};

export const SPEC_EXTRACT_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'spec-extract-v1',
  executorVersion: 'v1',
  graphKind: 'project',
  nodeId: SPEC_EXTRACT as never,
  kind: 'task_backed',
  recoveryPolicy: 'settle_if_result',
};

// ── snapshot 工具 ─────────────────────────────────────────────────

/** 从 input snapshot 取 idea artifact 的 sessionId（contract requiresArtifacts:['idea']） */
function ideaSessionIdFromSnapshot(snapshot: unknown): string {
  const artifacts = (snapshot as { artifacts?: { idea?: { artifactId?: unknown } | null } } | null)
    ?.artifacts;
  const artifactId = artifacts?.idea?.artifactId;
  if (typeof artifactId !== 'string' || artifactId.length === 0) {
    throw new Error('input snapshot 缺少 idea artifact ref');
  }
  return artifactId;
}

// ── executors ─────────────────────────────────────────────────────

function ideaCaptureExecute(
  ctx: IntakeExecutorContext,
  ectx: NodeExecutionInputContext,
): NodeOutput {
  const projDb = ctx.getProjectDb(ectx.projectId);
  const meta = projDb.getProjectMetadataRepository().get();
  const initialIdea = meta?.initialIdea?.trim();
  if (!initialIdea) {
    throw new Error('项目缺少初始想法（project_metadata.initial_idea）');
  }
  const grillDeps = buildGrillSessionDeps(projDb, {
    getProjectDb: ctx.getProjectDb,
    idGenerator: ctx.idGenerator,
    clock: ctx.clock,
  });
  const session = createGrillSession(grillDeps, {
    projectId: ectx.projectId,
    goal: initialIdea,
  });
  const started = startGrillSession(grillDeps, {
    sessionId: session.id,
    expectedVersion: session.version,
  });
  return {
    artifact: {
      kind: 'idea',
      artifactId: started.id,
      producerNodeId: ectx.nodeId as never,
      version: 1,
    },
  };
}

function askQuestionExecute(
  ctx: IntakeExecutorContext,
  ectx: NodeExecutionInputContext,
): NodeOutput {
  const sessionId = ideaSessionIdFromSnapshot(ectx.inputSnapshot);
  const projDb = ctx.getProjectDb(ectx.projectId);
  const grillDeps = buildGrillSessionDeps(projDb, {
    getProjectDb: ctx.getProjectDb,
    idGenerator: ctx.idGenerator,
    clock: ctx.clock,
  });
  const session = grillDeps.sessionRepo.getById(sessionId);
  if (!session || session.projectId !== ectx.projectId) {
    throw new Error('intake session 不存在或不属于本项目');
  }
  const pending = grillDeps.questionRepo
    .listBySession(sessionId)
    .filter((q) => q.status === 'PLANNED')
    .sort((a, b) => a.sequence - b.sequence);
  if (pending.length === 0) {
    // 图语义保证 ASK_QUESTION 只在 SPEC_EXTRACT ask_more（已写入问题）后激活；
    // 无 PLANNED 问题属数据不变量破坏，fail-fast 交给 EXECUTOR_ERROR fail-closed
    throw new Error('没有待提出的追问问题');
  }
  markQuestionAsked(grillDeps, {
    sessionId,
    expectedVersion: session.version,
    questionId: pending[0].id,
  });
  // 图契约 noOut：不产 outcome、不产 artifact
  return {};
}

function specExtractPrepareTask(ectx: NodeExecutionInputContext): NodeTaskSpec {
  const sessionId = ideaSessionIdFromSnapshot(ectx.inputSnapshot);
  return {
    taskType: 'SPEC_EXTRACT',
    payloadJson: JSON.stringify({ sessionId }),
  };
}

// ── 注册 ──────────────────────────────────────────────────────────

/** 把 GE-3 Intake executor 注册进生产 registry / runners（worker 启动时调用一次） */
export function registerIntakeExecutors(
  registry: ExecutorRegistry,
  runners: Map<string, NodeExecutorRunner>,
  ctx: IntakeExecutorContext,
): void {
  registry.register(IDEA_CAPTURE_DESCRIPTOR);
  runners.set(IDEA_CAPTURE_DESCRIPTOR.executorId, {
    descriptor: IDEA_CAPTURE_DESCRIPTOR,
    execute: (ectx: NodeExecutionInputContext) => ideaCaptureExecute(ctx, ectx),
  } as NodeExecutorRunner);

  registry.register(ASK_QUESTION_DESCRIPTOR);
  runners.set(ASK_QUESTION_DESCRIPTOR.executorId, {
    descriptor: ASK_QUESTION_DESCRIPTOR,
    execute: (ectx: NodeExecutionInputContext) => askQuestionExecute(ctx, ectx),
  } as NodeExecutorRunner);

  registry.register(SPEC_EXTRACT_DESCRIPTOR);
  runners.set(SPEC_EXTRACT_DESCRIPTOR.executorId, {
    descriptor: SPEC_EXTRACT_DESCRIPTOR,
    prepareTask: (ectx: NodeExecutionInputContext) => specExtractPrepareTask(ectx),
  } as NodeExecutorRunner);
}
