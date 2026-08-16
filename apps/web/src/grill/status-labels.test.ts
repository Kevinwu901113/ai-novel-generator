import { describe, it, expect } from 'vitest';
import {
  sessionStatusLabel,
  questionStatusLabel,
  proposalStatusLabel,
  isTerminalSession,
  isPausedSession,
  isQuestionAnswerable,
  isQuestionSkippable,
  isQuestionSupersedable,
  isProposalReviewable,
  grillErrorMessage,
} from './status-labels';

describe('sessionStatusLabel', () => {
  it('返回已知状态的中文标签', () => {
    expect(sessionStatusLabel('DRAFT')).toBe('草稿');
    expect(sessionStatusLabel('ACTIVE')).toBe('进行中');
    expect(sessionStatusLabel('PAUSED')).toBe('已暂停');
    expect(sessionStatusLabel('COMPLETED')).toBe('已完成');
    expect(sessionStatusLabel('ABANDONED')).toBe('已放弃');
  });

  it('未知状态返回原值', () => {
    expect(sessionStatusLabel('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('questionStatusLabel', () => {
  it('返回已知状态的中文标签', () => {
    expect(questionStatusLabel('PLANNED')).toBe('待提问');
    expect(questionStatusLabel('ASKED')).toBe('已提问');
    expect(questionStatusLabel('ANSWERED')).toBe('已回答');
    expect(questionStatusLabel('SKIPPED')).toBe('已跳过');
    expect(questionStatusLabel('SUPERSEDED')).toBe('已废弃');
  });
});

describe('proposalStatusLabel', () => {
  it('返回已知状态的中文标签', () => {
    expect(proposalStatusLabel('PROPOSED')).toBe('待审核');
    expect(proposalStatusLabel('ACCEPTED')).toBe('已接受');
    expect(proposalStatusLabel('REJECTED')).toBe('已拒绝');
    expect(proposalStatusLabel('SUPERSEDED')).toBe('已废弃');
  });
});

describe('isTerminalSession', () => {
  it('终态返回 true', () => {
    expect(isTerminalSession('COMPLETED')).toBe(true);
    expect(isTerminalSession('ABANDONED')).toBe(true);
  });

  it('非终态返回 false', () => {
    expect(isTerminalSession('DRAFT')).toBe(false);
    expect(isTerminalSession('ACTIVE')).toBe(false);
    expect(isTerminalSession('PAUSED')).toBe(false);
  });
});

describe('isPausedSession', () => {
  it('PAUSED 返回 true', () => {
    expect(isPausedSession('PAUSED')).toBe(true);
  });

  it('其他状态返回 false', () => {
    expect(isPausedSession('ACTIVE')).toBe(false);
    expect(isPausedSession('DRAFT')).toBe(false);
  });
});

describe('isQuestionAnswerable', () => {
  it('可回答状态返回 true', () => {
    expect(isQuestionAnswerable('PLANNED')).toBe(true);
    expect(isQuestionAnswerable('ASKED')).toBe(true);
    expect(isQuestionAnswerable('ANSWERED')).toBe(true);
  });

  it('不可回答状态返回 false', () => {
    expect(isQuestionAnswerable('SKIPPED')).toBe(false);
    expect(isQuestionAnswerable('SUPERSEDED')).toBe(false);
  });
});

describe('isQuestionSkippable', () => {
  it('可跳过状态返回 true', () => {
    expect(isQuestionSkippable('PLANNED')).toBe(true);
    expect(isQuestionSkippable('ASKED')).toBe(true);
  });

  it('不可跳过状态返回 false', () => {
    expect(isQuestionSkippable('ANSWERED')).toBe(false);
    expect(isQuestionSkippable('SKIPPED')).toBe(false);
    expect(isQuestionSkippable('SUPERSEDED')).toBe(false);
  });
});

describe('isQuestionSupersedable', () => {
  it('可废弃状态返回 true', () => {
    expect(isQuestionSupersedable('PLANNED')).toBe(true);
    expect(isQuestionSupersedable('ASKED')).toBe(true);
    expect(isQuestionSupersedable('ANSWERED')).toBe(true);
  });

  it('不可废弃状态返回 false', () => {
    expect(isQuestionSupersedable('SKIPPED')).toBe(false);
    expect(isQuestionSupersedable('SUPERSEDED')).toBe(false);
  });
});

describe('isProposalReviewable', () => {
  it('PROPOSED 返回 true', () => {
    expect(isProposalReviewable('PROPOSED')).toBe(true);
  });

  it('已审核状态返回 false', () => {
    expect(isProposalReviewable('ACCEPTED')).toBe(false);
    expect(isProposalReviewable('REJECTED')).toBe(false);
    expect(isProposalReviewable('SUPERSEDED')).toBe(false);
  });
});

describe('grillErrorMessage', () => {
  it('已知错误码返回中文消息', () => {
    expect(grillErrorMessage('GRILL_VERSION_CONFLICT', '默认')).toBe('会话已在其他操作中更新');
    expect(grillErrorMessage('GRILL_SESSION_NOT_FOUND', '默认')).toBe('会话不存在');
    expect(grillErrorMessage('GRILL_OWNERSHIP_CONFLICT', '默认')).toBe('资源不属于当前会话');
  });

  it('未知错误码返回 fallback', () => {
    expect(grillErrorMessage('UNKNOWN_CODE', '默认消息')).toBe('默认消息');
  });

  it('undefined 错误码返回 fallback', () => {
    expect(grillErrorMessage(undefined, '默认消息')).toBe('默认消息');
  });
});
