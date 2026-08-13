/**
 * 章节生成展示逻辑测试（B10）。
 *
 * 重点在两条容易被"顺手写错"的产品语义：
 * - 次数用尽时按钮文案改变而**不禁用**（耗尽后再提交一次是进入升级四选项的唯一入口）；
 * - 只要有候选就展示（生成中 / 终态 / 升级决策都要看得见），避免"内容存在却不可达"。
 */

import { describe, it, expect } from 'vitest';
import type { ChapterRunStateDto } from '@ai-novel/contracts';
import {
  CHAPTER_CANDIDATE_REWRITE_LIMIT,
  CHAPTER_REGENERATE_LIMIT,
  CHAPTER_REWRITE_LIMIT,
} from '@ai-novel/contracts';
import {
  CANDIDATE_ESCALATION_OPTIONS,
  CANDIDATE_GATE_OPTIONS,
  autoRewriteRemaining,
  candidateRewriteRemaining,
  chapterPhaseLabel,
  isChapterTerminal,
  isChapterWorking,
  regenerateOptionCopy,
  regenerateRemaining,
  rewriteOptionCopy,
  showsCandidate,
} from './chapter-logic';

function state(overrides: Partial<ChapterRunStateDto> = {}): ChapterRunStateDto {
  return {
    runId: 'run-1',
    blueprintChapterId: 'ch-1',
    phase: 'awaiting_decision',
    terminalStatus: null,
    gateActive: true,
    escalationActive: false,
    candidate: {
      revisionNo: 1,
      source: 'DRAFT',
      title: '第一章',
      content: '正文',
      createdAt: '2026-08-13T00:00:00.000Z',
    },
    critiques: [],
    rewriteUsed: 0,
    candidateRewriteUsed: 0,
    regenerateUsed: 0,
    ...overrides,
  };
}

describe('阶段文案与分类', () => {
  it('每个阶段都有中文文案（穷尽联合，新增阶段漏写即类型错）', () => {
    const phases = [
      'idle',
      'planning',
      'drafting',
      'reviewing',
      'rewriting',
      'awaiting_decision',
      'awaiting_escalation',
      'accepted_pending_commit',
      'completed',
      'blocked',
      'cancelled',
      'failed',
    ] as const;
    for (const phase of phases) {
      expect(chapterPhaseLabel(phase).length).toBeGreaterThan(0);
    }
  });

  it('"已采用"与"已完成"文案区分：前者是写入过程中，后者才是已写入稿件', () => {
    expect(chapterPhaseLabel('accepted_pending_commit')).toContain('正在写入稿件');
    expect(chapterPhaseLabel('completed')).toContain('已写入稿件');
  });

  it('工作中 / 终态分类', () => {
    expect(isChapterWorking('drafting')).toBe(true);
    expect(isChapterWorking('awaiting_decision')).toBe(false);
    expect(isChapterTerminal('cancelled')).toBe(true);
    expect(isChapterTerminal('accepted_pending_commit')).toBe(false);
  });
});

describe('候选展示', () => {
  it('只要有候选就展示（含生成中与终态）', () => {
    expect(showsCandidate(state({ phase: 'rewriting' }))).toBe(true);
    expect(showsCandidate(state({ phase: 'cancelled', terminalStatus: 'cancelled' }))).toBe(true);
    expect(showsCandidate(state({ candidate: null }))).toBe(false);
    expect(showsCandidate(null)).toBe(false);
  });
});

describe('剩余次数与按钮文案', () => {
  it('剩余次数按上限扣减且不为负', () => {
    expect(candidateRewriteRemaining(state({ candidateRewriteUsed: 2 }))).toBe(
      CHAPTER_CANDIDATE_REWRITE_LIMIT - 2,
    );
    expect(regenerateRemaining(state({ regenerateUsed: 99 }))).toBe(0);
    expect(autoRewriteRemaining(state({ rewriteUsed: 1 }))).toBe(CHAPTER_REWRITE_LIMIT - 1);
    expect(
      candidateRewriteRemaining(state({ candidateRewriteUsed: CHAPTER_REGENERATE_LIMIT + 9 })),
    ).toBe(0);
  });

  it('次数用尽 → 文案改为"进入后续决策"（按钮不禁用，那是唯一升级入口）', () => {
    const normal = rewriteOptionCopy(2);
    const exhausted = rewriteOptionCopy(0);
    expect(normal.label).not.toBe(exhausted.label);
    expect(exhausted.label).toContain('后续决策');
    expect(exhausted.description).toContain('已用完');

    const regenExhausted = regenerateOptionCopy(0);
    expect(regenExhausted.label).toContain('后续决策');
  });
});

describe('选项集合', () => {
  it('候选确认三选项与图的 candidate_gate 枚举一致', () => {
    expect(CANDIDATE_GATE_OPTIONS.map((o) => o.outcome).sort()).toEqual(
      ['accept', 'reject', 'request_rewrite'].sort(),
    );
  });

  it('升级四选项与图的 escalation_decision 枚举一致', () => {
    expect(CANDIDATE_ESCALATION_OPTIONS.map((o) => o.outcome).sort()).toEqual(
      ['accept_current', 'cancel', 'continue_later', 'modify_requirements'].sort(),
    );
  });

  it('"采用"文案说明写入稿件与后续去处（GE-7 起写入真实发生）', () => {
    const accept = CANDIDATE_GATE_OPTIONS.find((o) => o.outcome === 'accept')!;
    expect(accept.description).toContain('写入稿件');
  });
});
