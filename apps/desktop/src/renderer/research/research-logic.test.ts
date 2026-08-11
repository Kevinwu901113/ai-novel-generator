/**
 * Web Research 纯逻辑单测（B6）：相位派生（含 stale 优先级）、强度文案、版本链排序（含防环）、
 * escalation 选项闭合集合。
 */

import { describe, it, expect } from 'vitest';
import type { ResearchBundleDto, ResearchStateDto } from '@ai-novel/contracts';
import {
  RESEARCH_ESCALATION_OPTIONS,
  deriveResearchPhase,
  depthLabel,
  orderBundleChain,
} from './research-logic';

function state(overrides: Partial<ResearchStateDto> = {}): ResearchStateDto {
  return {
    runId: 'run-1',
    researchDecision: null,
    researchValid: null,
    bundleRef: null,
    bundleInvalidated: false,
    escalationActive: false,
    researchRetryUsed: 0,
    ...overrides,
  };
}

function bundle(overrides: Partial<ResearchBundleDto> = {}): ResearchBundleDto {
  return {
    id: 'rb-1',
    projectId: 'p1',
    version: 1,
    depth: 'deep',
    questions: [],
    factNotes: [],
    conclusion: '结论',
    createdAt: '2026-08-10T00:00:00.000Z',
    basedOnBundleId: null,
    ...overrides,
  };
}

describe('deriveResearchPhase', () => {
  it('state 为 null，或 runId 为 null → no-run', () => {
    expect(deriveResearchPhase(null, true, false)).toEqual({ kind: 'no-run' });
    expect(deriveResearchPhase(state({ runId: null }), true, false)).toEqual({ kind: 'no-run' });
  });

  it('escalationActive → escalation（优先于其余一切信号）', () => {
    expect(
      deriveResearchPhase(
        state({ researchDecision: 'deep', researchValid: 'invalid', escalationActive: true }),
        false,
        true,
      ),
    ).toEqual({ kind: 'escalation' });
  });

  it('有在途任务但缺 key → key-missing', () => {
    expect(deriveResearchPhase(state({ researchDecision: 'deep' }), false, true)).toEqual({
      kind: 'key-missing',
    });
  });

  it('researchDecision 为 null（区别于 none）→ not-started（"尚未调研"）', () => {
    expect(deriveResearchPhase(state({ researchDecision: null }), true, false)).toEqual({
      kind: 'not-started',
    });
  });

  it('researchDecision 为 none → skipped-none（"无需调研"，与 not-started 严格区分）', () => {
    const result = deriveResearchPhase(state({ researchDecision: 'none' }), true, false);
    expect(result).toEqual({ kind: 'skipped-none' });
    expect(result.kind).not.toBe('not-started');
  });

  it('有在途任务且 key 已配置 → running', () => {
    expect(deriveResearchPhase(state({ researchDecision: 'deep' }), true, true)).toEqual({
      kind: 'running',
    });
  });

  it('bundleInvalidated 且有 bundleRef → stale，即使 researchValid=valid 也不落 ready（优先级）', () => {
    expect(
      deriveResearchPhase(
        state({
          researchDecision: 'deep',
          researchValid: 'valid',
          bundleRef: 'rb-1',
          bundleInvalidated: true,
        }),
        true,
        false,
      ),
    ).toEqual({ kind: 'stale', bundleRef: 'rb-1' });
  });

  it('researchValid=valid 且有 bundleRef 且未失效 → ready', () => {
    expect(
      deriveResearchPhase(
        state({ researchDecision: 'deep', researchValid: 'valid', bundleRef: 'rb-1' }),
        true,
        false,
      ),
    ).toEqual({ kind: 'ready', bundleRef: 'rb-1' });
  });

  it('researchValid=invalid 且预算未耗尽（无 escalation）→ invalid-retrying', () => {
    expect(
      deriveResearchPhase(
        state({ researchDecision: 'deep', researchValid: 'invalid' }),
        true,
        false,
      ),
    ).toEqual({ kind: 'invalid-retrying' });
  });

  it('decision 已产出但尚无 valid/invalid 结论、也无在途任务（瞬时态）→ 兜底 not-started', () => {
    expect(deriveResearchPhase(state({ researchDecision: 'light' }), true, false)).toEqual({
      kind: 'not-started',
    });
  });
});

describe('depthLabel', () => {
  it('none/light/deep 三档中文文案', () => {
    expect(depthLabel('none')).toBe('本项目无需调研');
    expect(depthLabel('light')).toBe('轻度调研');
    expect(depthLabel('deep')).toBe('深度调研');
  });
});

describe('RESEARCH_ESCALATION_OPTIONS', () => {
  it('闭合五选项，与 domain ResearchEscalationDecision 一致', () => {
    const outcomes = RESEARCH_ESCALATION_OPTIONS.map((o) => o.outcome).sort();
    expect(outcomes).toEqual(
      [
        'cancel',
        'continue_later',
        'modify_requirements',
        'skip_research',
        'use_current_research',
      ].sort(),
    );
    for (const opt of RESEARCH_ESCALATION_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.description.length).toBeGreaterThan(0);
    }
  });
});

describe('orderBundleChain', () => {
  it('无链（basedOnBundleId 全 null）时按 createdAt 排序', () => {
    const a = bundle({ id: 'a', createdAt: '2026-08-10T00:00:00.000Z' });
    const b = bundle({ id: 'b', createdAt: '2026-08-11T00:00:00.000Z' });
    expect(orderBundleChain([b, a]).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('单链按 basedOnBundleId 串起最早→最新', () => {
    const v1 = bundle({ id: 'v1', createdAt: '2026-08-10T00:00:00.000Z', basedOnBundleId: null });
    const v2 = bundle({ id: 'v2', createdAt: '2026-08-11T00:00:00.000Z', basedOnBundleId: 'v1' });
    const v3 = bundle({ id: 'v3', createdAt: '2026-08-12T00:00:00.000Z', basedOnBundleId: 'v2' });
    // 打乱输入顺序，验证链重建而非依赖输入顺序
    expect(orderBundleChain([v3, v1, v2]).map((x) => x.id)).toEqual(['v1', 'v2', 'v3']);
  });

  it('basedOnBundleId 指向集合外的 id 视为链起点（不丢项）', () => {
    const orphan = bundle({
      id: 'o',
      createdAt: '2026-08-10T00:00:00.000Z',
      basedOnBundleId: 'missing',
    });
    expect(orderBundleChain([orphan]).map((x) => x.id)).toEqual(['o']);
  });

  it('防环：自引用（basedOnBundleId === 自身 id）不死循环，正常收录', () => {
    const selfRef = bundle({
      id: 's',
      createdAt: '2026-08-10T00:00:00.000Z',
      basedOnBundleId: 's',
    });
    const result = orderBundleChain([selfRef]);
    expect(result.map((x) => x.id)).toEqual(['s']);
  });

  it('防环：二元互指（A↔B）不死循环，按 createdAt 兜底收录且不丢项', () => {
    const a = bundle({ id: 'a', createdAt: '2026-08-10T00:00:00.000Z', basedOnBundleId: 'b' });
    const b = bundle({ id: 'b', createdAt: '2026-08-11T00:00:00.000Z', basedOnBundleId: 'a' });
    const result = orderBundleChain([a, b]);
    expect(result).toHaveLength(2);
    expect(result.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });

  it('防环：三元环（A→B→C→A）不死循环，全部收录', () => {
    const a = bundle({ id: 'a', createdAt: '2026-08-10T00:00:00.000Z', basedOnBundleId: 'c' });
    const b = bundle({ id: 'b', createdAt: '2026-08-11T00:00:00.000Z', basedOnBundleId: 'a' });
    const c = bundle({ id: 'c', createdAt: '2026-08-12T00:00:00.000Z', basedOnBundleId: 'b' });
    const result = orderBundleChain([a, b, c]);
    expect(result).toHaveLength(3);
    expect(result.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('多条独立链：各链内部有序，链之间按各自起点 createdAt 排序', () => {
    const chain1v1 = bundle({
      id: '1a',
      createdAt: '2026-08-10T00:00:00.000Z',
      basedOnBundleId: null,
    });
    const chain1v2 = bundle({
      id: '1b',
      createdAt: '2026-08-13T00:00:00.000Z',
      basedOnBundleId: '1a',
    });
    const chain2v1 = bundle({
      id: '2a',
      createdAt: '2026-08-11T00:00:00.000Z',
      basedOnBundleId: null,
    });
    const result = orderBundleChain([chain1v2, chain2v1, chain1v1]);
    expect(result.map((x) => x.id)).toEqual(['1a', '1b', '2a']);
  });
});
