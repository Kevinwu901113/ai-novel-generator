import type { ChapterCritiqueIssue } from '@ai-novel/domain';
import {
  computeAiSmellSignals,
  computeRepetitionMetrics,
  segmentText,
} from '@ai-novel/writing-evaluation';

export interface ChineseProseQualityReport {
  readonly characterCount: number;
  readonly sentenceCount: number;
  readonly punctuationWarningCount: number;
  readonly aiSmellCount: number;
  readonly aiSmellPerThousand: number;
  readonly metaphorMarkerCount: number;
  readonly metaphorMarkersPerThousand: number;
  readonly duplicateSentenceRatio: number;
  readonly repeatedSentenceOpenerRatio: number;
  readonly blockingIssues: ReadonlyArray<ChapterCritiqueIssue>;
}

const METAPHOR_MARKER = /仿佛|似乎|像是|像被|像一(?:缕|层|把|只)/g;
const DIRECT_EMOTION =
  /不知为何|莫名(?:地)?|心中一(?:阵|股)|心里(?:一|有)|内心(?:一|深处)|感到一阵|感觉到一股/g;
const EMPTY_CLICHES = [
  '命运的齿轮开始转动',
  '空气仿佛凝固',
  '仿佛整个世界都安静了',
  '某种东西悄然改变',
  '说不清道不明',
  '难以言喻',
] as const;

function excerptAround(content: string, marker: string): string {
  const at = content.indexOf(marker);
  if (at < 0) return '';
  return content.slice(Math.max(0, at - 35), at + marker.length + 65).trim();
}

/**
 * 保守的运行时质量门：只把高密度、可重复计算的模式列为 blocking。
 * 它不是“AI 检测器”，也不替代人工文学判断；作用是防止 Critic 漏判后直接放行。
 */
export function analyzeChineseProseQuality(content: string): ChineseProseQualityReport {
  const segmentation = segmentText(content);
  const aiSmell = computeAiSmellSignals(segmentation);
  const repetition = computeRepetitionMetrics(segmentation);
  const characterCount = Math.max(1, [...content.replace(/\s/g, '')].length);
  const metaphorMarkers = content.match(METAPHOR_MARKER) ?? [];
  const metaphorMarkersPerThousand = (metaphorMarkers.length * 1000) / characterCount;
  const directEmotionMarkers = content.match(DIRECT_EMOTION) ?? [];
  const directEmotionPerThousand = (directEmotionMarkers.length * 1000) / characterCount;
  const clichéHits = EMPTY_CLICHES.filter((phrase) => content.includes(phrase));
  const blockingIssues: ChapterCritiqueIssue[] = [];

  if (segmentation.warnings.length > 0) {
    blockingIssues.push({
      severity: 'major',
      excerpt: '',
      problem: `正文存在 ${segmentation.warnings.length} 处未闭合或不匹配的引号：${segmentation.warnings
        .slice(0, 3)
        .join('；')}。`,
      suggestion: '逐段补齐或改正引号，确认对白与叙述的边界后再提交。',
    });
  }

  if (metaphorMarkers.length >= 6 && metaphorMarkersPerThousand >= 2.5) {
    blockingIssues.push({
      severity: 'major',
      excerpt: excerptAround(content, metaphorMarkers[0]!),
      problem: `全章出现 ${metaphorMarkers.length} 处“像/仿佛/似乎”类比标记（每千字 ${metaphorMarkersPerThousand.toFixed(1)} 处），形成模板化 AI 腔。`,
      suggestion: '保留少数真正必要的比喻，其余改为人物动作、物体变化或准确的感官事实。',
    });
  }

  if (aiSmell.totalCount >= 10 && aiSmell.totalPerThousandCodePoints >= 4) {
    const leading = aiSmell.entries
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 4)
      .map((entry) => `${entry.pattern}×${entry.count}`)
      .join('、');
    blockingIssues.push({
      severity: 'major',
      excerpt: '',
      problem: `AI 腔启发式信号共 ${aiSmell.totalCount} 处（每千字 ${aiSmell.totalPerThousandCodePoints.toFixed(1)} 处），高频项为 ${leading}。`,
      suggestion: '删除填充词与抽象判断，打破公式句式，用具体动作、对白和可感知细节重写高频段落。',
    });
  }

  if (directEmotionMarkers.length >= 5 && directEmotionPerThousand >= 1.5) {
    blockingIssues.push({
      severity: 'major',
      excerpt: excerptAround(content, directEmotionMarkers[0]!),
      problem: `全章有 ${directEmotionMarkers.length} 处“莫名/心中一阵/感到一阵”等直陈情绪，人物反应被概括词替代。`,
      suggestion: '把情绪改写为动作选择、身体反应、停顿或带人物口吻的对白。',
    });
  }

  if (clichéHits.length >= 2) {
    blockingIssues.push({
      severity: 'major',
      excerpt: excerptAround(content, clichéHits[0]!),
      problem: `同章出现多处空泛套话：${clichéHits.join('、')}。`,
      suggestion: '删除总结式套话，改写为本场景独有且能推动情节的具体变化。',
    });
  }

  if (segmentation.sentences.length >= 20 && repetition.duplicateSentenceRatio >= 0.03) {
    blockingIssues.push({
      severity: 'major',
      excerpt: '',
      problem: `重复句比例达到 ${(repetition.duplicateSentenceRatio * 100).toFixed(1)}%，存在明显复写或凑字数。`,
      suggestion: '删除重复句，保留首次出现的信息，并用新的事件推进补足必要篇幅。',
    });
  }

  return {
    characterCount,
    sentenceCount: segmentation.sentences.length,
    punctuationWarningCount: segmentation.warnings.length,
    aiSmellCount: aiSmell.totalCount,
    aiSmellPerThousand: aiSmell.totalPerThousandCodePoints,
    metaphorMarkerCount: metaphorMarkers.length,
    metaphorMarkersPerThousand,
    duplicateSentenceRatio: repetition.duplicateSentenceRatio,
    repeatedSentenceOpenerRatio: repetition.repeatedSentenceOpenerRatio,
    blockingIssues,
  };
}
