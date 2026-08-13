/**
 * 稿件导出测试（GE-7）。
 *
 * 重点：导出不改动用户正文——Markdown 不转义正文里的标记字符，TXT 不加装饰分隔符。
 */

import { describe, it, expect } from 'vitest';
import {
  isExportFormat,
  renderManuscript,
  renderManuscriptAsMarkdown,
  renderManuscriptAsTxt,
  suggestedExportFileName,
} from './index.js';

const INPUT = {
  manuscriptTitle: '位面客栈',
  chapters: [
    { title: '第一章 远客', content: '雨砸在屋檐上。  \n\n\n\n小满擦干酒杯。' },
    { title: '第二章 异动', content: '通道又抖了一下。' },
  ],
};

describe('renderManuscriptAsTxt', () => {
  it('标题独占一行、章节间空行、连续空行压缩、行尾空白清除', () => {
    const txt = renderManuscriptAsTxt(INPUT);
    expect(txt.startsWith('位面客栈\n\n第一章 远客\n\n雨砸在屋檐上。\n\n小满擦干酒杯。')).toBe(
      true,
    );
    expect(txt).toContain('第二章 异动');
    expect(txt).not.toContain('\n\n\n');
    expect(txt.endsWith('\n')).toBe(true);
  });
});

describe('renderManuscriptAsMarkdown', () => {
  it('稿件标题 # / 章节标题 ##', () => {
    const md = renderManuscriptAsMarkdown(INPUT);
    expect(md.startsWith('# 位面客栈')).toBe(true);
    expect(md).toContain('## 第一章 远客');
  });

  it('正文里的 Markdown 标记字符原样保留（不擅自改动作品）', () => {
    const md = renderManuscriptAsMarkdown({
      manuscriptTitle: '书',
      chapters: [{ title: '第一章', content: '他写下 *强调* 与 # 号。' }],
    });
    expect(md).toContain('他写下 *强调* 与 # 号。');
    expect(md).not.toContain('\\*');
  });
});

describe('格式与文件名', () => {
  it('isExportFormat 只认两种格式', () => {
    expect(isExportFormat('txt')).toBe(true);
    expect(isExportFormat('markdown')).toBe(true);
    expect(isExportFormat('docx')).toBe(false);
  });

  it('renderManuscript 按格式分派', () => {
    expect(renderManuscript('txt', INPUT).startsWith('位面客栈')).toBe(true);
    expect(renderManuscript('markdown', INPUT).startsWith('# 位面客栈')).toBe(true);
  });

  it('文件名去掉路径分隔符等不安全字符；空标题有兜底', () => {
    expect(suggestedExportFileName('a/b:c*d', 'txt')).toBe('abcd.txt');
    expect(suggestedExportFileName('   ', 'markdown')).toBe('未命名稿件.md');
  });
});
