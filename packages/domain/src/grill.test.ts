import { describe, it, expect } from 'vitest';
import {
  isValidSessionTransition,
  assertValidSessionTransition,
  isTerminalSessionStatus,
  isValidQuestionTransition,
  assertValidQuestionTransition,
  isTerminalQuestionStatus,
  isValidProposalTransition,
  assertValidProposalTransition,
  isTerminalProposalStatus,
  createGrillSessionId,
  createGrillQuestionId,
  createGrillAnswerId,
  createGrillProposalId,
  type GrillSessionStatus,
  type GrillQuestionStatus,
  type GrillProposalStatus,
} from './grill.js';

// ── 会话状态转换 ──────────────────────────────────────────────────

describe('isValidSessionTransition', () => {
  const allowed: Array<[GrillSessionStatus, GrillSessionStatus]> = [
    ['DRAFT', 'ACTIVE'],
    ['DRAFT', 'ABANDONED'],
    ['ACTIVE', 'PAUSED'],
    ['ACTIVE', 'COMPLETED'],
    ['ACTIVE', 'ABANDONED'],
    ['PAUSED', 'ACTIVE'],
    ['PAUSED', 'ABANDONED'],
  ];

  it.each(allowed)('%s -> %s 应该合法', (from, to) => {
    expect(isValidSessionTransition(from, to)).toBe(true);
  });

  const forbidden: Array<[GrillSessionStatus, GrillSessionStatus]> = [
    ['DRAFT', 'PAUSED'],
    ['DRAFT', 'COMPLETED'],
    ['DRAFT', 'DRAFT'],
    ['ACTIVE', 'DRAFT'],
    ['ACTIVE', 'ACTIVE'],
    ['PAUSED', 'PAUSED'],
    ['PAUSED', 'COMPLETED'],
    ['COMPLETED', 'ACTIVE'],
    ['COMPLETED', 'PAUSED'],
    ['COMPLETED', 'ABANDONED'],
    ['COMPLETED', 'COMPLETED'],
    ['ABANDONED', 'ACTIVE'],
    ['ABANDONED', 'PAUSED'],
    ['ABANDONED', 'COMPLETED'],
    ['ABANDONED', 'ABANDONED'],
  ];

  it.each(forbidden)('%s -> %s 应该非法', (from, to) => {
    expect(isValidSessionTransition(from, to)).toBe(false);
  });
});

describe('assertValidSessionTransition', () => {
  it('合法转换不抛出', () => {
    expect(() => assertValidSessionTransition('DRAFT', 'ACTIVE')).not.toThrow();
  });

  it('非法转换抛出明确错误', () => {
    expect(() => assertValidSessionTransition('COMPLETED', 'ACTIVE')).toThrow(
      '非法烧烤会话状态转换: COMPLETED -> ACTIVE',
    );
  });
});

describe('isTerminalSessionStatus', () => {
  it('COMPLETED 和 ABANDONED 是终态', () => {
    expect(isTerminalSessionStatus('COMPLETED')).toBe(true);
    expect(isTerminalSessionStatus('ABANDONED')).toBe(true);
  });

  it('DRAFT、ACTIVE、PAUSED 不是终态', () => {
    expect(isTerminalSessionStatus('DRAFT')).toBe(false);
    expect(isTerminalSessionStatus('ACTIVE')).toBe(false);
    expect(isTerminalSessionStatus('PAUSED')).toBe(false);
  });
});

// ── 问题状态转换 ──────────────────────────────────────────────────

describe('isValidQuestionTransition', () => {
  const allowed: Array<[GrillQuestionStatus, GrillQuestionStatus]> = [
    ['PLANNED', 'ASKED'],
    ['PLANNED', 'SKIPPED'],
    ['PLANNED', 'SUPERSEDED'],
    ['ASKED', 'ANSWERED'],
    ['ASKED', 'SKIPPED'],
    ['ASKED', 'SUPERSEDED'],
    ['ANSWERED', 'SUPERSEDED'],
  ];

  it.each(allowed)('%s -> %s 应该合法', (from, to) => {
    expect(isValidQuestionTransition(from, to)).toBe(true);
  });

  const forbidden: Array<[GrillQuestionStatus, GrillQuestionStatus]> = [
    ['PLANNED', 'ANSWERED'],
    ['PLANNED', 'PLANNED'],
    ['ASKED', 'PLANNED'],
    ['ASKED', 'ASKED'],
    ['ANSWERED', 'ASKED'],
    ['ANSWERED', 'ANSWERED'],
    ['ANSWERED', 'SKIPPED'],
    ['SKIPPED', 'ASKED'],
    ['SKIPPED', 'ANSWERED'],
    ['SKIPPED', 'SUPERSEDED'],
    ['SUPERSEDED', 'ASKED'],
    ['SUPERSEDED', 'ANSWERED'],
    ['SUPERSEDED', 'SKIPPED'],
  ];

  it.each(forbidden)('%s -> %s 应该非法', (from, to) => {
    expect(isValidQuestionTransition(from, to)).toBe(false);
  });
});

describe('assertValidQuestionTransition', () => {
  it('合法转换不抛出', () => {
    expect(() => assertValidQuestionTransition('PLANNED', 'ASKED')).not.toThrow();
  });

  it('非法转换抛出明确错误', () => {
    expect(() => assertValidQuestionTransition('SKIPPED', 'ASKED')).toThrow(
      '非法烧烤问题状态转换: SKIPPED -> ASKED',
    );
  });
});

describe('isTerminalQuestionStatus', () => {
  it('SKIPPED 和 SUPERSEDED 是终态', () => {
    expect(isTerminalQuestionStatus('SKIPPED')).toBe(true);
    expect(isTerminalQuestionStatus('SUPERSEDED')).toBe(true);
  });

  it('PLANNED、ASKED、ANSWERED 不是终态', () => {
    expect(isTerminalQuestionStatus('PLANNED')).toBe(false);
    expect(isTerminalQuestionStatus('ASKED')).toBe(false);
    expect(isTerminalQuestionStatus('ANSWERED')).toBe(false);
  });
});

// ── 提案状态转换 ──────────────────────────────────────────────────

describe('isValidProposalTransition', () => {
  const allowed: Array<[GrillProposalStatus, GrillProposalStatus]> = [
    ['PROPOSED', 'ACCEPTED'],
    ['PROPOSED', 'REJECTED'],
    ['PROPOSED', 'SUPERSEDED'],
  ];

  it.each(allowed)('%s -> %s 应该合法', (from, to) => {
    expect(isValidProposalTransition(from, to)).toBe(true);
  });

  const forbidden: Array<[GrillProposalStatus, GrillProposalStatus]> = [
    ['PROPOSED', 'PROPOSED'],
    ['ACCEPTED', 'PROPOSED'],
    ['ACCEPTED', 'REJECTED'],
    ['ACCEPTED', 'SUPERSEDED'],
    ['REJECTED', 'PROPOSED'],
    ['REJECTED', 'ACCEPTED'],
    ['REJECTED', 'SUPERSEDED'],
    ['SUPERSEDED', 'PROPOSED'],
    ['SUPERSEDED', 'ACCEPTED'],
    ['SUPERSEDED', 'REJECTED'],
  ];

  it.each(forbidden)('%s -> %s 应该非法', (from, to) => {
    expect(isValidProposalTransition(from, to)).toBe(false);
  });
});

describe('assertValidProposalTransition', () => {
  it('合法转换不抛出', () => {
    expect(() => assertValidProposalTransition('PROPOSED', 'ACCEPTED')).not.toThrow();
  });

  it('非法转换抛出明确错误', () => {
    expect(() => assertValidProposalTransition('ACCEPTED', 'REJECTED')).toThrow(
      '非法推理提案状态转换: ACCEPTED -> REJECTED',
    );
  });
});

describe('isTerminalProposalStatus', () => {
  it('ACCEPTED、REJECTED、SUPERSEDED 是终态', () => {
    expect(isTerminalProposalStatus('ACCEPTED')).toBe(true);
    expect(isTerminalProposalStatus('REJECTED')).toBe(true);
    expect(isTerminalProposalStatus('SUPERSEDED')).toBe(true);
  });

  it('PROPOSED 不是终态', () => {
    expect(isTerminalProposalStatus('PROPOSED')).toBe(false);
  });
});

// ── 品牌类型工厂 ──────────────────────────────────────────────────

describe('createGrillSessionId', () => {
  it('有效 ID 通过', () => {
    expect(createGrillSessionId('session-1')).toBe('session-1');
  });

  it('空字符串拒绝', () => {
    expect(() => createGrillSessionId('')).toThrow('GrillSessionId 不能为空');
  });

  it('纯空白拒绝', () => {
    expect(() => createGrillSessionId('   ')).toThrow('GrillSessionId 不能为空');
  });
});

describe('createGrillQuestionId', () => {
  it('有效 ID 通过', () => {
    expect(createGrillQuestionId('q-1')).toBe('q-1');
  });

  it('空字符串拒绝', () => {
    expect(() => createGrillQuestionId('')).toThrow('GrillQuestionId 不能为空');
  });
});

describe('createGrillAnswerId', () => {
  it('有效 ID 通过', () => {
    expect(createGrillAnswerId('a-1')).toBe('a-1');
  });

  it('空字符串拒绝', () => {
    expect(() => createGrillAnswerId('')).toThrow('GrillAnswerId 不能为空');
  });
});

describe('createGrillProposalId', () => {
  it('有效 ID 通过', () => {
    expect(createGrillProposalId('p-1')).toBe('p-1');
  });

  it('空字符串拒绝', () => {
    expect(() => createGrillProposalId('')).toThrow('GrillProposalId 不能为空');
  });
});
