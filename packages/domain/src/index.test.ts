import { describe, it, expect } from 'vitest';
import {
  createProjectId,
  createProviderProfileId,
  createProjectName,
  createInitialIdea,
  createChangeSet,
  unicodeCodePointLength,
  isValidTaskTransition,
  assertValidTaskTransition,
  isValidInvocationTransition,
  assertValidInvocationTransition,
  isTerminalTaskStatus,
  isTerminalInvocationStatus,
  type ChangeEntry,
} from './index';

describe('unicodeCodePointLength', () => {
  it('应该正确计算 ASCII 字符串长度', () => {
    expect(unicodeCodePointLength('hello')).toBe(5);
  });

  it('应该正确计算中文字符长度', () => {
    expect(unicodeCodePointLength('你好世界')).toBe(4);
  });

  it('应该正确计算 emoji 长度（每个 emoji 算 1）', () => {
    // 🎉 是 2 个 UTF-16 code unit 但 1 个 code point
    expect(unicodeCodePointLength('🎉')).toBe(1);
    expect(unicodeCodePointLength('🎉🎊🎈')).toBe(3);
  });

  it('应该正确计算混合字符串长度', () => {
    expect(unicodeCodePointLength('hello你好🎉')).toBe(8);
  });

  it('空字符串返回 0', () => {
    expect(unicodeCodePointLength('')).toBe(0);
  });

  it('应该正确计算扩展平面字符（如 𝌆）', () => {
    // 𝌆 是 U+1D306，2 个 UTF-16 code unit 但 1 个 code point
    expect(unicodeCodePointLength('𝌆')).toBe(1);
  });
});

describe('createProjectId', () => {
  it('应该从有效字符串创建 ProjectId', () => {
    const id = createProjectId('project-001');
    expect(id).toBe('project-001');
  });

  it('应该拒绝空字符串', () => {
    expect(() => createProjectId('')).toThrow('ProjectId 不能为空');
  });

  it('应该拒绝纯空白字符串', () => {
    expect(() => createProjectId('   ')).toThrow('ProjectId 不能为空');
  });

  it('应该保留原始字符串值', () => {
    const raw = 'test-project-123';
    const id = createProjectId(raw);
    expect(id).toBe(raw);
  });
});

describe('createChangeSet', () => {
  it('应该创建有效的 ChangeSet', () => {
    const changes: ChangeEntry[] = [{ field: 'title', oldValue: '旧标题', newValue: '新标题' }];
    const cs = createChangeSet(
      'fixed-id-001',
      'project',
      'proj-1',
      changes,
      '更新标题',
      '2024-01-01T00:00:00.000Z',
    );

    expect(cs.id).toBe('fixed-id-001');
    expect(cs.scope).toBe('project');
    expect(cs.targetId).toBe('proj-1');
    expect(cs.changes).toEqual(changes);
    expect(cs.reason).toBe('更新标题');
    expect(cs.createdAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('应该拒绝空 id', () => {
    expect(() =>
      createChangeSet('', 'project', 'proj-1', [], '原因', '2024-01-01T00:00:00.000Z'),
    ).toThrow('ChangeSet id 不能为空');
  });

  it('应该拒绝纯空白 id', () => {
    expect(() =>
      createChangeSet('   ', 'project', 'proj-1', [], '原因', '2024-01-01T00:00:00.000Z'),
    ).toThrow('ChangeSet id 不能为空');
  });

  it('应该接受调用方注入的 id 和时间戳', () => {
    const cs = createChangeSet(
      'custom-id',
      'chapter',
      'ch-1',
      [],
      '原因',
      '2025-06-15T12:00:00.000Z',
    );
    expect(cs.id).toBe('custom-id');
    expect(cs.createdAt).toBe('2025-06-15T12:00:00.000Z');
  });

  it('应该支持所有决策范围', () => {
    const scopes = ['project', 'chapter', 'scene', 'line'] as const;
    for (const scope of scopes) {
      const cs = createChangeSet(
        `id-${scope}`,
        scope,
        'target',
        [],
        '测试',
        '2024-01-01T00:00:00.000Z',
      );
      expect(cs.scope).toBe(scope);
    }
  });
});

describe('createProjectName', () => {
  it('应该从有效字符串创建 ProjectName', () => {
    const name = createProjectName('我的小说');
    expect(name).toBe('我的小说');
  });

  it('应该 trim 前后空白', () => {
    const name = createProjectName('  我的小说  ');
    expect(name).toBe('我的小说');
  });

  it('应该拒绝空字符串', () => {
    expect(() => createProjectName('')).toThrow('项目名称不能为空');
  });

  it('应该拒绝纯空白字符串', () => {
    expect(() => createProjectName('   ')).toThrow('项目名称不能为空');
  });

  it('应该接受 100 个 Unicode code point 的名称', () => {
    const name100 = '你'.repeat(100);
    const name = createProjectName(name100);
    expect(unicodeCodePointLength(name)).toBe(100);
  });

  it('应该拒绝 101 个 Unicode code point 的名称', () => {
    const name101 = '你'.repeat(101);
    expect(() => createProjectName(name101)).toThrow(/不能超过 100/);
  });

  it('应该正确计算 emoji 名称长度', () => {
    const emojiName = '🎉'.repeat(100);
    const name = createProjectName(emojiName);
    expect(unicodeCodePointLength(name)).toBe(100);
  });

  it('应该拒绝超过 100 个 emoji 的名称', () => {
    const emojiName = '🎉'.repeat(101);
    expect(() => createProjectName(emojiName)).toThrow(/不能超过 100/);
  });
});

describe('createInitialIdea', () => {
  it('应该从有效字符串创建 InitialIdea', () => {
    const idea = createInitialIdea('我想写一个科幻故事');
    expect(idea).toBe('我想写一个科幻故事');
  });

  it('应该 trim 前后空白', () => {
    const idea = createInitialIdea('  我想写一个科幻故事  ');
    expect(idea).toBe('我想写一个科幻故事');
  });

  it('应该拒绝空字符串', () => {
    expect(() => createInitialIdea('')).toThrow('初始想法不能为空');
  });

  it('应该拒绝纯空白字符串', () => {
    expect(() => createInitialIdea('   ')).toThrow('初始想法不能为空');
  });

  it('应该接受 20000 个 Unicode code point 的想法', () => {
    const idea20k = '你'.repeat(20_000);
    const idea = createInitialIdea(idea20k);
    expect(unicodeCodePointLength(idea)).toBe(20_000);
  });

  it('应该拒绝 20001 个 Unicode code point 的想法', () => {
    const idea20k1 = '你'.repeat(20_001);
    expect(() => createInitialIdea(idea20k1)).toThrow(/不能超过 20000/);
  });

  it('应该正确计算 emoji 想法长度', () => {
    const emojiIdea = '🎉'.repeat(20_000);
    const idea = createInitialIdea(emojiIdea);
    expect(unicodeCodePointLength(idea)).toBe(20_000);
  });
});

describe('createProviderProfileId', () => {
  it('应该从有效字符串创建 ProviderProfileId', () => {
    const id = createProviderProfileId('mimo-token-plan-cn');
    expect(id).toBe('mimo-token-plan-cn');
  });

  it('应该拒绝空字符串', () => {
    expect(() => createProviderProfileId('')).toThrow('ProviderProfileId 不能为空');
  });

  it('应该拒绝纯空白字符串', () => {
    expect(() => createProviderProfileId('   ')).toThrow('ProviderProfileId 不能为空');
  });

  it('应该保留原始字符串值', () => {
    const raw = 'test-provider-123';
    const id = createProviderProfileId(raw);
    expect(id).toBe(raw);
  });
});

// ── 任务状态转换 ─────────────────────────────────────────────────

describe('isValidTaskTransition', () => {
  it.each([
    ['PENDING', 'RUNNING'],
    ['PENDING', 'CANCELLED'],
    ['PENDING', 'STALE'],
    ['RUNNING', 'SUCCEEDED'],
    ['RUNNING', 'FAILED'],
    ['RUNNING', 'CANCELLED'],
    ['RUNNING', 'STALE'],
    ['FAILED', 'PENDING'],
    ['CANCELLED', 'PENDING'],
    ['STALE', 'PENDING'],
  ] as const)('应该允许 %s -> %s', (from, to) => {
    expect(isValidTaskTransition(from, to)).toBe(true);
  });

  it.each([
    ['SUCCEEDED', 'RUNNING'],
    ['SUCCEEDED', 'FAILED'],
    ['FAILED', 'SUCCEEDED'],
    ['CANCELLED', 'SUCCEEDED'],
    ['STALE', 'SUCCEEDED'],
    ['SUCCEEDED', 'PENDING'],
    ['SUCCEEDED', 'CANCELLED'],
    ['SUCCEEDED', 'STALE'],
  ] as const)('应该禁止 %s -> %s', (from, to) => {
    expect(isValidTaskTransition(from, to)).toBe(false);
  });
});

describe('assertValidTaskTransition', () => {
  it('应该允许合法转换', () => {
    expect(() => assertValidTaskTransition('PENDING', 'RUNNING')).not.toThrow();
  });

  it('应该拒绝非法转换', () => {
    expect(() => assertValidTaskTransition('SUCCEEDED', 'RUNNING')).toThrow(
      '非法任务状态转换: SUCCEEDED -> RUNNING',
    );
  });

  it('应该拒绝 SUCCEEDED -> FAILED', () => {
    expect(() => assertValidTaskTransition('SUCCEEDED', 'FAILED')).toThrow();
  });

  it('应该拒绝 FAILED -> SUCCEEDED', () => {
    expect(() => assertValidTaskTransition('FAILED', 'SUCCEEDED')).toThrow();
  });
});

describe('isTerminalTaskStatus', () => {
  it('SUCCEEDED 是终态', () => {
    expect(isTerminalTaskStatus('SUCCEEDED')).toBe(true);
  });

  it('FAILED 是终态', () => {
    expect(isTerminalTaskStatus('FAILED')).toBe(true);
  });

  it('CANCELLED 是终态', () => {
    expect(isTerminalTaskStatus('CANCELLED')).toBe(true);
  });

  it('PENDING 不是终态', () => {
    expect(isTerminalTaskStatus('PENDING')).toBe(false);
  });

  it('RUNNING 不是终态', () => {
    expect(isTerminalTaskStatus('RUNNING')).toBe(false);
  });

  it('STALE 不是终态', () => {
    expect(isTerminalTaskStatus('STALE')).toBe(false);
  });
});

// ── 模型调用状态转换 ─────────────────────────────────────────────

describe('isValidInvocationTransition', () => {
  it.each([
    ['PENDING', 'RUNNING'],
    ['PENDING', 'CANCELLED'],
    ['RUNNING', 'SUCCEEDED'],
    ['RUNNING', 'FAILED'],
    ['RUNNING', 'CANCELLED'],
  ] as const)('应该允许 %s -> %s', (from, to) => {
    expect(isValidInvocationTransition(from, to)).toBe(true);
  });

  it.each([
    ['SUCCEEDED', 'RUNNING'],
    ['SUCCEEDED', 'FAILED'],
    ['FAILED', 'SUCCEEDED'],
    ['FAILED', 'RUNNING'],
    ['CANCELLED', 'SUCCEEDED'],
    ['CANCELLED', 'RUNNING'],
    ['PENDING', 'SUCCEEDED'],
    ['PENDING', 'FAILED'],
  ] as const)('应该禁止 %s -> %s', (from, to) => {
    expect(isValidInvocationTransition(from, to)).toBe(false);
  });
});

describe('assertValidInvocationTransition', () => {
  it('应该允许合法转换', () => {
    expect(() => assertValidInvocationTransition('PENDING', 'RUNNING')).not.toThrow();
  });

  it('应该拒绝非法转换', () => {
    expect(() => assertValidInvocationTransition('SUCCEEDED', 'RUNNING')).toThrow(
      '非法调用状态转换: SUCCEEDED -> RUNNING',
    );
  });
});

describe('isTerminalInvocationStatus', () => {
  it('SUCCEEDED 是终态', () => {
    expect(isTerminalInvocationStatus('SUCCEEDED')).toBe(true);
  });

  it('FAILED 是终态', () => {
    expect(isTerminalInvocationStatus('FAILED')).toBe(true);
  });

  it('CANCELLED 是终态', () => {
    expect(isTerminalInvocationStatus('CANCELLED')).toBe(true);
  });

  it('PENDING 不是终态', () => {
    expect(isTerminalInvocationStatus('PENDING')).toBe(false);
  });

  it('RUNNING 不是终态', () => {
    expect(isTerminalInvocationStatus('RUNNING')).toBe(false);
  });
});
