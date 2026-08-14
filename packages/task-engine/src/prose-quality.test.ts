import { describe, expect, it } from 'vitest';
import { analyzeChineseProseQuality } from './prose-quality.js';

describe('中文正文确定性质量门', () => {
  it('高密度类比和 AI 腔词表命中形成 blocking issues', () => {
    const content = '她仿佛看见旧影，又似乎听见回声，某种东西在心中一阵翻涌。'.repeat(35);
    const report = analyzeChineseProseQuality(content);
    expect(report.metaphorMarkerCount).toBeGreaterThanOrEqual(6);
    expect(report.aiSmellCount).toBeGreaterThanOrEqual(10);
    expect(report.blockingIssues.some((issue) => issue.problem.includes('模板化 AI 腔'))).toBe(
      true,
    );
  });

  it('少量自然出现的标记不被误判为阻塞', () => {
    const content = [
      '门轴响了一声。陈默放下账本，走到窗边。',
      '雨水顺着瓦沟落进院子，砸得石阶发白。',
      '“还走吗？”掌柜问。',
      '陈默把信塞进怀里：“天亮就走。”',
      '掌柜没再劝，只把油灯拨亮了一点。',
    ].join('\n');
    expect(analyzeChineseProseQuality(content).blockingIssues).toEqual([]);
  });

  it('未闭合或不匹配的对白引号会阻止直接放行', () => {
    const report = analyzeChineseProseQuality('掌柜放下灯：“今夜别走。\n雨一直下到天亮。');
    expect(report.punctuationWarningCount).toBeGreaterThan(0);
    expect(report.blockingIssues).toContainEqual(
      expect.objectContaining({ problem: expect.stringContaining('不匹配的引号') }),
    );
  });
});
