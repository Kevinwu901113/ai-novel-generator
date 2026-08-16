import { describe, it, expect } from 'vitest';
import {
  validateGoal,
  validateTopic,
  validateQuestionText,
  validateAnswer,
  validateProposalKey,
  validateProposalValueJson,
  validateConfidence,
  validateBasedOnAnswerIds,
  validateExpectedVersion,
} from './validation';

describe('validateGoal', () => {
  it('空字符串返回错误', () => {
    expect(validateGoal('')).toBe('会话目标不能为空');
    expect(validateGoal('   ')).toBe('会话目标不能为空');
  });

  it('有效目标返回 null', () => {
    expect(validateGoal('探索角色动机')).toBeNull();
  });
});

describe('validateTopic', () => {
  it('空字符串返回错误', () => {
    expect(validateTopic('')).toBe('问题主题不能为空');
    expect(validateTopic('   ')).toBe('问题主题不能为空');
  });

  it('有效主题返回 null', () => {
    expect(validateTopic('角色背景')).toBeNull();
  });
});

describe('validateQuestionText', () => {
  it('空字符串返回错误', () => {
    expect(validateQuestionText('')).toBe('问题内容不能为空');
    expect(validateQuestionText('   ')).toBe('问题内容不能为空');
  });

  it('有效内容返回 null', () => {
    expect(validateQuestionText('主角的童年经历是什么？')).toBeNull();
  });
});

describe('validateAnswer', () => {
  it('空字符串返回错误', () => {
    expect(validateAnswer('')).toBe('回答内容不能为空');
    expect(validateAnswer('   ')).toBe('回答内容不能为空');
  });

  it('有效回答返回 null', () => {
    expect(validateAnswer('主角在一个小镇长大')).toBeNull();
  });
});

describe('validateProposalKey', () => {
  it('空字符串返回错误', () => {
    expect(validateProposalKey('')).toBe('提案 key 不能为空');
    expect(validateProposalKey('   ')).toBe('提案 key 不能为空');
  });

  it('有效 key 返回 null', () => {
    expect(validateProposalKey('character.motivation')).toBeNull();
  });
});

describe('validateProposalValueJson', () => {
  it('空字符串返回错误', () => {
    expect(validateProposalValueJson('')).toBe('提案值不能为空');
    expect(validateProposalValueJson('   ')).toBe('提案值不能为空');
  });

  it('无效 JSON 返回错误', () => {
    expect(validateProposalValueJson('{invalid')).toBe('提案值必须是有效 JSON');
    expect(validateProposalValueJson('not json')).toBe('提案值必须是有效 JSON');
  });

  it('有效 JSON 返回 null', () => {
    expect(validateProposalValueJson('{"key": "value"}')).toBeNull();
    expect(validateProposalValueJson('"string"')).toBeNull();
    expect(validateProposalValueJson('42')).toBeNull();
    expect(validateProposalValueJson('null')).toBeNull();
  });
});

describe('validateConfidence', () => {
  it('NaN 返回错误', () => {
    expect(validateConfidence(NaN)).toBe('置信度不能为空');
  });

  it('超出范围返回错误', () => {
    expect(validateConfidence(-0.1)).toBe('置信度必须在 0 到 1 之间');
    expect(validateConfidence(1.1)).toBe('置信度必须在 0 到 1 之间');
  });

  it('有效值返回 null', () => {
    expect(validateConfidence(0)).toBeNull();
    expect(validateConfidence(0.5)).toBeNull();
    expect(validateConfidence(1)).toBeNull();
  });
});

describe('validateBasedOnAnswerIds', () => {
  it('空数组返回错误', () => {
    expect(validateBasedOnAnswerIds([])).toBe('至少需要选择一个回答');
  });

  it('只有空字符串返回错误', () => {
    expect(validateBasedOnAnswerIds(['', '  '])).toBe('至少需要选择一个回答');
  });

  it('有效数组返回 null', () => {
    expect(validateBasedOnAnswerIds(['id-1'])).toBeNull();
    expect(validateBasedOnAnswerIds(['id-1', 'id-2'])).toBeNull();
  });
});

describe('validateExpectedVersion', () => {
  it('非整数返回错误', () => {
    expect(validateExpectedVersion(1.5)).toBe('版本号必须为正整数');
    expect(validateExpectedVersion(NaN)).toBe('版本号必须为正整数');
  });

  it('非正数返回错误', () => {
    expect(validateExpectedVersion(0)).toBe('版本号必须为正整数');
    expect(validateExpectedVersion(-1)).toBe('版本号必须为正整数');
  });

  it('有效版本返回 null', () => {
    expect(validateExpectedVersion(1)).toBeNull();
    expect(validateExpectedVersion(42)).toBeNull();
  });
});
