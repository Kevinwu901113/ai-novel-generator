/**
 * 故事图谱仓库（D14 / B22，migration v22）。
 *
 * 三条纪律直接落在 SQL 上：
 * - story_states append-only：状态变化 = 插入新边 + 关闭旧边，UPDATE 只触碰
 *   valid_until_chapter / superseded_by_id 两列，事实内容永不被改写（D-B22-1）；
 * - 自动抽取只写 origin='extracted'，所有清理都带 origin 过滤，
 *   user 覆盖层不被重抽触碰（D-B22-4 / D-B22-6）；
 * - 自动抽取永不合并两个既有实体，疑似同实体只进待审队列（D-B22-5）。
 *
 * 只提供抽取管线（B22 工单二）需要的读写；故事圣经 UI 的查询在 B24。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  requireString,
  requireNumber,
  optionalString,
  optionalNumber,
} from './creation-contract-repositories.js';
import type {
  CreateStoryEntityAliasData,
  CreateStoryEntityData,
  CreateStoryExtractionData,
  CreateStoryMergeReviewData,
  CreateStoryStateData,
  CreateStoryThreadData,
  DbStoryEntityKind,
  DbStoryExtractionStatus,
  DbStoryMergeReviewStatus,
  DbStoryOrigin,
  DbStoryThreadStatus,
  StoryEntityRegistryEntry,
  StoryEntityRow,
  StoryExtractionRow,
  StoryGraphClearExtractedResult,
  StoryGraphPriorContext,
  StoryMergeReviewRow,
  StoryStateRow,
  StoryThreadRow,
} from './types.js';

// ── 读取解码 ──────────────────────────────────────────────────────

/** 图记录损坏（列值不符合 schema 承诺）；调用方按不可恢复错误处理 */
export class StoryGraphDataCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryGraphDataCorruptionError';
  }
}

function requireLiteral<T extends string>(
  row: Record<string, unknown>,
  key: string,
  allowed: ReadonlyArray<T>,
  context: string,
): T {
  const value = requireString(row, key, context);
  if (!(allowed as ReadonlyArray<string>).includes(value)) {
    throw new StoryGraphDataCorruptionError(`${context}: ${key} 非法取值 ${value}`);
  }
  return value as T;
}

const ORIGINS: ReadonlyArray<DbStoryOrigin> = ['extracted', 'user'];
const ENTITY_KINDS: ReadonlyArray<DbStoryEntityKind> = ['character', 'location', 'item', 'setting'];
const THREAD_STATUSES: ReadonlyArray<DbStoryThreadStatus> = ['open', 'closed', 'abandoned'];
const EXTRACTION_STATUSES: ReadonlyArray<DbStoryExtractionStatus> = [
  'pending',
  'succeeded',
  'failed',
];
const MERGE_REVIEW_STATUSES: ReadonlyArray<DbStoryMergeReviewStatus> = [
  'pending',
  'merged',
  'rejected',
];

function decodeEntity(row: Record<string, unknown>): StoryEntityRow {
  const ctx = 'story_entities';
  return {
    id: requireString(row, 'id', ctx),
    projectId: requireString(row, 'project_id', ctx),
    kind: requireLiteral(row, 'kind', ENTITY_KINDS, ctx),
    canonicalName: requireString(row, 'canonical_name', ctx),
    profileSummary: requireString(row, 'profile_summary', ctx),
    firstChapter: optionalNumber(row, 'first_chapter'),
    origin: requireLiteral(row, 'origin', ORIGINS, ctx),
    mergedIntoId: optionalString(row, 'merged_into_id'),
    createdAt: requireString(row, 'created_at', ctx),
    updatedAt: requireString(row, 'updated_at', ctx),
  };
}

function decodeState(row: Record<string, unknown>): StoryStateRow {
  const ctx = 'story_states';
  return {
    id: requireString(row, 'id', ctx),
    projectId: requireString(row, 'project_id', ctx),
    subjectEntityId: requireString(row, 'subject_entity_id', ctx),
    predicate: requireString(row, 'predicate', ctx),
    objectEntityId: optionalString(row, 'object_entity_id'),
    objectText: optionalString(row, 'object_text'),
    validFromChapter: requireNumber(row, 'valid_from_chapter', ctx),
    validUntilChapter: optionalNumber(row, 'valid_until_chapter'),
    sourceChapterId: optionalString(row, 'source_chapter_id'),
    sourceContentHash: optionalString(row, 'source_content_hash'),
    evidenceSpan: optionalString(row, 'evidence_span'),
    confidence: optionalNumber(row, 'confidence'),
    origin: requireLiteral(row, 'origin', ORIGINS, ctx),
    supersededById: optionalString(row, 'superseded_by_id'),
    createdAt: requireString(row, 'created_at', ctx),
  };
}

function decodeThread(row: Record<string, unknown>): StoryThreadRow {
  const ctx = 'story_threads';
  return {
    id: requireString(row, 'id', ctx),
    projectId: requireString(row, 'project_id', ctx),
    kind: requireString(row, 'kind', ctx),
    description: requireString(row, 'description', ctx),
    status: requireLiteral(row, 'status', THREAD_STATUSES, ctx),
    promisedPayoff: optionalString(row, 'promised_payoff'),
    openedChapter: requireNumber(row, 'opened_chapter', ctx),
    closedChapter: optionalNumber(row, 'closed_chapter'),
    sourceChapterId: optionalString(row, 'source_chapter_id'),
    sourceContentHash: optionalString(row, 'source_content_hash'),
    evidenceSpan: optionalString(row, 'evidence_span'),
    origin: requireLiteral(row, 'origin', ORIGINS, ctx),
    createdAt: requireString(row, 'created_at', ctx),
    updatedAt: requireString(row, 'updated_at', ctx),
  };
}

function decodeExtraction(row: Record<string, unknown>): StoryExtractionRow {
  const ctx = 'story_extractions';
  return {
    id: requireString(row, 'id', ctx),
    projectId: requireString(row, 'project_id', ctx),
    chapterId: requireString(row, 'chapter_id', ctx),
    sourceVersionId: requireString(row, 'source_version_id', ctx),
    sourceContentHash: requireString(row, 'source_content_hash', ctx),
    taskId: optionalString(row, 'task_id'),
    status: requireLiteral(row, 'status', EXTRACTION_STATUSES, ctx),
    extractedAt: requireString(row, 'extracted_at', ctx),
  };
}

function decodeMergeReview(row: Record<string, unknown>): StoryMergeReviewRow {
  const ctx = 'story_merge_reviews';
  return {
    id: requireString(row, 'id', ctx),
    projectId: requireString(row, 'project_id', ctx),
    entityAId: requireString(row, 'entity_a_id', ctx),
    entityBId: requireString(row, 'entity_b_id', ctx),
    suggestedReason: requireString(row, 'suggested_reason', ctx),
    status: requireLiteral(row, 'status', MERGE_REVIEW_STATUSES, ctx),
    createdAt: requireString(row, 'created_at', ctx),
    decidedAt: optionalString(row, 'decided_at'),
  };
}

// ── 实体档案追加（D-B22-5）────────────────────────────────────────

/** 实体档案字符上限：超限截断最旧段落 */
export const STORY_ENTITY_PROFILE_SUMMARY_LIMIT = 2000;

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * 把新描述追加到实体档案并按阈值收敛（D-B22-5）。
 *
 * 丢的永远是最旧段落——最新描述必留；单个段落自身超限时整段保留，
 * 不做句中切断（LightRAG 式 LLM 重摘要推迟到 B24）。
 */
export function appendProfileSummaryText(existing: string, addition: string): string {
  const paragraphs = [...splitParagraphs(existing), ...splitParagraphs(addition)];
  while (
    paragraphs.length > 1 &&
    paragraphs.join('\n\n').length > STORY_ENTITY_PROFILE_SUMMARY_LIMIT
  ) {
    paragraphs.shift();
  }
  return paragraphs.join('\n\n');
}

// ── 实体仓库 ──────────────────────────────────────────────────────

export class StoryEntityRepositoryImpl {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateStoryEntityData): void {
    this.db
      .prepare(
        `INSERT INTO story_entities
           (id, project_id, kind, canonical_name, profile_summary, first_chapter,
            origin, merged_into_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.kind,
        data.canonicalName,
        data.profileSummary,
        data.firstChapter,
        data.origin,
        data.createdAt,
        data.createdAt,
      );
  }

  getById(projectId: string, id: string): StoryEntityRow | null {
    const row = this.db
      .prepare('SELECT * FROM story_entities WHERE project_id = ? AND id = ?')
      .get(projectId, id) as Record<string, unknown> | undefined;
    return row ? decodeEntity(row) : null;
  }

  /**
   * canonical_name 精确命中（已被软合并的实体不再作为归并目标）。
   * 同名多实体时取最早创建的那个：判定重名是否同人由待审队列负责，不在这里猜。
   */
  findByCanonicalName(projectId: string, canonicalName: string): StoryEntityRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM story_entities
          WHERE project_id = ? AND canonical_name = ? AND merged_into_id IS NULL
          ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get(projectId, canonicalName) as Record<string, unknown> | undefined;
    return row ? decodeEntity(row) : null;
  }

  /** 别名精确命中 */
  findByAlias(projectId: string, alias: string): StoryEntityRow | null {
    const row = this.db
      .prepare(
        `SELECT e.* FROM story_entity_aliases a
           JOIN story_entities e ON e.id = a.entity_id
          WHERE a.project_id = ? AND a.alias = ? AND e.merged_into_id IS NULL
          ORDER BY e.created_at ASC, e.id ASC LIMIT 1`,
      )
      .get(projectId, alias) as Record<string, unknown> | undefined;
    return row ? decodeEntity(row) : null;
  }

  /** 归并判据：canonical_name 或别名精确命中（D-B22-5），都不中则是新实体 */
  findByNameOrAlias(projectId: string, name: string): StoryEntityRow | null {
    return this.findByCanonicalName(projectId, name) ?? this.findByAlias(projectId, name);
  }

  /** 追加档案段落（超阈值丢最旧段落）；实体不存在返回 false */
  appendProfileSummary(projectId: string, id: string, addition: string, now: string): boolean {
    const current = this.getById(projectId, id);
    if (!current) return false;
    const next = appendProfileSummaryText(current.profileSummary, addition);
    const result = this.db
      .prepare(
        `UPDATE story_entities SET profile_summary = ?, updated_at = ?
          WHERE project_id = ? AND id = ?`,
      )
      .run(next, now, projectId, id);
    return result.changes === 1;
  }

  /** 登记别名；同 (别名, 实体) 重复登记幂等返回 false */
  addAlias(data: CreateStoryEntityAliasData): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO story_entity_aliases
           (id, project_id, entity_id, alias, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(data.id, data.projectId, data.entityId, data.alias, data.origin, data.createdAt);
    return result.changes === 1;
  }

  listAliases(projectId: string, entityId: string): ReadonlyArray<string> {
    const rows = this.db
      .prepare(
        `SELECT alias FROM story_entity_aliases
          WHERE project_id = ? AND entity_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(projectId, entityId) as Array<Record<string, unknown>>;
    return rows.map((r) => requireString(r, 'alias', 'story_entity_aliases'));
  }
}

// ── 状态边仓库 ────────────────────────────────────────────────────

/** 前驱边被拼接后接手的两列（D-B22-7） */
interface SpliceLink {
  readonly supersededById: string | null;
  readonly validUntilChapter: number | null;
}

/**
 * 从被删边 startId 出发，跳过连环被删的边，返回前驱应接手的链接。
 *
 * 走到链上第一条存续边就停；被删边本身仍开着（superseded 为 NULL）时返回空链接，
 * 前驱因此重开。理论上不该出现的成环也按重开处理——宁可少一条链接不写坏数据。
 */
function resolveSpliceLink(doomed: ReadonlyMap<string, SpliceLink>, startId: string): SpliceLink {
  const empty: SpliceLink = { supersededById: null, validUntilChapter: null };
  let current = doomed.get(startId);
  const visited = new Set<string>([startId]);
  while (current) {
    const next = current.supersededById;
    if (next === null || !doomed.has(next)) {
      return { supersededById: next, validUntilChapter: current.validUntilChapter };
    }
    if (visited.has(next)) return empty;
    visited.add(next);
    current = doomed.get(next);
  }
  return empty;
}

export class StoryStateRepositoryImpl {
  constructor(private readonly db: DatabaseSync) {}

  /** 插入新边，一律以"仍有效"落库（valid_until_chapter / superseded_by_id 恒为 NULL） */
  insert(data: CreateStoryStateData): void {
    this.db
      .prepare(
        `INSERT INTO story_states
           (id, project_id, subject_entity_id, predicate, object_entity_id, object_text,
            valid_from_chapter, valid_until_chapter, source_chapter_id, source_content_hash,
            evidence_span, confidence, origin, superseded_by_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.subjectEntityId,
        data.predicate,
        data.objectEntityId,
        data.objectText,
        data.validFromChapter,
        data.sourceChapterId,
        data.sourceContentHash,
        data.evidenceSpan,
        data.confidence,
        data.origin,
        data.createdAt,
      );
  }

  getById(projectId: string, id: string): StoryStateRow | null {
    const row = this.db
      .prepare('SELECT * FROM story_states WHERE project_id = ? AND id = ?')
      .get(projectId, id) as Record<string, unknown> | undefined;
    return row ? decodeState(row) : null;
  }

  /**
   * 主体 + 谓词上当前有效的抽取边（valid_until_chapter IS NULL 且 origin='extracted'）。
   * 只看 extracted 层：user 覆盖层由检索端优先，重抽不许碰。
   */
  listCurrentBySubjectPredicate(
    projectId: string,
    subjectEntityId: string,
    predicate: string,
  ): ReadonlyArray<StoryStateRow> {
    const rows = this.db
      .prepare(
        `SELECT * FROM story_states
          WHERE project_id = ? AND subject_entity_id = ? AND predicate = ?
            AND valid_until_chapter IS NULL AND origin = 'extracted'
          ORDER BY valid_from_chapter ASC, created_at ASC, id ASC`,
      )
      .all(projectId, subjectEntityId, predicate) as Array<Record<string, unknown>>;
    return rows.map(decodeState);
  }

  listBySourceChapter(projectId: string, sourceChapterId: string): ReadonlyArray<StoryStateRow> {
    const rows = this.db
      .prepare(
        `SELECT * FROM story_states
          WHERE project_id = ? AND source_chapter_id = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(projectId, sourceChapterId) as Array<Record<string, unknown>>;
    return rows.map(decodeState);
  }

  /**
   * 关闭旧边：填 valid_until_chapter + superseded_by_id（append-only 的唯一写法）。
   *
   * WHERE 里的 valid_until_chapter IS NULL 保证不重复关闭，origin='extracted'
   * 保证用户覆盖层的边不会被自动抽取关掉。
   */
  supersede(
    projectId: string,
    id: string,
    validUntilChapter: number,
    supersededById: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE story_states
            SET valid_until_chapter = ?, superseded_by_id = ?
          WHERE project_id = ? AND id = ?
            AND valid_until_chapter IS NULL AND origin = 'extracted'`,
      )
      .run(validUntilChapter, supersededById, projectId, id);
    return result.changes === 1;
  }

  /**
   * 改章重抽的定向失效（D-B22-4，口径按 D-B22-7 收窄）：只删该章抽出的边，
   * 不级联删下游——下游边锚定在未改动章节的正文上，证据仍然成立，级联删除
   * 只会制造要靠全量重建才能补回的空洞。
   *
   * 删除前做链接拼接：前驱边 A 越过被删的 B 接手它的 superseded_by_id 与
   * valid_until_chapter（同章内连改两次时是 B1→B2 连环，逐跳走到链上第一条
   * 存续边为止）；B 若仍开着，A 就此重开。origin='user' 记录全程不触碰。
   * 返回删除行数。
   */
  deleteExtractedBySourceChapter(projectId: string, sourceChapterId: string): number {
    const ctx = 'story_states';
    const doomedRows = this.db
      .prepare(
        `SELECT id, superseded_by_id, valid_until_chapter FROM story_states
          WHERE project_id = ? AND source_chapter_id = ? AND origin = 'extracted'`,
      )
      .all(projectId, sourceChapterId) as Array<Record<string, unknown>>;
    if (doomedRows.length === 0) return 0;

    const doomed = new Map<string, SpliceLink>();
    for (const row of doomedRows) {
      doomed.set(requireString(row, 'id', ctx), {
        supersededById: optionalString(row, 'superseded_by_id'),
        validUntilChapter: optionalNumber(row, 'valid_until_chapter'),
      });
    }
    const ids = [...doomed.keys()];
    const placeholders = ids.map(() => '?').join(', ');

    // 存续前驱改写：跳过连环被删的边，接手链上第一条存续边的链接
    const predecessorRows = this.db
      .prepare(
        `SELECT id, superseded_by_id FROM story_states
          WHERE project_id = ? AND origin = 'extracted'
            AND superseded_by_id IN (${placeholders})`,
      )
      .all(projectId, ...ids) as Array<Record<string, unknown>>;
    const spliceStmt = this.db.prepare(
      `UPDATE story_states SET valid_until_chapter = ?, superseded_by_id = ?
        WHERE project_id = ? AND id = ?`,
    );
    for (const row of predecessorRows) {
      const id = requireString(row, 'id', ctx);
      if (doomed.has(id)) continue; // 待删集合内部的相互引用无需修补
      const link = resolveSpliceLink(doomed, requireString(row, 'superseded_by_id', ctx));
      spliceStmt.run(link.validUntilChapter, link.supersededById, projectId, id);
    }

    // 清掉待删边自身的链接，避免逐行删除时撞自引用 FK
    this.db
      .prepare(
        `UPDATE story_states SET superseded_by_id = NULL
          WHERE project_id = ? AND id IN (${placeholders})`,
      )
      .run(projectId, ...ids);
    const deleted = this.db
      .prepare(`DELETE FROM story_states WHERE project_id = ? AND id IN (${placeholders})`)
      .run(projectId, ...ids);
    return Number(deleted.changes);
  }
}

// ── 线程（伏笔）仓库 ──────────────────────────────────────────────

export class StoryThreadRepositoryImpl {
  constructor(private readonly db: DatabaseSync) {}

  /** 开启线程（status 恒为 'open'） */
  open(data: CreateStoryThreadData): void {
    this.db
      .prepare(
        `INSERT INTO story_threads
           (id, project_id, kind, description, status, promised_payoff, opened_chapter,
            closed_chapter, source_chapter_id, source_content_hash, evidence_span,
            origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.kind,
        data.description,
        data.promisedPayoff,
        data.openedChapter,
        data.sourceChapterId,
        data.sourceContentHash,
        data.evidenceSpan,
        data.origin,
        data.createdAt,
        data.createdAt,
      );
  }

  getById(projectId: string, id: string): StoryThreadRow | null {
    const row = this.db
      .prepare('SELECT * FROM story_threads WHERE project_id = ? AND id = ?')
      .get(projectId, id) as Record<string, unknown> | undefined;
    return row ? decodeThread(row) : null;
  }

  /** 描述精确命中的 open 线程（抽取端核销时先按描述找回既有线程） */
  findOpenByDescription(projectId: string, description: string): StoryThreadRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM story_threads
          WHERE project_id = ? AND description = ? AND status = 'open'
          ORDER BY opened_chapter ASC, created_at ASC, id ASC LIMIT 1`,
      )
      .get(projectId, description) as Record<string, unknown> | undefined;
    return row ? decodeThread(row) : null;
  }

  listOpen(projectId: string): ReadonlyArray<StoryThreadRow> {
    const rows = this.db
      .prepare(
        `SELECT * FROM story_threads
          WHERE project_id = ? AND status = 'open'
          ORDER BY opened_chapter ASC, created_at ASC, id ASC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map(decodeThread);
  }

  /** 核销：status → closed + closed_chapter；已核销/用户线程不动 */
  close(projectId: string, id: string, closedChapter: number, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE story_threads
            SET status = 'closed', closed_chapter = ?, updated_at = ?
          WHERE project_id = ? AND id = ? AND status = 'open' AND origin = 'extracted'`,
      )
      .run(closedChapter, now, projectId, id);
    return result.changes === 1;
  }

  /**
   * 重抽某章前把该章核销过的线程重开（否则重抽只会重复核销、少了的核销无从撤回）。
   * 按章节序而非章节 id 匹配，因为核销记录的是 closed_chapter 序号。
   */
  reopenClosedAtChapter(projectId: string, closedChapter: number, now: string): number {
    const result = this.db
      .prepare(
        `UPDATE story_threads
            SET status = 'open', closed_chapter = NULL, updated_at = ?
          WHERE project_id = ? AND closed_chapter = ?
            AND status = 'closed' AND origin = 'extracted'`,
      )
      .run(now, projectId, closedChapter);
    return Number(result.changes);
  }

  /** 改章重抽：删除该章开启的抽取线程（user 线程不动），返回删除行数 */
  deleteExtractedBySourceChapter(projectId: string, sourceChapterId: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM story_threads
          WHERE project_id = ? AND source_chapter_id = ? AND origin = 'extracted'`,
      )
      .run(projectId, sourceChapterId);
    return Number(result.changes);
  }
}

// ── 抽取账本仓库 ──────────────────────────────────────────────────

export class StoryExtractionRepositoryImpl {
  constructor(private readonly db: DatabaseSync) {}

  register(data: CreateStoryExtractionData): void {
    this.db
      .prepare(
        `INSERT INTO story_extractions
           (id, project_id, chapter_id, source_version_id, source_content_hash,
            task_id, status, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.chapterId,
        data.sourceVersionId,
        data.sourceContentHash,
        data.taskId,
        data.status,
        data.extractedAt,
      );
  }

  /** 该章最新一次抽取记录（读取端据此比对 content_hash 判 stale） */
  getLatestByChapter(projectId: string, chapterId: string): StoryExtractionRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM story_extractions
          WHERE project_id = ? AND chapter_id = ?
          ORDER BY extracted_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId, chapterId) as Record<string, unknown> | undefined;
    return row ? decodeExtraction(row) : null;
  }

  /** 改章重抽：清掉该章的账本记录，返回删除行数 */
  deleteByChapter(projectId: string, chapterId: string): number {
    const result = this.db
      .prepare('DELETE FROM story_extractions WHERE project_id = ? AND chapter_id = ?')
      .run(projectId, chapterId);
    return Number(result.changes);
  }
}

// ── 待审队列仓库 ──────────────────────────────────────────────────

export class StoryMergeReviewRepositoryImpl {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 提交待审（D-B22-5 铁律：自动抽取只能怀疑，不能合并）。
   * 同一对实体已有 pending 时幂等返回 false（部分唯一索引兜底）。
   */
  insertPending(data: CreateStoryMergeReviewData): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO story_merge_reviews
           (id, project_id, entity_a_id, entity_b_id, suggested_reason,
            status, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .run(
        data.id,
        data.projectId,
        data.entityAId,
        data.entityBId,
        data.suggestedReason,
        data.createdAt,
      );
    return result.changes === 1;
  }

  listPending(projectId: string): ReadonlyArray<StoryMergeReviewRow> {
    const rows = this.db
      .prepare(
        `SELECT * FROM story_merge_reviews
          WHERE project_id = ? AND status = 'pending'
          ORDER BY created_at ASC, id ASC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map(decodeMergeReview);
  }
}

// ── 跨表：前情登记表读取 + 回填清空 ───────────────────────────────

export class StoryGraphRepositoryImpl {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 前情登记表（D-B22-4）：一次取全项目实体（canonical + 别名）与 open 线程，
   * 供抽取 prompt 做指代消解的锚。
   */
  loadPriorContext(projectId: string): StoryGraphPriorContext {
    const entityRows = this.db
      .prepare(
        `SELECT * FROM story_entities
          WHERE project_id = ? AND merged_into_id IS NULL
          ORDER BY created_at ASC, id ASC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    const aliasRows = this.db
      .prepare(
        `SELECT entity_id, alias FROM story_entity_aliases
          WHERE project_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;

    const aliasesByEntity = new Map<string, string[]>();
    for (const row of aliasRows) {
      const entityId = requireString(row, 'entity_id', 'story_entity_aliases');
      const alias = requireString(row, 'alias', 'story_entity_aliases');
      const bucket = aliasesByEntity.get(entityId);
      if (bucket) bucket.push(alias);
      else aliasesByEntity.set(entityId, [alias]);
    }

    const entities: StoryEntityRegistryEntry[] = entityRows.map((row) => {
      const entity = decodeEntity(row);
      return { entity, aliases: aliasesByEntity.get(entity.id) ?? [] };
    });

    const threadRows = this.db
      .prepare(
        `SELECT * FROM story_threads
          WHERE project_id = ? AND status = 'open'
          ORDER BY opened_chapter ASC, created_at ASC, id ASC`,
      )
      .all(projectId) as Array<Record<string, unknown>>;

    return { entities, openThreads: threadRows.map(decodeThread) };
  }

  /**
   * 回填重建的第一步（D-B22-6）：清空全项目 extracted 图记录，
   * origin='user' 覆盖层原样保留。
   *
   * 两个不显然的地方：
   * - 待审队列整表清空：它的成员 id 指向即将被重建的 extracted 实体，留着就是悬空；
   * - 仍被 user 记录引用的 extracted 实体保留（删了会让保留下来的用户记录悬空，
   *   与"user 层永不受损"直接冲突）。
   */
  clearExtracted(projectId: string): StoryGraphClearExtractedResult {
    // append-only 允许触碰的两列：先解链再删，避免逐行删除时自引用 FK 报错
    this.db
      .prepare(
        `UPDATE story_states SET valid_until_chapter = NULL, superseded_by_id = NULL
          WHERE project_id = ? AND origin = 'extracted'`,
      )
      .run(projectId);
    const states = this.db
      .prepare(`DELETE FROM story_states WHERE project_id = ? AND origin = 'extracted'`)
      .run(projectId);
    const threads = this.db
      .prepare(`DELETE FROM story_threads WHERE project_id = ? AND origin = 'extracted'`)
      .run(projectId);
    const mergeReviews = this.db
      .prepare('DELETE FROM story_merge_reviews WHERE project_id = ?')
      .run(projectId);
    const aliases = this.db
      .prepare(`DELETE FROM story_entity_aliases WHERE project_id = ? AND origin = 'extracted'`)
      .run(projectId);
    const entities = this.db
      .prepare(
        `DELETE FROM story_entities
          WHERE project_id = ? AND origin = 'extracted'
            AND NOT EXISTS (
              SELECT 1 FROM story_entity_aliases a
               WHERE a.entity_id = story_entities.id AND a.origin = 'user')
            AND NOT EXISTS (
              SELECT 1 FROM story_states s
               WHERE s.origin = 'user'
                 AND (s.subject_entity_id = story_entities.id
                      OR s.object_entity_id = story_entities.id))
            AND NOT EXISTS (
              SELECT 1 FROM story_entities other
               WHERE other.origin = 'user' AND other.merged_into_id = story_entities.id)`,
      )
      .run(projectId);
    const extractions = this.db
      .prepare('DELETE FROM story_extractions WHERE project_id = ?')
      .run(projectId);

    return {
      states: Number(states.changes),
      threads: Number(threads.changes),
      aliases: Number(aliases.changes),
      entities: Number(entities.changes),
      extractions: Number(extractions.changes),
      mergeReviews: Number(mergeReviews.changes),
    };
  }
}
