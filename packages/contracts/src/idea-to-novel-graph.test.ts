/**
 * @ai-novel/contracts - Idea-to-Novel Graph 跨进程契约校验测试
 */

import { describe, it, expect } from 'vitest';
import {
  isValidWorkflowStage,
  isValidGraphNodeStatusPublicData,
  isValidGraphRunTerminalStatusPublicData,
  isValidGraphArtifactKindPublicData,
  isValidGraphArtifactRefPublicData,
  isValidGraphLoopBudgetKeyPublicData,
  isValidGraphPendingHumanDecisionPublicData,
  isValidGraphRunStatePublicData,
  type GraphRunStatePublicData,
} from './index';

describe('闭合枚举校验', () => {
  it('WorkflowStage', () => {
    expect(isValidWorkflowStage('idea')).toBe(true);
    expect(isValidWorkflowStage('generate')).toBe(true);
    expect(isValidWorkflowStage('done')).toBe(true);
    expect(isValidWorkflowStage('export')).toBe(false);
    expect(isValidWorkflowStage(1)).toBe(false);
  });

  it('GraphNodeStatusPublicData', () => {
    expect(isValidGraphNodeStatusPublicData('waiting_for_human')).toBe(true);
    expect(isValidGraphNodeStatusPublicData('succeeded')).toBe(true);
    expect(isValidGraphNodeStatusPublicData('running')).toBe(false);
  });

  it('GraphRunTerminalStatusPublicData', () => {
    expect(isValidGraphRunTerminalStatusPublicData('completed')).toBe(true);
    expect(isValidGraphRunTerminalStatusPublicData('paused')).toBe(false);
  });

  it('GraphArtifactKindPublicData', () => {
    expect(isValidGraphArtifactKindPublicData('researchBundle')).toBe(true);
    expect(isValidGraphArtifactKindPublicData('manuscript')).toBe(true);
    expect(isValidGraphArtifactKindPublicData('outline')).toBe(false);
  });

  it('GraphLoopBudgetKeyPublicData', () => {
    expect(isValidGraphLoopBudgetKeyPublicData('rewrite')).toBe(true);
    expect(isValidGraphLoopBudgetKeyPublicData('retry')).toBe(false);
  });
});

describe('GraphArtifactRefPublicData（闭合判别联合）', () => {
  it('合法引用通过', () => {
    expect(isValidGraphArtifactRefPublicData({ kind: 'creationSpec', artifactId: 'spec-1' })).toBe(
      true,
    );
    expect(isValidGraphArtifactRefPublicData({ kind: 'generationRun', artifactId: 'gen-1' })).toBe(
      true,
    );
  });

  it('拒绝未知 kind / 空 artifactId / 非对象', () => {
    expect(isValidGraphArtifactRefPublicData({ kind: 'plot', artifactId: 'x' })).toBe(false);
    expect(isValidGraphArtifactRefPublicData({ kind: 'idea', artifactId: '' })).toBe(false);
    expect(isValidGraphArtifactRefPublicData(null)).toBe(false);
    expect(isValidGraphArtifactRefPublicData('idea')).toBe(false);
  });
});

describe('GraphPendingHumanDecisionPublicData', () => {
  it('合法决策通过，非法拒绝', () => {
    expect(
      isValidGraphPendingHumanDecisionPublicData({
        nodeId: 'CANDIDATE_GATE',
        decisionType: 'candidate_gate',
      }),
    ).toBe(true);
    expect(
      isValidGraphPendingHumanDecisionPublicData({
        nodeId: 'COLLECT_ANSWER',
        decisionType: 'answer_question',
      }),
    ).toBe(true);
    expect(isValidGraphPendingHumanDecisionPublicData({ nodeId: 'X', decisionType: 'reply' })).toBe(
      false,
    );
    expect(isValidGraphPendingHumanDecisionPublicData({ nodeId: '' })).toBe(false);
    expect(isValidGraphPendingHumanDecisionPublicData(null)).toBe(false);
  });
});

describe('GraphRunStatePublicData（共享状态契约）', () => {
  function validState(): GraphRunStatePublicData {
    return {
      graphId: 'idea-to-novel',
      graphVersion: 'v1',
      projectId: 'p1',
      workflowRunId: 'r1',
      nodeStatuses: { IDEA_CAPTURE: 'succeeded', DRAFT: 'active' },
      activeFrontier: ['DRAFT'],
      artifacts: {
        idea: { kind: 'idea', artifactId: 'idea-1' },
        creationSpec: null,
        researchBundle: null,
        storyBlueprint: null,
        generationRun: null,
        manuscript: null,
      },
      pendingHumanDecision: null,
      attemptBudget: {
        clarification: 0,
        researchRetry: 0,
        blueprintRewrite: 0,
        rewrite: 1,
        candidateRewrite: 0,
        regenerate: 0,
      },
      invalidatedArtifacts: [{ kind: 'storyBlueprint', artifactId: 'bp-1' }],
      terminalStatus: null,
    };
  }

  it('合法共享状态通过', () => {
    expect(isValidGraphRunStatePublicData(validState())).toBe(true);
  });

  it('非法 nodeStatus 值被拒', () => {
    const s = validState();
    s.nodeStatuses.DRAFT = 'running' as never;
    expect(isValidGraphRunStatePublicData(s)).toBe(false);
  });

  it('缺失 artifact kind 或 kind 与引用不匹配被拒', () => {
    const missing = validState();
    delete (missing.artifacts as { idea?: unknown }).idea;
    expect(isValidGraphRunStatePublicData(missing)).toBe(false);

    const mismatched = validState();
    mismatched.artifacts.idea = { kind: 'manuscript', artifactId: 'ms-1' };
    expect(isValidGraphRunStatePublicData(mismatched)).toBe(false);
  });

  it('非法 pending decision / 非法 terminal / 负预算被拒', () => {
    const badPending = validState();
    badPending.pendingHumanDecision = { nodeId: 'X', decisionType: 'reply' as never };
    expect(isValidGraphRunStatePublicData(badPending)).toBe(false);

    const badTerminal = validState();
    badTerminal.terminalStatus = 'paused' as never;
    expect(isValidGraphRunStatePublicData(badTerminal)).toBe(false);

    const badBudget = validState();
    badBudget.attemptBudget.rewrite = -1;
    expect(isValidGraphRunStatePublicData(badBudget)).toBe(false);
  });

  it('非法 invalidatedArtifacts 被拒', () => {
    const bad = validState();
    bad.invalidatedArtifacts = [{ kind: 'plot' as never, artifactId: 'x' }];
    expect(isValidGraphRunStatePublicData(bad)).toBe(false);
  });
});
