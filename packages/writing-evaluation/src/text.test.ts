/**
 * B. Unicode 与分段/分句测试矩阵。
 */

import { describe, expect, it } from 'vitest';
import {
  codePointLength,
  containsWhitespace,
  hasSubstantiveContent,
  normalizeText,
  segmentText,
} from './text.js';

describe('normalizeText', () => {
  it('执行 NFC 规范化', () => {
    expect(normalizeText('ä')).toBe('ä');
  });

  it('将 CRLF / CR 统一为 LF', () => {
    expect(normalizeText('a\r\nb\rc\n')).toBe('a\nb\nc');
  });

  it('清除每行首尾空白', () => {
    expect(normalizeText('  你好  \n 世界  ')).toBe('你好\n世界');
  });

  it('连续空行不产生空段落', () => {
    expect(normalizeText('a\n\n\nb')).toBe('a\nb');
  });

  it('空白行被移除', () => {
    expect(normalizeText('a\n  \nb')).toBe('a\nb');
  });
});

describe('codePointLength', () => {
  it('emoji / surrogate pairs 按 code point 计数', () => {
    expect(codePointLength('👋')).toBe(1);
    // 👋(1) + 你(1) + 好(1) = 3 code points
    expect(codePointLength('👋你好')).toBe(3);
  });

  it('组合字符为多个 code points', () => {
    expect(codePointLength('é')).toBe(2);
  });

  it('普通中文按字符计数', () => {
    expect(codePointLength('你好世界')).toBe(4);
  });
});

describe('segmentText — 段落', () => {
  it('每个非空逻辑行作为一个段落', () => {
    const seg = segmentText('第一段\n第二段\n第三段');
    expect(seg.paragraphs).toEqual(['第一段', '第二段', '第三段']);
  });

  it('不自动合并相邻行', () => {
    const seg = segmentText('第一段\n第二段');
    expect(seg.paragraphs).toEqual(['第一段', '第二段']);
  });

  it('连续空行不产生空段落', () => {
    const seg = segmentText('a\n\n\nb');
    expect(seg.paragraphs).toEqual(['a', 'b']);
    expect(seg.paragraphs.length).toBe(2);
  });
});

describe('segmentText — 中文句末', () => {
  it('识别 。 ！ ？', () => {
    const seg = segmentText('你好。我好！大家好？');
    expect(seg.sentences).toEqual(['你好。', '我好！', '大家好？']);
  });

  it('识别 ASCII ! ?', () => {
    const seg = segmentText('你好!你好?');
    expect(seg.sentences).toEqual(['你好!', '你好?']);
  });

  it('识别省略号 ……（两个 U+2026）', () => {
    const seg = segmentText('他走了……她站在原地。');
    expect(seg.sentences).toEqual(['他走了……', '她站在原地。']);
  });

  it('识别单个 …', () => {
    const seg = segmentText('他欲言又止…没再说下去。');
    expect(seg.sentences).toEqual(['他欲言又止…', '没再说下去。']);
  });

  it('识别 ASCII 连续点 ...', () => {
    const seg = segmentText('等等...他说。');
    expect(seg.sentences).toEqual(['等等...', '他说。']);
  });

  it('ASCII . 作为小数点不切句', () => {
    const seg = segmentText('圆周率是3.14。');
    expect(seg.sentences).toEqual(['圆周率是3.14。']);
  });

  it('英文句点切句', () => {
    const seg = segmentText('He left. She stayed.');
    expect(seg.sentences).toEqual(['He left.', 'She stayed.']);
  });

  it('中文与英文混排', () => {
    const seg = segmentText('他说：I love it! 然后走了。');
    expect(seg.sentences).toEqual(['他说：I love it!', '然后走了。']);
  });
});

describe('segmentText — 引号', () => {
  it('句子结尾后的闭合引号归入当前句', () => {
    const seg = segmentText('“你来了。”他说。');
    expect(seg.sentences).toEqual(['“你来了。”', '他说。']);
  });

  it('支持 「」 引号', () => {
    const seg = segmentText('「到了。」她点头。');
    expect(seg.sentences).toEqual(['「到了。」', '她点头。']);
  });

  it('支持 『』 引号', () => {
    const seg = segmentText('『原来如此。』他若有所思。');
    expect(seg.sentences).toEqual(['『原来如此。』', '他若有所思。']);
  });

  it('未闭合引号产生 warning', () => {
    const seg = segmentText('“你好。');
    expect(seg.warnings.some((w) => w.includes('未闭合引号'))).toBe(true);
  });

  it('闭合引号不产生 warning', () => {
    const seg = segmentText('“你好。”');
    expect(seg.warnings.filter((w) => w.includes('未闭合引号'))).toHaveLength(0);
  });
});

describe('segmentText — 对话统计', () => {
  it('整句对话 ratio 为 1', () => {
    const seg = segmentText('“你好。”');
    expect(seg.dialogueCodePointRatio).toBe(1);
  });

  it('对话与叙述混合', () => {
    const seg = segmentText('他说：“走吧。”然后起身。');
    // 对话：“走吧。” = 5 cp（含引号）；全文 13 cp
    expect(seg.dialogueCodePointCount).toBe(5);
    expect(seg.dialogueCodePointRatio).toBeCloseTo(5 / 13, 5);
  });

  it('未闭合引号区域不计入 dialogue', () => {
    const seg = segmentText('“你好。');
    expect(seg.dialogueCodePointCount).toBe(0);
  });

  it('无对话时 ratio 为 0', () => {
    const seg = segmentText('他转身走了。');
    expect(seg.dialogueCodePointRatio).toBe(0);
  });
});

describe('segmentText — 边界', () => {
  it('连续标点归入当前句', () => {
    const seg = segmentText('你好。。再见');
    expect(seg.sentences).toEqual(['你好。。', '再见']);
  });

  it('连续句末后紧跟普通内容正常切句', () => {
    const seg = segmentText('他走了。！她又说。');
    expect(seg.sentences).toEqual(['他走了。！', '她又说。']);
  });

  it('纯标点文本过滤为 0 句', () => {
    const seg = segmentText('。。。');
    expect(seg.sentences).toHaveLength(0);
  });

  it('emoji 句子被保留', () => {
    const seg = segmentText('👋再见。');
    expect(seg.sentences).toEqual(['👋再见。']);
  });

  it('空输入返回零统计且无异常', () => {
    const seg = segmentText('');
    expect(seg.codePointCount).toBe(0);
    expect(seg.paragraphs).toHaveLength(0);
    expect(seg.sentences).toHaveLength(0);
    expect(seg.dialogueCodePointRatio).toBe(0);
  });

  it('hasSubstantiveContent 判断正确', () => {
    expect(hasSubstantiveContent('你好')).toBe(true);
    expect(hasSubstantiveContent('。。。')).toBe(false);
    expect(hasSubstantiveContent('  ')).toBe(false);
  });

  it('containsWhitespace 判断正确', () => {
    expect(containsWhitespace('你 好')).toBe(true);
    expect(containsWhitespace('你好')).toBe(false);
  });
});
