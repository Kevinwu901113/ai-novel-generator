/**
 * D-B7-1/2 结构性守卫（复查随行修复 note 3）。
 *
 * 现状（B7）：PROJECT_READY 恰好有两条入边——`blueprint-user-gate--project-ready-accept`
 * （BLUEPRINT_USER_GATE, outcome blueprint_gate=accept）与
 * `blueprint-escalation--project-ready-accept`（BLUEPRINT_ESCALATION,
 * outcome escalation_decision=accept_current）——都已被 `isBlueprintAcceptDecision`
 * （graph-run.ts）覆盖，触发 D-B7-1 的同事务 `storyBlueprintRepo.markAccepted` 副作用。
 *
 * 本测试**不硬编码这两条边**，而是从 `IDEA_TO_NOVEL_PROJECT_GRAPH_V1` 权威图定义动态
 * 枚举 PROJECT_READY 的全部入边，逐条断言被 `isBlueprintAcceptDecision` 覆盖。
 * 意图：将来任何人给 PROJECT_READY 加一条新入边（例如新的门禁/升级路径）却忘了同步
 * 登记 accept 副作用，这条测试会立即变红——不会重演本批次修的"run 已终态但
 * accepted=0"故障（静默地）。
 */

import { describe, it, expect } from 'vitest';
import {
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  PROJECT_READY,
  type EdgeOutcomeRequirement,
} from '@ai-novel/domain';
import { isBlueprintAcceptDecision } from './graph-run.js';

describe('D-B7-1/2 结构性守卫：PROJECT_READY 的每一条入边都必须被 accept 副作用覆盖', () => {
  const incomingEdges = IDEA_TO_NOVEL_PROJECT_GRAPH_V1.edges.filter((e) => e.to === PROJECT_READY);

  it('图定义里确实存在指向 PROJECT_READY 的入边（守卫本身没有失效为空测试）', () => {
    expect(incomingEdges.length).toBeGreaterThan(0);
  });

  it.each(incomingEdges.map((e) => [e.id, e] as const))(
    '入边 %s 被 isBlueprintAcceptDecision 覆盖',
    (_edgeId, edge) => {
      const fromNode = IDEA_TO_NOVEL_PROJECT_GRAPH_V1.nodes.find((n) => n.id === edge.from);
      expect(fromNode, `入边 ${edge.id} 的源节点 ${edge.from} 必须存在于图定义中`).toBeDefined();

      // PROJECT_READY 目前只应由"门禁/升级节点的条件出边"到达（conditional，携带
      // requiredOutcomes）。若将来出现 fixed 边或 artifact-only 边直达 PROJECT_READY，
      // 这里必须显式失败——那意味着"是否需要 accept 副作用"这一判断需要重新设计，
      // 不能被这条守卫默默放过。
      expect(
        edge.kind,
        `入边 ${edge.id} 是 ${edge.kind} 边，不是 conditional——isBlueprintAcceptDecision ` +
          '只认识 gate/escalation 决策 outcome，需要人工重新评估这条新入边的 accept 语义',
      ).toBe('conditional');

      const requiredOutcomes = edge.requiredOutcomes ?? [];
      expect(
        requiredOutcomes.length,
        `入边 ${edge.id} 是 conditional 边却没有 requiredOutcomes`,
      ).toBeGreaterThan(0);

      // 该节点用于 applyHumanDecision 的 outcome 条件由 node.output.requiredOutcomeCondition
      // 决定（gate/escalation 节点成功时只产出这一个 outcome condition）；在
      // requiredOutcomes 里找到匹配该 condition 的那一项，取其 expectedOutcome 才是
      // applyHumanDecision 实际会收到的 `input.outcome` 取值。
      const conditionName = fromNode!.output.requiredOutcomeCondition;
      expect(
        conditionName,
        `入边 ${edge.id} 的源节点 ${edge.from} 不产出 outcome（noOut），` +
          '无法通过人工决策 outcome 到达——需要重新评估',
      ).not.toBeNull();

      const matching = requiredOutcomes.find(
        (r: EdgeOutcomeRequirement) => r.condition === conditionName,
      );
      expect(
        matching,
        `入边 ${edge.id} 的 requiredOutcomes 里找不到与源节点 output 条件 ` +
          `${String(conditionName)} 匹配的项`,
      ).toBeDefined();

      // 核心断言：这条边实际会触发的 (nodeId, outcome) 组合必须被
      // isBlueprintAcceptDecision 识别为"需要 accept 副作用"。
      expect(
        isBlueprintAcceptDecision(edge.from, String(matching!.expectedOutcome)),
        `入边 ${edge.id}（${edge.from} → PROJECT_READY，outcome=${String(matching!.expectedOutcome)}）` +
          '未被 isBlueprintAcceptDecision 覆盖——到达 PROJECT_READY 时不会触发 ' +
          'markAccepted，会重演"run 已终态但 accepted=0"故障',
      ).toBe(true);
    },
  );
});
