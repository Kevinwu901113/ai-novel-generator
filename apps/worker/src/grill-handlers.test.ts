import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AppDatabase, ProjectDatabase } from '@ai-novel/database';
import { dispatchGrillCommand, type GrillHandlerContext } from './grill-handlers.js';
import { AppError } from '@ai-novel/application';

let tempDir: string;
let appDb: AppDatabase;

const NOW = '2024-06-15T12:00:00.000Z';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'grill-handlers-test-'));
  const dataRoot = join(tempDir, 'data');
  mkdirSync(join(dataRoot, 'projects'), { recursive: true });
  appDb = new AppDatabase(join(dataRoot, 'app.sqlite'));
});

afterEach(() => {
  appDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function createProjectWithDb(): { projectId: string; projectDir: string } {
  const projectId = randomUUID();
  const projectDir = join(tempDir, 'data', 'projects', projectId);
  mkdirSync(projectDir, { recursive: true });

  const projDb = new ProjectDatabase(join(projectDir, 'project.sqlite'));
  projDb.getProjectMetadataRepository().create({
    id: projectId,
    name: '测试项目',
    initialIdea: '想法',
    status: 'idea',
    createdAt: NOW,
    updatedAt: NOW,
  });
  projDb.close();

  appDb.getProjectIndexRepository().create({
    id: projectId,
    name: '测试项目',
    initialIdea: '想法',
    status: 'idea',
    projectDirectory: projectDir,
    createdAt: NOW,
    updatedAt: NOW,
  });

  return { projectId, projectDir };
}

function createContext(): GrillHandlerContext {
  return {
    getProjectDb(projectId: string): ProjectDatabase {
      const project = appDb.getProjectIndexRepository().getById(projectId);
      if (!project) {
        throw new AppError('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`);
      }
      return new ProjectDatabase(join(project.projectDirectory, 'project.sqlite'));
    },
    idGenerator: { generate: () => randomUUID() },
    clock: { now: () => NOW },
  };
}

// ── Payload 验证测试 ──────────────────────────────────────────────

function expectErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('应该抛出异常');
  } catch (err) {
    expect((err as AppError).code).toBe(code);
  }
}

describe('Grill RPC payload 验证', () => {
  it('grill.createSession 缺少 goal → GRILL_VALIDATION_ERROR', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    expectErrorCode(
      () => dispatchGrillCommand('grill.createSession', { projectId }, ctx),
      'GRILL_VALIDATION_ERROR',
    );
  });

  it('grill.createSession 缺少 projectId → GRILL_VALIDATION_ERROR', () => {
    const ctx = createContext();
    expectErrorCode(
      () => dispatchGrillCommand('grill.createSession', { goal: '目标' }, ctx),
      'GRILL_VALIDATION_ERROR',
    );
  });

  it('grill.answerQuestion 缺少 text → GRILL_VALIDATION_ERROR', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.answerQuestion',
          { projectId, sessionId: 's1', expectedVersion: 1, questionId: 'q1', source: 'USER' },
          ctx,
        ),
      'GRILL_VALIDATION_ERROR',
    );
  });

  it('grill.answerQuestion 非法 source → GRILL_VALIDATION_ERROR', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.answerQuestion',
          {
            projectId,
            sessionId: 's1',
            expectedVersion: 1,
            questionId: 'q1',
            text: 'x',
            source: 'AI',
          },
          ctx,
        ),
      'GRILL_VALIDATION_ERROR',
    );
  });

  it('grill.reviewProposal 非法 decision → GRILL_VALIDATION_ERROR', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.reviewProposal',
          { projectId, sessionId: 's1', expectedVersion: 1, proposalId: 'p1', decision: 'MAYBE' },
          ctx,
        ),
      'GRILL_VALIDATION_ERROR',
    );
  });

  it('grill.addQuestions 非数组 questions → GRILL_VALIDATION_ERROR', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.addQuestions',
          { projectId, sessionId: 's1', expectedVersion: 1, questions: 'not-array' },
          ctx,
        ),
      'GRILL_VALIDATION_ERROR',
    );
  });
});

// ── 项目/会话缺失测试 ─────────────────────────────────────────────

describe('Grill RPC 资源缺失', () => {
  it('不存在的 projectId → PROJECT_NOT_FOUND', () => {
    const ctx = createContext();
    expectErrorCode(
      () =>
        dispatchGrillCommand('grill.createSession', { projectId: 'nonexistent', goal: 'g' }, ctx),
      'PROJECT_NOT_FOUND',
    );
  });

  it('不存在的 sessionId → GRILL_SESSION_NOT_FOUND', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    expectErrorCode(
      () => dispatchGrillCommand('grill.getSession', { projectId, sessionId: 'nonexistent' }, ctx),
      'GRILL_SESSION_NOT_FOUND',
    );
  });
});

// ── 版本冲突测试 ──────────────────────────────────────────────────

describe('Grill RPC 版本冲突', () => {
  it('过期 version → GRILL_VERSION_CONFLICT', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();

    const session = dispatchGrillCommand(
      'grill.createSession',
      { projectId, goal: '目标' },
      ctx,
    ) as { id: string; version: number };

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.startSession',
          { projectId, sessionId: session.id, expectedVersion: 99 },
          ctx,
        ),
      'GRILL_VERSION_CONFLICT',
    );
  });
});

// ── 完整生命周期测试 ──────────────────────────────────────────────

describe('Grill RPC 生命周期', () => {
  it('创建 → 启动 → 添加问题 → 回答 → 完成', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();

    // 创建会话
    const session = dispatchGrillCommand(
      'grill.createSession',
      { projectId, goal: '测试目标' },
      ctx,
    ) as { id: string; version: number; status: string };
    expect(session.status).toBe('DRAFT');
    expect(session.version).toBe(1);

    // 启动
    const started = dispatchGrillCommand(
      'grill.startSession',
      { projectId, sessionId: session.id, expectedVersion: 1 },
      ctx,
    ) as { status: string; version: number };
    expect(started.status).toBe('ACTIVE');

    // 添加问题
    const questions = dispatchGrillCommand(
      'grill.addQuestions',
      {
        projectId,
        sessionId: session.id,
        expectedVersion: 2,
        questions: [
          { topic: '类型', text: '什么类型？', rationale: '确认类型', dependsOnQuestionIds: [] },
        ],
      },
      ctx,
    ) as Array<{ id: string; status: string }>;
    expect(questions).toHaveLength(1);
    expect(questions[0].status).toBe('PLANNED');

    // 回答问题
    const answer = dispatchGrillCommand(
      'grill.answerQuestion',
      {
        projectId,
        sessionId: session.id,
        expectedVersion: 3,
        questionId: questions[0].id,
        text: '奇幻',
        source: 'USER',
      },
      ctx,
    ) as { text: string; revision: number };
    expect(answer.text).toBe('奇幻');
    expect(answer.revision).toBe(1);

    // 获取当前答案
    const answers = dispatchGrillCommand(
      'grill.getCurrentAnswers',
      { projectId, sessionId: session.id },
      ctx,
    ) as Array<{ text: string }>;
    expect(answers).toHaveLength(1);

    // 完成会话
    const completed = dispatchGrillCommand(
      'grill.completeSession',
      { projectId, sessionId: session.id, expectedVersion: 4 },
      ctx,
    ) as { status: string };
    expect(completed.status).toBe('COMPLETED');
  });

  it('暂停 → 恢复', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();

    const session = dispatchGrillCommand('grill.createSession', { projectId, goal: 'g' }, ctx) as {
      id: string;
    };

    dispatchGrillCommand(
      'grill.startSession',
      { projectId, sessionId: session.id, expectedVersion: 1 },
      ctx,
    );

    const paused = dispatchGrillCommand(
      'grill.pauseSession',
      { projectId, sessionId: session.id, expectedVersion: 2 },
      ctx,
    ) as { status: string };
    expect(paused.status).toBe('PAUSED');

    const resumed = dispatchGrillCommand(
      'grill.resumeSession',
      { projectId, sessionId: session.id, expectedVersion: 3 },
      ctx,
    ) as { status: string };
    expect(resumed.status).toBe('ACTIVE');
  });
});

// ── Redaction 测试 ────────────────────────────────────────────────

describe('Grill RPC redaction', () => {
  it('返回的 DTO 不含内部字段', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();

    const session = dispatchGrillCommand(
      'grill.createSession',
      { projectId, goal: 'g' },
      ctx,
    ) as Record<string, unknown>;

    // 不应有数据库内部字段
    expect(session).not.toHaveProperty('project_id');
    expect(session).not.toHaveProperty('created_at');
    expect(session).not.toHaveProperty('updated_at');

    // 应有公开字段
    expect(session).toHaveProperty('id');
    expect(session).toHaveProperty('projectId');
    expect(session).toHaveProperty('createdAt');
  });

  it('提案 DTO 解析 proposedValue JSON', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();

    const session = dispatchGrillCommand('grill.createSession', { projectId, goal: 'g' }, ctx) as {
      id: string;
    };

    dispatchGrillCommand(
      'grill.startSession',
      { projectId, sessionId: session.id, expectedVersion: 1 },
      ctx,
    );

    const proposal = dispatchGrillCommand(
      'grill.createProposal',
      {
        projectId,
        sessionId: session.id,
        basedOnAnswerIds: [],
        key: 'genre',
        proposedValueJson: '"奇幻"',
        confidence: 0.9,
        rationale: '推断',
      },
      ctx,
    ) as Record<string, unknown>;

    // proposedValue 应该是解析后的值，不是 JSON 字符串
    expect(proposal.proposedValue).toBe('奇幻');
    expect(proposal).not.toHaveProperty('proposedValueJson');
  });
});

// ── 未知命令测试 ──────────────────────────────────────────────────

describe('Grill RPC 未知命令', () => {
  it('grill.unknownCommand → VALIDATION_ERROR', () => {
    const ctx = createContext();
    expect(() => dispatchGrillCommand('grill.unknownCommand', {}, ctx)).toThrow(
      '未知命令: grill.unknownCommand',
    );
  });

  it('不映射为 PROJECT_CREATE_FAILED', () => {
    const ctx = createContext();
    try {
      dispatchGrillCommand('grill.unknownCommand', {}, ctx);
    } catch (err) {
      expect((err as AppError).code).toBe('VALIDATION_ERROR');
      expect((err as AppError).code).not.toBe('PROJECT_CREATE_FAILED');
    }
  });
});
