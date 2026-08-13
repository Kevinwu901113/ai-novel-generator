/**
 * GE-6 章节生成节点 executor（B9；设计见 docs/development/b9-chapter-wiring-design.md）。
 *
 * 注册 ChapterGenerationGraphV1 上除人工 Gate 与 MANUSCRIPT_COMMIT 之外的全部节点：
 *
 * | 节点                                    | kind        | 任务类型          | 产出                     |
 * | --------------------------------------- | ----------- | ----------------- | ------------------------ |
 * | CHAPTER_PLAN                            | task_backed | CHAPTER_PLAN      | 场景计划（内部 artifact）|
 * | DRAFT                                   | task_backed | CHAPTER_DRAFT     | generationRun artifact   |
 * | CONTINUITY / STYLE / REQUIREMENT_CRITIC | task_backed | CHAPTER_CRITIQUE  | critique_verdict outcome |
 * | CRITIQUE_JOIN                           | sync        | —                 | 由 domain 聚合           |
 * | REWRITE                                 | task_backed | CHAPTER_REWRITE   | 新候选修订（noOut）      |
 * | CHAPTER_READY / CANCELLED / BLOCKED     | sync        | —                 | 终态（TD-029-4）         |
 *
 * D-B9-4：`CRITIQUE_JOIN` 的 executor 恒返回 `{}`。图定义给它的 `output` 是
 * `out('critique_verdict', null)`，但 `completeNode`（domain transitions）对带
 * `joinAggregationPolicy` 的节点**拒绝调用方传入的 outcome**，改为从三个 Critic 的
 * 已 succeeded 状态与产出确定性聚合（`aggregateJoinOutcome`，all_pass_or_needs_rewrite）。
 * 所以这里若"顺手"产出一个 verdict，settlement 会直接抛错——JOIN 只负责触发这次聚合。
 *
 * D-B9-5（销 TD-029-4）：Chapter Graph 的三个 TERMINAL 节点此前从未注册 executor。
 * `driveRun` 对 TERMINAL kind 没有豁免（见 project-terminal-executors.ts 顶部说明），
 * 未注册时 `onExecutorMissing` 会静默跳过——章节 run 走到终态节点会永远停在
 * `active` 而不真正终态化。GE-6 是第一个真正驱动到章节终态的批次，故在此补齐。
 *
 * MANUSCRIPT_COMMIT（COMMIT kind）**有意不注册**：写入权威稿件属 GE-7，且锁定不变量
 * 第 5 条要求"生成候选 ≠ 权威稿件"。用户在候选 Gate 选 accept 后，run 会停在
 * MANUSCRIPT_COMMIT active（能力缺口跳过，不失败、不终态化），等 GE-7 接线。
 * B10 的候选界面必须如实说明这一点，不得让 accept 看起来像"已保存"。
 */

import type { ProjectDatabase } from '@ai-novel/database';
import type {
  Clock,
  ExecutorRegistry,
  IdGenerator,
  NodeExecutionInputContext,
  NodeExecutorDescriptor,
  NodeExecutorRunner,
  NodeOutput,
  NodeTaskSpec,
} from '@ai-novel/application';
import {
  CHAPTER_GENERATION_GRAPH_V1,
  CHAPTER_PLAN,
  CONTINUITY_CRITIC,
  CRITIQUE_JOIN,
  DRAFT,
  REQUIREMENT_CRITIC,
  REWRITE,
  STYLE_CRITIC,
} from '@ai-novel/domain';

export interface ChapterExecutorContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: IdGenerator;
  clock: Clock;
}

// ── descriptors ───────────────────────────────────────────────────

export const CHAPTER_PLAN_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'chapter-plan-v1',
  executorVersion: 'v1',
  graphKind: 'chapter',
  nodeId: CHAPTER_PLAN as never,
  kind: 'task_backed',
  recoveryPolicy: 'settle_if_result',
};

export const CHAPTER_DRAFT_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'chapter-draft-v1',
  executorVersion: 'v1',
  graphKind: 'chapter',
  nodeId: DRAFT as never,
  kind: 'task_backed',
  recoveryPolicy: 'settle_if_result',
};

/** 三个 Critic 各自一个 descriptor（registry 按 nodeId 查找），执行体共用 */
export const CRITIC_DESCRIPTORS: ReadonlyArray<NodeExecutorDescriptor> = [
  {
    executorId: 'continuity-critic-v1',
    executorVersion: 'v1',
    graphKind: 'chapter',
    nodeId: CONTINUITY_CRITIC as never,
    kind: 'task_backed',
    recoveryPolicy: 'settle_if_result',
  },
  {
    executorId: 'style-critic-v1',
    executorVersion: 'v1',
    graphKind: 'chapter',
    nodeId: STYLE_CRITIC as never,
    kind: 'task_backed',
    recoveryPolicy: 'settle_if_result',
  },
  {
    executorId: 'requirement-critic-v1',
    executorVersion: 'v1',
    graphKind: 'chapter',
    nodeId: REQUIREMENT_CRITIC as never,
    kind: 'task_backed',
    recoveryPolicy: 'settle_if_result',
  },
];

export const CRITIQUE_JOIN_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'critique-join-v1',
  executorVersion: 'v1',
  graphKind: 'chapter',
  nodeId: CRITIQUE_JOIN as never,
  kind: 'sync',
  recoveryPolicy: 'replayable',
};

export const CHAPTER_REWRITE_DESCRIPTOR: NodeExecutorDescriptor = {
  executorId: 'chapter-rewrite-v1',
  executorVersion: 'v1',
  graphKind: 'chapter',
  nodeId: REWRITE as never,
  kind: 'task_backed',
  recoveryPolicy: 'settle_if_result',
};

// ── snapshot 工具（照 research/blueprint executor 的本地纪律：不跨消费者共享）──

interface SnapshotShape {
  readonly budget?: Record<string, unknown>;
}

/** 预算键计数（缺失读 0）——只用于 prompt 变异提示，不作身份用途 */
function budgetValueFromSnapshot(snapshot: unknown, key: string): number {
  const budget = (snapshot as SnapshotShape | null)?.budget;
  const value = budget?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * D-B9-2：payload 只带 prompt 变异提示（三个循环预算计数），不带任何身份字段——
 * 蓝图/章节/创作要求/候选正文一律由任务引擎按权威 execution.graphRunId 反查。
 *
 * 各节点声明的 `requiresBudgetKeys` 不同（图契约冻结）：未声明的键不会进 snapshot，
 * 读到 0 —— 这正是"该节点不关心这个循环"的正确语义，不需要也不应该绕过契约去补读。
 */
function chapterPayload(ectx: NodeExecutionInputContext): string {
  return JSON.stringify({
    rewriteAttempt: budgetValueFromSnapshot(ectx.inputSnapshot, 'rewrite'),
    candidateRewriteAttempt: budgetValueFromSnapshot(ectx.inputSnapshot, 'candidateRewrite'),
    regenerateAttempt: budgetValueFromSnapshot(ectx.inputSnapshot, 'regenerate'),
  });
}

function planPrepareTask(ectx: NodeExecutionInputContext): NodeTaskSpec {
  return { taskType: 'CHAPTER_PLAN', payloadJson: chapterPayload(ectx) };
}

function draftPrepareTask(ectx: NodeExecutionInputContext): NodeTaskSpec {
  return { taskType: 'CHAPTER_DRAFT', payloadJson: chapterPayload(ectx) };
}

function critiquePrepareTask(ectx: NodeExecutionInputContext): NodeTaskSpec {
  return { taskType: 'CHAPTER_CRITIQUE', payloadJson: chapterPayload(ectx) };
}

function rewritePrepareTask(ectx: NodeExecutionInputContext): NodeTaskSpec {
  return { taskType: 'CHAPTER_REWRITE', payloadJson: chapterPayload(ectx) };
}

/** D-B9-4：JOIN 只触发聚合，绝不自带 outcome（否则 completeNode 直接抛错） */
function critiqueJoinExecute(): NodeOutput {
  return {};
}

// ── 注册 ──────────────────────────────────────────────────────────

const CHAPTER_TERMINAL_NODE_IDS: ReadonlyArray<string> = CHAPTER_GENERATION_GRAPH_V1.nodes
  .filter((n) => n.kind === 'TERMINAL')
  .map((n) => n.id);

/** D-B9-5 / TD-029-4：Chapter Graph 三个 TERMINAL 节点的平凡 sync executor */
export function registerChapterTerminalExecutors(
  registry: ExecutorRegistry,
  runners: Map<string, NodeExecutorRunner>,
): void {
  for (const nodeId of CHAPTER_TERMINAL_NODE_IDS) {
    const descriptor: NodeExecutorDescriptor = {
      executorId: `chapter-terminal-${nodeId.toLowerCase()}-v1`,
      executorVersion: 'v1',
      graphKind: 'chapter',
      nodeId: nodeId as never,
      kind: 'sync',
      recoveryPolicy: 'replayable',
    };
    registry.register(descriptor);
    runners.set(descriptor.executorId, {
      descriptor,
      execute: () => ({}),
    } as NodeExecutorRunner);
  }
}

/** 把 GE-6 章节生成 executor 注册进生产 registry / runners（worker 启动时调用一次） */
export function registerChapterExecutors(
  registry: ExecutorRegistry,
  runners: Map<string, NodeExecutorRunner>,
  _ctx: ChapterExecutorContext,
): void {
  const taskBacked: ReadonlyArray<
    readonly [NodeExecutorDescriptor, (ectx: NodeExecutionInputContext) => NodeTaskSpec]
  > = [
    [CHAPTER_PLAN_DESCRIPTOR, planPrepareTask],
    [CHAPTER_DRAFT_DESCRIPTOR, draftPrepareTask],
    ...CRITIC_DESCRIPTORS.map(
      (d) =>
        [d, critiquePrepareTask] as readonly [
          NodeExecutorDescriptor,
          (ectx: NodeExecutionInputContext) => NodeTaskSpec,
        ],
    ),
    [CHAPTER_REWRITE_DESCRIPTOR, rewritePrepareTask],
  ];

  for (const [descriptor, prepareTask] of taskBacked) {
    registry.register(descriptor);
    runners.set(descriptor.executorId, {
      descriptor,
      prepareTask: (ectx: NodeExecutionInputContext) => prepareTask(ectx),
    } as NodeExecutorRunner);
  }

  registry.register(CRITIQUE_JOIN_DESCRIPTOR);
  runners.set(CRITIQUE_JOIN_DESCRIPTOR.executorId, {
    descriptor: CRITIQUE_JOIN_DESCRIPTOR,
    execute: () => critiqueJoinExecute(),
  } as NodeExecutorRunner);

  registerChapterTerminalExecutors(registry, runners);
}
