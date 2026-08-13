/**
 * 章节生成 RPC 处理器（GE-6 / B10，设计见 docs/development/b10-chapter-ui-design.md）。
 *
 * 四条只读 / 写通道：
 * - `chapter.getOverview`：已接受蓝图的章节列表 + 每章最新一次生成 run 的阶段（章节列表页）；
 * - `chapter.startRun`：**产品入口**——按 blueprintChapterId 创建 ChapterGenerationRun。
 *   绑定的 creationSpecVersionId / researchBundleId / storyBlueprintId 由 worker 从已
 *   completed 的 project run 权威状态里取，渲染进程不拼装身份（D-B10-1）；
 * - `chapter.getRunState`：一次 run 的完整状态投影（阶段 + 当前候选 + 审查结论 + 预算）；
 * - `chapter.submitDecision`：候选 Gate / 升级 Gate 的人工决策；`request_rewrite` 时
 *   先落改写意见再推进 Graph（D-B10-3）。
 *
 * 纪律：
 * - 阶段（ChapterRunPhaseDto）在**worker 侧**由 Graph 节点状态派生，渲染进程不推导
 *   Graph 语义（B4/B6/B8 同则）；
 * - 决策一律经 `applyHumanDecision`（graph-run.ts），本文件不直写 graph_runs；
 * - 非人工节点的推进只能由 executor + settlement 完成，本文件不提供任何伪造通道。
 */

import { AppError, applyHumanDecision, createChapterRun } from '@ai-novel/application';
import type { Clock, GraphRunDeps, IdGenerator } from '@ai-novel/application';
import {
  isValidGetChapterOverviewInput,
  isValidGetChapterRunStateInput,
  isValidStartChapterRunInput,
  isValidSubmitChapterDecisionInput,
} from '@ai-novel/contracts';
import { CHAPTER_GENERATION_GRAPH_V1, IDEA_TO_NOVEL_PROJECT_GRAPH_V1 } from '@ai-novel/domain';
import { sha256Hex } from '@ai-novel/task-engine';
import type { ProjectDatabase } from '@ai-novel/database';
import {
  CANDIDATE_ESCALATION,
  CANDIDATE_GATE,
  CHAPTER_PLAN,
  CONTINUITY_CRITIC,
  CRITIQUE_JOIN,
  DRAFT,
  MANUSCRIPT_COMMIT,
  REQUIREMENT_CRITIC,
  REWRITE,
  STYLE_CRITIC,
  createChapterRewriteFeedback,
} from '@ai-novel/domain';
import type {
  ChapterCandidate,
  ChapterCritique,
  ChapterGenerationRunState,
  IdeaToNovelProjectRunState,
  StoryBlueprint,
} from '@ai-novel/domain';
import type {
  ChapterCandidateDto,
  ChapterCritiqueDimensionDto,
  ChapterCritiqueDto,
  ChapterOverviewDto,
  ChapterOverviewItemDto,
  ChapterRunPhaseDto,
  ChapterRunStateDto,
  SubmitChapterDecisionInputDto,
} from '@ai-novel/contracts';

export interface ChapterHandlerContext {
  getProjectDb(projectId: string): ProjectDatabase;
  idGenerator: IdGenerator;
  clock: Clock;
  /**
   * D-B3-1 live drive：创建 run / 人工决策落地后异步驱动一次 NodeRunner
   * （fire-and-forget，自行吞错；权威兜底是启动恢复）。
   */
  driveAfter?: (projectId: string, runId: string) => void;
}

/**
 * TD-023 连接纪律：每条命令打开一次 ProjectDatabase，结束（含抛错）在 finally 关闭；
 * 连接不逃逸出本次分发（driveAfter 自开自关）。GraphRunDeps 与只读查询共用同一连接。
 */
function withChapterDeps<T>(
  ctx: ChapterHandlerContext,
  projectId: string,
  fn: (projDb: ProjectDatabase, deps: GraphRunDeps) => T,
): T {
  const projDb = ctx.getProjectDb(projectId);
  try {
    return fn(projDb, {
      idGenerator: ctx.idGenerator,
      clock: ctx.clock,
      hashPayload: (payload: string) => sha256Hex(payload),
      tx: projDb.getGraphRunTransaction(),
      projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
      chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
    });
  } finally {
    projDb.close();
  }
}

const CRITIC_DIMENSION_BY_NODE: Readonly<Record<string, ChapterCritiqueDimensionDto>> = {
  [CONTINUITY_CRITIC]: 'continuity',
  [STYLE_CRITIC]: 'style',
  [REQUIREMENT_CRITIC]: 'requirement',
};

// ── 阶段派生 ──────────────────────────────────────────────────────

/**
 * 由章节 run 状态派生作者语言阶段（D-B10-2）。
 *
 * 优先级：终态 > 人工 Gate > accept 后停在 MANUSCRIPT_COMMIT > 在途节点 > idle。
 *
 * `accepted_pending_commit` 是本批次必须如实暴露的一个状态：用户点"采用"后，Graph
 * 会激活 MANUSCRIPT_COMMIT，而该节点的 executor 属 GE-7、当前**有意未注册**——run
 * 会停在那里不动。若把它显示成"已完成"，就是一次空承诺（B6/B7/B8 各踩过一次）。
 */
export function deriveChapterPhase(state: ChapterGenerationRunState): ChapterRunPhaseDto {
  if (state.terminalStatus !== null) return state.terminalStatus;
  if (state.nodeStatuses[CANDIDATE_ESCALATION] === 'waiting_for_human') {
    return 'awaiting_escalation';
  }
  if (state.nodeStatuses[CANDIDATE_GATE] === 'waiting_for_human') return 'awaiting_decision';
  if (state.nodeStatuses[MANUSCRIPT_COMMIT] === 'active') return 'accepted_pending_commit';
  if (state.nodeStatuses[CHAPTER_PLAN] === 'active') return 'planning';
  if (state.nodeStatuses[DRAFT] === 'active') return 'drafting';
  if (state.nodeStatuses[REWRITE] === 'active') return 'rewriting';
  const reviewing = [CONTINUITY_CRITIC, STYLE_CRITIC, REQUIREMENT_CRITIC, CRITIQUE_JOIN].some(
    (nodeId) => state.nodeStatuses[nodeId] === 'active',
  );
  if (reviewing) return 'reviewing';
  return 'idle';
}

// ── DTO 投影 ──────────────────────────────────────────────────────

function toCandidateDto(candidate: ChapterCandidate): ChapterCandidateDto {
  return {
    revisionNo: candidate.revisionNo,
    source: candidate.source,
    title: candidate.title,
    content: candidate.content,
    createdAt: candidate.createdAt,
  };
}

/**
 * 审查结论 → 公开 DTO（逐字段显式构造，不 spread domain 对象）。
 * 节点 id 换成审查维度：界面上不出现任何节点 id（PRODUCT_DIRECTION §4）。
 * 未知节点 id 直接跳过——宁可少显示一条，也不把工程标识泄漏到界面。
 */
function toCritiqueDtos(critiques: ReadonlyArray<ChapterCritique>): ChapterCritiqueDto[] {
  const result: ChapterCritiqueDto[] = [];
  for (const critique of critiques) {
    const dimension = CRITIC_DIMENSION_BY_NODE[critique.criticNodeId];
    if (!dimension) continue;
    result.push({
      dimension,
      verdict: critique.verdict,
      summary: critique.summary,
      issues: critique.issues.map((issue) => ({
        severity: issue.severity,
        excerpt: issue.excerpt,
        problem: issue.problem,
        suggestion: issue.suggestion,
      })),
    });
  }
  return result;
}

function toRunStateDto(
  projDb: ProjectDatabase,
  state: ChapterGenerationRunState,
): ChapterRunStateDto {
  const runId = state.workflowRunId;
  const projectId = state.projectId;
  const candidate = projDb.getChapterCandidateRepository().getLatestByRun(projectId, runId);
  const critiques = candidate
    ? projDb
        .getChapterCritiqueRepository()
        .listByCandidateRevision(projectId, runId, candidate.revisionNo)
    : [];
  return {
    runId,
    blueprintChapterId: state.blueprintChapterId,
    phase: deriveChapterPhase(state),
    terminalStatus: state.terminalStatus,
    gateActive: state.nodeStatuses[CANDIDATE_GATE] === 'waiting_for_human',
    escalationActive: state.nodeStatuses[CANDIDATE_ESCALATION] === 'waiting_for_human',
    candidate: candidate ? toCandidateDto(candidate) : null,
    critiques: toCritiqueDtos(critiques),
    rewriteUsed: state.attemptBudget.rewrite ?? 0,
    candidateRewriteUsed: state.attemptBudget.candidateRewrite ?? 0,
    regenerateUsed: state.attemptBudget.regenerate ?? 0,
  };
}

// ── 读取权威绑定 ──────────────────────────────────────────────────

interface ProjectBinding {
  readonly creationSpecVersionId: string;
  readonly researchBundleId: string | null;
  readonly storyBlueprintId: string;
  readonly blueprint: StoryBlueprint;
}

function listRuns(projDb: ProjectDatabase, projectId: string) {
  return projDb
    .getGraphRunTransaction()
    .runInTransaction((repos) => repos.graphRunRepo.listByProject(projectId));
}

function sortedByCreation<
  T extends { readonly state: { createdAt: string; workflowRunId: string } },
>(records: ReadonlyArray<T>): T[] {
  return [...records].sort((a, b) => {
    if (a.state.createdAt !== b.state.createdAt) {
      return a.state.createdAt < b.state.createdAt ? -1 : 1;
    }
    return a.state.workflowRunId < b.state.workflowRunId ? -1 : 1;
  });
}

/**
 * D-B10-1：章节 run 的绑定由 worker 从**最新 project run 的权威状态**取，渲染进程
 * 不拼装身份。要求蓝图已被用户显式接受（story_blueprints.accepted）——未接受就发起
 * 章节生成会绕开 BLUEPRINT_USER_GATE 的产品语义。
 */
function readProjectBinding(projDb: ProjectDatabase, projectId: string): ProjectBinding | null {
  const projectRecords = listRuns(projDb, projectId).filter((r) => r.kind === 'project');
  if (projectRecords.length === 0) return null;
  const latest = sortedByCreation(projectRecords).at(-1)!.state as IdeaToNovelProjectRunState;
  const specRef = latest.artifacts.creationSpec;
  const blueprintRef = latest.artifacts.storyBlueprint;
  if (!specRef || !blueprintRef) return null;
  const found = projDb.getStoryBlueprintRepository().getById(projectId, blueprintRef.artifactId);
  if (!found || !found.accepted) return null;
  return {
    creationSpecVersionId: specRef.artifactId,
    researchBundleId: latest.artifacts.researchBundle?.artifactId ?? null,
    storyBlueprintId: blueprintRef.artifactId,
    blueprint: found.blueprint,
  };
}

/** 某蓝图章节的最新一次章节 run（无则 null） */
function latestChapterRun(
  projDb: ProjectDatabase,
  projectId: string,
  blueprintChapterId: string,
): ChapterGenerationRunState | null {
  const chapterRecords = listRuns(projDb, projectId).filter(
    (r) =>
      r.kind === 'chapter' &&
      (r.state as ChapterGenerationRunState).blueprintChapterId === blueprintChapterId,
  );
  if (chapterRecords.length === 0) return null;
  return sortedByCreation(chapterRecords).at(-1)!.state as ChapterGenerationRunState;
}

// ── 命令实现 ──────────────────────────────────────────────────────

export function getChapterOverview(
  ctx: ChapterHandlerContext,
  projectId: string,
): ChapterOverviewDto {
  return withChapterDeps(ctx, projectId, (projDb) => {
    const binding = readProjectBinding(projDb, projectId);
    if (!binding) return { blueprintId: null, chapters: [] };
    const chapters: ChapterOverviewItemDto[] = binding.blueprint.chapters.map((chapter) => {
      const run = latestChapterRun(projDb, projectId, chapter.id);
      const candidate = run
        ? projDb.getChapterCandidateRepository().getLatestByRun(projectId, run.workflowRunId)
        : null;
      return {
        blueprintChapterId: chapter.id,
        title: chapter.title,
        goal: chapter.goal,
        runId: run?.workflowRunId ?? null,
        phase: run ? deriveChapterPhase(run) : 'idle',
        hasCandidate: candidate !== null,
      };
    });
    return { blueprintId: binding.storyBlueprintId, chapters };
  });
}

export function getChapterRunState(
  ctx: ChapterHandlerContext,
  projectId: string,
  runId: string,
): ChapterRunStateDto | null {
  return withChapterDeps(ctx, projectId, (projDb) => {
    const record = projDb
      .getGraphRunTransaction()
      .runInTransaction((repos) => repos.graphRunRepo.getById(runId));
    if (!record || record.kind !== 'chapter') return null;
    const state = record.state as ChapterGenerationRunState;
    if (state.projectId !== projectId) return null;
    return toRunStateDto(projDb, state);
  });
}

/**
 * 发起一章的生成。
 *
 * 幂等键按 (projectId, blueprintChapterId, 该章已有 run 数) 派生——同一章重复点击
 * "开始生成"不会创建两条 run；用户显式重新生成（新 run）时计数变化，键随之变化。
 * 该章已有非终态 run 时直接返回既有 run 的状态，不新建（避免同章并行两条 run）。
 */
export function startChapterRun(
  ctx: ChapterHandlerContext,
  projectId: string,
  blueprintChapterId: string,
): ChapterRunStateDto {
  const result = withChapterDeps(ctx, projectId, (projDb, deps) => {
    const binding = readProjectBinding(projDb, projectId);
    if (!binding) {
      throw new AppError('VALIDATION_ERROR', '项目尚未就绪：需要先接受一份故事蓝图');
    }
    if (!binding.blueprint.chapters.some((c) => c.id === blueprintChapterId)) {
      throw new AppError('VALIDATION_ERROR', '该章节不属于当前蓝图');
    }
    const existingRuns = listRuns(projDb, projectId).filter(
      (r) =>
        r.kind === 'chapter' &&
        (r.state as ChapterGenerationRunState).blueprintChapterId === blueprintChapterId,
    );
    const active = existingRuns.find((r) => r.state.terminalStatus === null);
    if (active) {
      return toRunStateDto(projDb, active.state as ChapterGenerationRunState);
    }
    const { run } = createChapterRun(deps, {
      projectId,
      creationSpecVersionId: binding.creationSpecVersionId,
      researchBundleId: binding.researchBundleId,
      storyBlueprintId: binding.storyBlueprintId,
      blueprintChapterId,
      idempotencyKey: `chapter-run:${projectId}:${blueprintChapterId}:${existingRuns.length}`,
    });
    return toRunStateDto(projDb, run as ChapterGenerationRunState);
  });
  // 连接关闭后再驱动（driveAfter 自开自关）
  ctx.driveAfter?.(projectId, result.runId);
  return result;
}

/**
 * 提交候选 Gate / 升级 Gate 的决策。
 *
 * D-B10-3（改写意见）：`request_rewrite` 时**先**把意见写进权威存储，**再**推进 Graph。
 * 顺序不可颠倒——反过来的话，REWRITE 任务可能在意见落盘前就被调度，用户的意见会被
 * 静默丢弃（B7 的 D-B7-1 教训的同族：跨事务顺序即语义）。反向的残留（意见已写但
 * 决策失败）是良性的：那条意见只会被"针对该修订的下一次改写"读取，没有下一次改写
 * 就永远不被消费，不会污染任何内容。
 */
export function submitChapterDecision(
  ctx: ChapterHandlerContext,
  input: SubmitChapterDecisionInputDto,
): ChapterRunStateDto {
  const result = withChapterDeps(ctx, input.projectId, (projDb, deps) => {
    const record = projDb
      .getGraphRunTransaction()
      .runInTransaction((repos) => repos.graphRunRepo.getById(input.runId));
    if (!record || record.kind !== 'chapter') {
      throw new AppError('VALIDATION_ERROR', '章节生成流程不存在');
    }
    const state = record.state as ChapterGenerationRunState;
    if (state.projectId !== input.projectId) {
      throw new AppError('VALIDATION_ERROR', '章节生成流程不属于本项目');
    }

    if (input.feedback !== null) {
      const candidate = projDb
        .getChapterCandidateRepository()
        .getLatestByRun(input.projectId, input.runId);
      if (!candidate) {
        throw new AppError('VALIDATION_ERROR', '当前没有可改写的候选正文');
      }
      projDb.getChapterRewriteFeedbackRepository().save(
        createChapterRewriteFeedback({
          id: ctx.idGenerator.generate(),
          projectId: input.projectId,
          graphRunId: input.runId,
          candidateRevisionNo: candidate.revisionNo,
          feedback: input.feedback,
          createdAt: ctx.clock.now(),
        }),
      );
    }

    applyHumanDecision(deps, {
      kind: input.kind,
      runId: input.runId,
      nodeId: input.kind === 'gate' ? CANDIDATE_GATE : CANDIDATE_ESCALATION,
      outcome: input.outcome,
      idempotencyKey: input.idempotencyKey,
    } as never);

    const updated = projDb
      .getGraphRunTransaction()
      .runInTransaction((repos) => repos.graphRunRepo.getById(input.runId));
    if (!updated) throw new AppError('VALIDATION_ERROR', '章节生成流程不存在');
    return toRunStateDto(projDb, updated.state as ChapterGenerationRunState);
  });
  ctx.driveAfter?.(input.projectId, input.runId);
  return result;
}

// ── 分发 ──────────────────────────────────────────────────────────

export function dispatchChapterCommand(
  command: string,
  payload: unknown,
  ctx: ChapterHandlerContext,
): unknown {
  switch (command) {
    case 'chapter.getOverview': {
      if (!isValidGetChapterOverviewInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 chapter.getOverview 输入');
      }
      return getChapterOverview(ctx, payload.projectId);
    }
    case 'chapter.startRun': {
      if (!isValidStartChapterRunInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 chapter.startRun 输入');
      }
      return startChapterRun(ctx, payload.projectId, payload.blueprintChapterId);
    }
    case 'chapter.getRunState': {
      if (!isValidGetChapterRunStateInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 chapter.getRunState 输入');
      }
      return getChapterRunState(ctx, payload.projectId, payload.runId);
    }
    case 'chapter.submitDecision': {
      if (!isValidSubmitChapterDecisionInput(payload)) {
        throw new AppError('VALIDATION_ERROR', '非法 chapter.submitDecision 输入');
      }
      return submitChapterDecision(ctx, payload);
    }
    default:
      throw new AppError('VALIDATION_ERROR', `未知章节命令: ${command}`);
  }
}
