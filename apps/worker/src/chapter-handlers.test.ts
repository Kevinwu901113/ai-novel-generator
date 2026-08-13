/**
 * 章节生成 RPC 处理器测试（B10，真实 SQLite）。
 *
 * - `deriveChapterPhase`：阶段优先级（终态 > 人工 Gate > accept 后停在提交节点 > 在途）；
 * - `chapter.getOverview`：未接受蓝图时返回空（不让用户从未就绪的项目发起生成）；
 * - `chapter.startRun`：绑定由 worker 从权威 project run 取；同章重复发起复用既有 run；
 * - `chapter.submitDecision`：`request_rewrite` 的意见**先落库再推进 Graph**，且能被
 *   REWRITE 任务按候选修订号读到（D-B10-3 的端到端闭合）；
 * - 非法输入 / 跨项目 run 一律拒绝。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import { AppError, createChapterRun } from '@ai-novel/application';
import type { GraphRunDeps } from '@ai-novel/application';
import {
  CANDIDATE_ESCALATION,
  CANDIDATE_GATE,
  CHAPTER_GENERATION_GRAPH_V1,
  CHAPTER_PLAN,
  DRAFT,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  MANUSCRIPT_COMMIT,
  canonicalSerializeContractSections,
  canonicalSerializeContractSnapshot,
  validateCreationContractSections,
} from '@ai-novel/domain';
import type { ChapterGenerationRunState } from '@ai-novel/domain';
import { sha256Hex } from '@ai-novel/task-engine';
import { sha256Utf8 } from '@ai-novel/database';
import {
  deriveChapterPhase,
  dispatchChapterCommand,
  type ChapterHandlerContext,
} from './chapter-handlers.js';

const NOW = '2026-08-13T00:00:00.000Z';
const PROJECT_ID = 'p1';
const BLUEPRINT_ID = 'bp-1';
const CHAPTER_ID = 'ch-1';
const SPEC_ID = 'spec-1';

let tempDir: string;
let dbPath: string;
let idCounter = 0;

const clock = { now: () => NOW };
const idGenerator = { generate: () => `id-${++idCounter}` };

function openDb(): ProjectDatabase {
  return new ProjectDatabase(dbPath);
}

function seedProject(accepted: boolean): void {
  const db = openDb();
  try {
    db.getProjectMetadataRepository().create({
      id: PROJECT_ID,
      name: '测试项目',
      initialIdea: '一个客栈故事',
      status: 'ACTIVE',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const sections = validateCreationContractSections({
      premise: '主角在异世界经营客栈',
      genre: ['fantasy'],
      tone: ['light'],
      targetAudience: 'adults',
      narrativePov: 'THIRD_LIMITED',
      tense: 'PAST',
      protagonist: { characterKey: 'xiaoman', name: '小满' },
    });
    db.getCreationContractVersionRepository().create({
      id: SPEC_ID,
      projectId: PROJECT_ID,
      version: 1,
      schemaVersion: 1,
      sourceProposalId: null,
      basedOnGrillSessionId: null,
      basedOnGrillSessionVersion: null,
      sectionsJson: canonicalSerializeContractSections(sections),
      lockedFieldPathsJson: '[]',
      contractSnapshotHash: sha256Utf8(
        canonicalSerializeContractSnapshot({ sections, lockedFieldPaths: [], schemaVersion: 1 }),
      ),
      provenanceJson: '[]',
      createdAt: NOW,
      createdBy: 'user',
    });
    db.getStoryBlueprintRepository().save(
      {
        id: BLUEPRINT_ID,
        projectId: PROJECT_ID,
        version: 1,
        premise: '客栈迎来形形色色的旅人',
        characters: [{ name: '小满', role: '主角', description: '客栈老板' }],
        relationships: ['小满——常客阿岩'],
        world: '十字路口客栈',
        conflict: '通道不稳定',
        ending: '找到稳定通道的方法',
        plotlines: [{ name: '主线', summary: '追查根源' }],
        chapters: [{ id: CHAPTER_ID, title: '第一章 远客', goal: '引出客栈与主角' }],
        createdAt: NOW,
      },
      accepted,
    );
    // 一条已完成的 project run，artifacts 指向上面两个真实对象
    const tx = db.getGraphRunTransaction();
    tx.runInTransaction((repos) => {
      repos.graphRunRepo.create(
        {
          graphId: IDEA_TO_NOVEL_PROJECT_GRAPH_V1.id,
          graphVersion: 'v1',
          workflowRunId: 'project-run-1',
          projectId: PROJECT_ID,
          nodeStatuses: Object.fromEntries(
            IDEA_TO_NOVEL_PROJECT_GRAPH_V1.nodes.map((n) => [n.id, 'pending']),
          ),
          nodeOutcomes: {},
          artifacts: {
            idea: null,
            creationSpec: { kind: 'creationSpec', artifactId: SPEC_ID },
            researchBundle: null,
            storyBlueprint: { kind: 'storyBlueprint', artifactId: BLUEPRINT_ID },
          },
          invalidatedArtifacts: [],
          consumedEdges: [],
          attemptBudget: {},
          pendingHumanDecision: null,
          terminalStatus: 'completed',
          createdAt: NOW,
        } as never,
        NOW,
      );
    });
  } finally {
    db.close();
  }
}

function buildCtx(): ChapterHandlerContext {
  return { getProjectDb: () => openDb(), idGenerator, clock };
}

function graphDeps(db: ProjectDatabase): GraphRunDeps {
  return {
    idGenerator,
    clock,
    hashPayload: (payload: string) => sha256Hex(payload),
    tx: db.getGraphRunTransaction(),
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
  };
}

function chapterStateFixture(
  overrides: Partial<ChapterGenerationRunState>,
): ChapterGenerationRunState {
  const nodeStatuses = Object.fromEntries(
    CHAPTER_GENERATION_GRAPH_V1.nodes.map((n) => [n.id, 'pending']),
  );
  return {
    graphId: CHAPTER_GENERATION_GRAPH_V1.id,
    graphVersion: 'v1',
    workflowRunId: 'chapter-run-1',
    projectId: PROJECT_ID,
    creationSpecVersionId: SPEC_ID,
    researchBundleId: null,
    storyBlueprintId: BLUEPRINT_ID,
    blueprintChapterId: CHAPTER_ID,
    nodeStatuses,
    nodeOutcomes: {},
    artifacts: { generationRun: null, manuscript: null },
    invalidatedArtifacts: [],
    consumedEdges: [],
    attemptBudget: {},
    pendingHumanDecision: null,
    terminalStatus: null,
    createdAt: NOW,
    ...overrides,
  } as unknown as ChapterGenerationRunState;
}

describe('deriveChapterPhase', () => {
  it('终态优先于一切', () => {
    const state = chapterStateFixture({
      terminalStatus: 'cancelled',
      nodeStatuses: { [CANDIDATE_GATE]: 'waiting_for_human' } as never,
    });
    expect(deriveChapterPhase(state)).toBe('cancelled');
  });

  it('升级 Gate 优先于候选 Gate', () => {
    const state = chapterStateFixture({
      nodeStatuses: {
        [CANDIDATE_GATE]: 'waiting_for_human',
        [CANDIDATE_ESCALATION]: 'waiting_for_human',
      } as never,
    });
    expect(deriveChapterPhase(state)).toBe('awaiting_escalation');
  });

  it('采用后停在写入稿件节点 → accepted_pending_commit（不冒充"已完成"）', () => {
    const state = chapterStateFixture({
      nodeStatuses: { [MANUSCRIPT_COMMIT]: 'active' } as never,
    });
    expect(deriveChapterPhase(state)).toBe('accepted_pending_commit');
  });

  it('在途节点映射到作者语言阶段', () => {
    expect(
      deriveChapterPhase(
        chapterStateFixture({ nodeStatuses: { [CHAPTER_PLAN]: 'active' } as never }),
      ),
    ).toBe('planning');
    expect(
      deriveChapterPhase(chapterStateFixture({ nodeStatuses: { [DRAFT]: 'active' } as never })),
    ).toBe('drafting');
  });
});

describe('章节 RPC 分发（真实 SQLite）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chapter-handlers-'));
    dbPath = join(tempDir, 'project.sqlite');
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('蓝图未被接受 → 章节列表为空（不给未就绪项目发起生成的入口）', () => {
    seedProject(false);
    const overview = dispatchChapterCommand(
      'chapter.getOverview',
      { projectId: PROJECT_ID },
      buildCtx(),
    ) as { blueprintId: string | null; chapters: ReadonlyArray<unknown> };
    expect(overview.blueprintId).toBeNull();
    expect(overview.chapters).toHaveLength(0);
  });

  it('蓝图已接受 → 列出章节；未生成时阶段为 idle', () => {
    seedProject(true);
    const overview = dispatchChapterCommand(
      'chapter.getOverview',
      { projectId: PROJECT_ID },
      buildCtx(),
    ) as {
      blueprintId: string | null;
      chapters: ReadonlyArray<{ blueprintChapterId: string; phase: string; runId: string | null }>;
    };
    expect(overview.blueprintId).toBe(BLUEPRINT_ID);
    expect(overview.chapters).toHaveLength(1);
    expect(overview.chapters[0]!.phase).toBe('idle');
    expect(overview.chapters[0]!.runId).toBeNull();
  });

  it('startRun：绑定取自权威 project run；同章重复发起复用既有 run', () => {
    seedProject(true);
    const ctx = buildCtx();
    const first = dispatchChapterCommand(
      'chapter.startRun',
      { projectId: PROJECT_ID, blueprintChapterId: CHAPTER_ID },
      ctx,
    ) as { runId: string; blueprintChapterId: string };
    expect(first.blueprintChapterId).toBe(CHAPTER_ID);

    const second = dispatchChapterCommand(
      'chapter.startRun',
      { projectId: PROJECT_ID, blueprintChapterId: CHAPTER_ID },
      ctx,
    ) as { runId: string };
    expect(second.runId).toBe(first.runId);

    const db = openDb();
    try {
      const runs = db
        .getGraphRunTransaction()
        .runInTransaction((repos) => repos.graphRunRepo.listByProject(PROJECT_ID));
      expect(runs.filter((r) => r.kind === 'chapter')).toHaveLength(1);
      const state = runs.find((r) => r.kind === 'chapter')!.state as ChapterGenerationRunState;
      expect(state.creationSpecVersionId).toBe(SPEC_ID);
      expect(state.storyBlueprintId).toBe(BLUEPRINT_ID);
    } finally {
      db.close();
    }
  });

  it('startRun：蓝图里没有该章节 → 拒绝', () => {
    seedProject(true);
    expect(() =>
      dispatchChapterCommand(
        'chapter.startRun',
        { projectId: PROJECT_ID, blueprintChapterId: 'ch-not-exist' },
        buildCtx(),
      ),
    ).toThrow(AppError);
  });

  it('submitDecision：request_rewrite 的意见先落库，可按候选修订号读到（D-B10-3）', () => {
    seedProject(true);
    const db = openDb();
    let runId: string;
    try {
      const { run } = createChapterRun(graphDeps(db), {
        projectId: PROJECT_ID,
        creationSpecVersionId: SPEC_ID,
        researchBundleId: null,
        storyBlueprintId: BLUEPRINT_ID,
        blueprintChapterId: CHAPTER_ID,
        idempotencyKey: 'chapter-feedback-1',
      });
      runId = run.workflowRunId;
      // 造一个候选修订（正常由 DRAFT 执行器写入）
      db.getChapterCandidateRepository().save({
        id: 'cand-1',
        projectId: PROJECT_ID,
        graphRunId: runId,
        revisionNo: 1,
        source: 'DRAFT',
        artifactId: 'cand-1',
        title: '第一章 远客',
        content: '正文'.repeat(120),
        producedByTaskId: null,
        producedByInvocationId: null,
        createdAt: NOW,
      });
    } finally {
      db.close();
    }

    // Graph 尚未停在 gate，故决策必然被拒——但意见应当已经落库（顺序即语义）
    expect(() =>
      dispatchChapterCommand(
        'chapter.submitDecision',
        {
          projectId: PROJECT_ID,
          runId,
          kind: 'gate',
          outcome: 'request_rewrite',
          feedback: '第二场的对话太客气了',
          idempotencyKey: 'decision-1',
        },
        buildCtx(),
      ),
    ).toThrow();

    const verifyDb = openDb();
    try {
      const stored = verifyDb
        .getChapterRewriteFeedbackRepository()
        .getLatestForRevision(PROJECT_ID, runId, 1);
      expect(stored?.feedback).toBe('第二场的对话太客气了');
    } finally {
      verifyDb.close();
    }
  });

  it('submitDecision：没有候选正文时带意见 → 拒绝（不留孤儿意见）', () => {
    seedProject(true);
    const db = openDb();
    let runId: string;
    try {
      const { run } = createChapterRun(graphDeps(db), {
        projectId: PROJECT_ID,
        creationSpecVersionId: SPEC_ID,
        researchBundleId: null,
        storyBlueprintId: BLUEPRINT_ID,
        blueprintChapterId: CHAPTER_ID,
        idempotencyKey: 'chapter-feedback-2',
      });
      runId = run.workflowRunId;
    } finally {
      db.close();
    }
    expect(() =>
      dispatchChapterCommand(
        'chapter.submitDecision',
        {
          projectId: PROJECT_ID,
          runId,
          kind: 'gate',
          outcome: 'request_rewrite',
          feedback: '改一下',
          idempotencyKey: 'decision-2',
        },
        buildCtx(),
      ),
    ).toThrow(AppError);
  });

  it('未知命令 / 非法输入一律拒绝', () => {
    seedProject(true);
    expect(() => dispatchChapterCommand('chapter.unknown', {}, buildCtx())).toThrow(AppError);
    expect(() => dispatchChapterCommand('chapter.getOverview', {}, buildCtx())).toThrow(AppError);
    expect(() =>
      dispatchChapterCommand('chapter.startRun', { projectId: PROJECT_ID }, buildCtx()),
    ).toThrow(AppError);
  });
});
