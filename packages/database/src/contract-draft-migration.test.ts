/**
 * 创作契约草案任务类型数据库迁移测试。
 *
 * 验证 migration v6：
 * - 从旧版本（v5）数据库正确升级，保留全部既有 tasks/model_invocations；
 * - tasks.task_type CHECK 扩展支持 CREATION_CONTRACT_DRAFT；
 * - 旧三类任务完整保留，未知 task type 被拒；
 * - dedupe partial unique index、FK、触发器、composite unique index 仍存在；
 * - creation_contract_proposals 新增 task_id / invocation_id 唯一约束；
 * - transactionImmediate 可用；
 * - 新建数据库直接得到最终 schema（幂等、无第二套任务表）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  canonicalSerializeContractSections,
  validateCreationContractSections,
} from '@ai-novel/domain';
import { SQLiteMigrator } from './migrator.js';
import { ProjectDatabase, PROJECT_MIGRATIONS } from './project-database.js';
import { sha256Utf8 } from './creation-contract-repositories.js';

const NOW = '2024-06-15T12:00:00.000Z';

/** 最小合法 sections 的 canonical JSON。 */
function makeSectionsJson(): string {
  return canonicalSerializeContractSections(
    validateCreationContractSections({
      premise: '一个关于迁移的故事',
      genre: ['sci-fi'],
      tone: ['dark'],
      targetAudience: 'adults',
      narrativePov: 'FIRST',
      tense: 'PAST',
      protagonist: { characterKey: 'protag', name: 'Protagonist' },
    }),
  );
}

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'contract-draft-migration-'));
  dbPath = join(tempDir, 'project.sqlite');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 构建一个 v5 数据库并写入代表三类旧任务的完整数据链。 */
function buildV5Database(): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const migrator = new SQLiteMigrator(db);
    migrator.migrate(0, PROJECT_MIGRATIONS.slice(0, 5));
    expect(migrator.getCurrentVersion()).toBe(5);

    // project_metadata（作为项目存在性锚点）
    db.prepare(
      `INSERT INTO project_metadata (id, name, initial_idea, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('p1', '项目一', '一个故事', 'contract', NOW, NOW);

    // 三类旧任务
    db.prepare(
      `INSERT INTO tasks
         (id, project_id, task_type, status, input_version_json, payload_json,
          result_json, error_code, error_message, attempt_count, dedupe_key,
          created_at, updated_at, started_at, finished_at, stale_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      't-connect',
      'p1',
      'PROVIDER_CONNECTION_TEST',
      'SUCCEEDED',
      '{}',
      '{}',
      '{"ok":true}',
      null,
      null,
      1,
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
      't-invocation',
      'p1',
      'MODEL_INVOCATION_TEST',
      'FAILED',
      '{}',
      '{"promptHash":"abc"}',
      null,
      'PROVIDER_TIMEOUT',
      '连接超时',
      1,
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

    // model_invocations（关联 t-connect）
    db.prepare(
      `INSERT INTO model_invocations
         (id, project_id, task_id, provider_profile_id, model, status,
          attempt_number, request_kind, prompt_hash, request_metadata_json,
          response_metadata_json, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, total_tokens, latency_ms, finish_reason, error_code,
          error_message, provider_request_id, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'inv-connect',
      'p1',
      't-connect',
      'mimo-token-plan-cn',
      'MiMo-V2.5-Pro',
      'SUCCEEDED',
      1,
      'model_invocation_test',
      'a'.repeat(64),
      '{}',
      '{}',
      10,
      20,
      null,
      null,
      30,
      100,
      'end_turn',
      null,
      null,
      'req-1',
      NOW,
      NOW,
      NOW,
    );

    // grill_sessions（供后续契约基线引用）
    db.prepare(
      `INSERT INTO grill_sessions
         (id, project_id, status, version, goal, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('gs1', 'p1', 'COMPLETED', 3, '一个目标', NOW, NOW);
  } finally {
    db.close();
  }
}

describe('migration v6: CREATION_CONTRACT_DRAFT', () => {
  it('从 v5 升级：保留全部既有任务与调用记录', () => {
    buildV5Database();
    const db = new ProjectDatabase(dbPath);
    try {
      const version = db.database
        .prepare('SELECT MAX(version) as v FROM schema_migrations')
        .get() as { v: number };
      expect(version.v).toBe(11);

      const tasks = db.getTaskRepository().listByProject('p1');
      const types = tasks.map((t) => t.taskType).sort();
      expect(types).toEqual([
        'GRILL_QUESTION_PLAN',
        'MODEL_INVOCATION_TEST',
        'PROVIDER_CONNECTION_TEST',
      ]);

      const connect = db.getTaskRepository().getById('t-connect');
      expect(connect).not.toBeNull();
      expect(connect?.resultJson).toBe('{"ok":true}');
      expect(connect?.attemptCount).toBe(1);
      expect(connect?.status).toBe('SUCCEEDED');

      const invocation = db.getModelInvocationRepository().getById('inv-connect');
      expect(invocation).not.toBeNull();
      expect(invocation?.model).toBe('MiMo-V2.5-Pro');
      expect(invocation?.providerRequestId).toBe('req-1');
      expect(invocation?.status).toBe('SUCCEEDED');
    } finally {
      db.close();
    }
  });

  it('新 task type 可插入，未知 task type 被拒', () => {
    buildV5Database();
    const db = new ProjectDatabase(dbPath);
    try {
      db.getTaskRepository().create({
        id: 't-draft',
        projectId: 'p1',
        taskType: 'CREATION_CONTRACT_DRAFT',
        status: 'PENDING',
        inputVersionJson: '{}',
        payloadJson: '{}',
        dedupeKey: 'creation_contract_draft:gs1:3:none:none',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const task = db.getTaskRepository().getById('t-draft');
      expect(task?.taskType).toBe('CREATION_CONTRACT_DRAFT');

      expect(() =>
        db.getTaskRepository().create({
          id: 't-bad',
          projectId: 'p1',
          taskType: 'NOT_A_TASK_TYPE' as never,
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

  it('dedupe partial unique index 升级后仍生效', () => {
    buildV5Database();
    const db = new ProjectDatabase(dbPath);
    try {
      db.getTaskRepository().create({
        id: 't-draft-1',
        projectId: 'p1',
        taskType: 'CREATION_CONTRACT_DRAFT',
        status: 'PENDING',
        inputVersionJson: '{}',
        payloadJson: '{}',
        dedupeKey: 'creation_contract_draft:gs1:3:none:none',
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(() =>
        db.getTaskRepository().create({
          id: 't-draft-2',
          projectId: 'p1',
          taskType: 'CREATION_CONTRACT_DRAFT',
          status: 'PENDING',
          inputVersionJson: '{}',
          payloadJson: '{}',
          dedupeKey: 'creation_contract_draft:gs1:3:none:none',
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ).toThrow();
      // 既有 dedupe（grill_question_plan:gs1:1）仍占用
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

  it('所有索引、FK、CHECK 仍存在（含 proposal 唯一约束）', () => {
    buildV5Database();
    const db = new ProjectDatabase(dbPath);
    try {
      const indexNames = (
        db.database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index'
               AND name IN ('idx_tasks_dedupe_active', 'uq_tasks_project_id',
                            'uq_cc_proposals_task', 'uq_cc_proposals_invocation',
                            'idx_tasks_status', 'idx_tasks_project_created')`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      for (const expected of [
        'idx_tasks_dedupe_active',
        'uq_tasks_project_id',
        'uq_cc_proposals_task',
        'uq_cc_proposals_invocation',
        'idx_tasks_status',
        'idx_tasks_project_created',
      ]) {
        expect(indexNames).toContain(expected);
      }

      const triggers = (
        db.database
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='trigger'
             AND name LIKE 'trg_cc_%'`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(triggers.length).toBeGreaterThan(0);

      // FK 仍生效：不存在的 task 不能创建 proposal
      const sectionsJson = makeSectionsJson();
      expect(() =>
        db.getCreationContractProposalRepository().create({
          id: 'prop-fk',
          projectId: 'p1',
          taskId: 'no-such-task',
          invocationId: 'inv-connect',
          baseGrillSessionId: 'gs1',
          baseGrillSessionVersion: 3,
          baseContractVersion: null,
          schemaVersion: 1,
          sectionsJson,
          sectionsHash: sha256Utf8(sectionsJson),
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('proposal task_id / invocation_id 唯一约束生效', () => {
    buildV5Database();
    const db = new ProjectDatabase(dbPath);
    try {
      // 构造 task + invocation 使 FK 成立
      db.getTaskRepository().create({
        id: 't-ccd',
        projectId: 'p1',
        taskType: 'CREATION_CONTRACT_DRAFT',
        status: 'SUCCEEDED',
        inputVersionJson: '{}',
        payloadJson: '{}',
        createdAt: NOW,
        updatedAt: NOW,
      });
      db.getModelInvocationRepository().create({
        id: 'inv-ccd',
        projectId: 'p1',
        taskId: 't-ccd',
        providerProfileId: 'mimo-token-plan-cn',
        model: 'MiMo-V2.5-Pro',
        status: 'SUCCEEDED',
        attemptNumber: 1,
        requestKind: 'creation_contract_draft',
        promptHash: 'c'.repeat(64),
        requestMetadataJson: '{}',
        createdAt: NOW,
      });
      const sectionsJson = makeSectionsJson();
      const hashA = sha256Utf8(sectionsJson);
      db.getCreationContractProposalRepository().create({
        id: 'prop-1',
        projectId: 'p1',
        taskId: 't-ccd',
        invocationId: 'inv-ccd',
        baseGrillSessionId: 'gs1',
        baseGrillSessionVersion: 3,
        baseContractVersion: null,
        schemaVersion: 1,
        sectionsJson,
        sectionsHash: hashA,
        createdAt: NOW,
        updatedAt: NOW,
      });
      // 同 task 第二个 proposal 被拒（task_id 唯一）
      const differentSectionsJson = makeSectionsJson();
      expect(() =>
        db.getCreationContractProposalRepository().create({
          id: 'prop-2',
          projectId: 'p1',
          taskId: 't-ccd',
          invocationId: 'inv-ccd',
          baseGrillSessionId: 'gs1',
          baseGrillSessionVersion: 3,
          baseContractVersion: null,
          schemaVersion: 1,
          sectionsJson: differentSectionsJson,
          sectionsHash: sha256Utf8(differentSectionsJson),
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('transactionImmediate 可用', () => {
    buildV5Database();
    const db = new ProjectDatabase(dbPath);
    try {
      const result = db.transactionImmediate(() => 42);
      expect(result).toBe(42);
      // 事务内失败回滚
      expect(() =>
        db.transactionImmediate(() => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
    } finally {
      db.close();
    }
  });

  it('重复启动幂等：直接打开新数据库即得到最终 schema', () => {
    const db = new ProjectDatabase(dbPath);
    db.close();
    // 再次打开：无新迁移应用，schema 稳定
    const db2 = new ProjectDatabase(dbPath);
    try {
      const version = db2.database
        .prepare('SELECT MAX(version) as v FROM schema_migrations')
        .get() as { v: number };
      expect(version.v).toBe(11);
      db2.getTaskRepository().create({
        id: 't-fresh',
        projectId: 'p1',
        taskType: 'CREATION_CONTRACT_DRAFT',
        status: 'PENDING',
        inputVersionJson: '{}',
        payloadJson: '{}',
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(db2.getTaskRepository().getById('t-fresh')).not.toBeNull();
    } finally {
      db2.close();
    }
  });

  it('未创建第二套任务表', () => {
    buildV5Database();
    const db = new ProjectDatabase(dbPath);
    try {
      const taskTables = (
        db.database
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%task%'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(taskTables).toContain('tasks');
      expect(taskTables.filter((n) => n.startsWith('tasks_'))).toEqual([]);
    } finally {
      db.close();
    }
  });
});
