import type { ChapterLength, CreationContractSections } from '@ai-novel/domain';

export const MIN_PER_CHAPTER_TARGET = 500;
export const MAX_PER_CHAPTER_TARGET = 40_000;
const MIN_TARGET_PERCENT = 90;
const MAX_TARGET_PERCENT = 110;
export const MIN_TARGET_RATIO = MIN_TARGET_PERCENT / 100;
export const MAX_TARGET_RATIO = MAX_TARGET_PERCENT / 100;

export interface ChapterLengthRequirement {
  readonly targetCharacters: number;
  readonly minimumCharacters: number;
  readonly maximumCharacters: number;
}

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function parseChineseInteger(raw: string): number | null {
  const colloquialWan = /^([一二两三四五六七八九])万([一二两三四五六七八九])$/.exec(raw);
  if (colloquialWan) {
    return CHINESE_DIGITS[colloquialWan[1]!]! * 10_000 + CHINESE_DIGITS[colloquialWan[2]!]! * 1000;
  }

  let total = 0;
  let section = 0;
  let digit = 0;
  let saw = false;
  for (const char of raw) {
    const value = CHINESE_DIGITS[char];
    if (value !== undefined) {
      digit = value;
      saw = true;
      continue;
    }
    const unit = char === '十' ? 10 : char === '百' ? 100 : char === '千' ? 1000 : 0;
    if (unit > 0) {
      section += (digit || 1) * unit;
      digit = 0;
      saw = true;
      continue;
    }
    if (char === '万') {
      total += (section + digit || 1) * 10_000;
      section = 0;
      digit = 0;
      saw = true;
      continue;
    }
    return null;
  }
  return saw ? total + section + digit : null;
}

function parseLengthToken(raw: string): number | null {
  const token = raw
    .normalize('NFKC')
    .replace(/[，,\s]/g, '')
    .toLowerCase();
  const arabic = /^(\d+(?:\.\d+)?)(万|千|k)?$/.exec(token);
  let value: number | null = null;
  if (arabic) {
    const multiplier =
      arabic[2] === '万' ? 10_000 : arabic[2] === '千' || arabic[2] === 'k' ? 1000 : 1;
    value = Math.round(Number(arabic[1]) * multiplier);
  } else if (/^[零〇一二两三四五六七八九十百千万]+$/.test(token)) {
    value = parseChineseInteger(token);
  }
  return value !== null &&
    Number.isSafeInteger(value) &&
    value >= MIN_PER_CHAPTER_TARGET &&
    value <= MAX_PER_CHAPTER_TARGET
    ? value
    : null;
}

const LENGTH_TOKEN = '(?:\\d+(?:\\.\\d+)?\\s*(?:万|千|[kK])?|[零〇一二两三四五六七八九十百千万]+)';

/** 从旧版 structure 自由文本中兼容提取单章目标；新数据应使用 sections.chapterLength。 */
export function inferChapterLengthFromStructure(
  structure: string | undefined,
): ChapterLength | null {
  if (!structure) return null;
  const normalized = structure.normalize('NFKC').replace(/[，,]/g, '');
  const scoped = /(?:每一章|每章|单章|一章(?:正文)?)([^。；;\n]{0,48})/g;
  for (const match of normalized.matchAll(scoped)) {
    const tail = match[1] ?? '';
    const range = new RegExp(
      `(${LENGTH_TOKEN})\\s*(?:到|至|[-—~～])\\s*(${LENGTH_TOKEN})\\s*(?:字|字符)`,
    ).exec(tail);
    if (range) {
      const first = parseLengthToken(range[1]!);
      const second = parseLengthToken(range[2]!);
      if (first !== null && second !== null) {
        const minimumCharacters = Math.min(first, second);
        const maximumCharacters = Math.max(first, second);
        return {
          targetCharacters: Math.round((minimumCharacters + maximumCharacters) / 2),
          minimumCharacters,
          maximumCharacters,
        };
      }
    }
    const single = new RegExp(`(${LENGTH_TOKEN})\\s*(?:字|字符)`).exec(tail);
    if (single) {
      const targetCharacters = parseLengthToken(single[1]!);
      if (targetCharacters !== null) return { targetCharacters };
    }
  }
  return null;
}

export function inferPerChapterTargetCharacters(
  creationSpec: CreationContractSections,
): number | null {
  return (
    creationSpec.chapterLength?.targetCharacters ??
    inferChapterLengthFromStructure(creationSpec.structure)?.targetCharacters ??
    null
  );
}

export function resolveChapterLengthRequirement(
  creationSpec: CreationContractSections,
): ChapterLengthRequirement | null {
  const declared =
    creationSpec.chapterLength ?? inferChapterLengthFromStructure(creationSpec.structure);
  if (!declared) return null;
  return {
    targetCharacters: declared.targetCharacters,
    minimumCharacters:
      declared.minimumCharacters ??
      Math.floor((declared.targetCharacters * MIN_TARGET_PERCENT) / 100),
    maximumCharacters:
      declared.maximumCharacters ??
      Math.ceil((declared.targetCharacters * MAX_TARGET_PERCENT) / 100),
  };
}
