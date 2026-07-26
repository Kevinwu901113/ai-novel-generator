import { describe, it, expect } from 'vitest';
import { createProjectId, createChangeSet, type ChangeEntry } from './index';

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
