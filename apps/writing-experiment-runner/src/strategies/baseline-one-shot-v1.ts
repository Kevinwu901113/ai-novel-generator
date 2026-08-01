/**
 * baseline-one-shot-v1 策略：单次真实模型调用生成一个场景的正文候选。
 *
 * 固定参数：temperature 0.7 / maxTokens 1024 / concurrency 1 / retries 0。
 * Prompt 结构固定（system 稳定、user 逐 case 变化）；默认只记录 promptVersion + promptHash，
 * 不把完整 prompt 落盘。
 */

import type { CreationContractSections, NarrativePov, Tense } from '@ai-novel/domain';
import { sha256Hex, type WritingGenerationExperimentInput } from '@ai-novel/writing-evaluation';
import type { EvaluationConstraintV1 } from '@ai-novel/writing-evaluation';

export const BASELINE_ONE_SHOT_STRATEGY = {
  strategyId: 'baseline-one-shot-v1',
  strategyVersion: '1',
  promptVersion: 'baseline-one-shot-v1.p1',
  defaultTemperature: 0.7,
  defaultMaxTokens: 1024,
  concurrency: 1,
  retries: 0,
} as const;

export const BASELINE_STRATEGY_ID = BASELINE_ONE_SHOT_STRATEGY.strategyId;

const NARRATIVE_POV_LABEL: Readonly<Record<NarrativePov, string>> = {
  FIRST: '第一人称',
  THIRD_LIMITED: '第三人称有限视角',
  THIRD_OMNISCIENT: '第三人称全知',
  SECOND: '第二人称',
  OTHER: '其他',
};

const TENSE_LABEL: Readonly<Record<Tense, string>> = {
  PAST: '过去时',
  PRESENT: '现在时',
  MIXED: '混合时态',
};

export interface BuiltPrompt {
  readonly system: string;
  readonly user: string;
}

/** system 稳定（跨 case 相同），只定义结构与规则，不嵌入具体 fixture 事实。 */
const SYSTEM_PROMPT = [
  '【角色与任务】你是中文小说创作者。根据给定的创作契约与场景简报，生成一段符合要求的场景正文（prose）。只输出正文本身。',
  '',
  '【禁止内容与行为】',
  '- 不得引入创作契约与场景简报中标记为禁止的内容（forbiddenFacts / mustAvoid）；',
  '- 不得修改契约既定事实，不得新增契约未定义的设定；',
  '- 不得自称 AI；',
  '- 不得输出任何说明、分析、标题、大纲或元评论。',
  '',
  '【输出规则】',
  '- 只输出正文（prose）；不输出标题、说明、分析或解释；',
  '- 不使用 markdown 代码围栏；',
  '- 遵守场景简报 targetLength 的字数范围；',
  '- 不自我重复；',
  '- 使用中文写作，使用“”等中文标点。',
].join('\n');

function renderContract(contract: CreationContractSections): string {
  const lines: string[] = [];
  lines.push(`- 前提：${contract.premise}`);
  lines.push(`- 类型：${contract.genre.join('、')}`);
  lines.push(`- 基调：${contract.tone.join('、')}`);
  if (contract.themes !== undefined) lines.push(`- 主题：${contract.themes.join('、')}`);
  lines.push(`- 目标读者：${contract.targetAudience}`);
  lines.push(`- 叙事视角：${NARRATIVE_POV_LABEL[contract.narrativePov]}`);
  lines.push(`- 时态：${TENSE_LABEL[contract.tense]}`);
  if (contract.targetLength !== undefined) {
    lines.push(
      `- 目标篇幅：${contract.targetLength.value}${contract.targetLength.unit === 'words' ? ' 字' : ' 章'}`,
    );
  }
  if (contract.structure !== undefined) lines.push(`- 结构：${contract.structure}`);
  const protagonist = contract.protagonist;
  const protoParts = [`${protagonist.name}`];
  if (protagonist.role !== undefined) protoParts.push(`（${protagonist.role}）`);
  lines.push(`- 主角：${protoParts.join('')}`);
  if (protagonist.motivation !== undefined) lines.push(`  - 动机：${protagonist.motivation}`);
  if (protagonist.arc !== undefined) lines.push(`  - 弧线：${protagonist.arc}`);
  if (protagonist.traits !== undefined && protagonist.traits.length > 0) {
    lines.push(`  - 特质：${protagonist.traits.join('、')}`);
  }
  if (contract.supportingCharacters !== undefined && contract.supportingCharacters.length > 0) {
    for (const sc of contract.supportingCharacters) {
      const parts = [`- 配角：${sc.name}`];
      if (sc.role !== undefined) parts.push(`（${sc.role}）`);
      if (sc.relationship !== undefined) parts.push(`，与主角关系：${sc.relationship}`);
      lines.push(parts.join(''));
    }
  }
  if (contract.relationships !== undefined && contract.relationships.length > 0) {
    for (const rel of contract.relationships) {
      lines.push(`- 关系：${rel.fromCharacterKey} → ${rel.toCharacterKey}（${rel.type}）`);
    }
  }
  if (contract.worldRules !== undefined && contract.worldRules.length > 0) {
    lines.push(`- 世界规则：${contract.worldRules.join('；')}`);
  }
  if (contract.mustInclude !== undefined && contract.mustInclude.length > 0) {
    lines.push(`- 必须包含：${contract.mustInclude.join('；')}`);
  }
  if (contract.mustAvoid !== undefined && contract.mustAvoid.length > 0) {
    lines.push(`- 必须避免：${contract.mustAvoid.join('；')}`);
  }
  if (contract.contentBoundaries !== undefined) {
    const cb = contract.contentBoundaries;
    if (cb.rating !== undefined) lines.push(`- 内容分级：${cb.rating}`);
    if (cb.allowedContent !== undefined && cb.allowedContent.length > 0) {
      lines.push(`- 允许内容：${cb.allowedContent.join('；')}`);
    }
    if (cb.prohibitedContent !== undefined && cb.prohibitedContent.length > 0) {
      lines.push(`- 禁止内容：${cb.prohibitedContent.join('；')}`);
    }
    if (cb.notes !== undefined) lines.push(`- 内容边界说明：${cb.notes}`);
  }
  if (contract.unresolvedQuestions !== undefined && contract.unresolvedQuestions.length > 0) {
    lines.push(`- 未决问题：${contract.unresolvedQuestions.join('；')}`);
  }
  return lines.join('\n');
}

function renderConstraint(constraint: EvaluationConstraintV1): string {
  switch (constraint.kind) {
    case 'required-phrase':
      return `至少出现短语“${constraint.phrase}”${constraint.minOccurrences} 次`;
    case 'forbidden-phrase':
      return `不得出现短语“${constraint.phrase}”`;
    case 'phrase-max-count':
      return `短语“${constraint.phrase}”最多出现 ${constraint.maxOccurrences} 次`;
    case 'text-length-range':
      return `正文长度应为 ${constraint.minCodePoints}–${constraint.maxCodePoints} 个字符（code points）`;
    case 'dialogue-ratio-range':
      return `对话占比应在 ${constraint.minRatio}–${constraint.maxRatio}`;
    case 'manual-criterion':
      return ''; // 人工评分项，不进入生成约束
  }
}

/** 逐 case 构造确定性 prompt。同输入 → 同 prompt bytes → 同 promptHash。 */
export function buildBaselineOneShotPrompt(input: WritingGenerationExperimentInput): BuiltPrompt {
  const { sceneBrief } = input;
  const hardConstraints = input.constraints.map(renderConstraint).filter((line) => line.length > 0);

  const userLines: string[] = [];
  userLines.push('【创作契约】');
  userLines.push(renderContract(input.contract));
  userLines.push('');
  userLines.push('【场景简报】');
  userLines.push(`- 场景目标：${sceneBrief.sceneGoal}`);
  userLines.push(`- 参与人物：${sceneBrief.participants.join('、')}`);
  userLines.push(`- 地点：${sceneBrief.location}`);
  if (sceneBrief.entryState.length > 0) {
    userLines.push(`- 进入状态：${sceneBrief.entryState.join('；')}`);
  }
  if (sceneBrief.exitState.length > 0) {
    userLines.push(`- 离开状态：${sceneBrief.exitState.join('；')}`);
  }
  userLines.push(`- 冲突：${sceneBrief.conflict}`);
  if (sceneBrief.requiredFacts.length > 0) {
    userLines.push(`- 必须事实：${sceneBrief.requiredFacts.join('；')}`);
  }
  if (sceneBrief.forbiddenFacts.length > 0) {
    userLines.push(`- 禁止事实：${sceneBrief.forbiddenFacts.join('；')}`);
  }
  userLines.push(
    `- 目标长度：${sceneBrief.targetLength.minCodePoints}–${sceneBrief.targetLength.maxCodePoints} 个字符（code points）`,
  );
  if (hardConstraints.length > 0) {
    userLines.push('');
    userLines.push('【硬性约束】');
    for (const line of hardConstraints) {
      userLines.push(`- ${line}`);
    }
  }
  userLines.push('');
  userLines.push('请直接输出正文。');

  return { system: SYSTEM_PROMPT, user: userLines.join('\n') };
}

export function computePromptHash(prompt: BuiltPrompt): string {
  return sha256Hex(`${prompt.system}\n\n${prompt.user}`);
}
