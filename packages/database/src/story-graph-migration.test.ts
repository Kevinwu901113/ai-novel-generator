/**
 * 故事图谱数据层迁移测试（D14 / B22，migration v22）。
 *
 * 验证：
 * - 新建数据库直接得到六张图表（不建 story_events，D-D14-1 事件层二期）；
 * - 从 v21 升级：既有 tasks / model_invocations / dedupe 索引一行不丢；
 * - tasks.task_type CHECK 接受 STORY_GRAPH_EXTRACT，未知类型仍被拒；
 * - 表级不变量：origin 只认 extracted/user、状态边客体二选一恰好一个非空。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteMigrator } from './migrator.js';
import { ProjectDatabase, PROJECT_MIGRATIONS } from './project-database.js';

const NOW = '2026-08-19T00:00:00.000Z';
const HASH = 'a'.repeat(64);

const STORY_INDEX_TABLES = ['story_embeddings', 'story_graph_fts'];

const STORY_TABLES = [
  'story_entities',
  'story_entity_aliases',
  'story_states',
  'story_threads',
  'story_extractions',
  'story_merge_reviews',
];

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'story-graph-migration-'));
  dbPath = join(tempDir, 'project.sqlite');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 构建一个 v21 数据库并写入代表既有数据的任务链。 */
function buildV21Database(): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const migrator = new SQLiteMigrator(db);
    migrator.migrate(0, PROJECT_MIGRATIONS.slice(0, 21));
    expect(migrator.getCurrentVersion()).toBe(21);

    db.prepare(
      `INSERT INTO project_metadata (id, name, initial_idea, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('p1', '项目一', '一个故事', 'drafting', NOW, NOW);

    db.prepare(
      `INSERT INTO tasks
         (id, project_id, task_type, status, input_version_json, payload_json,
          result_json, error_code, error_message, attempt_count, dedupe_key,
          created_at, updated_at, started_at, finished_at, stale_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      't-draft',
      'p1',
      'CHAPTER_DRAFT',
      'SUCCEEDED',
      '{}',
      '{"chapterId":"c1"}',
      '{"ok":true}',
      null,
      null,
      2,
      null,
      NOW,
      NOW,
      NOW,
      NOW,
      null,
      null,
    );
    db.prepare(
      `INSERT INTO tasks
         (id, project_id, task_type, status, input_version_json, payload_json,
          result_json, error_code, error_message, attempt_count, dedupe_key,
          created_at, updated_at, started_at, finished_at, stale_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      't-plan',
      'p1',
      'GRILL_QUESTION_PLAN',
      'PENDING',
      '{"sessionId":"gs1","baseSessionVersion":1}',
      '{}',
      null,
      null,
      null,
      0,
      'grill_question_plan:gs1:1',
      NOW,
      NOW,
      null,
      null,
      null,
      null,
    );

    db.prepare(
      `INSERT INTO model_invocations
         (id, project_id, task_id, provider_profile_id, model, status,
          attempt_number, request_kind, prompt_hash, request_metadata_json,
          response_metadata_json, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, total_tokens, latency_ms, finish_reason, error_code,
          error_message, provider_request_id, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'inv-draft',
      'p1',
      't-draft',
      'mimo-token-plan-cn',
      'MiMo-V2.5-Pro',
      'SUCCEEDED',
      1,
      'chapter_draft',
      HASH,
      '{}',
      '{}',
      100,
      200,
      null,
      null,
      300,
      1200,
      'end_turn',
      null,
      null,
      'req-1',
      NOW,
      NOW,
      NOW,
    );
  } finally {
    db.close();
  }
}

function seedProject(db: ProjectDatabase): void {
  db.getProjectMetadataRepository().create({
    id: 'p1',
    name: '项目一',
    initialIdea: '一个故事',
    status: 'drafting',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function listTables(db: ProjectDatabase): ReadonlyArray<string> {
  return (
    db.database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe('migration v22: 故事图谱数据层', () => {
  it('新建数据库直接建齐六张图表，且不建 story_events', () => {
    const db = new ProjectDatabase(dbPath);
    try {
      const tables = listTables(db);
      for (const table of STORY_TABLES) {
        expect(tables).toContain(table);
      }
      // 事件时间线按 D-D14-1 推迟到二期
      expect(tables).not.toContain('story_events');

      // 全部 STRICT
      for (const table of STORY_TABLES) {
        const sql = (
          db.database
            .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
            .get(table) as { sql: string }
        ).sql;
        expect(sql).toContain('STRICT');
      }
    } finally {
      db.close();
    }
  });

  it('从 v21 升级到 v22：既有任务与调用记录一行不丢', () => {
    buildV21Database();
    const db = new ProjectDatabase(dbPath);
    try {
      const version = db.database
        .prepare('SELECT MAX(version) as v FROM schema_migrations')
        .get() as { v: number };
      expect(version.v).toBe(23);

      const tasks = db.getTaskRepository().listByProject('p1');
      expect(tasks.map((t) => t.taskType).sort()).toEqual(['CHAPTER_DRAFT', 'GRILL_QUESTION_PLAN']);

      const draft = db.getTaskRepository().getById('t-draft');
      expect(draft?.status).toBe('SUCCEEDED');
      expect(draft?.attemptCount).toBe(2);
      expect(draft?.resultJson).toBe('{"ok":true}');
      expect(draft?.payloadJson).toBe('{"chapterId":"c1"}');

      const plan = db.getTaskRepository().getById('t-plan');
      expect(plan?.dedupeKey).toBe('grill_question_plan:gs1:1');

      const invocation = db.getModelInvocationRepository().getById('inv-draft');
      expect(invocation?.model).toBe('MiMo-V2.5-Pro');
      expect(invocation?.totalTokens).toBe(300);
      expect(invocation?.providerRequestId).toBe('req-1');

      // 六表在升级路径上同样建齐
      const tables = listTables(db);
      for (const table of STORY_TABLES) {
        expect(tables).toContain(table);
      }
      // 重建 tasks 未留下第二套任务表
      expect(tables.filter((n) => n.startsWith('tasks_'))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('升级后 tasks 索引仍在，dedupe 唯一性仍生效', () => {
    buildV21Database();
    const db = new ProjectDatabase(dbPath);
    try {
      const indexNames = (
        db.database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      for (const expected of [
        'idx_tasks_status',
        'idx_tasks_project_created',
        'idx_tasks_dedupe_active',
        'uq_tasks_project_id',
      ]) {
        expect(indexNames).toContain(expected);
      }

      expect(() =>
        db.getTaskRepository().create({
          id: 't-plan-dup',
          projectId: 'p1',
          taskType: 'GRILL_QUESTION_PLAN',
          status: 'PENDING',
          inputVersionJson: '{}',
          payloadJson: '{}',
          dedupeKey: 'grill_question_plan:gs1:1',
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('tasks 接受 STORY_GRAPH_EXTRACT，拒绝未知任务类型', () => {
    buildV21Database();
    const db = new ProjectDatabase(dbPath);
    try {
      db.getTaskRepository().create({
        id: 't-graph',
        projectId: 'p1',
        taskType: 'STORY_GRAPH_EXTRACT',
        status: 'PENDING',
        inputVersionJson: '{}',
        payloadJson: '{"chapterId":"c1","sourceVersionId":"v1"}',
        dedupeKey: 'story_graph_extract:c1',
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(db.getTaskRepository().getById('t-graph')?.taskType).toBe('STORY_GRAPH_EXTRACT');

      expect(() =>
        db.getTaskRepository().create({
          id: 't-bad',
          projectId: 'p1',
          taskType: 'STORY_GRAPH_REBUILD' as never,
          status: 'PENDING',
          inputVersionJson: '{}',
          payloadJson: '{}',
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('origin 只认 extracted/user', () => {
    const db = new ProjectDatabase(dbPath);
    try {
      seedProject(db);
      expect(() =>
        db.database
          .prepare(
            `INSERT INTO story_entities
               (id, project_id, kind, canonical_name, profile_summary, first_chapter,
                origin, merged_into_id, created_at, updated_at)
             VALUES (?, ?, 'character', ?, '', 1, 'imported', NULL, ?, ?)`,
          )
          .run('e-bad', 'p1', '林三', NOW, NOW),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('状态边客体二选一：两个都填或都空都被拒', () => {
    const db = new ProjectDatabase(dbPath);
    try {
      seedProject(db);
      db.getStoryEntityRepository().create({
        id: 'e1',
        projectId: 'p1',
        kind: 'character',
        canonicalName: '林三',
        profileSummary: '',
        firstChapter: 1,
        origin: 'extracted',
        createdAt: NOW,
      });

      const insertState = (objectEntityId: string | null, objectText: string | null): void => {
        db.database
          .prepare(
            `INSERT INTO story_states
               (id, project_id, subject_entity_id, predicate, object_entity_id, object_text,
                valid_from_chapter, valid_until_chapter, source_chapter_id, source_content_hash,
                evidence_span, confidence, origin, superseded_by_id, created_at)
             VALUES (?, 'p1', 'e1', '身份', ?, ?, 1, NULL, 'c1', ?, NULL, NULL, 'extracted', NULL, ?)`,
          )
          .run('s-bad', objectEntityId, objectText, HASH, NOW);
      };

      expect(() => insertState(null, null)).toThrow();
      expect(() => insertState('e1', '掌门')).toThrow();
    } finally {
      db.close();
    }
  });

  it('抽取记录必须锚定来源章与内容哈希，user 覆盖层不受此限', () => {
    const db = new ProjectDatabase(dbPath);
    try {
      seedProject(db);
      db.getStoryEntityRepository().create({
        id: 'e1',
        projectId: 'p1',
        kind: 'character',
        canonicalName: '林三',
        profileSummary: '',
        firstChapter: 1,
        origin: 'extracted',
        createdAt: NOW,
      });

      expect(() =>
        db.getStoryStateRepository().insert({
          id: 's-unanchored',
          projectId: 'p1',
          subjectEntityId: 'e1',
          predicate: '身份',
          objectEntityId: null,
          objectText: '掌门',
          validFromChapter: 1,
          sourceChapterId: null,
          sourceContentHash: null,
          evidenceSpan: null,
          confidence: null,
          origin: 'extracted',
          createdAt: NOW,
        }),
      ).toThrow();

      db.getStoryStateRepository().insert({
        id: 's-user',
        projectId: 'p1',
        subjectEntityId: 'e1',
        predicate: '身份',
        objectEntityId: null,
        objectText: '掌门',
        validFromChapter: 1,
        sourceChapterId: null,
        sourceContentHash: null,
        evidenceSpan: null,
        confidence: null,
        origin: 'user',
        createdAt: NOW,
      });
      expect(db.getStoryStateRepository().getById('p1', 's-user')?.origin).toBe('user');
    } finally {
      db.close();
    }
  });
});

describe('migration v23: 检索地基（story_embeddings + story_graph_fts）', () => {
  it('新建数据库直接建齐两张索引表', () => {
    const db = new ProjectDatabase(dbPath);
    try {
      const tables = listTables(db);
      for (const table of STORY_INDEX_TABLES) {
        expect(tables).toContain(table);
      }
      const embeddingsSql = (
        db.database
          .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get('story_embeddings') as { sql: string }
      ).sql;
      expect(embeddingsSql).toContain('STRICT');
    } finally {
      db.close();
    }
  });

  it('从 v22 升级：既有图数据不丢，索引表补齐', () => {
    // 先建到 v22 并写入一条图记录
    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec('PRAGMA foreign_keys = ON');
      const migrator = new SQLiteMigrator(legacy);
      migrator.migrate(0, PROJECT_MIGRATIONS.slice(0, 22));
      expect(migrator.getCurrentVersion()).toBe(22);
      legacy
        .prepare(
          `INSERT INTO project_metadata (id, name, initial_idea, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('p1', '项目一', '一个故事', 'drafting', NOW, NOW);
      legacy
        .prepare(
          `INSERT INTO story_entities
             (id, project_id, kind, canonical_name, profile_summary, first_chapter,
              origin, merged_into_id, created_at, updated_at)
           VALUES (?, ?, 'character', ?, ?, 1, 'extracted', NULL, ?, ?)`,
        )
        .run('e1', 'p1', '林三', '外门弟子', NOW, NOW);
    } finally {
      legacy.close();
    }

    const db = new ProjectDatabase(dbPath);
    try {
      const version = db.database
        .prepare('SELECT MAX(version) as v FROM schema_migrations')
        .get() as { v: number };
      expect(version.v).toBe(23);
      expect(db.getStoryEntityRepository().findByCanonicalName('p1', '林三')?.id).toBe('e1');
      for (const table of STORY_INDEX_TABLES) {
        expect(listTables(db)).toContain(table);
      }
      // v22 时代写进去的旧行没有 FTS 索引（v23 之前没有这张表）——
      // 回填重建会把它们重新灌进去，这里如实断言现状而不是假装它已经在了
      expect(db.getStoryGraphSearch().searchFts('p1', '外门弟子', 10)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('FTS 虚表可用：trigram 子串命中，两字词按分词器语义命中不了', () => {
    const db = new ProjectDatabase(dbPath);
    try {
      seedProject(db);
      db.database
        .prepare('INSERT INTO story_graph_fts (kind, ref_id, text) VALUES (?, ?, ?)')
        .run('state', 's1', '身份 外门弟子 他还只是外门弟子。');

      const hit = db.getStoryGraphSearch().searchFts('p1', '外门弟子', 10);
      expect(hit.map((m) => m.refId)).toEqual(['s1']);
      // trigram 的硬性下限是 3 字符：两字词永远不命中（所以主干还有别名激活那一路）
      expect(db.getStoryGraphSearch().searchFts('p1', '外门', 10)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('嵌入表唯一约束：同一图行至多一条嵌入', () => {
    const db = new ProjectDatabase(dbPath);
    try {
      seedProject(db);
      const insert = (id: string) =>
        db.database
          .prepare(
            `INSERT INTO story_embeddings
               (id, project_id, kind, ref_id, model, dims, vector, content_hash, created_at)
             VALUES (?, 'p1', 'state', 's1', 'm', 2, ?, ?, ?)`,
          )
          .run(id, new Uint8Array(8), 'a'.repeat(64), NOW);
      insert('emb-1');
      expect(() => insert('emb-2')).toThrow();
    } finally {
      db.close();
    }
  });
});
