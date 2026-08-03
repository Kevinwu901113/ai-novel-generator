/**
 * @ai-novel/contracts - Idea-to-Novel Graph 跨进程契约校验测试
 *
 * 覆盖 contracts 暴露的稳定公共 DTO / 枚举校验：
 * - WorkflowStage 投影；
 * - Graph identity DTO / run kind；
 * - 进度投影（active nodes + possible next nodes）；
 * - 人工决策公共 input DTO（含 Idea Intake 凭证制语义：answer 必须带 answerId）；
 * - 终止状态 DTO。
 */

import { describe, it, expect } from 'vitest';
import {
  isValidWorkflowStage,
  isValidGraphRunKind,
  isValidGraphIdentityDto,
  isValidGraphNodeProjectionDto,
  isValidGraphProgressProjectionDto,
  isValidHumanDecisionInputDto,
  isValidRunTerminalStatusDto,
  isValidRunTerminalStateDto,
  isValidGraphNodeStatusDto,
  type HumanDecisionInputDto,
} from './index';

describe('闭合枚举校验', () => {
  it('WorkflowStage', () => {
    expect(isValidWorkflowStage('idea')).toBe(true);
    expect(isValidWorkflowStage('generate')).toBe(true);
    expect(isValidWorkflowStage('done')).toBe(true);
    expect(isValidWorkflowStage('export')).toBe(false);
    expect(isValidWorkflowStage(1)).toBe(false);
  });

  it('GraphRunKind / RunTerminalStatus / GraphNodeStatus', () => {
    expect(isValidGraphRunKind('project')).toBe(true);
    expect(isValidGraphRunKind('chapter')).toBe(true);
    expect(isValidGraphRunKind('scene')).toBe(false);

    expect(isValidRunTerminalStatusDto('completed')).toBe(true);
    expect(isValidRunTerminalStatusDto('blocked')).toBe(true);
    expect(isValidRunTerminalStatusDto('paused')).toBe(false);

    expect(isValidGraphNodeStatusDto('waiting_for_human')).toBe(true);
    expect(isValidGraphNodeStatusDto('running')).toBe(false);
  });
});

describe('Graph identity DTO', () => {
  it('合法 identity 通过；类型错误 / 空 id 拒绝', () => {
    expect(
      isValidGraphIdentityDto({
        graphId: 'idea-to-novel-project',
        graphVersion: 'v1',
        kind: 'project',
      }),
    ).toBe(true);
    expect(
      isValidGraphIdentityDto({
        graphId: 'chapter-generation',
        graphVersion: 'v1',
        kind: 'chapter',
      }),
    ).toBe(true);
    expect(isValidGraphIdentityDto({ graphId: '', graphVersion: 'v1', kind: 'project' })).toBe(
      false,
    );
    expect(isValidGraphIdentityDto({ graphId: 'x', graphVersion: 'v1', kind: 'runtime' })).toBe(
      false,
    );
    expect(isValidGraphIdentityDto(null)).toBe(false);
  });
});

describe('进度投影 DTO', () => {
  it('合法节点投影 / 进度投影通过；非法拒绝', () => {
    expect(
      isValidGraphNodeProjectionDto({ nodeId: 'SPEC_EXTRACT', stage: 'clarify', status: 'active' }),
    ).toBe(true);
    expect(
      isValidGraphNodeProjectionDto({ nodeId: 'X', stage: 'exported', status: 'active' }),
    ).toBe(false);

    const progress = {
      activeNodes: [
        { nodeId: 'DRAFT', stage: 'generate', status: 'active' },
        { nodeId: 'CONTINUITY_CRITIC', stage: 'generate', status: 'active' },
      ],
      possibleNextNodes: ['CRITIQUE_JOIN'],
    };
    expect(isValidGraphProgressProjectionDto(progress)).toBe(true);
    expect(isValidGraphProgressProjectionDto({ ...progress, possibleNextNodes: [1] })).toBe(false);
  });
});

describe('人工决策公共 input DTO', () => {
  it('intake answer 必须带非空 trimmed answerId', () => {
    const valid: HumanDecisionInputDto = {
      nodeId: 'COLLECT_ANSWER',
      decisionType: 'intake_response',
      action: 'answer',
      answerId: 'answer-1',
    };
    expect(isValidHumanDecisionInputDto(valid)).toBe(true);
    expect(isValidHumanDecisionInputDto({ ...valid, answerId: '' })).toBe(false);
    expect(isValidHumanDecisionInputDto({ ...valid, answerId: '  x  ' })).toBe(false);
  });

  it('skip / finish 不需要 answerId', () => {
    expect(
      isValidHumanDecisionInputDto({
        nodeId: 'COLLECT_ANSWER',
        decisionType: 'intake_response',
        action: 'skip',
      }),
    ).toBe(true);
    expect(
      isValidHumanDecisionInputDto({
        nodeId: 'COLLECT_ANSWER',
        decisionType: 'intake_response',
        action: 'finish',
      }),
    ).toBe(true);
    // 非法 action
    expect(
      isValidHumanDecisionInputDto({
        nodeId: 'COLLECT_ANSWER',
        decisionType: 'intake_response',
        action: 'maybe',
      }),
    ).toBe(false);
  });

  it('blueprint / candidate gate 与 escalation 闭合枚举', () => {
    expect(
      isValidHumanDecisionInputDto({
        nodeId: 'BLUEPRINT_USER_GATE',
        decisionType: 'blueprint_gate',
        outcome: 'accept',
      }),
    ).toBe(true);
    expect(
      isValidHumanDecisionInputDto({
        nodeId: 'BLUEPRINT_USER_GATE',
        decisionType: 'blueprint_gate',
        outcome: 'accept_all',
      }),
    ).toBe(false);
    expect(
      isValidHumanDecisionInputDto({
        nodeId: 'CANDIDATE_GATE',
        decisionType: 'candidate_gate',
        outcome: 'reject',
      }),
    ).toBe(true);
    expect(
      isValidHumanDecisionInputDto({
        nodeId: 'RESEARCH_ESCALATION',
        decisionType: 'escalation',
        outcome: 'skip_research',
      }),
    ).toBe(true);
    expect(
      isValidHumanDecisionInputDto({
        nodeId: 'INTAKE_ESCALATION',
        decisionType: 'escalation',
        outcome: 'modify_idea',
      }),
    ).toBe(true);
    expect(
      isValidHumanDecisionInputDto({
        nodeId: 'X',
        decisionType: 'escalation',
        outcome: 'not_an_outcome',
      }),
    ).toBe(false);
  });
});

describe('终止状态 DTO', () => {
  it('合法 / 非法终止状态', () => {
    expect(isValidRunTerminalStateDto({ terminalStatus: null })).toBe(true);
    expect(isValidRunTerminalStateDto({ terminalStatus: 'blocked' })).toBe(true);
    expect(isValidRunTerminalStateDto({ terminalStatus: 'suspended' })).toBe(false);
    expect(isValidRunTerminalStateDto(null)).toBe(false);
  });
});
