/**
 * 蓝图纯逻辑单测（B8）。
 *
 * 重点覆盖优先级顺序——尤其"失效优先于 gate"（D-B8-4：失效时 accept 会被后端
 * fail-closed 拒绝，UI 必须先禁用）与"accepted 优先于终态"（D-B8-3：run 已
 * completed 的冷启动必须仍落在可展示蓝图的相位，而不是 terminal 文案）。
 */

import { describe, it, expect } from 'vitest';
import type { BlueprintStateDto, GraphProgressProjectionDto } from '@ai-novel/contracts';
// 直接对齐 domain 权威闭合枚举（GRAPH_CONDITION_OUTCOMES 是条件边的运行时取值
// 集合，与 BlueprintGateDecision / EscalationDecision 同源）。domain 若增删选项，
// 这里会直接变红，而不是像硬编码数组那样悄悄跟丢——沿用 B6 research-logic.test 的做法。
import {
  GRAPH_CONDITION_OUTCOMES,
  type BlueprintGateDecision,
  type EscalationDecision,
} from '@ai-novel/domain';
import {
  BLUEPRINT_ESCALATION_OPTIONS,
  BLUEPRINT_GATE_OPTIONS,
  BLUEPRINT_REWRITE_LIMIT,
  deriveBlueprintPhase,
  hasActiveBlueprintGenerate,
  rewriteRemaining,
  showsBlueprintContent,
  terminalStatusLabel,
} from './blueprint-logic';

function state(overrides: Partial<BlueprintStateDto> = {}): BlueprintStateDto {
  return {
    runId: 'run-1',
    blueprintRef: null,
    accepted: false,
    blueprintInvalidated: false,
    gateActive: false,
    escalationActive: false,
    rewriteUsed: 0,
    ...overrides,
  };
}

function progress(
  activeNodes: GraphProgressProjectionDto['activeNodes'],
): GraphProgressProjectionDto {
  return { activeNodes, possibleNextNodes: [] };
}

describe('deriveBlueprintPhase', () => {
  it('无 state / runId 为 null → no-run', () => {
    expect(deriveBlueprintPhase(null, null, false)).toEqual({ kind: 'no-run' });
    expect(deriveBlueprintPhase(state({ runId: null }), null, false)).toEqual({ kind: 'no-run' });
  });

  it('escalationActive 最高优先 → escalation', () => {
    const phase = deriveBlueprintPhase(
      state({ escalationActive: true, gateActive: true, blueprintRef: 'bp-1', accepted: true }),
      'completed',
      true,
    );
    expect(phase).toEqual({ kind: 'escalation' });
  });

  it('D-B8-4：gate 期间蓝图已失效 → stale 优先于 gate（accept 必须先被禁用）', () => {
    expect(
      deriveBlueprintPhase(
        state({ gateActive: true, blueprintInvalidated: true, blueprintRef: 'bp-1' }),
        null,
        false,
      ),
    ).toEqual({ kind: 'stale', blueprintRef: 'bp-1' });
  });

  it('gateActive 且未失效 → gate', () => {
    expect(
      deriveBlueprintPhase(state({ gateActive: true, blueprintRef: 'bp-1' }), null, false),
    ).toEqual({ kind: 'gate', blueprintRef: 'bp-1' });
  });

  it('D-B8-3：accepted 且 run 已 completed → ready（不是 terminal，冷启动必须看得到蓝图）', () => {
    expect(
      deriveBlueprintPhase(state({ accepted: true, blueprintRef: 'bp-1' }), 'completed', false),
    ).toEqual({ kind: 'ready', blueprintRef: 'bp-1' });
  });

  it('非 gate 态下的失效（等待重新生成）→ stale', () => {
    expect(
      deriveBlueprintPhase(
        state({ blueprintInvalidated: true, blueprintRef: 'bp-1' }),
        null,
        false,
      ),
    ).toEqual({ kind: 'stale', blueprintRef: 'bp-1' });
  });

  it('run 终态且蓝图未被接受 → terminal（blocked/cancelled）', () => {
    expect(deriveBlueprintPhase(state(), 'blocked', false)).toEqual({
      kind: 'terminal',
      status: 'blocked',
    });
    expect(deriveBlueprintPhase(state(), 'cancelled', false)).toEqual({
      kind: 'terminal',
      status: 'cancelled',
    });
  });

  it('BLUEPRINT_GENERATE 在途 → generating', () => {
    expect(deriveBlueprintPhase(state(), null, true)).toEqual({ kind: 'generating' });
  });

  it('已产出但 gate 尚未激活的瞬时态 → gate 兜底展示内容', () => {
    expect(deriveBlueprintPhase(state({ blueprintRef: 'bp-1' }), null, false)).toEqual({
      kind: 'gate',
      blueprintRef: 'bp-1',
    });
  });

  it('兜底 → not-started', () => {
    expect(deriveBlueprintPhase(state(), null, false)).toEqual({ kind: 'not-started' });
  });
});

describe('showsBlueprintContent', () => {
  it('stale / gate / ready 展示正文，其余不展示', () => {
    expect(showsBlueprintContent({ kind: 'stale', blueprintRef: 'b' })).toBe(true);
    expect(showsBlueprintContent({ kind: 'gate', blueprintRef: 'b' })).toBe(true);
    expect(showsBlueprintContent({ kind: 'ready', blueprintRef: 'b' })).toBe(true);
    expect(showsBlueprintContent({ kind: 'escalation' })).toBe(false);
    expect(showsBlueprintContent({ kind: 'generating' })).toBe(false);
    expect(showsBlueprintContent({ kind: 'no-run' })).toBe(false);
    expect(showsBlueprintContent({ kind: 'not-started' })).toBe(false);
    expect(showsBlueprintContent({ kind: 'terminal', status: 'blocked' })).toBe(false);
  });
});

describe('hasActiveBlueprintGenerate', () => {
  it('BLUEPRINT_GENERATE 为 active 时为真', () => {
    expect(
      hasActiveBlueprintGenerate(
        progress([{ nodeId: 'BLUEPRINT_GENERATE', stage: 'blueprint', status: 'active' }]),
      ),
    ).toBe(true);
  });

  it('BLUEPRINT_GENERATE 非 active（如已 succeeded）或无 progress → 假', () => {
    expect(
      hasActiveBlueprintGenerate(
        progress([{ nodeId: 'BLUEPRINT_GENERATE', stage: 'blueprint', status: 'succeeded' }]),
      ),
    ).toBe(false);
    expect(
      hasActiveBlueprintGenerate(
        progress([{ nodeId: 'RESEARCH_EXECUTE', stage: 'research', status: 'active' }]),
      ),
    ).toBe(false);
    expect(hasActiveBlueprintGenerate(null)).toBe(false);
  });
});

describe('闭合枚举投影', () => {
  it('gate 两选项与 domain BlueprintGateDecision 闭合枚举完全一致（不多不少）', () => {
    const domainOutcomes: ReadonlyArray<BlueprintGateDecision> =
      GRAPH_CONDITION_OUTCOMES.blueprint_gate;
    expect([...BLUEPRINT_GATE_OPTIONS.map((o) => o.outcome)].sort()).toEqual(
      [...domainOutcomes].sort(),
    );
  });

  it('escalation 四选项与 domain EscalationDecision 闭合枚举完全一致（不多不少）', () => {
    const domainOutcomes: ReadonlyArray<EscalationDecision> =
      GRAPH_CONDITION_OUTCOMES.escalation_decision;
    expect([...BLUEPRINT_ESCALATION_OPTIONS.map((o) => o.outcome)].sort()).toEqual(
      [...domainOutcomes].sort(),
    );
  });

  it('D-B8-7：改写按钮文案不暗示可定向修改（无 feedback 承载，TD-029-1）', () => {
    const rewrite = BLUEPRINT_GATE_OPTIONS.find((o) => o.outcome === 'request_rewrite');
    expect(rewrite?.description).toContain('不能定向修改');
  });
});

describe('terminalStatusLabel / rewriteRemaining', () => {
  it('三终态各自文案（D-B8-3）', () => {
    expect(terminalStatusLabel('completed')).toBe('项目已就绪');
    expect(terminalStatusLabel('blocked')).toBe('项目已搁置，可以继续');
    expect(terminalStatusLabel('cancelled')).toBe('项目流程已取消');
    expect(terminalStatusLabel('failed')).toBe('项目流程失败');
  });

  it('剩余改写次数按上限 3 计算且不为负', () => {
    expect(BLUEPRINT_REWRITE_LIMIT).toBe(3);
    expect(rewriteRemaining(0)).toBe(3);
    expect(rewriteRemaining(3)).toBe(0);
    expect(rewriteRemaining(5)).toBe(0);
  });
});
