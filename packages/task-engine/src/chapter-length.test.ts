import { describe, expect, it } from 'vitest';
import { validateCreationContractSections } from '@ai-novel/domain';
import {
  inferChapterLengthFromStructure,
  inferPerChapterTargetCharacters,
  resolveChapterLengthRequirement,
} from './chapter-length.js';

const BASE = validateCreationContractSections({
  premise: '测试故事',
  genre: ['悬疑'],
  tone: ['冷硬'],
  targetAudience: '成年读者',
  narrativePov: 'THIRD_LIMITED',
  tense: 'PAST',
  protagonist: { characterKey: 'lead', name: '主角' },
});

describe('单章篇幅解析', () => {
  it('优先使用结构化 chapterLength，并保留用户明确范围', () => {
    const spec = validateCreationContractSections({
      ...BASE,
      targetLength: { unit: 'chapters', value: 1 },
      chapterLength: {
        targetCharacters: 15_000,
        minimumCharacters: 14_000,
        maximumCharacters: 16_000,
      },
    });
    expect(inferPerChapterTargetCharacters(spec)).toBe(15_000);
    expect(resolveChapterLengthRequirement(spec)).toEqual({
      targetCharacters: 15_000,
      minimumCharacters: 14_000,
      maximumCharacters: 16_000,
    });
  });

  it.each([
    ['每章约3000字', 3000],
    ['单章三千字左右', 3000],
    ['仅有一章，一章正文一万五千字', 15_000],
    ['单章1.5万字', 15_000],
    ['每章一万五字', 15_000],
  ])('兼容旧 structure：%s', (structure, expected) => {
    expect(inferChapterLengthFromStructure(structure)?.targetCharacters).toBe(expected);
  });

  it('识别显式区间，不把全书总字数误当单章字数', () => {
    expect(inferChapterLengthFromStructure('短篇，每章12000到15000字')).toEqual({
      targetCharacters: 13_500,
      minimumCharacters: 12_000,
      maximumCharacters: 15_000,
    });
    expect(inferChapterLengthFromStructure('全书约15万字，共50章')).toBeNull();
  });

  it('只有目标时沿用统一容差', () => {
    expect(
      resolveChapterLengthRequirement({
        ...BASE,
        chapterLength: { targetCharacters: 15_000 },
      }),
    ).toEqual({
      targetCharacters: 15_000,
      minimumCharacters: 13_500,
      maximumCharacters: 16_500,
    });
  });
});
