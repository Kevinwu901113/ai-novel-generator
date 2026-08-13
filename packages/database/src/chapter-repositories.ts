/**
 * 章节生成持久化仓库（GE-6 / B9，migration v17）。
 *
 * chapter_scene_plans / chapter_candidates / chapter_critiques 三表的实现。
 * 契约与"当前候选 = 同 run 内最大修订号"的语义见
 * `packages/application/src/chapter-generation.ts` 与 domain `chapter-generation.ts`。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  ChapterCandidate,
  ChapterCandidateSource,
  ChapterCritique,
  ChapterCritiqueIssue,
  ChapterRewriteFeedback,
  ChapterScene,
  ChapterScenePlan,
  CritiqueVerdict,
} from '@ai-novel/domain';
import type {
  ChapterCandidateRepositoryPort,
  ChapterCritiqueRepositoryPort,
  ChapterRewriteFeedbackRepositoryPort,
  ChapterScenePlanRepositoryPort,
} from '@ai-novel/application';

interface DbScenePlanRow {
  id: string;
  project_id: string;
  graph_run_id: string;
  blueprint_chapter_id: string;
  title: string;
  scenes_json: string;
  created_at: string;
}

interface DbCandidateRow {
  id: string;
  project_id: string;
  graph_run_id: string;
  revision_no: number;
  source: string;
  artifact_id: string | null;
  title: string;
  content: string;
  created_at: string;
}

interface DbCritiqueRow {
  id: string;
  project_id: string;
  graph_run_id: string;
  candidate_revision_no: number;
  critic_node_id: string;
  verdict: string;
  summary: string;
  issues_json: string;
  created_at: string;
}

function decodeScenePlan(row: DbScenePlanRow): ChapterScenePlan {
  const parsed: unknown = JSON.parse(row.scenes_json);
  if (!Array.isArray(parsed)) {
    throw new Error(`chapter_scene_plans ${row.id} scenes_json 损坏`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    graphRunId: row.graph_run_id,
    blueprintChapterId: row.blueprint_chapter_id,
    title: row.title,
    scenes: parsed as ReadonlyArray<ChapterScene>,
    createdAt: row.created_at,
  };
}

function decodeCandidate(row: DbCandidateRow): ChapterCandidate {
  if (row.source !== 'DRAFT' && row.source !== 'REWRITE') {
    throw new Error(`chapter_candidates ${row.id} source 非法: ${row.source}`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    graphRunId: row.graph_run_id,
    revisionNo: row.revision_no,
    source: row.source as ChapterCandidateSource,
    artifactId: row.artifact_id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
  };
}

function decodeCritique(row: DbCritiqueRow): ChapterCritique {
  const parsed: unknown = JSON.parse(row.issues_json);
  if (!Array.isArray(parsed)) {
    throw new Error(`chapter_critiques ${row.id} issues_json 损坏`);
  }
  if (row.verdict !== 'pass' && row.verdict !== 'needs_rewrite') {
    throw new Error(`chapter_critiques ${row.id} verdict 非法: ${row.verdict}`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    graphRunId: row.graph_run_id,
    candidateRevisionNo: row.candidate_revision_no,
    criticNodeId: row.critic_node_id,
    verdict: row.verdict as CritiqueVerdict,
    summary: row.summary,
    issues: parsed as ReadonlyArray<ChapterCritiqueIssue>,
    createdAt: row.created_at,
  };
}

export class ChapterScenePlanRepositoryImpl implements ChapterScenePlanRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  save(plan: ChapterScenePlan): void {
    this.db
      .prepare(
        `INSERT INTO chapter_scene_plans
           (id, project_id, graph_run_id, blueprint_chapter_id, title, scenes_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.projectId,
        plan.graphRunId,
        plan.blueprintChapterId,
        plan.title,
        JSON.stringify(plan.scenes),
        plan.createdAt,
      );
  }

  getLatestByRun(projectId: string, graphRunId: string): ChapterScenePlan | null {
    const row = this.db
      .prepare(
        `SELECT * FROM chapter_scene_plans
          WHERE project_id = ? AND graph_run_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId, graphRunId) as DbScenePlanRow | undefined;
    return row ? decodeScenePlan(row) : null;
  }
}

export class ChapterCandidateRepositoryImpl implements ChapterCandidateRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  save(candidate: ChapterCandidate): void {
    this.db
      .prepare(
        `INSERT INTO chapter_candidates
           (id, project_id, graph_run_id, revision_no, source, artifact_id, title, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.id,
        candidate.projectId,
        candidate.graphRunId,
        candidate.revisionNo,
        candidate.source,
        candidate.artifactId,
        candidate.title,
        candidate.content,
        candidate.createdAt,
      );
  }

  getLatestByRun(projectId: string, graphRunId: string): ChapterCandidate | null {
    const row = this.db
      .prepare(
        `SELECT * FROM chapter_candidates
          WHERE project_id = ? AND graph_run_id = ?
          ORDER BY revision_no DESC LIMIT 1`,
      )
      .get(projectId, graphRunId) as DbCandidateRow | undefined;
    return row ? decodeCandidate(row) : null;
  }

  getMaxRevisionNo(projectId: string, graphRunId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(revision_no), 0) AS max_revision
           FROM chapter_candidates WHERE project_id = ? AND graph_run_id = ?`,
      )
      .get(projectId, graphRunId) as { max_revision: number } | undefined;
    return row?.max_revision ?? 0;
  }

  listByRun(projectId: string, graphRunId: string): ReadonlyArray<ChapterCandidate> {
    const rows = this.db
      .prepare(
        `SELECT * FROM chapter_candidates
          WHERE project_id = ? AND graph_run_id = ?
          ORDER BY revision_no ASC`,
      )
      .all(projectId, graphRunId) as unknown as ReadonlyArray<DbCandidateRow>;
    return rows.map(decodeCandidate);
  }

  getByArtifactId(projectId: string, artifactId: string): ChapterCandidate | null {
    const row = this.db
      .prepare('SELECT * FROM chapter_candidates WHERE project_id = ? AND artifact_id = ?')
      .get(projectId, artifactId) as DbCandidateRow | undefined;
    return row ? decodeCandidate(row) : null;
  }
}

export class ChapterCritiqueRepositoryImpl implements ChapterCritiqueRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  save(critique: ChapterCritique): void {
    this.db
      .prepare(
        `INSERT INTO chapter_critiques
           (id, project_id, graph_run_id, candidate_revision_no, critic_node_id,
            verdict, summary, issues_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        critique.id,
        critique.projectId,
        critique.graphRunId,
        critique.candidateRevisionNo,
        critique.criticNodeId,
        critique.verdict,
        critique.summary,
        JSON.stringify(critique.issues),
        critique.createdAt,
      );
  }

  listByCandidateRevision(
    projectId: string,
    graphRunId: string,
    candidateRevisionNo: number,
  ): ReadonlyArray<ChapterCritique> {
    const rows = this.db
      .prepare(
        `SELECT * FROM chapter_critiques
          WHERE project_id = ? AND graph_run_id = ? AND candidate_revision_no = ?
          ORDER BY critic_node_id ASC`,
      )
      .all(projectId, graphRunId, candidateRevisionNo) as unknown as ReadonlyArray<DbCritiqueRow>;
    return rows.map(decodeCritique);
  }
}

/** B10（D-B10-3）：候选 Gate 的改写意见（图决策 DTO 无 feedback 字段，故独立存储） */
export class ChapterRewriteFeedbackRepositoryImpl implements ChapterRewriteFeedbackRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  save(feedback: ChapterRewriteFeedback): void {
    this.db
      .prepare(
        `INSERT INTO chapter_rewrite_feedback
           (id, project_id, graph_run_id, candidate_revision_no, feedback, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        feedback.id,
        feedback.projectId,
        feedback.graphRunId,
        feedback.candidateRevisionNo,
        feedback.feedback,
        feedback.createdAt,
      );
  }

  getLatestForRevision(
    projectId: string,
    graphRunId: string,
    candidateRevisionNo: number,
  ): ChapterRewriteFeedback | null {
    const row = this.db
      .prepare(
        `SELECT * FROM chapter_rewrite_feedback
          WHERE project_id = ? AND graph_run_id = ? AND candidate_revision_no = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId, graphRunId, candidateRevisionNo) as
      | {
          id: string;
          project_id: string;
          graph_run_id: string;
          candidate_revision_no: number;
          feedback: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      graphRunId: row.graph_run_id,
      candidateRevisionNo: row.candidate_revision_no,
      feedback: row.feedback,
      createdAt: row.created_at,
    };
  }
}
