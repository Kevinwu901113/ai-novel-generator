/**
 * 稳定 Markdown 报告渲染。
 *
 * 顶部声明：
 * - 此报告不是 AI 检测器；
 * - 自动指标不代表文学质量；
 * - 没有单一总分；
 * - 人工盲评仍是质量判断核心。
 *
 * 默认不嵌入完整文章正文。
 */

import type {
  DistributionStats,
  RatingAggregationReport,
  WritingEvaluationReportV1,
} from './schema.js';
import { HUMAN_RATING_DIMENSIONS } from './schema.js';

function fmtNumber(value: number | null, digits = 4): string {
  if (value === null) return '-';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(digits);
}

function distributionTable(dist: DistributionStats, label: string): string {
  return [
    `### ${label}`,
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    `| 最小值 | ${fmtNumber(dist.min)} |`,
    `| 最大值 | ${fmtNumber(dist.max)} |`,
    `| 均值 | ${fmtNumber(dist.mean)} |`,
    `| 中位数 | ${fmtNumber(dist.median)} |`,
    `| p90 | ${fmtNumber(dist.p90)} |`,
    `| 标准差 | ${fmtNumber(dist.standardDeviation)} |`,
    `| 变异系数 | ${fmtNumber(dist.coefficientOfVariation)} |`,
    '',
  ].join('\n');
}

const NOT_EVALUATED_DIMENSIONS: ReadonlyArray<[string, string]> = [
  ['character-credibility', '人物可信度'],
  ['plot-quality', '情节质量'],
  ['subtext-quality', '潜台词质量'],
  ['semantic-continuity', '语义连续性'],
  ['character-voice-distinctness', '人物声音真实区分度'],
  ['literary-value', '文学价值'],
  ['continue-reading-desire', '是否想继续读'],
];

export function renderMarkdownReport(report: WritingEvaluationReportV1): string {
  const lines: string[] = [];

  lines.push(`# 写作评测报告：${report.suiteId}`);
  lines.push('');
  lines.push('> 本报告不是 AI 检测器。');
  lines.push('> 自动指标不代表文学质量。');
  lines.push('> 没有单一总分。');
  lines.push('> 人工盲评仍是质量判断的核心。');
  lines.push('');
  lines.push(`- 生成时间（clock）：\`${report.generatedAt}\``);
  lines.push(`- 工具版本：\`${report.toolVersion}\``);
  lines.push(`- suiteHash：\`${report.suiteHash}\``);
  lines.push('');

  lines.push('## 自动指标覆盖范围');
  lines.push('');
  lines.push('| 类别 | 是否自动 |');
  lines.push('| --- | --- |');
  const coverage = report.metricCoverage;
  lines.push(`| 长度 | ${coverage.automatic.length ? '是' : '否'} |`);
  lines.push(`| 分布 | ${coverage.automatic.distributions ? '是' : '否'} |`);
  lines.push(`| 重复信号 | ${coverage.automatic.repetition ? '是' : '否'} |`);
  lines.push(`| AI-smell 词表信号 | ${coverage.automatic.lexiconSignals ? '是' : '否'} |`);
  lines.push(`| 显式约束 | ${coverage.automatic.explicitConstraints ? '是' : '否'} |`);
  lines.push('');
  lines.push('### 尚未自动评估的质量维度');
  lines.push('');
  for (const [id, label] of NOT_EVALUATED_DIMENSIONS) {
    lines.push(`- \`${id}\`：${label}（manual only）`);
  }
  lines.push('');

  for (const caseReport of report.caseResults) {
    lines.push(`## 用例：${caseReport.caseId}（${caseReport.title}）`);
    lines.push('');
    for (const candidateId of caseReport.candidateIds) {
      lines.push(...renderCandidateSection(report, candidateId));
    }
  }

  if (report.warnings.length > 0) {
    lines.push('## 全局警告');
    lines.push('');
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('> 说明：默认不嵌入完整正文；如需原文请使用 blind packet 或本地保留的候选文本。');
  lines.push('');

  return lines.join('\n');
}

function renderCandidateSection(report: WritingEvaluationReportV1, candidateId: string): string[] {
  const cr = report.candidateResults.find((r) => r.candidateId === candidateId);
  if (!cr) return [''];

  const lines: string[] = [];
  lines.push(`### 候选：${candidateId}`);
  lines.push('');
  lines.push(`- strategyId：\`${cr.strategyId}\``);
  lines.push(`- modelId：\`${cr.modelId}\``);
  lines.push(`- promptVersion：\`${cr.promptVersion}\``);
  lines.push(`- textHash：\`${cr.textHash}\``);
  lines.push(
    `- generationParameters：temperature=${fmtNumber(cr.generationParameters.temperature)}, maxTokens=${
      cr.generationParameters.maxTokens ?? 'null'
    }, seed=${cr.generationParameters.seed ?? 'null'}`,
  );
  lines.push('');

  lines.push('#### 基础统计');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| codePointCount | ${cr.basicStats.codePointCount} |`);
  lines.push(`| paragraphCount | ${cr.basicStats.paragraphCount} |`);
  lines.push(`| sentenceCount | ${cr.basicStats.sentenceCount} |`);
  lines.push(`| dialogueCodePointRatio | ${fmtNumber(cr.basicStats.dialogueCodePointRatio)} |`);
  lines.push('');

  lines.push(distributionTable(cr.distributionMetrics.sentenceLength, '句长分布（code points）'));
  lines.push(
    distributionTable(cr.distributionMetrics.paragraphLength, '段落长度分布（code points）'),
  );

  lines.push('#### 重复信号');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('| --- | --- |');
  lines.push(
    `| duplicateSentenceRatio | ${fmtNumber(cr.repetitionMetrics.duplicateSentenceRatio)} |`,
  );
  lines.push(
    `| repeatedCharacterNgramRatio(2) | ${fmtNumber(cr.repetitionMetrics.repeatedCharacterNgramRatio.n2)} |`,
  );
  lines.push(
    `| repeatedCharacterNgramRatio(3) | ${fmtNumber(cr.repetitionMetrics.repeatedCharacterNgramRatio.n3)} |`,
  );
  lines.push(
    `| repeatedCharacterNgramRatio(4) | ${fmtNumber(cr.repetitionMetrics.repeatedCharacterNgramRatio.n4)} |`,
  );
  lines.push(
    `| repeatedSentenceOpenerRatio | ${fmtNumber(cr.repetitionMetrics.repeatedSentenceOpenerRatio)} |`,
  );
  lines.push('');
  lines.push('Top n-grams（n=2/3/4）：');
  if (cr.repetitionMetrics.topRepeatedNgrams.length === 0) {
    lines.push('- （无）');
  } else {
    for (const g of cr.repetitionMetrics.topRepeatedNgrams) {
      lines.push(`- [n=${g.n}] \`${g.ngram}\` × ${g.count}`);
    }
  }
  lines.push('');
  lines.push('Top 句子开词：');
  if (cr.repetitionMetrics.topRepeatedSentenceOpeners.length === 0) {
    lines.push('- （无）');
  } else {
    for (const o of cr.repetitionMetrics.topRepeatedSentenceOpeners) {
      lines.push(`- \`${o.opener}\` × ${o.count}`);
    }
  }
  lines.push('');

  lines.push('#### AI-smell 启发式词表信号');
  lines.push('');
  lines.push('> 出现这些词不等于文章差；指标仅反映词表命中频率，不是 AI 检测。');
  lines.push('');
  lines.push('| lexiconId | 模式 | count | perThousandCodePoints |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of cr.aiSmellSignals.entries) {
    lines.push(
      `| ${entry.lexiconId} | \`${entry.pattern}\` | ${entry.count} | ${fmtNumber(entry.perThousandCodePoints)} |`,
    );
  }
  lines.push(
    `| **total** | - | **${cr.aiSmellSignals.totalCount}** | **${fmtNumber(cr.aiSmellSignals.totalPerThousandCodePoints)}** |`,
  );
  lines.push('');

  lines.push('#### 显式约束结果');
  lines.push('');
  lines.push('| constraintId | kind | status | explanation |');
  lines.push('| --- | --- | --- | --- |');
  for (const result of cr.constraintResults) {
    lines.push(
      `| ${result.constraintId} | ${result.kind} | ${result.status} | ${result.explanation} |`,
    );
  }
  lines.push('');

  const phraseEvidence = cr.constraintResults.flatMap((r) => r.evidence);
  if (phraseEvidence.length > 0) {
    lines.push('约束 evidence（短 excerpt）：');
    lines.push('');
    for (const ev of phraseEvidence.slice(0, 10)) {
      const sentence = ev.sentenceIndex === null ? '-' : `句 ${ev.sentenceIndex}`;
      lines.push(`- 段 ${ev.paragraphIndex}/${sentence}: \`${ev.excerpt}\``);
    }
    lines.push('');
  }

  lines.push('#### AI-smell evidence（短 excerpt）');
  lines.push('');
  if (cr.evidence.aiSmell.length === 0) {
    lines.push('- （无）');
  } else {
    for (const ev of cr.evidence.aiSmell) {
      lines.push(
        `- ${ev.lexiconId}（段 ${ev.paragraphIndex}${ev.sentenceIndex === null ? '' : `/句 ${ev.sentenceIndex}`}）: \`${ev.excerpt}\``,
      );
    }
  }
  lines.push('');

  if (cr.warnings.length > 0) {
    lines.push('候选警告：');
    lines.push('');
    for (const w of cr.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  return lines;
}

export function renderMarkdownRatingAggregation(agg: RatingAggregationReport): string {
  const lines: string[] = [];
  lines.push(`# 人工评分聚合报告：${agg.suiteId}`);
  lines.push('');
  lines.push('> 样本评分只作为格式示例，不代表真实用户研究。');
  lines.push('> 不计算默认 overall score；各维度分开查看。');
  lines.push('');
  lines.push(`- 生成时间（clock）：\`${agg.generatedAt}\``);
  lines.push(`- 工具版本：\`${agg.toolVersion}\``);
  lines.push(`- rater count：${agg.raterCount}`);
  lines.push('');

  lines.push('## 各候选各维度聚合');
  lines.push('');
  for (const ca of agg.candidateAggregates) {
    lines.push(
      `### case ${ca.caseId} / alias ${ca.alias}${ca.candidateId ? ` / ${ca.candidateId}` : ''}`,
    );
    lines.push('');
    lines.push('| 维度 | count | mean | median |');
    lines.push('| --- | --- | --- | --- |');
    for (const dim of HUMAN_RATING_DIMENSIONS) {
      const d = ca.dimensions[dim];
      lines.push(`| ${dim} | ${d.count} | ${fmtNumber(d.mean)} | ${fmtNumber(d.median)} |`);
    }
    lines.push('');

    lines.push('preferredRank 分布：');
    lines.push('');
    const ranks = Object.keys(ca.rankDistribution)
      .map(Number)
      .sort((a, b) => a - b);
    for (const rank of ranks) {
      lines.push(`- rank ${rank}: ${ca.rankDistribution[rank]} 次`);
    }
    lines.push('');
  }

  if (agg.pairwiseWins.length > 0) {
    lines.push('## 两两对比（preferredRank wins）');
    lines.push('');
    lines.push('| caseId | aliasA | aliasB | A wins | B wins | ties |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const pw of agg.pairwiseWins) {
      lines.push(
        `| ${pw.caseId} | ${pw.aliasA} | ${pw.aliasB} | ${pw.aliasAWins} | ${pw.aliasBWins} | ${pw.ties} |`,
      );
    }
    lines.push('');
  }

  if (agg.missingDimensions.length > 0) {
    lines.push('## 缺失维度');
    lines.push('');
    for (const m of agg.missingDimensions) lines.push(`- ${m}`);
    lines.push('');
  }

  if (agg.warnings.length > 0) {
    lines.push('## 警告');
    lines.push('');
    for (const w of agg.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  return lines.join('\n');
}
