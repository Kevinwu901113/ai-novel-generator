/**
 * contract-labels 纯工具单元测试。
 */

import { describe, it, expect } from 'vitest';
import {
  labelFor,
  SECTION_LABELS,
  NARRATIVE_POV_LABELS,
  TENSE_LABELS,
  PROPOSAL_STATUS_LABELS,
  CONTRACT_VERSION_CREATED_BY_LABELS,
  PROVENANCE_SOURCE_LABELS,
  formatTargetLength,
  formatChapterLength,
  formatShortId,
  formatContractTime,
  isLockedFieldPath,
} from './contract-labels';

describe('SECTION_LABELS', () => {
  it('覆盖所有顶层 section', () => {
    const expected = [
      'premise',
      'genre',
      'tone',
      'themes',
      'targetAudience',
      'narrativePov',
      'tense',
      'targetLength',
      'chapterLength',
      'structure',
      'protagonist',
      'supportingCharacters',
      'relationships',
      'worldRules',
      'mustInclude',
      'mustAvoid',
      'contentBoundaries',
      'unresolvedQuestions',
    ];
    for (const key of expected) {
      expect(SECTION_LABELS[key]).toBeDefined();
    }
  });
});

describe('labelFor', () => {
  it('已知 key 返回中文标签', () => {
    expect(labelFor(SECTION_LABELS, 'premise')).toBe('前提');
    expect(labelFor(NARRATIVE_POV_LABELS, 'FIRST')).toBe('第一人称');
  });

  it('未知 key 回退为原始 key', () => {
    expect(labelFor(SECTION_LABELS, 'unknown_section')).toBe('unknown_section');
    expect(labelFor(NARRATIVE_POV_LABELS, 'UNKNOWN_POV')).toBe('UNKNOWN_POV');
  });
});

describe('NARRATIVE_POV_LABELS / TENSE_LABELS', () => {
  it('视角标签', () => {
    expect(labelFor(NARRATIVE_POV_LABELS, 'THIRD_LIMITED')).toBe('第三人称有限视角');
    expect(labelFor(NARRATIVE_POV_LABELS, 'THIRD_OMNISCIENT')).toBe('第三人称全知视角');
    expect(labelFor(NARRATIVE_POV_LABELS, 'SECOND')).toBe('第二人称');
    expect(labelFor(NARRATIVE_POV_LABELS, 'OTHER')).toBe('其他');
  });

  it('时态标签', () => {
    expect(labelFor(TENSE_LABELS, 'PAST')).toBe('过去时');
    expect(labelFor(TENSE_LABELS, 'PRESENT')).toBe('现在时');
    expect(labelFor(TENSE_LABELS, 'MIXED')).toBe('混合时态');
  });
});

describe('PROPOSAL_STATUS_LABELS', () => {
  it('提案状态标签', () => {
    expect(labelFor(PROPOSAL_STATUS_LABELS, 'PROPOSED')).toBe('待审核');
    expect(labelFor(PROPOSAL_STATUS_LABELS, 'ACCEPTED')).toBe('已接受');
    expect(labelFor(PROPOSAL_STATUS_LABELS, 'REJECTED')).toBe('已拒绝');
  });
});

describe('CONTRACT_VERSION_CREATED_BY_LABELS', () => {
  it('创建来源标签', () => {
    expect(labelFor(CONTRACT_VERSION_CREATED_BY_LABELS, 'user')).toBe('用户创建');
    expect(labelFor(CONTRACT_VERSION_CREATED_BY_LABELS, 'ai-proposal-accepted')).toBe(
      '由 AI 提案接受',
    );
    expect(labelFor(CONTRACT_VERSION_CREATED_BY_LABELS, 'lock')).toBe('锁定操作');
  });
});

describe('PROVENANCE_SOURCE_LABELS', () => {
  it('字段来源标签', () => {
    expect(labelFor(PROVENANCE_SOURCE_LABELS, 'GRILL_ANSWER')).toBe('Grill 回答');
    expect(labelFor(PROVENANCE_SOURCE_LABELS, 'AI_PROPOSAL')).toBe('AI 提案');
    expect(labelFor(PROVENANCE_SOURCE_LABELS, 'USER_EDIT')).toBe('用户修改');
    expect(labelFor(PROVENANCE_SOURCE_LABELS, 'PREVIOUS_VERSION')).toBe('继承自上一版本');
    expect(labelFor(PROVENANCE_SOURCE_LABELS, 'DEFAULT')).toBe('默认');
  });
});

describe('formatTargetLength', () => {
  it('words 单位', () => {
    expect(formatTargetLength({ unit: 'words', value: 80000 })).toBe('约 80,000 字');
  });

  it('chapters 单位', () => {
    expect(formatTargetLength({ unit: 'chapters', value: 20 })).toBe('约 20 章');
  });

  it('未知单位回退为原始单位', () => {
    expect(formatTargetLength({ unit: 'unknown', value: 5 })).toBe('约 5 unknown');
  });
});

describe('formatChapterLength', () => {
  it('格式化单章目标和显式范围', () => {
    expect(formatChapterLength({ targetCharacters: 15000 })).toBe('约 15,000 字');
    expect(
      formatChapterLength({
        targetCharacters: 13500,
        minimumCharacters: 12000,
        maximumCharacters: 15000,
      }),
    ).toBe('12,000–15,000 字（目标 13,500）');
  });
});

describe('formatShortId', () => {
  it('短 ID 原样返回', () => {
    expect(formatShortId('abc')).toBe('abc');
    expect(formatShortId('12345678')).toBe('12345678');
  });

  it('长 ID 截断为前 8 字符', () => {
    expect(formatShortId('1234567890')).toBe('12345678…');
  });
});

describe('formatContractTime', () => {
  it('null 返回占位符', () => {
    expect(formatContractTime(null)).toBe('—');
    expect(formatContractTime(undefined)).toBe('—');
  });

  it('ISO 时间格式化为非空字符串', () => {
    const result = formatContractTime('2024-01-01T00:00:00Z');
    expect(result).not.toBe('—');
    expect(result).toContain('2024');
  });
});

describe('isLockedFieldPath', () => {
  it('完全相等命中', () => {
    expect(isLockedFieldPath('/premise', ['/premise'])).toBe(true);
  });

  it('祖先路径命中（锁定父路径标记所有子字段）', () => {
    expect(isLockedFieldPath('/protagonist/name', ['/protagonist'])).toBe(true);
  });

  it('子路径命中（锁定子字段标记父路径）', () => {
    expect(isLockedFieldPath('/protagonist', ['/protagonist/name'])).toBe(true);
  });

  it('无关路径不命中', () => {
    expect(isLockedFieldPath('/premise', ['/genre'])).toBe(false);
    expect(isLockedFieldPath('/protagonist/name', ['/supportingCharacters/x/name'])).toBe(false);
  });

  it('空锁定列表不命中', () => {
    expect(isLockedFieldPath('/premise', [])).toBe(false);
  });
});
