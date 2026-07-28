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

    const questions = dispatchGrillCommand(
      'grill.addQuestions',
      {
        projectId,
        sessionId: session.id,
        expectedVersion: 2,
        questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
      },
      ctx,
    ) as Array<{ id: string }>;

    const answer = dispatchGrillCommand(
      'grill.answerQuestion',
      {
        projectId,
        sessionId: session.id,
        expectedVersion: 3,
        questionId: questions[0].id,
        text: '回答',
        source: 'USER',
      },
      ctx,
    ) as { id: string };

    const proposal = dispatchGrillCommand(
      'grill.createProposal',
      {
        projectId,
        sessionId: session.id,
        expectedVersion: 4,
        basedOnAnswerIds: [answer.id],
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

// ── 真实 SQLite 完整性测试 ────────────────────────────────────────

interface SessionRef {
  id: string;
  version: number;
}

function newActiveSession(ctx: GrillHandlerContext, projectId: string): SessionRef {
  const session = dispatchGrillCommand('grill.createSession', { projectId, goal: 'g' }, ctx) as {
    id: string;
    version: number;
  };
  const started = dispatchGrillCommand(
    'grill.startSession',
    { projectId, sessionId: session.id, expectedVersion: session.version },
    ctx,
  ) as { id: string; version: number };
  return { id: started.id, version: started.version };
}

function newQuestion(
  ctx: GrillHandlerContext,
  projectId: string,
  session: SessionRef,
): { questionId: string; session: SessionRef } {
  const questions = dispatchGrillCommand(
    'grill.addQuestions',
    {
      projectId,
      sessionId: session.id,
      expectedVersion: session.version,
      questions: [{ topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [] }],
    },
    ctx,
  ) as Array<{ id: string }>;
  return {
    questionId: questions[0].id,
    session: { id: session.id, version: session.version + 1 },
  };
}

function newAnswer(
  ctx: GrillHandlerContext,
  projectId: string,
  session: SessionRef,
  questionId: string,
): { answerId: string; session: SessionRef } {
  const answer = dispatchGrillCommand(
    'grill.answerQuestion',
    {
      projectId,
      sessionId: session.id,
      expectedVersion: session.version,
      questionId,
      text: '回答',
      source: 'USER',
    },
    ctx,
  ) as { id: string };
  return { answerId: answer.id, session: { id: session.id, version: session.version + 1 } };
}

function getSessionVersion(ctx: GrillHandlerContext, projectId: string, sessionId: string): number {
  const session = dispatchGrillCommand('grill.getSession', { projectId, sessionId }, ctx) as {
    version: number;
  };
  return session.version;
}

describe('Grill 真实 SQLite 完整性', () => {
  it('1. 会话 A 不能回答会话 B 的问题', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const b = newActiveSession(ctx, projectId);
    const { questionId } = newQuestion(ctx, projectId, a);

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.answerQuestion',
          {
            projectId,
            sessionId: b.id,
            expectedVersion: b.version,
            questionId,
            text: '回答',
            source: 'USER',
          },
          ctx,
        ),
      'GRILL_OWNERSHIP_CONFLICT',
    );
  });

  it('2. 会话 A 不能 skip/supersede 会话 B 的问题', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const b = newActiveSession(ctx, projectId);
    const { questionId } = newQuestion(ctx, projectId, a);

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.skipQuestion',
          { projectId, sessionId: b.id, expectedVersion: b.version, questionId },
          ctx,
        ),
      'GRILL_OWNERSHIP_CONFLICT',
    );
    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.supersedeQuestion',
          { projectId, sessionId: b.id, expectedVersion: b.version, questionId },
          ctx,
        ),
      'GRILL_OWNERSHIP_CONFLICT',
    );
  });

  it('3. 会话 A 不能审核会话 B 的 proposal', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const b = newActiveSession(ctx, projectId);
    const { questionId, session: a2 } = newQuestion(ctx, projectId, a);
    const { answerId, session: a3 } = newAnswer(ctx, projectId, a2, questionId);

    const proposal = dispatchGrillCommand(
      'grill.createProposal',
      {
        projectId,
        sessionId: a3.id,
        expectedVersion: a3.version,
        basedOnAnswerIds: [answerId],
        key: 'k',
        proposedValueJson: '"v"',
        confidence: 0.5,
        rationale: '',
      },
      ctx,
    ) as { id: string };

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.reviewProposal',
          {
            projectId,
            sessionId: b.id,
            expectedVersion: b.version,
            proposalId: proposal.id,
            decision: 'ACCEPTED',
          },
          ctx,
        ),
      'GRILL_OWNERSHIP_CONFLICT',
    );
  });

  it('4. 跨会话失败时两个 session version 都不变', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const b = newActiveSession(ctx, projectId);
    const { questionId } = newQuestion(ctx, projectId, a);

    const aVersionBefore = getSessionVersion(ctx, projectId, a.id);
    const bVersionBefore = getSessionVersion(ctx, projectId, b.id);

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.answerQuestion',
          {
            projectId,
            sessionId: b.id,
            expectedVersion: b.version,
            questionId,
            text: '回答',
            source: 'USER',
          },
          ctx,
        ),
      'GRILL_OWNERSHIP_CONFLICT',
    );

    expect(getSessionVersion(ctx, projectId, a.id)).toBe(aVersionBefore);
    expect(getSessionVersion(ctx, projectId, b.id)).toBe(bVersionBefore);
  });

  it('5. SKIPPED 问题不能回答', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const { questionId, session: a2 } = newQuestion(ctx, projectId, a);
    const skipped = dispatchGrillCommand(
      'grill.skipQuestion',
      { projectId, sessionId: a2.id, expectedVersion: a2.version, questionId },
      ctx,
    ) as { status: string; version?: number };
    expect(skipped.status).toBe('SKIPPED');

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.answerQuestion',
          {
            projectId,
            sessionId: a2.id,
            expectedVersion: a2.version + 1,
            questionId,
            text: '回答',
            source: 'USER',
          },
          ctx,
        ),
      'GRILL_STATE_CONFLICT',
    );
  });

  it('6. SUPERSEDED 问题不能回答', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const { questionId, session: a2 } = newQuestion(ctx, projectId, a);
    const { session: a3 } = newAnswer(ctx, projectId, a2, questionId);
    dispatchGrillCommand(
      'grill.supersedeQuestion',
      { projectId, sessionId: a3.id, expectedVersion: a3.version, questionId },
      ctx,
    );

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.answerQuestion',
          {
            projectId,
            sessionId: a3.id,
            expectedVersion: a3.version + 1,
            questionId,
            text: '回答',
            source: 'USER',
          },
          ctx,
        ),
      'GRILL_STATE_CONFLICT',
    );
  });

  it('7. ANSWERED 问题可生成 revision 2', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const { questionId, session: a2 } = newQuestion(ctx, projectId, a);
    const { session: a3 } = newAnswer(ctx, projectId, a2, questionId);

    const answer2 = dispatchGrillCommand(
      'grill.answerQuestion',
      {
        projectId,
        sessionId: a3.id,
        expectedVersion: a3.version,
        questionId,
        text: '修订',
        source: 'USER',
      },
      ctx,
    ) as { revision: number };
    expect(answer2.revision).toBe(2);

    const history = dispatchGrillCommand(
      'grill.listAnswerHistory',
      { projectId, sessionId: a3.id, questionId },
      ctx,
    ) as Array<{ revision: number; supersededAt: string | null }>;
    expect(history).toHaveLength(2);
    expect(history[0].supersededAt).not.toBeNull();
    expect(history[1].supersededAt).toBeNull();
  });

  it('8. ANSWERED 但无 current answer 时拒绝并回滚', () => {
    const { projectId, projectDir } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const { questionId, session: a2 } = newQuestion(ctx, projectId, a);
    const { session: a3 } = newAnswer(ctx, projectId, a2, questionId);

    // 人为制造不一致：直接废弃当前答案但不新增
    const raw = new ProjectDatabase(join(projectDir, 'project.sqlite'));
    raw.getGrillAnswerRepository().supersedeCurrent(questionId, '2024-06-15T13:00:00.000Z');
    raw.close();

    const versionBefore = getSessionVersion(ctx, projectId, a3.id);

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.answerQuestion',
          {
            projectId,
            sessionId: a3.id,
            expectedVersion: a3.version,
            questionId,
            text: '回答',
            source: 'USER',
          },
          ctx,
        ),
      'GRILL_STATE_CONFLICT',
    );

    // 版本不变（事务回滚）
    expect(getSessionVersion(ctx, projectId, a3.id)).toBe(versionBefore);
  });

  it('10. proposal 不能引用不存在的 answer', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.createProposal',
          {
            projectId,
            sessionId: a.id,
            expectedVersion: a.version,
            basedOnAnswerIds: ['ghost'],
            key: 'k',
            proposedValueJson: '"v"',
            confidence: 0.5,
            rationale: '',
          },
          ctx,
        ),
      'GRILL_VALIDATION_ERROR',
    );
  });

  it('11. proposal 不能引用其他 session 的 answer', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const b = newActiveSession(ctx, projectId);
    const { questionId, session: a2 } = newQuestion(ctx, projectId, a);
    const { answerId } = newAnswer(ctx, projectId, a2, questionId);

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.createProposal',
          {
            projectId,
            sessionId: b.id,
            expectedVersion: b.version,
            basedOnAnswerIds: [answerId],
            key: 'k',
            proposedValueJson: '"v"',
            confidence: 0.5,
            rationale: '',
          },
          ctx,
        ),
      'GRILL_OWNERSHIP_CONFLICT',
    );
  });

  it('12. proposal 不能引用 superseded answer', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const { questionId, session: a2 } = newQuestion(ctx, projectId, a);
    const { answerId, session: a3 } = newAnswer(ctx, projectId, a2, questionId);
    // 再次回答以废弃第一个答案
    const { session: a4 } = newAnswer(ctx, projectId, a3, questionId);

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.createProposal',
          {
            projectId,
            sessionId: a4.id,
            expectedVersion: a4.version,
            basedOnAnswerIds: [answerId],
            key: 'k',
            proposedValueJson: '"v"',
            confidence: 0.5,
            rationale: '',
          },
          ctx,
        ),
      'GRILL_VALIDATION_ERROR',
    );
  });

  it('13. dependsOn 不能引用其他 session 的 question', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const b = newActiveSession(ctx, projectId);
    const { questionId } = newQuestion(ctx, projectId, a);

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.addQuestions',
          {
            projectId,
            sessionId: b.id,
            expectedVersion: b.version,
            questions: [
              { topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: [questionId] },
            ],
          },
          ctx,
        ),
      'GRILL_OWNERSHIP_CONFLICT',
    );
  });

  it('14. dependsOn 不能自引用', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.addQuestions',
          {
            projectId,
            sessionId: a.id,
            expectedVersion: a.version,
            questions: [
              { id: 'q1', topic: 't', text: 'x', rationale: '', dependsOnQuestionIds: ['q1'] },
            ],
          },
          ctx,
        ),
      'GRILL_VALIDATION_ERROR',
    );
  });

  it('15. createProposal version CAS 冲突回滚', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();
    const a = newActiveSession(ctx, projectId);
    const { questionId, session: a2 } = newQuestion(ctx, projectId, a);
    const { answerId, session: a3 } = newAnswer(ctx, projectId, a2, questionId);

    const versionBefore = getSessionVersion(ctx, projectId, a3.id);

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.createProposal',
          {
            projectId,
            sessionId: a3.id,
            expectedVersion: 99,
            basedOnAnswerIds: [answerId],
            key: 'k',
            proposedValueJson: '"v"',
            confidence: 0.5,
            rationale: '',
          },
          ctx,
        ),
      'GRILL_VERSION_CONFLICT',
    );

    // 版本不变，提案未创建
    expect(getSessionVersion(ctx, projectId, a3.id)).toBe(versionBefore);
    const proposals = dispatchGrillCommand(
      'grill.listProposals',
      { projectId, sessionId: a3.id },
      ctx,
    ) as unknown[];
    expect(proposals).toHaveLength(0);
  });
});

// ── grill.listQuestions 测试 ──────────────────────────────────────

describe('grill.listQuestions', () => {
  it('返回 session 下的所有问题', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();

    // 创建 session
    const session = dispatchGrillCommand(
      'grill.createSession',
      { projectId, goal: '测试目标' },
      ctx,
    ) as { id: string; version: number };

    // 启动 session
    const started = dispatchGrillCommand(
      'grill.startSession',
      { projectId, sessionId: session.id, expectedVersion: session.version },
      ctx,
    ) as { id: string; version: number };

    // 添加问题（使用启动后的 version）
    dispatchGrillCommand(
      'grill.addQuestions',
      {
        projectId,
        sessionId: session.id,
        expectedVersion: started.version,
        questions: [
          { topic: '主题A', text: '问题A', rationale: '理由A', dependsOnQuestionIds: [] },
          { topic: '主题B', text: '问题B', rationale: '理由B', dependsOnQuestionIds: [] },
        ],
      },
      ctx,
    );

    // 列出问题
    const listed = dispatchGrillCommand(
      'grill.listQuestions',
      { projectId, sessionId: session.id },
      ctx,
    ) as Array<{ id: string; topic: string; text: string; status: string }>;

    expect(listed).toHaveLength(2);
    expect(listed[0].topic).toBe('主题A');
    expect(listed[1].topic).toBe('主题B');
    expect(listed[0].status).toBe('PLANNED');
    expect(listed[0].text).toBe('问题A');
  });

  it('空 session 返回空数组', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();

    const session = dispatchGrillCommand(
      'grill.createSession',
      { projectId, goal: '测试目标' },
      ctx,
    ) as { id: string };

    const listed = dispatchGrillCommand(
      'grill.listQuestions',
      { projectId, sessionId: session.id },
      ctx,
    ) as unknown[];

    expect(listed).toHaveLength(0);
  });

  it('session 不存在时抛出 GRILL_SESSION_NOT_FOUND', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();

    expectErrorCode(
      () =>
        dispatchGrillCommand('grill.listQuestions', { projectId, sessionId: 'nonexistent' }, ctx),
      'GRILL_SESSION_NOT_FOUND',
    );
  });

  it('project 不存在时抛出 PROJECT_NOT_FOUND', () => {
    const ctx = createContext();

    expectErrorCode(
      () =>
        dispatchGrillCommand(
          'grill.listQuestions',
          { projectId: 'nonexistent', sessionId: 'sess-1' },
          ctx,
        ),
      'PROJECT_NOT_FOUND',
    );
  });

  it('DTO 不暴露内部 JSON 字符串', () => {
    const { projectId } = createProjectWithDb();
    const ctx = createContext();

    const session = dispatchGrillCommand(
      'grill.createSession',
      { projectId, goal: '测试目标' },
      ctx,
    ) as { id: string; version: number };

    const started = dispatchGrillCommand(
      'grill.startSession',
      { projectId, sessionId: session.id, expectedVersion: session.version },
      ctx,
    ) as { id: string; version: number };

    dispatchGrillCommand(
      'grill.addQuestions',
      {
        projectId,
        sessionId: session.id,
        expectedVersion: started.version,
        questions: [
          {
            topic: '主题',
            text: '问题',
            rationale: '理由',
            dependsOnQuestionIds: [],
          },
        ],
      },
      ctx,
    );

    const listed = dispatchGrillCommand(
      'grill.listQuestions',
      { projectId, sessionId: session.id },
      ctx,
    ) as Array<{ dependsOnQuestionIds: unknown }>;

    // dependsOnQuestionIds 应该是结构化数组，不是 JSON 字符串
    expect(Array.isArray(listed[0].dependsOnQuestionIds)).toBe(true);
    expect(typeof listed[0].dependsOnQuestionIds).not.toBe('string');
  });

  it('输入验证失败时抛出 GRILL_VALIDATION_ERROR', () => {
    const ctx = createContext();

    expectErrorCode(
      () => dispatchGrillCommand('grill.listQuestions', null, ctx),
      'GRILL_VALIDATION_ERROR',
    );

    expectErrorCode(
      () => dispatchGrillCommand('grill.listQuestions', {}, ctx),
      'GRILL_VALIDATION_ERROR',
    );

    expectErrorCode(
      () => dispatchGrillCommand('grill.listQuestions', { projectId: 'p' }, ctx),
      'GRILL_VALIDATION_ERROR',
    );
  });
});
