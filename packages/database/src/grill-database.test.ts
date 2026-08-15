import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDatabase } from './project-database.js';
import { SQLiteMigrator } from './migrator.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'grill-database-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createDb(): ProjectDatabase {
  return new ProjectDatabase(join(tempDir, 'project.sqlite'));
}

const NOW = '2024-06-15T12:00:00.000Z';
const LATER = '2024-06-15T13:00:00.000Z';

// ── 迁移测试 ──────────────────────────────────────────────────────

describe('Grill 迁移', () => {
  it('新数据库应该包含 grill 表', () => {
    const db = createDb();
    try {
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'grill_%'")
        .all() as Array<{ name: string }>;
      raw.close();

      const names = tables.map((t) => t.name).sort();
      expect(names).toEqual([
        'grill_answers',
        'grill_inference_proposals',
        'grill_question_plan_proposals',
        'grill_questions',
        'grill_sessions',
      ]);
    } finally {
      db.close();
    }
  });

  it('新数据库版本应该是当前最新迁移版本', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const db = new ProjectDatabase(dbPath);
    db.close();

    const raw = new DatabaseSync(dbPath);
    const migrator = new SQLiteMigrator(raw);
    expect(migrator.getCurrentVersion()).toBe(20);
    raw.close();
  });

  it('v2 数据库升级到 v3 应该保留已有数据', () => {
    const dbPath = join(tempDir, 'project.sqlite');

    // 手动创建 v2 数据库
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations VALUES (1, '${NOW}');
      INSERT INTO schema_migrations VALUES (2, '${NOW}');

      CREATE TABLE project_metadata (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, initial_idea TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idea', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO project_metadata VALUES ('p1', '测试项目', '想法', 'idea', '${NOW}', '${NOW}');

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_type TEXT NOT NULL,
        status TEXT NOT NULL, input_version_json TEXT NOT NULL, payload_json TEXT NOT NULL,
        result_json TEXT, error_code TEXT, error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, stale_at TEXT, cancelled_at TEXT,
        CHECK (task_type IN ('PROVIDER_CONNECTION_TEST', 'MODEL_INVOCATION_TEST')),
        CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE')),
        CHECK (attempt_count >= 0),
        CHECK (json_valid(input_version_json)),
        CHECK (json_valid(payload_json)),
        CHECK (result_json IS NULL OR json_valid(result_json))
      ) STRICT;
      INSERT INTO tasks (id, project_id, task_type, status, input_version_json, payload_json, created_at, updated_at)
        VALUES ('t1', 'p1', 'MODEL_INVOCATION_TEST', 'SUCCEEDED', '{}', '{}', '${NOW}', '${NOW}');

      CREATE TABLE model_invocations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
        provider_profile_id TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
        attempt_number INTEGER NOT NULL, request_kind TEXT NOT NULL, prompt_hash TEXT NOT NULL,
        request_metadata_json TEXT NOT NULL, response_metadata_json TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, total_tokens INTEGER, latency_ms INTEGER,
        finish_reason TEXT, error_code TEXT, error_message TEXT, provider_request_id TEXT,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
        CHECK (attempt_number >= 1),
        CHECK (length(prompt_hash) = 64),
        CHECK (json_valid(request_metadata_json)),
        CHECK (response_metadata_json IS NULL OR json_valid(response_metadata_json))
      ) STRICT;
    `);
    raw.close();

    // 用 ProjectDatabase 打开（触发 v3 迁移）
    const db = new ProjectDatabase(dbPath);
    try {
      // 旧数据保留
      const metadata = db.getProjectMetadataRepository().get();
      expect(metadata?.name).toBe('测试项目');

      const task = db.getTaskRepository().getById('t1');
      expect(task?.status).toBe('SUCCEEDED');

      // grill 表可用
      db.getGrillSessionRepository().create({
        id: 'gs1',
        projectId: 'p1',
        goal: '测试目标',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const session = db.getGrillSessionRepository().getById('gs1');
      expect(session?.goal).toBe('测试目标');
    } finally {
      db.close();
    }
  });

  it('重新打开已迁移数据库应该幂等', () => {
    const dbPath = join(tempDir, 'project.sqlite');
    const db1 = new ProjectDatabase(dbPath);
    db1.getGrillSessionRepository().create({
      id: 'gs1',
      projectId: 'p1',
      goal: '目标',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db1.close();

    const db2 = new ProjectDatabase(dbPath);
    try {
      const session = db2.getGrillSessionRepository().getById('gs1');
      expect(session?.goal).toBe('目标');
    } finally {
      db2.close();
    }
  });
});

// ── CHECK 约束测试 ────────────────────────────────────────────────

describe('grill_sessions CHECK 约束', () => {
  it('拒绝非法 status', () => {
    const db = createDb();
    try {
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_sessions (id, project_id, status, version, goal, created_at, updated_at)
             VALUES ('x', 'p', 'INVALID', 1, 'g', '${NOW}', '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('拒绝 version < 1', () => {
    const db = createDb();
    try {
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_sessions (id, project_id, status, version, goal, created_at, updated_at)
             VALUES ('x', 'p', 'DRAFT', 0, 'g', '${NOW}', '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });
});

describe('grill_questions 约束', () => {
  it('FK: 拒绝不存在的 session_id', () => {
    const db = createDb();
    try {
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      raw.exec('PRAGMA foreign_keys = ON');
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_questions (id, session_id, sequence, topic, text, created_at)
             VALUES ('q1', 'nonexistent', 1, 'topic', 'text', '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('CHECK: 拒绝非法 status', () => {
    const db = createDb();
    try {
      db.getGrillSessionRepository().create({
        id: 's1',
        projectId: 'p1',
        goal: 'g',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_questions (id, session_id, sequence, topic, text, status, created_at)
             VALUES ('q1', 's1', 1, 'topic', 'text', 'INVALID', '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('CHECK: 拒绝 sequence < 1', () => {
    const db = createDb();
    try {
      db.getGrillSessionRepository().create({
        id: 's1',
        projectId: 'p1',
        goal: 'g',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_questions (id, session_id, sequence, topic, text, created_at)
             VALUES ('q1', 's1', 0, 'topic', 'text', '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('CHECK: 拒绝非法 depends_on_question_ids JSON', () => {
    const db = createDb();
    try {
      db.getGrillSessionRepository().create({
        id: 's1',
        projectId: 'p1',
        goal: 'g',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_questions (id, session_id, sequence, topic, text, depends_on_question_ids, created_at)
             VALUES ('q1', 's1', 1, 'topic', 'text', 'not-json', '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('UNIQUE: 拒绝同 session 重复 sequence', () => {
    const db = createDb();
    try {
      db.getGrillSessionRepository().create({
        id: 's1',
        projectId: 'p1',
        goal: 'g',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const repo = db.getGrillQuestionRepository();
      repo.create({
        id: 'q1',
        sessionId: 's1',
        sequence: 1,
        topic: 'topic',
        text: 'text',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });
      expect(() =>
        repo.create({
          id: 'q2',
          sessionId: 's1',
          sequence: 1,
          topic: 'topic2',
          text: 'text2',
          rationale: '',
          dependsOnQuestionIds: '[]',
          createdAt: NOW,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('grill_answers 约束', () => {
  function setupSessionAndQuestion(db: ProjectDatabase): void {
    db.getGrillSessionRepository().create({
      id: 's1',
      projectId: 'p1',
      goal: 'g',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.getGrillQuestionRepository().create({
      id: 'q1',
      sessionId: 's1',
      sequence: 1,
      topic: 'topic',
      text: 'text',
      rationale: '',
      dependsOnQuestionIds: '[]',
      createdAt: NOW,
    });
  }

  it('FK: 拒绝不存在的 question_id', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      raw.exec('PRAGMA foreign_keys = ON');
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_answers (id, session_id, question_id, revision, source, text, created_at)
             VALUES ('a1', 's1', 'nonexistent', 1, 'USER', 'answer', '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('CHECK: 拒绝非法 source', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_answers (id, session_id, question_id, revision, source, text, created_at)
             VALUES ('a1', 's1', 'q1', 1, 'AI', 'answer', '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('CHECK: 拒绝 revision < 1', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_answers (id, session_id, question_id, revision, source, text, created_at)
             VALUES ('a1', 's1', 'q1', 0, 'USER', 'answer', '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('UNIQUE: 拒绝同 question 重复 revision', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      const repo = db.getGrillAnswerRepository();
      repo.create({
        id: 'a1',
        sessionId: 's1',
        questionId: 'q1',
        revision: 1,
        source: 'USER',
        text: 'answer1',
        createdAt: NOW,
      });
      expect(() =>
        repo.create({
          id: 'a2',
          sessionId: 's1',
          questionId: 'q1',
          revision: 1,
          source: 'USER',
          text: 'answer2',
          createdAt: LATER,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('grill_inference_proposals 约束', () => {
  function setupSession(db: ProjectDatabase): void {
    db.getGrillSessionRepository().create({
      id: 's1',
      projectId: 'p1',
      goal: 'g',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  it('CHECK: 拒绝 confidence < 0', () => {
    const db = createDb();
    try {
      setupSession(db);
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_inference_proposals
               (id, session_id, based_on_answer_ids, key, proposed_value_json, confidence, created_at)
             VALUES ('pr1', 's1', '[]', 'k', '{}', -0.1, '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('CHECK: 拒绝 confidence > 1', () => {
    const db = createDb();
    try {
      setupSession(db);
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_inference_proposals
               (id, session_id, based_on_answer_ids, key, proposed_value_json, confidence, created_at)
             VALUES ('pr1', 's1', '[]', 'k', '{}', 1.1, '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('CHECK: confidence 边界 0 和 1 合法', () => {
    const db = createDb();
    try {
      setupSession(db);
      const repo = db.getGrillProposalRepository();
      repo.create({
        id: 'pr1',
        sessionId: 's1',
        basedOnAnswerIds: '[]',
        key: 'k1',
        proposedValueJson: '"v1"',
        confidence: 0,
        rationale: '',
        createdAt: NOW,
      });
      repo.create({
        id: 'pr2',
        sessionId: 's1',
        basedOnAnswerIds: '[]',
        key: 'k2',
        proposedValueJson: '"v2"',
        confidence: 1,
        rationale: '',
        createdAt: NOW,
      });
      expect(repo.getById('pr1')?.confidence).toBe(0);
      expect(repo.getById('pr2')?.confidence).toBe(1);
    } finally {
      db.close();
    }
  });

  it('CHECK: 拒绝非法 proposed_value_json', () => {
    const db = createDb();
    try {
      setupSession(db);
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_inference_proposals
               (id, session_id, based_on_answer_ids, key, proposed_value_json, confidence, created_at)
             VALUES ('pr1', 's1', '[]', 'k', 'not-json', 0.5, '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('CHECK: 拒绝非法 based_on_answer_ids JSON', () => {
    const db = createDb();
    try {
      setupSession(db);
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_inference_proposals
               (id, session_id, based_on_answer_ids, key, proposed_value_json, confidence, created_at)
             VALUES ('pr1', 's1', 'bad', 'k', '{}', 0.5, '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('FK: 拒绝不存在的 session_id', () => {
    const db = createDb();
    try {
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      raw.exec('PRAGMA foreign_keys = ON');
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_inference_proposals
               (id, session_id, based_on_answer_ids, key, proposed_value_json, confidence, created_at)
             VALUES ('pr1', 'nonexistent', '[]', 'k', '{}', 0.5, '${NOW}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });
});

// ── GrillSessionRepository 测试 ───────────────────────────────────

describe('GrillSessionRepository', () => {
  it('create + getById 往返', () => {
    const db = createDb();
    try {
      const repo = db.getGrillSessionRepository();
      repo.create({ id: 's1', projectId: 'p1', goal: '目标', createdAt: NOW, updatedAt: NOW });

      const session = repo.getById('s1');
      expect(session).toEqual({
        id: 's1',
        projectId: 'p1',
        status: 'DRAFT',
        version: 1,
        goal: '目标',
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: null,
        completedAt: null,
        abandonedAt: null,
      });
    } finally {
      db.close();
    }
  });

  it('getById 不存在返回 null', () => {
    const db = createDb();
    try {
      expect(db.getGrillSessionRepository().getById('nonexistent')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('listByProject 过滤', () => {
    const db = createDb();
    try {
      const repo = db.getGrillSessionRepository();
      repo.create({ id: 's1', projectId: 'p1', goal: 'g1', createdAt: NOW, updatedAt: NOW });
      repo.create({ id: 's2', projectId: 'p2', goal: 'g2', createdAt: NOW, updatedAt: NOW });
      repo.create({ id: 's3', projectId: 'p1', goal: 'g3', createdAt: LATER, updatedAt: LATER });

      const list = repo.listByProject('p1');
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('s3'); // DESC order
      expect(list[1].id).toBe('s1');
    } finally {
      db.close();
    }
  });

  it('transitionStatus CAS 成功（version 递增）', () => {
    const db = createDb();
    try {
      const repo = db.getGrillSessionRepository();
      repo.create({ id: 's1', projectId: 'p1', goal: 'g', createdAt: NOW, updatedAt: NOW });

      const ok = repo.transitionStatus('s1', 1, 'ACTIVE', LATER);
      expect(ok).toBe(true);

      const session = repo.getById('s1');
      expect(session?.status).toBe('ACTIVE');
      expect(session?.version).toBe(2);
      expect(session?.startedAt).toBe(LATER);
      expect(session?.updatedAt).toBe(LATER);
    } finally {
      db.close();
    }
  });

  it('transitionStatus CAS 失败（version 不匹配）', () => {
    const db = createDb();
    try {
      const repo = db.getGrillSessionRepository();
      repo.create({ id: 's1', projectId: 'p1', goal: 'g', createdAt: NOW, updatedAt: NOW });

      const ok = repo.transitionStatus('s1', 99, 'ACTIVE', LATER);
      expect(ok).toBe(false);

      const session = repo.getById('s1');
      expect(session?.status).toBe('DRAFT');
      expect(session?.version).toBe(1);
    } finally {
      db.close();
    }
  });

  it('transitionStatus COMPLETED 设置 completedAt', () => {
    const db = createDb();
    try {
      const repo = db.getGrillSessionRepository();
      repo.create({ id: 's1', projectId: 'p1', goal: 'g', createdAt: NOW, updatedAt: NOW });
      repo.transitionStatus('s1', 1, 'ACTIVE', LATER);

      const ok = repo.transitionStatus('s1', 2, 'COMPLETED', LATER);
      expect(ok).toBe(true);
      expect(repo.getById('s1')?.completedAt).toBe(LATER);
    } finally {
      db.close();
    }
  });

  it('transitionStatus ABANDONED 设置 abandonedAt', () => {
    const db = createDb();
    try {
      const repo = db.getGrillSessionRepository();
      repo.create({ id: 's1', projectId: 'p1', goal: 'g', createdAt: NOW, updatedAt: NOW });

      const ok = repo.transitionStatus('s1', 1, 'ABANDONED', LATER);
      expect(ok).toBe(true);
      expect(repo.getById('s1')?.abandonedAt).toBe(LATER);
    } finally {
      db.close();
    }
  });

  it('bumpVersion CAS 成功', () => {
    const db = createDb();
    try {
      const repo = db.getGrillSessionRepository();
      repo.create({ id: 's1', projectId: 'p1', goal: 'g', createdAt: NOW, updatedAt: NOW });

      const ok = repo.bumpVersion('s1', 1, LATER);
      expect(ok).toBe(true);
      expect(repo.getById('s1')?.version).toBe(2);
    } finally {
      db.close();
    }
  });

  it('bumpVersion CAS 失败', () => {
    const db = createDb();
    try {
      const repo = db.getGrillSessionRepository();
      repo.create({ id: 's1', projectId: 'p1', goal: 'g', createdAt: NOW, updatedAt: NOW });

      const ok = repo.bumpVersion('s1', 99, LATER);
      expect(ok).toBe(false);
      expect(repo.getById('s1')?.version).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ── GrillQuestionRepository 测试 ──────────────────────────────────

describe('GrillQuestionRepository', () => {
  function setupSession(db: ProjectDatabase): void {
    db.getGrillSessionRepository().create({
      id: 's1',
      projectId: 'p1',
      goal: 'g',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  it('create + getById', () => {
    const db = createDb();
    try {
      setupSession(db);
      const repo = db.getGrillQuestionRepository();
      repo.create({
        id: 'q1',
        sessionId: 's1',
        sequence: 1,
        topic: '主题',
        text: '问题文本',
        rationale: '原因',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });

      const q = repo.getById('q1');
      expect(q?.topic).toBe('主题');
      expect(q?.status).toBe('PLANNED');
      expect(q?.sequence).toBe(1);
    } finally {
      db.close();
    }
  });

  it('listBySession 按 sequence 排序', () => {
    const db = createDb();
    try {
      setupSession(db);
      const repo = db.getGrillQuestionRepository();
      repo.create({
        id: 'q2',
        sessionId: 's1',
        sequence: 2,
        topic: 't2',
        text: 'x',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });
      repo.create({
        id: 'q1',
        sessionId: 's1',
        sequence: 1,
        topic: 't1',
        text: 'x',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });

      const list = repo.listBySession('s1');
      expect(list[0].id).toBe('q1');
      expect(list[1].id).toBe('q2');
    } finally {
      db.close();
    }
  });

  it('transitionStatus 更新对应时间戳', () => {
    const db = createDb();
    try {
      setupSession(db);
      const repo = db.getGrillQuestionRepository();
      repo.create({
        id: 'q1',
        sessionId: 's1',
        sequence: 1,
        topic: 't',
        text: 'x',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });

      expect(repo.transitionStatus('q1', 'PLANNED', 'ASKED', LATER)).toBe(true);
      expect(repo.getById('q1')?.askedAt).toBe(LATER);
      expect(repo.getById('q1')?.status).toBe('ASKED');

      expect(repo.transitionStatus('q1', 'ASKED', 'ANSWERED', LATER)).toBe(true);
      expect(repo.getById('q1')?.answeredAt).toBe(LATER);
    } finally {
      db.close();
    }
  });

  it('transitionStatus CAS 失败（状态不匹配）', () => {
    const db = createDb();
    try {
      setupSession(db);
      const repo = db.getGrillQuestionRepository();
      repo.create({
        id: 'q1',
        sessionId: 's1',
        sequence: 1,
        topic: 't',
        text: 'x',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });

      expect(repo.transitionStatus('q1', 'ASKED', 'ANSWERED', LATER)).toBe(false);
      expect(repo.getById('q1')?.status).toBe('PLANNED');
    } finally {
      db.close();
    }
  });

  it('getMaxSequence', () => {
    const db = createDb();
    try {
      setupSession(db);
      const repo = db.getGrillQuestionRepository();
      expect(repo.getMaxSequence('s1')).toBe(0);

      repo.create({
        id: 'q1',
        sessionId: 's1',
        sequence: 3,
        topic: 't',
        text: 'x',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });
      expect(repo.getMaxSequence('s1')).toBe(3);
    } finally {
      db.close();
    }
  });
});

// ── GrillAnswerRepository 测试 ────────────────────────────────────

describe('GrillAnswerRepository', () => {
  function setupSessionAndQuestion(db: ProjectDatabase): void {
    db.getGrillSessionRepository().create({
      id: 's1',
      projectId: 'p1',
      goal: 'g',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.getGrillQuestionRepository().create({
      id: 'q1',
      sessionId: 's1',
      sequence: 1,
      topic: 't',
      text: 'x',
      rationale: '',
      dependsOnQuestionIds: '[]',
      createdAt: NOW,
    });
  }

  it('create + getById', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      const repo = db.getGrillAnswerRepository();
      repo.create({
        id: 'a1',
        sessionId: 's1',
        questionId: 'q1',
        revision: 1,
        source: 'USER',
        text: '答案',
        createdAt: NOW,
      });

      const answer = repo.getById('a1');
      expect(answer?.text).toBe('答案');
      expect(answer?.source).toBe('USER');
      expect(answer?.supersededAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it('getCurrentByQuestion 返回最新未废弃答案', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      const repo = db.getGrillAnswerRepository();
      repo.create({
        id: 'a1',
        sessionId: 's1',
        questionId: 'q1',
        revision: 1,
        source: 'USER',
        text: 'v1',
        createdAt: NOW,
      });

      expect(repo.getCurrentByQuestion('q1')?.id).toBe('a1');

      repo.supersedeCurrent('q1', LATER);
      repo.create({
        id: 'a2',
        sessionId: 's1',
        questionId: 'q1',
        revision: 2,
        source: 'USER',
        text: 'v2',
        createdAt: LATER,
      });

      expect(repo.getCurrentByQuestion('q1')?.id).toBe('a2');
    } finally {
      db.close();
    }
  });

  it('supersedeCurrent 标记旧答案', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      const repo = db.getGrillAnswerRepository();
      repo.create({
        id: 'a1',
        sessionId: 's1',
        questionId: 'q1',
        revision: 1,
        source: 'USER',
        text: 'v1',
        createdAt: NOW,
      });

      const ok = repo.supersedeCurrent('q1', LATER);
      expect(ok).toBe(true);
      expect(repo.getById('a1')?.supersededAt).toBe(LATER);
    } finally {
      db.close();
    }
  });

  it('listByQuestion 按 revision 排序', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      const repo = db.getGrillAnswerRepository();
      repo.create({
        id: 'a1',
        sessionId: 's1',
        questionId: 'q1',
        revision: 1,
        source: 'USER',
        text: 'v1',
        createdAt: NOW,
      });
      repo.supersedeCurrent('q1', LATER);
      repo.create({
        id: 'a2',
        sessionId: 's1',
        questionId: 'q1',
        revision: 2,
        source: 'USER',
        text: 'v2',
        createdAt: LATER,
      });

      const list = repo.listByQuestion('q1');
      expect(list[0].revision).toBe(1);
      expect(list[1].revision).toBe(2);
    } finally {
      db.close();
    }
  });

  it('listCurrentBySession 只返回未废弃答案', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      db.getGrillQuestionRepository().create({
        id: 'q2',
        sessionId: 's1',
        sequence: 2,
        topic: 't2',
        text: 'x',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });

      const repo = db.getGrillAnswerRepository();
      repo.create({
        id: 'a1',
        sessionId: 's1',
        questionId: 'q1',
        revision: 1,
        source: 'USER',
        text: 'v1',
        createdAt: NOW,
      });
      repo.create({
        id: 'a2',
        sessionId: 's1',
        questionId: 'q2',
        revision: 1,
        source: 'USER',
        text: 'v2',
        createdAt: NOW,
      });

      repo.supersedeCurrent('q1', LATER);

      const current = repo.listCurrentBySession('s1');
      expect(current).toHaveLength(1);
      expect(current[0].id).toBe('a2');
    } finally {
      db.close();
    }
  });
});

// ── GrillProposalRepository 测试 ──────────────────────────────────

describe('GrillProposalRepository', () => {
  function setupSession(db: ProjectDatabase): void {
    db.getGrillSessionRepository().create({
      id: 's1',
      projectId: 'p1',
      goal: 'g',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  it('create + getById', () => {
    const db = createDb();
    try {
      setupSession(db);
      const repo = db.getGrillProposalRepository();
      repo.create({
        id: 'pr1',
        sessionId: 's1',
        basedOnAnswerIds: '["a1"]',
        key: 'genre',
        proposedValueJson: '"奇幻"',
        confidence: 0.85,
        rationale: '基于回答推断',
        createdAt: NOW,
      });

      const proposal = repo.getById('pr1');
      expect(proposal?.key).toBe('genre');
      expect(proposal?.confidence).toBe(0.85);
      expect(proposal?.status).toBe('PROPOSED');
      expect(proposal?.reviewedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it('listBySession', () => {
    const db = createDb();
    try {
      setupSession(db);
      const repo = db.getGrillProposalRepository();
      repo.create({
        id: 'pr1',
        sessionId: 's1',
        basedOnAnswerIds: '[]',
        key: 'k1',
        proposedValueJson: '"v1"',
        confidence: 0.5,
        rationale: '',
        createdAt: NOW,
      });
      repo.create({
        id: 'pr2',
        sessionId: 's1',
        basedOnAnswerIds: '[]',
        key: 'k2',
        proposedValueJson: '"v2"',
        confidence: 0.7,
        rationale: '',
        createdAt: LATER,
      });

      expect(repo.listBySession('s1')).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('transitionStatus 成功', () => {
    const db = createDb();
    try {
      setupSession(db);
      const repo = db.getGrillProposalRepository();
      repo.create({
        id: 'pr1',
        sessionId: 's1',
        basedOnAnswerIds: '[]',
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
        createdAt: NOW,
      });

      const ok = repo.transitionStatus('pr1', 'PROPOSED', 'ACCEPTED', LATER);
      expect(ok).toBe(true);
      expect(repo.getById('pr1')?.status).toBe('ACCEPTED');
      expect(repo.getById('pr1')?.reviewedAt).toBe(LATER);
    } finally {
      db.close();
    }
  });

  it('transitionStatus CAS 失败', () => {
    const db = createDb();
    try {
      setupSession(db);
      const repo = db.getGrillProposalRepository();
      repo.create({
        id: 'pr1',
        sessionId: 's1',
        basedOnAnswerIds: '[]',
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
        createdAt: NOW,
      });

      const ok = repo.transitionStatus('pr1', 'ACCEPTED', 'REJECTED', LATER);
      expect(ok).toBe(false);
      expect(repo.getById('pr1')?.status).toBe('PROPOSED');
    } finally {
      db.close();
    }
  });
});

// ── 事务测试 ──────────────────────────────────────────────────────

describe('Grill 事务', () => {
  it('事务内操作原子提交', () => {
    const db = createDb();
    try {
      const sessionRepo = db.getGrillSessionRepository();
      const questionRepo = db.getGrillQuestionRepository();
      sessionRepo.create({ id: 's1', projectId: 'p1', goal: 'g', createdAt: NOW, updatedAt: NOW });

      db.transaction(() => {
        questionRepo.create({
          id: 'q1',
          sessionId: 's1',
          sequence: 1,
          topic: 't',
          text: 'x',
          rationale: '',
          dependsOnQuestionIds: '[]',
          createdAt: NOW,
        });
        sessionRepo.bumpVersion('s1', 1, LATER);
      });

      expect(questionRepo.getById('q1')).not.toBeNull();
      expect(sessionRepo.getById('s1')?.version).toBe(2);
    } finally {
      db.close();
    }
  });

  it('事务内异常回滚', () => {
    const db = createDb();
    try {
      const sessionRepo = db.getGrillSessionRepository();
      const questionRepo = db.getGrillQuestionRepository();
      sessionRepo.create({ id: 's1', projectId: 'p1', goal: 'g', createdAt: NOW, updatedAt: NOW });

      expect(() =>
        db.transaction(() => {
          questionRepo.create({
            id: 'q1',
            sessionId: 's1',
            sequence: 1,
            topic: 't',
            text: 'x',
            rationale: '',
            dependsOnQuestionIds: '[]',
            createdAt: NOW,
          });
          throw new Error('模拟失败');
        }),
      ).toThrow('模拟失败');

      expect(questionRepo.getById('q1')).toBeNull();
      expect(sessionRepo.getById('s1')?.version).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ── 故障注入测试 ──────────────────────────────────────────────────

describe('Grill 故障注入', () => {
  function setupActiveSession(db: ProjectDatabase): void {
    db.getGrillSessionRepository().create({
      id: 's1',
      projectId: 'p1',
      goal: 'g',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.getGrillSessionRepository().transitionStatus('s1', 1, 'ACTIVE', NOW);
  }

  it('旧答案 supersede 后插入失败，整组回滚', () => {
    const db = createDb();
    try {
      setupActiveSession(db);
      const questionRepo = db.getGrillQuestionRepository();
      const answerRepo = db.getGrillAnswerRepository();

      questionRepo.create({
        id: 'q1',
        sessionId: 's1',
        sequence: 1,
        topic: 't',
        text: 'x',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });
      questionRepo.transitionStatus('q1', 'PLANNED', 'ASKED', NOW);
      answerRepo.create({
        id: 'a1',
        sessionId: 's1',
        questionId: 'q1',
        revision: 1,
        source: 'USER',
        text: 'v1',
        createdAt: NOW,
      });

      expect(() =>
        db.transaction(() => {
          answerRepo.supersedeCurrent('q1', LATER);
          // 模拟插入失败：使用非法 revision
          const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
          raw.exec('PRAGMA foreign_keys = ON');
          raw
            .prepare(
              `INSERT INTO grill_answers (id, session_id, question_id, revision, source, text, created_at)
             VALUES ('a2', 's1', 'q1', 0, 'USER', 'v2', '${LATER}')`,
            )
            .run();
          raw.close();
        }),
      ).toThrow();

      // 旧答案未被废弃
      expect(answerRepo.getById('a1')?.supersededAt).toBeNull();
      expect(answerRepo.getCurrentByQuestion('q1')?.id).toBe('a1');
    } finally {
      db.close();
    }
  });

  it('新答案插入后 question CAS 失败，整组回滚', () => {
    const db = createDb();
    try {
      setupActiveSession(db);
      const questionRepo = db.getGrillQuestionRepository();
      const answerRepo = db.getGrillAnswerRepository();

      questionRepo.create({
        id: 'q1',
        sessionId: 's1',
        sequence: 1,
        topic: 't',
        text: 'x',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });
      // 不将问题转为 ASKED，保持 PLANNED

      expect(() =>
        db.transaction(() => {
          answerRepo.create({
            id: 'a1',
            sessionId: 's1',
            questionId: 'q1',
            revision: 1,
            source: 'USER',
            text: 'v1',
            createdAt: NOW,
          });
          // CAS 失败：问题不是 ASKED 状态
          const ok = questionRepo.transitionStatus('q1', 'ASKED', 'ANSWERED', LATER);
          if (!ok) throw new Error('CAS 冲突');
        }),
      ).toThrow('CAS 冲突');

      // 答案未持久化
      expect(answerRepo.getById('a1')).toBeNull();
      expect(questionRepo.getById('q1')?.status).toBe('PLANNED');
    } finally {
      db.close();
    }
  });

  it('question 更新后 session version CAS 失败，整组回滚', () => {
    const db = createDb();
    try {
      setupActiveSession(db);
      const questionRepo = db.getGrillQuestionRepository();
      const answerRepo = db.getGrillAnswerRepository();
      const sessionRepo = db.getGrillSessionRepository();

      questionRepo.create({
        id: 'q1',
        sessionId: 's1',
        sequence: 1,
        topic: 't',
        text: 'x',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });
      questionRepo.transitionStatus('q1', 'PLANNED', 'ASKED', NOW);

      expect(() =>
        db.transaction(() => {
          answerRepo.create({
            id: 'a1',
            sessionId: 's1',
            questionId: 'q1',
            revision: 1,
            source: 'USER',
            text: 'v1',
            createdAt: NOW,
          });
          questionRepo.transitionStatus('q1', 'ASKED', 'ANSWERED', LATER);
          // session CAS 失败：版本不匹配
          const ok = sessionRepo.bumpVersion('s1', 99, LATER);
          if (!ok) throw new Error('版本冲突');
        }),
      ).toThrow('版本冲突');

      // 全部回滚
      expect(answerRepo.getById('a1')).toBeNull();
      expect(questionRepo.getById('q1')?.status).toBe('ASKED');
      expect(sessionRepo.getById('s1')?.version).toBe(2);
    } finally {
      db.close();
    }
  });

  it('批量问题中途唯一约束失败，全部回滚', () => {
    const db = createDb();
    try {
      setupActiveSession(db);
      const questionRepo = db.getGrillQuestionRepository();
      const sessionRepo = db.getGrillSessionRepository();

      // 先插入 sequence=1 的问题
      questionRepo.create({
        id: 'q0',
        sessionId: 's1',
        sequence: 1,
        topic: 't0',
        text: 'x',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });

      expect(() =>
        db.transaction(() => {
          questionRepo.create({
            id: 'q1',
            sessionId: 's1',
            sequence: 2,
            topic: 't1',
            text: 'x',
            rationale: '',
            dependsOnQuestionIds: '[]',
            createdAt: NOW,
          });
          // 重复 sequence=1 触发 UNIQUE 约束
          questionRepo.create({
            id: 'q2',
            sessionId: 's1',
            sequence: 1,
            topic: 't2',
            text: 'x',
            rationale: '',
            dependsOnQuestionIds: '[]',
            createdAt: NOW,
          });
        }),
      ).toThrow();

      // q1 也回滚
      expect(questionRepo.getById('q1')).toBeNull();
      expect(questionRepo.getById('q2')).toBeNull();
      expect(sessionRepo.getById('s1')?.version).toBe(2);
    } finally {
      db.close();
    }
  });

  it('proposal 更新成功但 session CAS 失败，proposal 回滚', () => {
    const db = createDb();
    try {
      setupActiveSession(db);
      const proposalRepo = db.getGrillProposalRepository();
      const sessionRepo = db.getGrillSessionRepository();

      proposalRepo.create({
        id: 'pr1',
        sessionId: 's1',
        basedOnAnswerIds: '[]',
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
        createdAt: NOW,
      });

      expect(() =>
        db.transaction(() => {
          proposalRepo.transitionStatus('pr1', 'PROPOSED', 'ACCEPTED', LATER);
          // session CAS 失败
          const ok = sessionRepo.bumpVersion('s1', 99, LATER);
          if (!ok) throw new Error('版本冲突');
        }),
      ).toThrow('版本冲突');

      // proposal 回滚到 PROPOSED
      expect(proposalRepo.getById('pr1')?.status).toBe('PROPOSED');
      expect(proposalRepo.getById('pr1')?.reviewedAt).toBeNull();
    } finally {
      db.close();
    }
  });
});

// ── current-answer partial unique index 测试 ──────────────────────

describe('grill_answers current-answer 唯一索引', () => {
  function setupSessionAndQuestion(db: ProjectDatabase): void {
    db.getGrillSessionRepository().create({
      id: 's1',
      projectId: 'p1',
      goal: 'g',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.getGrillQuestionRepository().create({
      id: 'q1',
      sessionId: 's1',
      sequence: 1,
      topic: 't',
      text: 'x',
      rationale: '',
      dependsOnQuestionIds: '[]',
      createdAt: NOW,
    });
  }

  it('同一 question 不能直接插入两个 current answers', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      const raw = new DatabaseSync(join(tempDir, 'project.sqlite'));
      raw.exec('PRAGMA foreign_keys = ON');
      raw
        .prepare(
          `INSERT INTO grill_answers (id, session_id, question_id, revision, source, text, created_at)
           VALUES ('a1', 's1', 'q1', 1, 'USER', 'v1', '${NOW}')`,
        )
        .run();
      expect(() =>
        raw
          .prepare(
            `INSERT INTO grill_answers (id, session_id, question_id, revision, source, text, created_at)
             VALUES ('a2', 's1', 'q1', 2, 'USER', 'v2', '${LATER}')`,
          )
          .run(),
      ).toThrow();
      raw.close();
    } finally {
      db.close();
    }
  });

  it('不同 revision 但都 superseded_at NULL 时第二条失败', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      const repo = db.getGrillAnswerRepository();
      repo.create({
        id: 'a1',
        sessionId: 's1',
        questionId: 'q1',
        revision: 1,
        source: 'USER',
        text: 'v1',
        createdAt: NOW,
      });
      expect(() =>
        repo.create({
          id: 'a2',
          sessionId: 's1',
          questionId: 'q1',
          revision: 2,
          source: 'USER',
          text: 'v2',
          createdAt: LATER,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('旧答案 superseded 后允许插入新答案', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      const repo = db.getGrillAnswerRepository();
      repo.create({
        id: 'a1',
        sessionId: 's1',
        questionId: 'q1',
        revision: 1,
        source: 'USER',
        text: 'v1',
        createdAt: NOW,
      });
      repo.supersedeCurrent('q1', LATER);
      repo.create({
        id: 'a2',
        sessionId: 's1',
        questionId: 'q1',
        revision: 2,
        source: 'USER',
        text: 'v2',
        createdAt: LATER,
      });
      expect(repo.getCurrentByQuestion('q1')?.id).toBe('a2');
    } finally {
      db.close();
    }
  });

  it('不同 question 可各有一个 current answer', () => {
    const db = createDb();
    try {
      setupSessionAndQuestion(db);
      db.getGrillQuestionRepository().create({
        id: 'q2',
        sessionId: 's1',
        sequence: 2,
        topic: 't2',
        text: 'x',
        rationale: '',
        dependsOnQuestionIds: '[]',
        createdAt: NOW,
      });
      const repo = db.getGrillAnswerRepository();
      repo.create({
        id: 'a1',
        sessionId: 's1',
        questionId: 'q1',
        revision: 1,
        source: 'USER',
        text: 'v1',
        createdAt: NOW,
      });
      repo.create({
        id: 'a2',
        sessionId: 's1',
        questionId: 'q2',
        revision: 1,
        source: 'USER',
        text: 'v2',
        createdAt: NOW,
      });
      expect(repo.getCurrentByQuestion('q1')?.id).toBe('a1');
      expect(repo.getCurrentByQuestion('q2')?.id).toBe('a2');
    } finally {
      db.close();
    }
  });
});

// ── grill_question_plan_proposals FK/UNIQUE 约束 ──────────────────

describe('grill_question_plan_proposals 约束', () => {
  function setupBase(db: ProjectDatabase): void {
    db.getGrillSessionRepository().create({
      id: 's1',
      projectId: 'p1',
      goal: 'g',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.getTaskRepository().create({
      id: 'task-1',
      projectId: 'p1',
      taskType: 'GRILL_QUESTION_PLAN',
      status: 'SUCCEEDED',
      inputVersionJson: '{}',
      payloadJson: '{}',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.getModelInvocationRepository().create({
      id: 'inv-1',
      projectId: 'p1',
      taskId: 'task-1',
      providerProfileId: 'provider-1',
      model: 'test-model',
      status: 'SUCCEEDED',
      attemptNumber: 1,
      requestKind: 'grill_question_plan',
      promptHash: 'a'.repeat(64),
      requestMetadataJson: '{}',
      createdAt: NOW,
    });
  }

  function validProposal(id: string, taskId = 'task-1', invocationId = 'inv-1') {
    return {
      id,
      projectId: 'p1',
      sessionId: 's1',
      taskId,
      invocationId,
      baseSessionVersion: 1,
      schemaVersion: 1,
      questionsJson: '{"schemaVersion":1,"questions":[]}',
      createdAt: NOW,
    };
  }

  it('FK: 拒绝不存在的 task_id', () => {
    const db = createDb();
    try {
      setupBase(db);
      expect(() =>
        db.getGrillQuestionPlanProposalRepository().create(validProposal('pp1', 'ghost-task')),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('FK: 拒绝不存在的 invocation_id', () => {
    const db = createDb();
    try {
      setupBase(db);
      expect(() =>
        db
          .getGrillQuestionPlanProposalRepository()
          .create(validProposal('pp1', 'task-1', 'ghost-inv')),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('UNIQUE: 拒绝重复 task_id', () => {
    const db = createDb();
    try {
      setupBase(db);
      // 需要第二个 invocation
      db.getModelInvocationRepository().create({
        id: 'inv-2',
        projectId: 'p1',
        taskId: 'task-1',
        providerProfileId: 'provider-1',
        model: 'test-model',
        status: 'SUCCEEDED',
        attemptNumber: 2,
        requestKind: 'grill_question_plan',
        promptHash: 'b'.repeat(64),
        requestMetadataJson: '{}',
        createdAt: NOW,
      });
      db.getGrillQuestionPlanProposalRepository().create(validProposal('pp1'));
      expect(() =>
        db.getGrillQuestionPlanProposalRepository().create(validProposal('pp2', 'task-1', 'inv-2')),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('UNIQUE: 拒绝重复 invocation_id', () => {
    const db = createDb();
    try {
      setupBase(db);
      // 需要第二个 task
      db.getTaskRepository().create({
        id: 'task-2',
        projectId: 'p1',
        taskType: 'GRILL_QUESTION_PLAN',
        status: 'SUCCEEDED',
        inputVersionJson: '{}',
        payloadJson: '{}',
        createdAt: NOW,
        updatedAt: NOW,
      });
      db.getGrillQuestionPlanProposalRepository().create(validProposal('pp1'));
      expect(() =>
        db.getGrillQuestionPlanProposalRepository().create(validProposal('pp2', 'task-2', 'inv-1')),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('合法插入成功', () => {
    const db = createDb();
    try {
      setupBase(db);
      db.getGrillQuestionPlanProposalRepository().create(validProposal('pp1'));
      const row = db.getGrillQuestionPlanProposalRepository().getById('pp1');
      expect(row).not.toBeNull();
      expect(row!.taskId).toBe('task-1');
      expect(row!.invocationId).toBe('inv-1');
      expect(row!.status).toBe('PROPOSED');
    } finally {
      db.close();
    }
  });
});
