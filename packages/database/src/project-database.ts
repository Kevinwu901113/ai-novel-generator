/**
 * 项目数据库（project.sqlite）实现。
 *
 * 管理单个小说项目的元数据。
 * 使用 node:sqlite 的 DatabaseSync 同步 API。
 */

import { DatabaseSync } from 'node:sqlite';
import { SQLiteMigrator } from './migrator.js';
import {
  GrillSessionRepositoryImpl,
  GrillQuestionRepositoryImpl,
  GrillAnswerRepositoryImpl,
  GrillProposalRepositoryImpl,
  GrillQuestionPlanProposalRepositoryImpl,
} from './grill-repositories.js';
import {
  CreationContractProposalRepositoryImpl,
  CreationContractVersionRepositoryImpl,
  CreationContractCurrentRepositoryImpl,
  CreationContractLockEventRepositoryImpl,
} from './creation-contract-repositories.js';
import {
  ManuscriptRepositoryImpl,
  ChapterRepositoryImpl,
  ChapterVersionRepositoryImpl,
} from './manuscript-repositories.js';
import type {
  ProjectDatabaseManager,
  ProjectMetadataRepository,
  ProjectMetadataRow,
  CreateProjectMetadataData,
  TaskRepository,
  TaskRow,
  CreateTaskData,
  DbTaskType,
  DbTaskStatus,
  ModelInvocationRepository,
  ModelInvocationRow,
  CreateInvocationData,
  DbInvocationStatus,
  InvocationStats,
  GrillSessionRepository,
  GrillQuestionRepository,
  GrillAnswerRepository,
  GrillProposalRepository,
  GrillQuestionPlanProposalRepository,
  CreationContractProposalRepository,
  CreationContractVersionRepository,
  CreationContractCurrentRepository,
  CreationContractLockEventRepository,
  ManuscriptRepository,
  ChapterRepository,
  ChapterVersionRepository,
  Migration,
} from './types.js';

// ── 迁移定义 ──────────────────────────────────────────────────────

export const PROJECT_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_metadata (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        initial_idea TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idea',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        input_version_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        stale_at TEXT,
        cancelled_at TEXT,
        CHECK (task_type IN ('PROVIDER_CONNECTION_TEST', 'MODEL_INVOCATION_TEST')),
        CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE')),
        CHECK (attempt_count >= 0),
        CHECK (json_valid(input_version_json)),
        CHECK (json_valid(payload_json)),
        CHECK (result_json IS NULL OR json_valid(result_json))
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_created ON tasks(project_id, created_at);

      CREATE TABLE IF NOT EXISTS model_invocations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        provider_profile_id TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        request_kind TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        request_metadata_json TEXT NOT NULL,
        response_metadata_json TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        total_tokens INTEGER,
        latency_ms INTEGER,
        finish_reason TEXT,
        error_code TEXT,
        error_message TEXT,
        provider_request_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
        CHECK (attempt_number >= 1),
        CHECK (length(prompt_hash) = 64),
        CHECK (json_valid(request_metadata_json)),
        CHECK (response_metadata_json IS NULL OR json_valid(response_metadata_json)),
        CHECK (input_tokens IS NULL OR input_tokens >= 0),
        CHECK (output_tokens IS NULL OR output_tokens >= 0),
        CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
        CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
        CHECK (total_tokens IS NULL OR total_tokens >= 0),
        CHECK (latency_ms IS NULL OR latency_ms >= 0)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_invocations_task_attempt ON model_invocations(task_id, attempt_number);
      CREATE INDEX IF NOT EXISTS idx_invocations_project_created ON model_invocations(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_invocations_status ON model_invocations(status);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_invocations_task_attempt_unique
        ON model_invocations(task_id, attempt_number);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE grill_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        version INTEGER NOT NULL DEFAULT 1,
        goal TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        abandoned_at TEXT,
        CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED')),
        CHECK (version >= 1)
      ) STRICT;

      CREATE TABLE grill_questions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        topic TEXT NOT NULL,
        text TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'PLANNED',
        depends_on_question_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        asked_at TEXT,
        answered_at TEXT,
        skipped_at TEXT,
        superseded_at TEXT,
        FOREIGN KEY (session_id) REFERENCES grill_sessions(id),
        CHECK (status IN ('PLANNED', 'ASKED', 'ANSWERED', 'SKIPPED', 'SUPERSEDED')),
        CHECK (sequence >= 1),
        CHECK (json_valid(depends_on_question_ids))
      ) STRICT;

      CREATE UNIQUE INDEX idx_grill_questions_session_sequence
        ON grill_questions(session_id, sequence);

      CREATE TABLE grill_answers (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'USER',
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        superseded_at TEXT,
        FOREIGN KEY (session_id) REFERENCES grill_sessions(id),
        FOREIGN KEY (question_id) REFERENCES grill_questions(id),
        CHECK (source IN ('USER', 'IMPORTED')),
        CHECK (revision >= 1)
      ) STRICT;

      CREATE UNIQUE INDEX idx_grill_answers_question_revision
        ON grill_answers(question_id, revision);

      CREATE UNIQUE INDEX idx_grill_answers_one_current
        ON grill_answers(question_id)
        WHERE superseded_at IS NULL;

      CREATE TABLE grill_inference_proposals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        based_on_answer_ids TEXT NOT NULL DEFAULT '[]',
        key TEXT NOT NULL,
        proposed_value_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'PROPOSED',
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        FOREIGN KEY (session_id) REFERENCES grill_sessions(id),
        CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
        CHECK (confidence >= 0 AND confidence <= 1),
        CHECK (json_valid(based_on_answer_ids)),
        CHECK (json_valid(proposed_value_json))
      ) STRICT;

      CREATE INDEX idx_grill_sessions_project ON grill_sessions(project_id);
      CREATE INDEX idx_grill_questions_session ON grill_questions(session_id);
      CREATE INDEX idx_grill_answers_session ON grill_answers(session_id);
      CREATE INDEX idx_grill_proposals_session ON grill_inference_proposals(session_id);
    `,
  },
  {
    version: 4,
    sql: `
      -- 重建 tasks 表：放宽 task_type CHECK 以支持 GRILL_QUESTION_PLAN，
      -- 并新增可空 dedupe_key 列用于数据库级任务去重。
      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        input_version_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        dedupe_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        stale_at TEXT,
        cancelled_at TEXT,
        CHECK (task_type IN ('PROVIDER_CONNECTION_TEST', 'MODEL_INVOCATION_TEST', 'GRILL_QUESTION_PLAN')),
        CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE')),
        CHECK (attempt_count >= 0),
        CHECK (json_valid(input_version_json)),
        CHECK (json_valid(payload_json)),
        CHECK (result_json IS NULL OR json_valid(result_json))
      ) STRICT;

      INSERT INTO tasks_new (
        id, project_id, task_type, status, input_version_json, payload_json,
        result_json, error_code, error_message, attempt_count, dedupe_key,
        created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
      )
      SELECT
        id, project_id, task_type, status, input_version_json, payload_json,
        result_json, error_code, error_message, attempt_count, NULL,
        created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
      FROM tasks;

      DROP TABLE tasks;

      ALTER TABLE tasks_new RENAME TO tasks;

      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_tasks_project_created ON tasks(project_id, created_at);

      -- 去重：同一 dedupe_key 在 PENDING/RUNNING 状态下至多一个活跃任务。
      -- 任务终结（SUCCEEDED/FAILED/STALE/CANCELLED）后自动释放，可重新创建。
      CREATE UNIQUE INDEX idx_tasks_dedupe_active
        ON tasks(dedupe_key)
        WHERE dedupe_key IS NOT NULL AND status IN ('PENDING', 'RUNNING');

      -- Grill 问题规划提案：仅保存经验证的规范化计划，不保存原始模型输出。
      CREATE TABLE grill_question_plan_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        base_session_version INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        questions_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PROPOSED',
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        FOREIGN KEY (session_id) REFERENCES grill_sessions(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (invocation_id) REFERENCES model_invocations(id),
        CONSTRAINT uq_grill_plan_proposals_task UNIQUE (task_id),
        CONSTRAINT uq_grill_plan_proposals_invocation UNIQUE (invocation_id),
        CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'STALE')),
        CHECK (base_session_version >= 1),
        CHECK (schema_version = 1),
        CHECK (json_valid(questions_json))
      ) STRICT;

      CREATE INDEX idx_grill_plan_proposals_session
        ON grill_question_plan_proposals(session_id);
    `,
  },
  {
    version: 5,
    sql: `
      -- ── Composite UNIQUE indexes on parent tables (for composite FK references) ──

      CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_project_id
        ON tasks(project_id, id);

      CREATE UNIQUE INDEX IF NOT EXISTS uq_model_invocations_project_id
        ON model_invocations(project_id, id);

      CREATE UNIQUE INDEX IF NOT EXISTS uq_model_invocations_project_task_id
        ON model_invocations(project_id, task_id, id);

      CREATE UNIQUE INDEX IF NOT EXISTS uq_grill_sessions_project_id
        ON grill_sessions(project_id, id);

      -- ── 创作契约提案 ──────────────────────────────────────────

      CREATE TABLE IF NOT EXISTS creation_contract_proposals (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PROPOSED'
          CHECK (status IN ('PROPOSED','ACCEPTED','REJECTED','SUPERSEDED','STALE')),
        base_grill_session_id TEXT NOT NULL,
        base_grill_session_version INTEGER NOT NULL CHECK (base_grill_session_version > 0),
        base_contract_version INTEGER
          CHECK (base_contract_version IS NULL OR base_contract_version > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        sections_json TEXT NOT NULL CHECK (json_valid(sections_json)),
        sections_hash TEXT NOT NULL CHECK (length(sections_hash) = 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, id),
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id),
        FOREIGN KEY (project_id, invocation_id) REFERENCES model_invocations(project_id, id),
        FOREIGN KEY (project_id, task_id, invocation_id)
          REFERENCES model_invocations(project_id, task_id, id),
        FOREIGN KEY (project_id, base_grill_session_id)
          REFERENCES grill_sessions(project_id, id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_cc_proposals_project_status
        ON creation_contract_proposals(project_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_cc_proposals_grill_session
        ON creation_contract_proposals(base_grill_session_id);

      -- ── 创作契约版本 ──────────────────────────────────────────

      CREATE TABLE IF NOT EXISTS creation_contract_versions (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        source_proposal_id TEXT,
        based_on_grill_session_id TEXT,
        based_on_grill_session_version INTEGER,
        sections_json TEXT NOT NULL CHECK (json_valid(sections_json)),
        locked_field_paths_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(locked_field_paths_json)),
        contract_snapshot_hash TEXT NOT NULL CHECK (length(contract_snapshot_hash) = 64),
        provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
          CHECK (created_by IN ('user','ai-proposal-accepted','lock','unlock')),
        PRIMARY KEY (project_id, id),
        UNIQUE (project_id, version),
        FOREIGN KEY (project_id, source_proposal_id)
          REFERENCES creation_contract_proposals(project_id, id),
        FOREIGN KEY (project_id, based_on_grill_session_id)
          REFERENCES grill_sessions(project_id, id),
        CHECK (
          (based_on_grill_session_id IS NULL AND based_on_grill_session_version IS NULL)
          OR
          (based_on_grill_session_id IS NOT NULL AND based_on_grill_session_version > 0)
        )
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_cc_versions_project_version
        ON creation_contract_versions(project_id, version DESC);

      -- ── 创作契约当前指针 ──────────────────────────────────────

      CREATE TABLE IF NOT EXISTS creation_contract_current (
        project_id TEXT NOT NULL PRIMARY KEY,
        current_version_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id, current_version_id)
          REFERENCES creation_contract_versions(project_id, id)
      ) STRICT;

      -- ── 创作契约锁定事件（append-only 审计日志）────────────────

      CREATE TABLE IF NOT EXISTS creation_contract_lock_events (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        field_path TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('LOCK','UNLOCK')),
        version_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (project_id, id),
        FOREIGN KEY (project_id, version_id)
          REFERENCES creation_contract_versions(project_id, id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_cc_lock_events_version
        ON creation_contract_lock_events(project_id, version_id, created_at);

      -- ── Status transition trigger ──────────────────────────────

      CREATE TRIGGER IF NOT EXISTS trg_cc_proposals_status_transition
      BEFORE UPDATE OF status ON creation_contract_proposals
      BEGIN
        -- Must change updated_at when changing status
        SELECT RAISE(ABORT, 'updated_at must change when status changes')
        WHERE NEW.updated_at = OLD.updated_at;

        -- Only allow from PROPOSED to terminal states
        SELECT RAISE(ABORT, 'can only transition from PROPOSED')
        WHERE OLD.status != 'PROPOSED';

        -- Reject same-status update
        SELECT RAISE(ABORT, 'cannot update to same status')
        WHERE NEW.status = OLD.status;
      END;

      -- ── Immutability triggers ──────────────────────────────────

      -- updated_at cannot be changed without a status change (status trigger handles that)
      CREATE TRIGGER IF NOT EXISTS trg_cc_proposals_immutable_updated_at
      BEFORE UPDATE OF updated_at ON creation_contract_proposals
      WHEN NEW.status = OLD.status
      BEGIN
        SELECT RAISE(ABORT, 'updated_at cannot be changed without status change');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_cc_proposals_immutable_sections
      BEFORE UPDATE OF sections_json, sections_hash ON creation_contract_proposals
      BEGIN
        SELECT RAISE(ABORT, 'creation_contract_proposals sections_json and sections_hash are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_cc_proposals_immutable_identity
      BEFORE UPDATE OF id, project_id, task_id, invocation_id,
                       base_grill_session_id, base_grill_session_version,
                       base_contract_version, schema_version,
                       created_at ON creation_contract_proposals
      BEGIN
        SELECT RAISE(ABORT, 'creation_contract_proposals identity fields are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_cc_proposals_no_delete
      BEFORE DELETE ON creation_contract_proposals
      BEGIN
        SELECT RAISE(ABORT, 'creation_contract_proposals is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_cc_versions_no_update
      BEFORE UPDATE ON creation_contract_versions
      BEGIN
        SELECT RAISE(ABORT, 'creation_contract_versions is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_cc_versions_no_delete
      BEFORE DELETE ON creation_contract_versions
      BEGIN
        SELECT RAISE(ABORT, 'creation_contract_versions is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_cc_lock_events_no_update
      BEFORE UPDATE ON creation_contract_lock_events
      BEGIN
        SELECT RAISE(ABORT, 'creation_contract_lock_events is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_cc_lock_events_no_delete
      BEFORE DELETE ON creation_contract_lock_events
      BEGIN
        SELECT RAISE(ABORT, 'creation_contract_lock_events is append-only');
      END;
    `,
  },
  {
    version: 6,
    sql: `
      -- ── 重建 tasks 表：放宽 task_type CHECK 以支持 CREATION_CONTRACT_DRAFT ──
      -- 保留全部既有列、数据、CHECK、索引、dedupe 部分唯一索引与
      -- 被创作契约表复合 FK 引用的 parent 唯一索引（uq_tasks_project_id）。
      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        input_version_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        dedupe_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        stale_at TEXT,
        cancelled_at TEXT,
        CHECK (task_type IN ('PROVIDER_CONNECTION_TEST', 'MODEL_INVOCATION_TEST', 'GRILL_QUESTION_PLAN', 'CREATION_CONTRACT_DRAFT')),
        CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE')),
        CHECK (attempt_count >= 0),
        CHECK (json_valid(input_version_json)),
        CHECK (json_valid(payload_json)),
        CHECK (result_json IS NULL OR json_valid(result_json))
      ) STRICT;

      INSERT INTO tasks_new (
        id, project_id, task_type, status, input_version_json, payload_json,
        result_json, error_code, error_message, attempt_count, dedupe_key,
        created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
      )
      SELECT
        id, project_id, task_type, status, input_version_json, payload_json,
        result_json, error_code, error_message, attempt_count, dedupe_key,
        created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
      FROM tasks;

      DROP TABLE tasks;

      ALTER TABLE tasks_new RENAME TO tasks;

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_created ON tasks(project_id, created_at);

      -- 去重 partial unique index（原样重建，保证 PENDING/RUNNING 至多一个活跃任务）
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe_active
        ON tasks(dedupe_key)
        WHERE dedupe_key IS NOT NULL AND status IN ('PENDING', 'RUNNING');

      -- 被 creation_contract_proposals 复合 FK 引用的 parent 唯一索引（原样重建）
      CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_project_id
        ON tasks(project_id, id);

      -- ── 创作契约提案：task_id / invocation_id 唯一 ──
      -- 一个任务至多产生一个 proposal，一个调用至多产生一个 proposal。
      -- 全新功能，base 无历史 proposal 数据，不会因新增唯一约束失败。
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_proposals_task
        ON creation_contract_proposals(task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_proposals_invocation
        ON creation_contract_proposals(invocation_id);
    `,
  },
  {
    version: 7,
    sql: `
      -- ── Minimal Manuscript / Chapter Version（§6.4）─────────────
      -- 新增表（不重建既有表）：manuscripts / chapters / chapter_versions。
      -- 既有 v6 数据不受影响；全部复合主键 (project_id, id)、复合外键、
      -- 部分唯一索引、append-only trigger。

      CREATE TABLE IF NOT EXISTS manuscripts (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','archived')),
        creation_contract_version_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, id),
        FOREIGN KEY (project_id) REFERENCES project_metadata(id),
        FOREIGN KEY (project_id, creation_contract_version_id)
          REFERENCES creation_contract_versions(project_id, id)
      ) STRICT;

      -- 每 project 至多一个 active manuscript（§6.1）
      CREATE UNIQUE INDEX IF NOT EXISTS uq_manuscripts_project_active
        ON manuscripts(project_id) WHERE status = 'active';

      CREATE INDEX IF NOT EXISTS idx_manuscripts_project_status_updated
        ON manuscripts(project_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        manuscript_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position > 0),
        current_version_id TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, id),
        FOREIGN KEY (project_id, manuscript_id)
          REFERENCES manuscripts(project_id, id),
        -- 指针同章约束：chapters.id = chapter_versions.chapter_id（非 manuscript_id，§13）
        FOREIGN KEY (project_id, id, current_version_id)
          REFERENCES chapter_versions(project_id, chapter_id, id)
      ) STRICT;

      -- position 覆盖所有章节（含 archived），唯一（§5 不变量 10）
      CREATE UNIQUE INDEX IF NOT EXISTS uq_chapters_project_manuscript_position
        ON chapters(project_id, manuscript_id, position);

      CREATE INDEX IF NOT EXISTS idx_chapters_project_manuscript_status
        ON chapters(project_id, manuscript_id, status, position);

      CREATE TABLE IF NOT EXISTS chapter_versions (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        chapter_id TEXT NOT NULL,
        version_number INTEGER NOT NULL CHECK (version_number > 0),
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        content TEXT NOT NULL CHECK (length(content) <= 1000000),
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        parent_version_id TEXT,
        source_type TEXT NOT NULL
          CHECK (source_type IN ('USER','AI_GENERATION','AI_REWRITE','IMPORT','RESTORE')),
        created_by_task_id TEXT,
        invocation_id TEXT,
        creation_contract_version_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, id),
        UNIQUE (project_id, chapter_id, version_number),
        FOREIGN KEY (project_id, chapter_id)
          REFERENCES chapters(project_id, id),
        -- 血缘同章复合 FK
        FOREIGN KEY (project_id, chapter_id, parent_version_id)
          REFERENCES chapter_versions(project_id, chapter_id, id),
        -- provenance 全部复合 FK，禁止跨 project 引用（不变量 14）
        FOREIGN KEY (project_id, created_by_task_id)
          REFERENCES tasks(project_id, id),
        FOREIGN KEY (project_id, invocation_id)
          REFERENCES model_invocations(project_id, id),
        FOREIGN KEY (project_id, creation_contract_version_id)
          REFERENCES creation_contract_versions(project_id, id),
        -- sourceType 与 provenance 一致性（§4.3）
        CHECK (
          (source_type IN ('AI_GENERATION','AI_REWRITE') AND
             created_by_task_id IS NOT NULL AND invocation_id IS NOT NULL
             AND creation_contract_version_id IS NOT NULL)
          OR
          (source_type IN ('USER','IMPORT','RESTORE') AND
             created_by_task_id IS NULL AND invocation_id IS NULL)
        )
      ) STRICT;

      -- 支撑 chapters.current_version_id 复合外键 + 血缘外键
      CREATE UNIQUE INDEX IF NOT EXISTS uq_chapter_versions_project_chapter
        ON chapter_versions(project_id, chapter_id, id);

      -- AI task 幂等：同一 task 至多产生一个版本（§11.3）
      CREATE UNIQUE INDEX IF NOT EXISTS uq_chapter_versions_task
        ON chapter_versions(project_id, created_by_task_id)
        WHERE created_by_task_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_chapter_versions_project_chapter_number
        ON chapter_versions(project_id, chapter_id, version_number DESC);

      -- 不可变性：版本创建后不可 UPDATE / DELETE（不变量 2/9）
      CREATE TRIGGER IF NOT EXISTS trg_chapter_versions_no_update
      BEFORE UPDATE ON chapter_versions
      BEGIN SELECT RAISE(ABORT, 'chapter_versions is append-only'); END;

      CREATE TRIGGER IF NOT EXISTS trg_chapter_versions_no_delete
      BEFORE DELETE ON chapter_versions
      BEGIN SELECT RAISE(ABORT, 'chapter_versions is append-only'); END;
    `,
  },
];

// ── 项目元数据仓库实现 ────────────────────────────────────────────

class ProjectMetadataRepositoryImpl implements ProjectMetadataRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateProjectMetadataData): void {
    this.db
      .prepare(
        `INSERT INTO project_metadata (id, name, initial_idea, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(data.id, data.name, data.initialIdea, data.status, data.createdAt, data.updatedAt);
  }

  get(): ProjectMetadataRow | null {
    const row = this.db
      .prepare(
        'SELECT id, name, initial_idea, status, created_at, updated_at FROM project_metadata LIMIT 1',
      )
      .get() as
      | {
          id: string;
          name: string;
          initial_idea: string;
          status: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      initialIdea: row.initial_idea,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  update(data: Partial<Omit<ProjectMetadataRow, 'id'>>): void {
    const sets: string[] = [];
    const values: Array<string | null> = [];

    if (data.name !== undefined) {
      sets.push('name = ?');
      values.push(data.name);
    }
    if (data.initialIdea !== undefined) {
      sets.push('initial_idea = ?');
      values.push(data.initialIdea);
    }
    if (data.status !== undefined) {
      sets.push('status = ?');
      values.push(data.status);
    }
    if (data.createdAt !== undefined) {
      sets.push('created_at = ?');
      values.push(data.createdAt);
    }
    if (data.updatedAt !== undefined) {
      sets.push('updated_at = ?');
      values.push(data.updatedAt);
    }

    if (sets.length === 0) return;

    this.db.prepare(`UPDATE project_metadata SET ${sets.join(', ')}`).run(...values);
  }
}

// ── 任务仓库实现 ──────────────────────────────────────────────────

class TaskRepositoryImpl implements TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateTaskData): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, task_type, status, input_version_json, payload_json, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.taskType,
        data.status,
        data.inputVersionJson,
        data.payloadJson,
        data.dedupeKey ?? null,
        data.createdAt,
        data.updatedAt,
      );
  }

  getById(id: string): TaskRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, task_type, status, input_version_json, payload_json,
                result_json, error_code, error_message, attempt_count, dedupe_key,
                created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
         FROM tasks WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.toRow(row);
  }

  listByProject(projectId: string, limit = 100): ReadonlyArray<TaskRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_type, status, input_version_json, payload_json,
                result_json, error_code, error_message, attempt_count, dedupe_key,
                created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
         FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  listByStatus(status: string): ReadonlyArray<TaskRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_type, status, input_version_json, payload_json,
                result_json, error_code, error_message, attempt_count, dedupe_key,
                created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
         FROM tasks WHERE status = ? ORDER BY created_at`,
      )
      .all(status) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  claimPending(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET
           status = 'RUNNING',
           attempt_count = attempt_count + 1,
           started_at = ?,
           updated_at = ?,
           finished_at = NULL,
           error_code = NULL,
           error_message = NULL
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(now, now, id);
    return result.changes === 1;
  }

  completeRunning(id: string, resultJson: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'SUCCEEDED', result_json = ?, updated_at = ?, finished_at = ?
         WHERE id = ? AND status = 'RUNNING'`,
      )
      .run(resultJson, now, now, id);
    return result.changes === 1;
  }

  failRunning(id: string, errorCode: string, errorMessage: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
         WHERE id = ? AND status = 'RUNNING'`,
      )
      .run(errorCode, errorMessage, now, now, id);
    return result.changes === 1;
  }

  failPending(id: string, errorCode: string, errorMessage: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(errorCode, errorMessage, now, now, id);
    return result.changes === 1;
  }

  markStale(id: string, expectedStatuses: ReadonlyArray<DbTaskStatus>, now: string): boolean {
    if (expectedStatuses.length === 0) return false;
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'STALE', updated_at = ?, stale_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(now, now, id, ...expectedStatuses);
    return result.changes === 1;
  }

  resetToPending(id: string, expectedStatus: DbTaskStatus, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'PENDING', updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(now, id, expectedStatus);
    return result.changes === 1;
  }

  listRunning(): ReadonlyArray<TaskRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_type, status, input_version_json, payload_json,
                result_json, error_code, error_message, attempt_count, dedupe_key,
                created_at, updated_at, started_at, finished_at, stale_at, cancelled_at
         FROM tasks WHERE status = 'RUNNING'`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  private toRow(row: Record<string, unknown>): TaskRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      taskType: row.task_type as DbTaskType,
      status: row.status as DbTaskStatus,
      inputVersionJson: row.input_version_json as string,
      payloadJson: row.payload_json as string,
      resultJson: (row.result_json as string) ?? null,
      errorCode: (row.error_code as string) ?? null,
      errorMessage: (row.error_message as string) ?? null,
      dedupeKey: (row.dedupe_key as string) ?? null,
      attemptCount: row.attempt_count as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      startedAt: (row.started_at as string) ?? null,
      finishedAt: (row.finished_at as string) ?? null,
      staleAt: (row.stale_at as string) ?? null,
      cancelledAt: (row.cancelled_at as string) ?? null,
    };
  }
}

// ── 模型调用仓库实现 ──────────────────────────────────────────────

class ModelInvocationRepositoryImpl implements ModelInvocationRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(data: CreateInvocationData): void {
    this.db
      .prepare(
        `INSERT INTO model_invocations
           (id, project_id, task_id, provider_profile_id, model, status,
            attempt_number, request_kind, prompt_hash, request_metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.projectId,
        data.taskId,
        data.providerProfileId,
        data.model,
        data.status,
        data.attemptNumber,
        data.requestKind,
        data.promptHash,
        data.requestMetadataJson,
        data.createdAt,
      );
  }

  getById(id: string): ModelInvocationRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, task_id, provider_profile_id, model, status,
                attempt_number, request_kind, prompt_hash, request_metadata_json,
                response_metadata_json, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, total_tokens,
                latency_ms, finish_reason, error_code, error_message,
                provider_request_id, created_at, started_at, finished_at
         FROM model_invocations WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.toRow(row);
  }

  listByTask(taskId: string): ReadonlyArray<ModelInvocationRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_id, provider_profile_id, model, status,
                attempt_number, request_kind, prompt_hash, request_metadata_json,
                response_metadata_json, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, total_tokens,
                latency_ms, finish_reason, error_code, error_message,
                provider_request_id, created_at, started_at, finished_at
         FROM model_invocations WHERE task_id = ? ORDER BY attempt_number`,
      )
      .all(taskId) as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  markRunning(id: string, expectedStatus: 'PENDING', now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE model_invocations SET status = 'RUNNING', started_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(now, id, expectedStatus);
    return result.changes === 1;
  }

  markSucceeded(
    id: string,
    expectedStatus: 'RUNNING',
    result: {
      responseMetadataJson: string;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheWriteTokens: number | null;
      totalTokens: number | null;
      latencyMs: number | null;
      finishReason: string | null;
      providerRequestId: string | null;
      finishedAt: string;
    },
  ): boolean {
    const updateResult = this.db
      .prepare(
        `UPDATE model_invocations SET
           status = 'SUCCEEDED',
           response_metadata_json = ?,
           input_tokens = ?,
           output_tokens = ?,
           cache_read_tokens = ?,
           cache_write_tokens = ?,
           total_tokens = ?,
           latency_ms = ?,
           finish_reason = ?,
           provider_request_id = ?,
           finished_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(
        result.responseMetadataJson,
        result.inputTokens,
        result.outputTokens,
        result.cacheReadTokens,
        result.cacheWriteTokens,
        result.totalTokens,
        result.latencyMs,
        result.finishReason,
        result.providerRequestId,
        result.finishedAt,
        id,
        expectedStatus,
      );
    return updateResult.changes === 1;
  }

  markFailed(
    id: string,
    expectedStatuses: ReadonlyArray<DbInvocationStatus>,
    errorCode: string,
    errorMessage: string,
    latencyMs: number | null,
    finishedAt: string,
  ): boolean {
    if (expectedStatuses.length === 0) return false;
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE model_invocations SET
           status = 'FAILED', error_code = ?, error_message = ?,
           latency_ms = ?, finished_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(errorCode, errorMessage, latencyMs, finishedAt, id, ...expectedStatuses);
    return result.changes === 1;
  }

  getStatsByProject(projectId: string): InvocationStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) as invocation_count,
           COALESCE(SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END), 0) as succeeded_count,
           COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) as failed_count,
           COALESCE(SUM(COALESCE(input_tokens, 0)), 0) as total_input_tokens,
           COALESCE(SUM(COALESCE(output_tokens, 0)), 0) as total_output_tokens,
           COALESCE(SUM(COALESCE(total_tokens, 0)), 0) as total_tokens,
           COALESCE(SUM(COALESCE(latency_ms, 0)), 0) as total_latency_ms
         FROM model_invocations WHERE project_id = ?`,
      )
      .get(projectId) as Record<string, number>;

    return {
      invocationCount: row.invocation_count,
      succeededCount: row.succeeded_count,
      failedCount: row.failed_count,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalTokens: row.total_tokens,
      totalLatencyMs: row.total_latency_ms,
    };
  }

  listRunning(): ReadonlyArray<ModelInvocationRow> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, task_id, provider_profile_id, model, status,
                attempt_number, request_kind, prompt_hash, request_metadata_json,
                response_metadata_json, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, total_tokens,
                latency_ms, finish_reason, error_code, error_message,
                provider_request_id, created_at, started_at, finished_at
         FROM model_invocations WHERE status = 'RUNNING'`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => this.toRow(r));
  }

  private toRow(row: Record<string, unknown>): ModelInvocationRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      taskId: row.task_id as string,
      providerProfileId: row.provider_profile_id as string,
      model: row.model as string,
      status: row.status as DbInvocationStatus,
      attemptNumber: row.attempt_number as number,
      requestKind: row.request_kind as string,
      promptHash: row.prompt_hash as string,
      requestMetadataJson: row.request_metadata_json as string,
      responseMetadataJson: (row.response_metadata_json as string) ?? null,
      inputTokens: (row.input_tokens as number) ?? null,
      outputTokens: (row.output_tokens as number) ?? null,
      cacheReadTokens: (row.cache_read_tokens as number) ?? null,
      cacheWriteTokens: (row.cache_write_tokens as number) ?? null,
      totalTokens: (row.total_tokens as number) ?? null,
      latencyMs: (row.latency_ms as number) ?? null,
      finishReason: (row.finish_reason as string) ?? null,
      errorCode: (row.error_code as string) ?? null,
      errorMessage: (row.error_message as string) ?? null,
      providerRequestId: (row.provider_request_id as string) ?? null,
      createdAt: row.created_at as string,
      startedAt: (row.started_at as string) ?? null,
      finishedAt: (row.finished_at as string) ?? null,
    };
  }
}

// ── 项目数据库管理器 ──────────────────────────────────────────────

export class ProjectDatabase implements ProjectDatabaseManager {
  private readonly db: DatabaseSync;
  private readonly metadataRepo: ProjectMetadataRepositoryImpl;
  private readonly taskRepo: TaskRepositoryImpl;
  private readonly invocationRepo: ModelInvocationRepositoryImpl;
  private readonly grillSessionRepo: GrillSessionRepositoryImpl;
  private readonly grillQuestionRepo: GrillQuestionRepositoryImpl;
  private readonly grillAnswerRepo: GrillAnswerRepositoryImpl;
  private readonly grillProposalRepo: GrillProposalRepositoryImpl;
  private readonly grillQuestionPlanProposalRepo: GrillQuestionPlanProposalRepositoryImpl;
  private readonly ccProposalRepo: CreationContractProposalRepositoryImpl;
  private readonly ccVersionRepo: CreationContractVersionRepositoryImpl;
  private readonly ccCurrentRepo: CreationContractCurrentRepositoryImpl;
  private readonly ccLockEventRepo: CreationContractLockEventRepositoryImpl;
  private readonly manuscriptRepo: ManuscriptRepositoryImpl;
  private readonly chapterRepo: ChapterRepositoryImpl;
  private readonly chapterVersionRepo: ChapterVersionRepositoryImpl;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);

    // 配置 SQLite
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');

    // 运行迁移
    const migrator = new SQLiteMigrator(this.db);
    migrator.migrate(0, PROJECT_MIGRATIONS);

    this.metadataRepo = new ProjectMetadataRepositoryImpl(this.db);
    this.taskRepo = new TaskRepositoryImpl(this.db);
    this.invocationRepo = new ModelInvocationRepositoryImpl(this.db);
    this.grillSessionRepo = new GrillSessionRepositoryImpl(this.db);
    this.grillQuestionRepo = new GrillQuestionRepositoryImpl(this.db);
    this.grillAnswerRepo = new GrillAnswerRepositoryImpl(this.db);
    this.grillProposalRepo = new GrillProposalRepositoryImpl(this.db);
    this.grillQuestionPlanProposalRepo = new GrillQuestionPlanProposalRepositoryImpl(this.db);
    this.ccProposalRepo = new CreationContractProposalRepositoryImpl(this.db);
    this.ccVersionRepo = new CreationContractVersionRepositoryImpl(this.db);
    this.ccCurrentRepo = new CreationContractCurrentRepositoryImpl(this.db);
    this.ccLockEventRepo = new CreationContractLockEventRepositoryImpl(this.db);
    this.manuscriptRepo = new ManuscriptRepositoryImpl(this.db);
    this.chapterRepo = new ChapterRepositoryImpl(this.db);
    this.chapterVersionRepo = new ChapterVersionRepositoryImpl(this.db);
  }

  get database(): DatabaseSync {
    return this.db;
  }

  getProjectMetadataRepository(): ProjectMetadataRepository {
    return this.metadataRepo;
  }

  getTaskRepository(): TaskRepository {
    return this.taskRepo;
  }

  getModelInvocationRepository(): ModelInvocationRepository {
    return this.invocationRepo;
  }

  getGrillSessionRepository(): GrillSessionRepository {
    return this.grillSessionRepo;
  }

  getGrillQuestionRepository(): GrillQuestionRepository {
    return this.grillQuestionRepo;
  }

  getGrillAnswerRepository(): GrillAnswerRepository {
    return this.grillAnswerRepo;
  }

  getGrillProposalRepository(): GrillProposalRepository {
    return this.grillProposalRepo;
  }

  getGrillQuestionPlanProposalRepository(): GrillQuestionPlanProposalRepository {
    return this.grillQuestionPlanProposalRepo;
  }

  getCreationContractProposalRepository(): CreationContractProposalRepository {
    return this.ccProposalRepo;
  }

  getCreationContractVersionRepository(): CreationContractVersionRepository {
    return this.ccVersionRepo;
  }

  getCreationContractCurrentRepository(): CreationContractCurrentRepository {
    return this.ccCurrentRepo;
  }

  getCreationContractLockEventRepository(): CreationContractLockEventRepository {
    return this.ccLockEventRepo;
  }

  getManuscriptRepository(): ManuscriptRepository {
    return this.manuscriptRepo;
  }

  getChapterRepository(): ChapterRepository {
    return this.chapterRepo;
  }

  getChapterVersionRepository(): ChapterVersionRepository {
    return this.chapterVersionRepo;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * BEGIN IMMEDIATE 事务：执行前立即获得 RESERVED 写锁，
   * 避免延迟事务在并发写入时的升级死锁。用于创作契约草案的
   * proposal + invocation + task 最终原子提交。
   */
  transactionImmediate<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 验证项目数据库版本兼容性（不创建连接）。
 *
 * 打开项目时先检查版本，版本不兼容时给出明确错误。
 */
export function checkProjectDatabaseVersion(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const migrator = new SQLiteMigrator(db);
    const currentVersion = migrator.getCurrentVersion();
    const maxSupported = Math.max(...PROJECT_MIGRATIONS.map((m) => m.version), 0);
    if (currentVersion > maxSupported) {
      throw new Error(
        `项目数据库版本 ${currentVersion} 高于应用支持的最高版本 ${maxSupported}，无法打开。请升级应用。`,
      );
    }
  } finally {
    db.close();
  }
}
