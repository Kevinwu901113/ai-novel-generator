/**
 * antislop 策略共享第二趟逻辑。
 *
 * antislop-v1 与 antislop-v2 的第一趟 prompt 不同（v2 增加了反 AI 味文风规则），
 * 但第二趟完全一致：先由 computeAiSmellSignals 从初稿中提取可定位证据，
 * 零命中跳过，命中则用同一套定点改写 prompt 进行最小修改。
 */

import { computeAiSmellSignals, segmentText } from '@ai-novel/writing-evaluation';
import type { BuiltPrompt } from './baseline-one-shot-v1.js';

export interface AntislopEvidence {
  readonly lexiconId: string;
  readonly pattern: string;
  readonly paragraphIndex: number;
  readonly sentenceIndex: number | null;
  readonly excerpt: string;
}

/** 从初稿中提取检测器命中的具体证据（用于第二趟 prompt 与测试断言）。 */
export function collectAntislopEvidence(text: string): readonly AntislopEvidence[] {
  const signals = computeAiSmellSignals(segmentText(text));
  const evidence: AntislopEvidence[] = [];
  for (const entry of signals.entries) {
    for (const item of entry.evidence) {
      evidence.push({
        lexiconId: item.lexiconId,
        pattern: entry.pattern,
        paragraphIndex: item.paragraphIndex,
        sentenceIndex: item.sentenceIndex,
        excerpt: item.excerpt,
      });
    }
  }
  return evidence;
}

export const ANTISLOP_REVISION_SYSTEM_PROMPT = [
  '【角色与任务】你是中文小说定点修改编辑。只根据检测器定位到的具体问题进行最小修改，不进行整体润色或重写。',
  '',
  '【禁止内容与行为】',
  '- 不得重写整段或整篇；',
  '- 不得改变情节、人物、设定、视角、时态；',
  '- 不得补字数、扩写或新增内容；',
  '- 不得输出说明、分析、标题、大纲或元评论。',
  '',
  '【输出规则】',
  '- 只输出修改后的完整正文；',
  '- 不使用 markdown 代码围栏；',
  '- 使用中文写作，使用“”等中文标点。',
].join('\n');

function renderEvidence(evidence: readonly AntislopEvidence[]): string {
  return evidence
    .map((item) => {
      const sentence = item.sentenceIndex === null ? '' : `第 ${item.sentenceIndex + 1} 句`;
      return `- 第 ${item.paragraphIndex + 1} 段${sentence}，模式「${item.pattern}」：${item.excerpt}`;
    })
    .join('\n');
}

/** 由检测器定位出的具体问题驱动第二趟定点改写。 */
export function buildAntislopRevisionPrompt(
  firstDraft: string,
  evidence: readonly AntislopEvidence[],
): BuiltPrompt {
  const user = [
    '【任务】下面是一段已生成的中文小说场景初稿。质量检测器定位到以下 AI 腔/套话问题。请只修改这些被定位的句子，进行定点改写；不要重写整段，不要改变情节、人物、设定、视角或时态，不要补字数、扩写或新增内容。',
    '',
    '【初稿】',
    firstDraft,
    '',
    '【检测到的问题】',
    renderEvidence(evidence),
    '',
    '【改写要求】',
    '- 只改写“检测到的问题”中列出的句子；',
    '- 未列出的句子必须逐字保留；',
    '- 保持段落结构、句子数量与句序不变；',
    '- 不得改变情节、人物、设定、视角、时态与对话内容；',
    '- 改写后正文长度应与原文接近，不要补字数；',
    '- 直接输出修改后的完整正文。',
  ].join('\n');

  return { system: ANTISLOP_REVISION_SYSTEM_PROMPT, user };
}
