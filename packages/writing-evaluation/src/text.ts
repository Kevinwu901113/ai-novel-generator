/**
 * 中文文本规范化与分段/分句。
 *
 * 纯函数：不 mutation 输入。
 *
 * 段落规则（已记录，测试必须覆盖）：
 * - NFC 规范化后，将 CRLF / CR 统一为 LF；
 * - 按 \n 切分逻辑行；
 * - 清除每行首尾空白；
 * - 每个非空逻辑行是一个段落；
 * - 连续空行不产生空段落；
 * - 不自动合并相邻行。
 *
 * 句末识别：
 * - 中文句末：。 ！ ？；
 * - ASCII 句末：! ?；
 * - 省略号：……（两个 U+2026）、单个 …、ASCII "..." 连续点；
 * - ASCII '.' 仅在“不是小数点”时作为句末（digit.digit 之间不切句）；
 * - 句子结尾后的闭合引号（” 」 』 以及处于英文引号内的 "）归入当前句；
 * - 仅由标点/空白组成的片段不记为句子。
 *
 * 引号：
 * - 支持 “” 「」 『』 与 ASCII 双引号 "；
 * - 引号状态由栈跟踪，未闭合引号产生 warning；
 * - dialogue code points = 从开引号到匹配闭引号（含引号本身）的 code points；
 *   未闭合的引号区域不计入 dialogue（更安全），并产生 warning。
 */

// ── 标点集合 ──────────────────────────────────────────────────────

const PUNCTUATION_CHARS = [
  // ASCII
  '!',
  '"',
  '#',
  '$',
  '%',
  '&',
  "'",
  '(',
  ')',
  '*',
  '+',
  ',',
  '-',
  '.',
  '/',
  ':',
  ';',
  '<',
  '=',
  '>',
  '?',
  '@',
  '[',
  '\\',
  ']',
  '^',
  '_',
  '`',
  '{',
  '|',
  '}',
  '~',
  // 全角
  '，',
  '。',
  '、',
  '；',
  '：',
  '？',
  '！',
  '…',
  '—',
  '–',
  '·',
  '．',
  '｡',
  // 引号
  '“',
  '”',
  '‘',
  '’',
  '「',
  '」',
  '『',
  '』',
  '《',
  '》',
  '〈',
  '〉',
  // 括号
  '（',
  '）',
  '【',
  '】',
  '〔',
  '〕',
  '｛',
  '｝',
  // 其他全角符号
  '　',
  '～',
  '￥',
  '％',
];

const PUNCTUATION_SET = new Set(PUNCTUATION_CHARS);

function isWhitespaceChar(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '　';
}

function isSubstantiveChar(c: string): boolean {
  return !isWhitespaceChar(c) && !PUNCTUATION_SET.has(c);
}

/** 判断片段是否包含实质内容（至少一个非标点、非空白 code point）。 */
export function hasSubstantiveContent(segment: string): boolean {
  for (const c of segment) {
    if (isSubstantiveChar(c)) return true;
  }
  return false;
}

/** 判断片段是否包含空白字符（用于跳过跨空白 n-gram 窗口）。 */
export function containsWhitespace(segment: string): boolean {
  for (const c of segment) {
    if (isWhitespaceChar(c)) return true;
  }
  return false;
}

// ── 规范化 ────────────────────────────────────────────────────────

/**
 * 文本规范化：
 * - NFC；
 * - CRLF / CR → LF；
 * - 每行清除首尾空白；
 * - 去除空行（连续空行不产生空段落）。
 * 返回以 \n 连接的规范化文本。
 */
export function normalizeText(raw: string): string {
  const nfc = raw.normalize('NFC');
  const withLf = nfc.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = withLf.split('\n');
  const nonEmpty: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) nonEmpty.push(trimmed);
  }
  return nonEmpty.join('\n');
}

/** 计算 code point 数量。 */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

// ── 句末判定 ──────────────────────────────────────────────────────

const CJK_ENDERS = new Set(['。', '！', '？', '!', '?']);
const ELLIPSIS_CHAR = '…';

function isAsciiDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isCjkOpeningQuote(c: string): boolean {
  return c === '“' || c === '「' || c === '『';
}

function isCjkClosingQuote(c: string): boolean {
  return c === '”' || c === '」' || c === '』';
}

// ── 分段与分句 ────────────────────────────────────────────────────

export interface TextSegmentation {
  /** 规范化后的完整文本（段落以 \n 连接） */
  readonly normalizedText: string;
  readonly codePointCount: number;
  readonly paragraphs: readonly string[];
  /** 与 paragraphs 对齐的句群 */
  readonly sentenceGroups: readonly (readonly string[])[];
  /** 全部句子（跨段落扁平） */
  readonly sentences: readonly string[];
  readonly dialogueCodePointCount: number;
  readonly dialogueCodePointRatio: number;
  readonly warnings: readonly string[];
}

/**
 * 对单个段落执行分句。
 * 返回该段落的句子列表（过滤掉仅标点/空白的片段）。
 */
function segmentParagraph(paragraph: string): string[] {
  const cps = Array.from(paragraph);
  const sentences: string[] = [];
  let current: string[] = [];
  let quoteDepth = 0;
  let inAsciiQuote = false;

  const appendChar = (c: string): void => {
    current.push(c);
  };

  const finalizeSentence = (): void => {
    const sentence = current.join('').trim();
    if (sentence.length > 0 && hasSubstantiveContent(sentence)) {
      sentences.push(sentence);
    }
    current = [];
  };

  /** 更新引号深度；返回该字符是否为处于引号区域内的内容（含引号本身）。 */
  const updateQuoteState = (c: string): boolean => {
    if (c === '"') {
      if (!inAsciiQuote) {
        inAsciiQuote = true;
        quoteDepth += 1;
        return true;
      }
      inAsciiQuote = false;
      quoteDepth = Math.max(0, quoteDepth - 1);
      return true;
    }
    if (isCjkOpeningQuote(c)) {
      quoteDepth += 1;
      return true;
    }
    if (isCjkClosingQuote(c)) {
      if (quoteDepth > 0) quoteDepth -= 1;
      return true;
    }
    return false;
  };

  const consumeTrailingClosingQuotes = (): void => {
    while (i < cps.length) {
      const nc = cps[i];
      const isClosing = isCjkClosingQuote(nc) || (nc === '"' && inAsciiQuote);
      if (!isClosing) break;
      appendChar(nc);
      updateQuoteState(nc);
      i += 1;
    }
  };

  /** 连续句末标点（。！？…）归入当前句。 */
  const consumeFollowingEnders = (): void => {
    while (i < cps.length) {
      const nc = cps[i];
      if (CJK_ENDERS.has(nc) || nc === ELLIPSIS_CHAR) {
        appendChar(nc);
        i += 1;
      } else {
        break;
      }
    }
  };

  let i = 0;
  while (i < cps.length) {
    const c = cps[i];

    if (c === '"' || isCjkOpeningQuote(c) || isCjkClosingQuote(c)) {
      appendChar(c);
      updateQuoteState(c);
      i += 1;
      continue;
    }

    if (c === ELLIPSIS_CHAR) {
      if (i + 1 < cps.length && cps[i + 1] === ELLIPSIS_CHAR) {
        appendChar(c);
        appendChar(cps[i + 1]);
        i += 2;
      } else {
        appendChar(c);
        i += 1;
      }
      consumeFollowingEnders();
      consumeTrailingClosingQuotes();
      finalizeSentence();
      continue;
    }

    if (c === '.') {
      let run = 1;
      while (i + run < cps.length && cps[i + run] === '.') run += 1;
      if (run >= 2) {
        for (let k = 0; k < run; k += 1) appendChar(cps[i + k]);
        i += run;
        consumeFollowingEnders();
        consumeTrailingClosingQuotes();
        finalizeSentence();
        continue;
      }
      const prev = i > 0 ? cps[i - 1] : '';
      const next = i + 1 < cps.length ? cps[i + 1] : '';
      const isDecimal = isAsciiDigit(prev) && isAsciiDigit(next);
      appendChar(c);
      i += 1;
      if (!isDecimal) {
        consumeTrailingClosingQuotes();
        finalizeSentence();
      }
      continue;
    }

    if (CJK_ENDERS.has(c)) {
      appendChar(c);
      i += 1;
      consumeFollowingEnders();
      consumeTrailingClosingQuotes();
      finalizeSentence();
      continue;
    }

    appendChar(c);
    i += 1;
  }

  finalizeSentence();
  return sentences;
}

/**
 * 分段并分句。
 * 返回规范化文本、段落、句群、对话统计与 warnings。
 */
export function segmentText(raw: string): TextSegmentation {
  const normalizedText = normalizeText(raw);
  const paragraphs = normalizedText.split('\n').filter((p) => p.length > 0);

  const sentenceGroups: string[][] = [];
  const sentences: string[] = [];
  const warnings: string[] = [];

  let dialogueCodePointCount = 0;

  for (let pi = 0; pi < paragraphs.length; pi += 1) {
    const paragraph = paragraphs[pi];
    const paragraphDialogue = countDialogueCodePoints(paragraph);
    dialogueCodePointCount += paragraphDialogue.count;
    for (const w of paragraphDialogue.warnings) {
      warnings.push(`段落 ${pi + 1}: ${w}`);
    }
    const group = segmentParagraph(paragraph);
    sentenceGroups.push(group);
    sentences.push(...group);
  }

  const codePointCount = codePointLength(normalizedText);
  const dialogueCodePointRatio = codePointCount > 0 ? dialogueCodePointCount / codePointCount : 0;

  return {
    normalizedText,
    codePointCount,
    paragraphs,
    sentenceGroups,
    sentences,
    dialogueCodePointCount,
    dialogueCodePointRatio,
    warnings,
  };
}

// ── 对话统计 ──────────────────────────────────────────────────────

interface QuoteFrame {
  readonly char: string;
  readonly startIndex: number;
}

function countDialogueCodePoints(text: string): {
  count: number;
  warnings: string[];
} {
  const cps = Array.from(text);
  const warnings: string[] = [];
  let dialogue = 0;
  const stack: QuoteFrame[] = [];
  let inAsciiQuote = false;

  for (let i = 0; i < cps.length; i += 1) {
    const c = cps[i];
    if (c === '"') {
      if (!inAsciiQuote) {
        stack.push({ char: '"', startIndex: i });
        inAsciiQuote = true;
      } else {
        const frame = stack.pop();
        if (frame) dialogue += i - frame.startIndex + 1;
        inAsciiQuote = false;
      }
      continue;
    }
    if (isCjkOpeningQuote(c)) {
      stack.push({ char: c, startIndex: i });
      continue;
    }
    if (isCjkClosingQuote(c)) {
      const frame = stack.pop();
      if (frame) {
        dialogue += i - frame.startIndex + 1;
      } else {
        warnings.push(`发现没有对应开引号的闭合引号 "${c}"`);
      }
      continue;
    }
  }

  for (const frame of stack) {
    const label = frame.char === '"' ? '"' : `"${frame.char}"`;
    warnings.push(`未闭合引号 ${label}`);
  }

  return { count: dialogue, warnings };
}
