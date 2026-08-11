/**
 * GraphRunService —— Durable Graph Runtime Kernel（GE-1）。
 *
 * 硬不变量：任何状态变化只走同一条管线，且始终在单个 BEGIN IMMEDIATE 事务内：
 *
 *   load run state（含 expectedVersion）→ assertValidTransitionState(graph, state)
 *   → 恰好调用一个纯 domain transition
 *   → validateGraphRunState(graph, next) 必须为空
 *   → saveWithCas（UPDATE … WHERE id=? AND expected_version=?）→ 记录幂等命令 → COMMIT
 *
 * 服务绝不手工拼装状态、绝不原地修改、绝不在无 CAS 时持久化。
 * 执行器（Task Engine / Model Gateway / Research）的结果必须回到本服务，经 Domain transition 才能推进 Graph。
 */

import type {
  AnyIdeaToNovelGraphV1,
  AnyIdeaToNovelRunState,
  ArtifactRef,
  ChapterGenerationGraphV1,
  GraphNodeOutcome,
  HumanDecisionInput,
  IdeaToNovelProjectGraphV1,
  IdeaToNovelProjectRunState,
} from '@ai-novel/domain';
import {
  BLUEPRINT_ESCALATION,
  BLUEPRINT_USER_GATE,
  CHAPTER_GENERATION_GRAPH_ID,
  IDEA_TO_NOVEL_PROJECT_GRAPH_ID,
  applyArtifactChange as applyArtifactChangeTransition,
  applyNodeFailure as applyNodeFailureTransition,
  applyHumanDecision as applyHumanDecisionTransition,
  applyNodeSuccess as applyNodeSuccessTransition,
  artifactRef,
  createAnswerReceiptId,
  createBlueprintChapterId,
  createChapterInitialRunState,
  createCreationSpecVersionId,
  createGraphNodeId,
  createProjectId,
  createProjectInitialRunState,
  createResearchBundleArtifactId,
  createStoryBlueprintArtifactId,
  createWorkflowRunId,
  isGraphConditionName,
  isGraphConditionOutcome,
  requestHumanDecision as requestHumanDecisionTransition,
  validateGraphRunState,
} from '@ai-novel/domain';
import type { Clock, IdGenerator } from './types.js';
import { canonicalJson } from './canonical-json.js';
import type {
  GraphRunRepositoryPort,
  GraphRunStateRecord,
  GraphRunTransactionPort,
  GraphRunTransactionRepositories,
} from './graph-run-types.js';
import {
  GraphRunIdempotencyConflictError,
  GraphRunNotFoundError,
  GraphRunStateConflictError,
  GraphRunValidationError,
  GraphRunVersionConflictError,
} from './graph-run-errors.js';

// ── 依赖 ────────────────────────────────────────────────────────

export interface GraphRunDeps {
  idGenerator: IdGenerator;
  clock: Clock;
  /** 载荷指纹（幂等命令）。基础设施注入 sha256Hex。 */
  hashPayload: (payload: string) => string;
  tx: GraphRunTransactionPort;
  projectGraph: IdeaToNovelProjectGraphV1;
  chapterGraph: ChapterGenerationGraphV1;
}

// ── 输入类型 ────────────────────────────────────────────────────

export interface CreateProjectRunInput {
  readonly projectId: string;
  readonly idempotencyKey: string;
}

export interface CreateChapterRunInput {
  readonly projectId: string;
  readonly creationSpecVersionId: string;
  readonly researchBundleId: string | null;
  readonly storyBlueprintId: string;
  readonly blueprintChapterId: string;
  readonly idempotencyKey: string;
}

export interface GetRunProgressInput {
  readonly projectId: string;
  readonly runId: string;
}

/** advanceNode 的成功产物（二选一；均非必填） */
export interface AdvanceNodeInput {
  readonly projectId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly outcome?: { readonly condition: string; readonly value: string };
  readonly artifactRef?: { readonly kind: string; readonly artifactId: string };
  readonly idempotencyKey: string;
}

export interface FailNodeInput {
  readonly projectId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly idempotencyKey: string;
}

export interface RequestHumanDecisionInput {
  readonly projectId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly idempotencyKey: string;
}

/** 人工决策输入（闭合判别联合；kind 为单字面量以便 TS 收窄） */
export type ApplyHumanDecisionInput =
  | {
      readonly kind: 'intake_answer';
      readonly runId: string;
      readonly nodeId: string;
      readonly sessionId: string;
      readonly questionId: string;
      readonly text: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: 'intake_skip';
      readonly runId: string;
      readonly nodeId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: 'intake_finish';
      readonly runId: string;
      readonly nodeId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: 'gate' | 'escalation';
      readonly runId: string;
      readonly nodeId: string;
      readonly outcome: string;
      readonly idempotencyKey: string;
    };

export interface ListRunsInput {
  readonly projectId: string;
}

/** transition 结果 */
export interface GraphRunTransitionResult {
  readonly run: AnyIdeaToNovelRunState;
  readonly deduped: boolean;
}

// ── 内部辅助 ────────────────────────────────────────────────────

function resolveGraph(deps: GraphRunDeps, graphId: string): AnyIdeaToNovelGraphV1 {
  if (graphId === IDEA_TO_NOVEL_PROJECT_GRAPH_ID) return deps.projectGraph;
  if (graphId === CHAPTER_GENERATION_GRAPH_ID) return deps.chapterGraph;
  throw new GraphRunValidationError(`未知 graphId: ${graphId}`);
}

function loadRun(graphRunRepo: GraphRunRepositoryPort, runId: string): GraphRunStateRecord {
  const record = graphRunRepo.getById(runId);
  if (!record) throw new GraphRunNotFoundError(runId);
  return record;
}

function assertValidState(graph: AnyIdeaToNovelGraphV1, state: AnyIdeaToNovelRunState): void {
  const errors = validateGraphRunState(graph, state);
  if (errors.length > 0) {
    throw new GraphRunValidationError(
      `transition 产出非法状态: ${errors.map((e) => e.message).join('; ')}`,
    );
  }
}

/** 把 domain 抛出的普通 Error 转为应用错误（fail-closed） */
function toGraphRunError(err: unknown): Error {
  if (err instanceof GraphRunValidationError) return err;
  if (err instanceof Error) {
    return new GraphRunStateConflictError(err.message);
  }
  return new GraphRunStateConflictError(String(err));
}

/** 把 advanceNode 的成功产物转成 domain opts（校验闭合枚举/artifact 槽位） */
function buildSuccessOpts(
  graph: AnyIdeaToNovelGraphV1,
  nodeId: string,
  input: AdvanceNodeInput,
): { outcome?: GraphNodeOutcome; artifactRef?: ArtifactRef } {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new GraphRunValidationError(`节点不存在: ${nodeId}`);

  const opts: { outcome?: GraphNodeOutcome; artifactRef?: ArtifactRef } = {};
  if (input.outcome !== undefined) {
    const { condition, value } = input.outcome;
    if (!isGraphConditionName(condition)) {
      throw new GraphRunValidationError(`未知条件: ${condition}`);
    }
    if (!isGraphConditionOutcome(condition, value)) {
      throw new GraphRunValidationError(`非法 outcome: ${condition}=${String(value)}`);
    }
    opts.outcome = { condition, value } as GraphNodeOutcome;
  }
  if (input.artifactRef !== undefined) {
    const { kind, artifactId } = input.artifactRef;
    if (!graph.artifactKinds.includes(kind as never)) {
      throw new GraphRunValidationError(`artifact kind 不在本图槽位: ${kind}`);
    }
    opts.artifactRef = artifactRef(kind as never, artifactId);
  }
  return opts;
}

/**
 * 在 applyNodeSuccess 之后，同一事务内把新 frontier 中的人工交互节点
 * （CLARIFY_ANSWER / USER_GATE）链式挂起为 waiting_for_human。
 * 若多个人类节点同时激活（图设计违规），第二次 requestHumanDecision 抛错 → fail-closed。
 */
export function parkHumanNodes(
  graph: AnyIdeaToNovelGraphV1,
  state: AnyIdeaToNovelRunState,
): AnyIdeaToNovelRunState {
  let current = state;
  for (const node of graph.nodes) {
    if (current.nodeStatuses[node.id] !== 'active') continue;
    if (node.kind !== 'CLARIFY_ANSWER' && node.kind !== 'USER_GATE') continue;
    if (node.humanDecisionType === undefined) continue;
    current = requestHumanDecisionTransition(graph, current, node.id, node.humanDecisionType);
  }
  return current;
}

// ── 共享 transition 执行器（内核与 NodeSettlementService 共用）──

/**
 * 在**已打开的**事务内执行一次 Domain transition（RW-1 起内核与 settlement 共用）。
 *
 * 管线：幂等检查（commandLog）→ load run → validate → 纯 domain transition →
 * validate → saveWithCas（CAS）→ 写幂等 command 记录。
 *
 * 约束：调用方必须已经持有 `repos`（即处于 `deps.tx.runInTransaction` 回调内）。
 * 绝不手工拼装状态、绝不在无 CAS 时持久化。
 */
export function applyTransitionInTransaction(
  deps: GraphRunDeps,
  repos: GraphRunTransactionRepositories,
  runId: string,
  commandType: string,
  idempotencyKey: string,
  canonicalPayload: unknown,
  transition: (
    graph: AnyIdeaToNovelGraphV1,
    state: AnyIdeaToNovelRunState,
  ) => AnyIdeaToNovelRunState,
): GraphRunTransitionResult {
  const now = deps.clock.now();
  const payloadHash = deps.hashPayload(canonicalJson(canonicalPayload));

  const existing = repos.commandLog.get(idempotencyKey);
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new GraphRunIdempotencyConflictError();
    }
    return { run: loadRun(repos.graphRunRepo, runId).state, deduped: true };
  }

  const record = loadRun(repos.graphRunRepo, runId);
  const graph = resolveGraph(deps, record.state.graphId);

  let next: AnyIdeaToNovelRunState;
  try {
    next = transition(graph, record.state);
  } catch (err) {
    throw toGraphRunError(err);
  }
  assertValidState(graph, next);

  const ok = repos.graphRunRepo.saveWithCas(runId, record.expectedVersion, next, now);
  if (!ok) throw new GraphRunVersionConflictError(runId);
  repos.commandLog.insert({
    id: idempotencyKey,
    runId,
    commandType,
    payloadHash,
    appliedExpectedVersion: record.expectedVersion,
    appliedAt: now,
  });
  return { run: next, deduped: false };
}

// ── 用例 ────────────────────────────────────────────────────────

export function createProjectRun(
  deps: GraphRunDeps,
  input: CreateProjectRunInput,
): GraphRunTransitionResult {
  return deps.tx.runInTransaction((repos) => {
    const now = deps.clock.now();
    const payloadHash = deps.hashPayload(
      canonicalJson({ command: 'createProjectRun', projectId: input.projectId }),
    );

    const existing = repos.commandLog.get(input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new GraphRunIdempotencyConflictError();
      }
      return { run: loadRun(repos.graphRunRepo, existing.runId).state, deduped: true };
    }

    const workflowRunId = createWorkflowRunId(deps.idGenerator.generate());
    const state = createProjectInitialRunState({
      graph: deps.projectGraph,
      projectId: createProjectId(input.projectId),
      workflowRunId,
      createdAt: now,
    });
    repos.graphRunRepo.create(state, now);
    const inserted = repos.commandLog.insert({
      id: input.idempotencyKey,
      runId: workflowRunId,
      commandType: 'createProjectRun',
      payloadHash,
      appliedExpectedVersion: 1,
      appliedAt: now,
    });
    if (!inserted) {
      const winner = repos.commandLog.get(input.idempotencyKey);
      if (!winner) throw new GraphRunIdempotencyConflictError();
      return { run: loadRun(repos.graphRunRepo, winner.runId).state, deduped: true };
    }
    return { run: state, deduped: false };
  });
}

export function createChapterRun(
  deps: GraphRunDeps,
  input: CreateChapterRunInput,
): GraphRunTransitionResult {
  return deps.tx.runInTransaction((repos) => {
    const now = deps.clock.now();
    const payloadHash = deps.hashPayload(
      canonicalJson({
        command: 'createChapterRun',
        projectId: input.projectId,
        creationSpecVersionId: input.creationSpecVersionId,
        researchBundleId: input.researchBundleId,
        storyBlueprintId: input.storyBlueprintId,
        blueprintChapterId: input.blueprintChapterId,
      }),
    );

    const existing = repos.commandLog.get(input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new GraphRunIdempotencyConflictError();
      }
      return { run: loadRun(repos.graphRunRepo, existing.runId).state, deduped: true };
    }

    const workflowRunId = createWorkflowRunId(deps.idGenerator.generate());
    const state = createChapterInitialRunState({
      graph: deps.chapterGraph,
      projectId: createProjectId(input.projectId),
      workflowRunId,
      creationSpecVersionId: createCreationSpecVersionId(input.creationSpecVersionId),
      researchBundleId:
        input.researchBundleId === null
          ? null
          : createResearchBundleArtifactId(input.researchBundleId),
      storyBlueprintId: createStoryBlueprintArtifactId(input.storyBlueprintId),
      blueprintChapterId: createBlueprintChapterId(input.blueprintChapterId),
      createdAt: now,
    });
    repos.graphRunRepo.create(state, now);
    const inserted = repos.commandLog.insert({
      id: input.idempotencyKey,
      runId: workflowRunId,
      commandType: 'createChapterRun',
      payloadHash,
      appliedExpectedVersion: 1,
      appliedAt: now,
    });
    if (!inserted) {
      const winner = repos.commandLog.get(input.idempotencyKey);
      if (!winner) throw new GraphRunIdempotencyConflictError();
      return { run: loadRun(repos.graphRunRepo, winner.runId).state, deduped: true };
    }
    return { run: state, deduped: false };
  });
}

export function getRunProgress(
  deps: GraphRunDeps,
  input: GetRunProgressInput,
): AnyIdeaToNovelRunState {
  const record = deps.tx.runInTransaction((repos) => loadRun(repos.graphRunRepo, input.runId));
  return record.state;
}

export function advanceNode(deps: GraphRunDeps, input: AdvanceNodeInput): GraphRunTransitionResult {
  return deps.tx.runInTransaction((repos) =>
    applyTransitionInTransaction(
      deps,
      repos,
      input.runId,
      'advanceNode',
      input.idempotencyKey,
      {
        command: 'advanceNode',
        runId: input.runId,
        nodeId: input.nodeId,
        outcome: input.outcome ?? null,
        artifactRef: input.artifactRef ?? null,
      },
      (graph, state) => {
        const nodeId = createGraphNodeId(input.nodeId);
        const opts = buildSuccessOpts(graph, input.nodeId, input);
        const next = applyNodeSuccessTransition(graph, state, nodeId, opts);
        return parkHumanNodes(graph, next);
      },
    ),
  );
}

export function failNode(deps: GraphRunDeps, input: FailNodeInput): GraphRunTransitionResult {
  return deps.tx.runInTransaction((repos) =>
    failNodeInTransaction(deps, repos, input.runId, input.idempotencyKey, input.nodeId),
  );
}

/**
 * 在**已打开的**事务内执行 failNode（RW-1-R5 原子失败共用）。
 * 调用方必须已经持有 `repos`（即处于 `deps.tx.runInTransaction` 回调内）。
 */
export function failNodeInTransaction(
  deps: GraphRunDeps,
  repos: GraphRunTransactionRepositories,
  runId: string,
  idempotencyKey: string,
  nodeId: string,
): GraphRunTransitionResult {
  return applyTransitionInTransaction(
    deps,
    repos,
    runId,
    'failNode',
    idempotencyKey,
    { command: 'failNode', runId, nodeId },
    (graph, state) => applyNodeFailureTransition(graph, state, createGraphNodeId(nodeId)),
  );
}

/** applyArtifactChange 输入（上游权威 artifact 变化 → 级联失效下游） */
export interface ApplyArtifactChangeInput {
  readonly projectId: string;
  readonly runId: string;
  readonly artifactKind: string;
  readonly artifactId: string;
  readonly idempotencyKey: string;
}

/**
 * 应用一次权威 artifact 变化：更新 artifacts[changed.kind] 并把严格下游加入
 * invalidatedArtifacts（按 Graph artifactDownstreamOrder）。CreationSpec 更新 → 失效
 * researchBundle/storyBlueprint；generationRun 更新 → 失效 manuscript（GE-7 澄清）。
 */
export function applyArtifactChange(
  deps: GraphRunDeps,
  input: ApplyArtifactChangeInput,
): GraphRunTransitionResult {
  return deps.tx.runInTransaction((repos) => {
    const now = deps.clock.now();
    const payloadHash = deps.hashPayload(
      canonicalJson({
        command: 'applyArtifactChange',
        runId: input.runId,
        artifactKind: input.artifactKind,
        artifactId: input.artifactId,
      }),
    );

    const existing = repos.commandLog.get(input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new GraphRunIdempotencyConflictError();
      }
      return { run: loadRun(repos.graphRunRepo, input.runId).state, deduped: true };
    }

    const record = loadRun(repos.graphRunRepo, input.runId);
    const graph = resolveGraph(deps, record.state.graphId);
    if (!graph.artifactKinds.includes(input.artifactKind as never)) {
      throw new GraphRunValidationError(`artifact kind 不在本图槽位: ${input.artifactKind}`);
    }

    const changed = artifactRef(input.artifactKind as never, input.artifactId);
    let next: AnyIdeaToNovelRunState;
    try {
      next = applyArtifactChangeTransition(record.state, changed, graph.artifactDownstreamOrder);
    } catch (err) {
      throw toGraphRunError(err);
    }
    assertValidState(graph, next);

    const ok = repos.graphRunRepo.saveWithCas(input.runId, record.expectedVersion, next, now);
    if (!ok) throw new GraphRunVersionConflictError(input.runId);
    repos.commandLog.insert({
      id: input.idempotencyKey,
      runId: input.runId,
      commandType: 'applyArtifactChange',
      payloadHash,
      appliedExpectedVersion: record.expectedVersion,
      appliedAt: now,
    });
    return { run: next, deduped: false };
  });
}

export function requestHumanDecision(
  deps: GraphRunDeps,
  input: RequestHumanDecisionInput,
): GraphRunTransitionResult {
  return deps.tx.runInTransaction((repos) => {
    const now = deps.clock.now();
    const payloadHash = deps.hashPayload(
      canonicalJson({
        command: 'requestHumanDecision',
        runId: input.runId,
        nodeId: input.nodeId,
      }),
    );

    const existing = repos.commandLog.get(input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new GraphRunIdempotencyConflictError();
      }
      return { run: loadRun(repos.graphRunRepo, input.runId).state, deduped: true };
    }

    const record = loadRun(repos.graphRunRepo, input.runId);
    const graph = resolveGraph(deps, record.state.graphId);
    const node = graph.nodes.find((n) => n.id === input.nodeId);
    if (!node) throw new GraphRunValidationError(`节点不存在: ${input.nodeId}`);
    if (node.humanDecisionType === undefined) {
      throw new GraphRunStateConflictError(`节点 ${input.nodeId} 不是人工交互节点`);
    }

    let next: AnyIdeaToNovelRunState;
    try {
      next = requestHumanDecisionTransition(
        graph,
        record.state,
        createGraphNodeId(input.nodeId),
        node.humanDecisionType,
      );
    } catch (err) {
      throw toGraphRunError(err);
    }
    assertValidState(graph, next);

    const ok = repos.graphRunRepo.saveWithCas(input.runId, record.expectedVersion, next, now);
    if (!ok) throw new GraphRunVersionConflictError(input.runId);
    repos.commandLog.insert({
      id: input.idempotencyKey,
      runId: input.runId,
      commandType: 'requestHumanDecision',
      payloadHash,
      appliedExpectedVersion: record.expectedVersion,
      appliedAt: now,
    });
    return { run: next, deduped: false };
  });
}

export function applyHumanDecision(
  deps: GraphRunDeps,
  input: ApplyHumanDecisionInput,
): GraphRunTransitionResult {
  return deps.tx.runInTransaction((repos) => {
    const now = deps.clock.now();
    const payloadHash = deps.hashPayload(canonicalJson({ command: 'applyHumanDecision', input }));

    const existing = repos.commandLog.get(input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new GraphRunIdempotencyConflictError();
      }
      return { run: loadRun(repos.graphRunRepo, input.runId).state, deduped: true };
    }

    const record = loadRun(repos.graphRunRepo, input.runId);
    const graph = resolveGraph(deps, record.state.graphId);
    const node = graph.nodes.find((n) => n.id === input.nodeId);
    if (!node) throw new GraphRunValidationError(`节点不存在: ${input.nodeId}`);

    let decision: HumanDecisionInput;
    if (input.kind === 'intake_answer') {
      const answerId = deps.idGenerator.generate();
      repos.intakeAnswer.insertAnswer({
        id: answerId,
        sessionId: input.sessionId,
        questionId: input.questionId,
        text: input.text,
        createdAt: now,
      });
      decision = {
        nodeId: createGraphNodeId(input.nodeId),
        decisionType: 'intake_response',
        action: 'answer',
        answerId: createAnswerReceiptId(answerId),
      };
    } else if (input.kind === 'intake_skip') {
      decision = {
        nodeId: createGraphNodeId(input.nodeId),
        decisionType: 'intake_response',
        action: 'skip',
      };
    } else if (input.kind === 'intake_finish') {
      decision = {
        nodeId: createGraphNodeId(input.nodeId),
        decisionType: 'intake_response',
        action: 'finish',
      };
    } else {
      // gate / escalation：decisionType 由节点 humanDecisionType 决定
      const decisionType = node.humanDecisionType;
      if (
        decisionType !== 'blueprint_gate' &&
        decisionType !== 'candidate_gate' &&
        decisionType !== 'escalation'
      ) {
        throw new GraphRunStateConflictError(`节点 ${input.nodeId} 不是门禁/升级节点`);
      }

      // D-B7-1/2/8：blueprint 接受与 Graph gate 原子化（本批次核心）。
      // BLUEPRINT_USER_GATE 的 accept、BLUEPRINT_ESCALATION 的 accept_current 都是
      // "接受当前蓝图 → 形成 PROJECT_READY"的入边；镜像本函数 intake_answer 分支的
      // 现成先例——先写权威存储（storyBlueprintRepo.markAccepted），再走 transition，
      // 任一步抛错整事务回滚（fail-closed），杜绝"run 已终态但 accepted=0"的不可修复态。
      const isBlueprintAccept =
        (node.id === BLUEPRINT_USER_GATE && input.outcome === 'accept') ||
        (node.id === BLUEPRINT_ESCALATION && input.outcome === 'accept_current');
      if (isBlueprintAccept) {
        // D-B7-8：失效蓝图不得被接受。CreationSpec 变更后 storyBlueprint 进
        // invalidatedArtifacts（applyArtifactChange 只追加、不清空 artifacts 槽位），
        // 不在此拒绝的话用户可绕过"必须重新生成"直达 PROJECT_READY。
        const invalidated = record.state.invalidatedArtifacts.some(
          (ref) => ref.kind === 'storyBlueprint',
        );
        if (invalidated) {
          throw new GraphRunStateConflictError(
            '当前蓝图已因创作要求变更而失效，无法接受；请先请求重新生成',
          );
        }
        // blueprintId 只能取自 Graph 权威状态，不接受调用方传入——杜绝对任意历史
        // blueprintId 置 accepted 的伪造（gate DTO 亦是 exact-keys 校验，不加字段）。
        const projectState = record.state as IdeaToNovelProjectRunState;
        const blueprintArtifact = projectState.artifacts.storyBlueprint;
        if (blueprintArtifact === null) {
          throw new GraphRunStateConflictError('当前 run 尚无蓝图产物，无法接受');
        }
        const marked = repos.storyBlueprintRepo.markAccepted(
          record.state.projectId,
          blueprintArtifact.artifactId,
        );
        if (!marked) {
          throw new GraphRunStateConflictError('蓝图接受失败：权威存储未找到对应蓝图');
        }
      }

      decision = {
        nodeId: createGraphNodeId(input.nodeId),
        decisionType,
        outcome: input.outcome,
      } as HumanDecisionInput;
    }

    let next: AnyIdeaToNovelRunState;
    try {
      next = applyHumanDecisionTransition(graph, record.state, decision);
      next = parkHumanNodes(graph, next);
    } catch (err) {
      throw toGraphRunError(err);
    }
    assertValidState(graph, next);

    const ok = repos.graphRunRepo.saveWithCas(input.runId, record.expectedVersion, next, now);
    if (!ok) throw new GraphRunVersionConflictError(input.runId);
    repos.commandLog.insert({
      id: input.idempotencyKey,
      runId: input.runId,
      commandType: 'applyHumanDecision',
      payloadHash,
      appliedExpectedVersion: record.expectedVersion,
      appliedAt: now,
    });
    return { run: next, deduped: false };
  });
}

export function listRuns(
  deps: GraphRunDeps,
  input: ListRunsInput,
): ReadonlyArray<GraphRunStateRecord> {
  return deps.tx.runInTransaction((repos) => repos.graphRunRepo.listByProject(input.projectId));
}

/**
 * 启动恢复：对每个非终态 run 中处于 'active' 的节点执行 fail 路径（安全可重放）。
 * waiting_for_human 不触碰；空 frontier 且无 active 的非法 run 只记录不手工造终态。
 * 返回被恢复的 runId 列表。
 */
export function recoverInFlightRuns(
  deps: GraphRunDeps,
): ReadonlyArray<{ runId: string; nodeId: string }> {
  const nonTerminal = deps.tx.runInTransaction((repos) => repos.graphRunRepo.listNonTerminal());
  const interrupted: Array<{ runId: string; nodeId: string }> = [];

  for (const record of nonTerminal) {
    const activeNodes = Object.entries(record.state.nodeStatuses)
      .filter((entry): entry is [string, 'active'] => entry[1] === 'active')
      .map(([nodeId]) => nodeId);
    if (activeNodes.length === 0) continue; // waiting_for_human / 非 active：安全停驻

    const nodeId = activeNodes[0];
    try {
      failNode(deps, {
        projectId: record.state.projectId,
        runId: record.state.workflowRunId,
        nodeId,
        idempotencyKey: `recover:${record.state.workflowRunId}:${nodeId}:${record.expectedVersion}`,
      });
      interrupted.push({ runId: record.state.workflowRunId, nodeId });
    } catch {
      // 非致命：记录并继续；不手工拼装终态
      interrupted.push({ runId: record.state.workflowRunId, nodeId });
    }
  }
  return interrupted;
}
