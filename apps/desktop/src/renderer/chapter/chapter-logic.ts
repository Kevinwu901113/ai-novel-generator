/**
 * 章节生成旅程纯逻辑（B10，设计见 docs/development/b10-chapter-ui-design.md）。
 *
 * 与 B4/B6/B8 同一纪律：阶段由后端 DTO（ChapterRunStateDto.phase，worker 侧按 Graph
 * 节点状态派生）驱动，renderer 只做展示投影，不自行推导 Graph 语义。本文件只负责
 * "阶段 → 中文文案 / 可用操作 / 剩余次数"这类纯展示映射。
 */

import type { ChapterRunPhaseDto, ChapterRunStateDto } from '@ai-novel/contracts';
import {
  CHAPTER_CANDIDATE_REWRITE_LIMIT,
  CHAPTER_REGENERATE_LIMIT,
  CHAPTER_REWRITE_LIMIT,
} from '@ai-novel/contracts';

/** 阶段的作者语言标签（界面上不出现节点 / 任务 / token 等工程概念） */
export function chapterPhaseLabel(phase: ChapterRunPhaseDto): string {
  switch (phase) {
    case 'idle':
      return '还没开始';
    case 'planning':
      return '正在安排这一章的场景';
    case 'drafting':
      return '正在起草正文';
    case 'reviewing':
      return '正在自查（连续性 / 语言风格 / 是否符合要求）';
    case 'rewriting':
      return '正在按意见改写';
    case 'awaiting_decision':
      return '等你确认';
    case 'awaiting_escalation':
      return '改写次数已用完，等你决定';
    case 'accepted_pending_commit':
      return '你已采用（尚未写入稿件）';
    case 'completed':
      return '本章已完成';
    case 'blocked':
      return '已搁置';
    case 'cancelled':
      return '已取消';
    case 'failed':
      return '生成失败';
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

/** 生成过程中（有进行中的后台工作）——用于转圈提示 */
export function isChapterWorking(phase: ChapterRunPhaseDto): boolean {
  return (
    phase === 'planning' || phase === 'drafting' || phase === 'reviewing' || phase === 'rewriting'
  );
}

/** 阶段是否为终态（不再有后续动作） */
export function isChapterTerminal(phase: ChapterRunPhaseDto): boolean {
  return (
    phase === 'completed' || phase === 'blocked' || phase === 'cancelled' || phase === 'failed'
  );
}

/**
 * 候选正文是否应当展示。
 *
 * 与 B8 同一原则——**不能让用户对着看不见的内容做决定或失去回看**：
 * - 等你确认 / 升级决策：决策对象就是这份正文；
 * - 你已采用：采用的是哪一版必须看得见；
 * - 终态：那一版已经生成出来了，只是没走完流程，仍应可回看；
 * - 生成中：上一版仍是当前唯一可读内容（改写时尤其重要，用户要对照）。
 * 即"只要有候选就展示"，唯一例外是压根没有候选。
 */
export function showsCandidate(state: ChapterRunStateDto | null): boolean {
  return state?.candidate != null;
}

/** 候选确认环节的三个选项（domain 闭合枚举 CandidateGateDecision 的投影） */
export const CANDIDATE_GATE_OPTIONS: ReadonlyArray<{
  readonly outcome: 'accept' | 'request_rewrite' | 'reject';
  readonly label: string;
  readonly description: string;
}> = [
  {
    outcome: 'accept',
    label: '采用这一版',
    // 如实文案（锁定不变量第 5 条）：写入权威稿件属 GE-7，本批次只落 Gate 决策。
    description: '确认这一版为本章定稿；写入稿件的能力还在开发中，采用后正文仍保存在这里',
  },
  {
    outcome: 'request_rewrite',
    label: '按我的意见改写',
    description: '保留这一版的整体思路，按你写的意见修改（可以不写意见，那样会按自查问题改）',
  },
  {
    outcome: 'reject',
    label: '重写一版',
    description: '不要这一版，按本章目标重新起草（会换一种写法，不保留当前正文）',
  },
];

/** 升级决策的四个选项（domain 闭合枚举 EscalationDecision 的投影） */
export const CANDIDATE_ESCALATION_OPTIONS: ReadonlyArray<{
  readonly outcome: string;
  readonly label: string;
  readonly description: string;
}> = [
  {
    outcome: 'accept_current',
    label: '就用现在这一版',
    description: '不再改写，采用当前正文（写入稿件的能力还在开发中）',
  },
  {
    outcome: 'modify_requirements',
    // 如实文案：章节 run 只负责一章，改要求超出它的能力范围——图上这条边直接走
    // CHAPTER_BLOCKED 终态，之后需要重新发起本章生成。
    label: '要改的是整体要求',
    description: '本章生成会就此停下；调整创作要求或蓝图后，需要重新发起本章生成',
  },
  {
    outcome: 'continue_later',
    label: '稍后再说',
    description: '先停在这里（本章会转为搁置）；之后可以重新发起本章生成',
  },
  {
    outcome: 'cancel',
    label: '取消本章生成',
    description: '结束本次生成（已生成的内容保留，可回看）',
  },
];

/** 剩余次数（上限与图定义的 loop.maxIterations 一致，由 worker 侧 parity 测试守卫） */
export function candidateRewriteRemaining(state: ChapterRunStateDto): number {
  return Math.max(0, CHAPTER_CANDIDATE_REWRITE_LIMIT - state.candidateRewriteUsed);
}

export function regenerateRemaining(state: ChapterRunStateDto): number {
  return Math.max(0, CHAPTER_REGENERATE_LIMIT - state.regenerateUsed);
}

export function autoRewriteRemaining(state: ChapterRunStateDto): number {
  return Math.max(0, CHAPTER_REWRITE_LIMIT - state.rewriteUsed);
}

/**
 * "按我的意见改写"按钮的文案随剩余次数变化。
 *
 * 与 B8 蓝图侧同一结构性理由：图的 gate→escalation 边要求"提交 request_rewrite 且
 * 预算已耗尽"才路由进 CANDIDATE_ESCALATION —— **耗尽后再提交一次是进入升级四选项的
 * 唯一入口**，因此按钮绝不能在次数用尽时禁用（会让 gate 变成死端），只改文案。
 */
export function rewriteOptionCopy(remaining: number): {
  readonly label: string;
  readonly description: string;
} {
  if (remaining > 0) {
    const base = CANDIDATE_GATE_OPTIONS.find((o) => o.outcome === 'request_rewrite')!;
    return { label: base.label, description: base.description };
  }
  return {
    label: '还是不满意，进入后续决策',
    description: '按意见改写的次数已用完；提交后由你决定：就用这版、改整体要求、稍后再说或取消',
  };
}

/** 同理：重写一版（regenerate）耗尽后同样是进入升级决策的入口，不禁用 */
export function regenerateOptionCopy(remaining: number): {
  readonly label: string;
  readonly description: string;
} {
  if (remaining > 0) {
    const base = CANDIDATE_GATE_OPTIONS.find((o) => o.outcome === 'reject')!;
    return { label: base.label, description: base.description };
  }
  return {
    label: '不要这版，进入后续决策',
    description: '重写次数已用完；提交后由你决定：就用这版、改整体要求、稍后再说或取消',
  };
}

/** 审查维度的中文名 */
export function critiqueDimensionLabel(dimension: 'continuity' | 'style' | 'requirement'): string {
  switch (dimension) {
    case 'continuity':
      return '前后是否自洽';
    case 'style':
      return '语言与风格';
    case 'requirement':
      return '是否符合要求';
    default: {
      const exhaustive: never = dimension;
      return exhaustive;
    }
  }
}

/** 候选来源的中文说明（首稿 / 改写稿） */
export function candidateSourceLabel(source: 'DRAFT' | 'REWRITE'): string {
  return source === 'DRAFT' ? '首稿' : '改写稿';
}
