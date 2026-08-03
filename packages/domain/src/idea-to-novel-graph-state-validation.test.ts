/**
 * @ai-novel/domain - Graph-aware Run State Validation tests
 *
 * 覆盖 req 6：graphId/version 匹配、nodeStatuses 恰好覆盖、frontier/status 双向一致、
 * pending decision 一致、terminal 一致性、预算/artifact 槽位完整、去重、prototype 安全、拒绝额外键。
 */

import { describe, it, expect } from 'vitest';
import {
  IDEA_TO_NOVEL_GRAPH_V1,
  IDEA_CAPTURE,
  DRAFT,
  createWorkflowRunId,
} from './idea-to-novel-graph.js';
import {
  createInitialRunState,
  artifactRef,
  type IdeaToNovelGraphRunState,
  type ProjectId,
} from './index.js';
import {
  validateGraphRunState,
  isValidGraphRunState,
  type GraphStateValidationErrorCode,
} from './idea-to-novel-graph-state-validation.js';

const G = IDEA_TO_NOVEL_GRAPH_V1;
const PROJECT_ID = 'project-1' as unknown as ProjectId;
const RUN_ID = createWorkflowRunId('run-1');

function fresh(): IdeaToNovelGraphRunState {
  return createInitialRunState({
    graph: G,
    projectId: PROJECT_ID,
    workflowRunId: RUN_ID,
    createdAt: '2026-08-03T00:00:00.000Z',
  });
}

function hasCode(state: IdeaToNovelGraphRunState, code: GraphStateValidationErrorCode): boolean {
  return validateGraphRunState(G, state).some((e) => e.code === code);
}

describe('validateGraphRunState（graph-aware）', () => {
  it('合法初始状态有效', () => {
    expect(isValidGraphRunState(G, fresh())).toBe(true);
  });

  it('合法 completed 状态有效（EXPORT_READY succeeded，frontier 空）', () => {
    const s = fresh();
    const completed: IdeaToNovelGraphRunState = {
      ...s,
      nodeStatuses: {
        ...s.nodeStatuses,
        IDEA_CAPTURE: 'succeeded',
        EXPORT_READY: 'succeeded',
      },
      activeFrontier: [],
      terminalStatus: 'completed',
    };
    expect(isValidGraphRunState(G, completed)).toBe(true);
  });

  it('graphId/version 与权威 Graph 不一致 → 拒绝', () => {
    expect(hasCode({ ...fresh(), graphId: 'other' as never }, 'STATE_GRAPH_ID_MISMATCH')).toBe(
      true,
    );
  });

  it('nodeStatuses 缺节点 / 含未知节点 → 拒绝', () => {
    const nodeStatuses = Object.fromEntries(
      Object.entries(fresh().nodeStatuses).filter(([id]) => id !== DRAFT),
    ) as unknown as IdeaToNovelGraphRunState['nodeStatuses'];
    expect(hasCode({ ...fresh(), nodeStatuses }, 'STATE_NODE_KEY_SET_INCOMPLETE')).toBe(true);

    const withUnknown = {
      ...fresh(),
      nodeStatuses: { ...fresh().nodeStatuses, GHOST: 'pending' },
    } as unknown as IdeaToNovelGraphRunState;
    expect(hasCode(withUnknown, 'STATE_NODE_KEY_SET_UNKNOWN')).toBe(true);
  });

  it('activeFrontier 重复 / 与状态不一致 → 拒绝', () => {
    expect(
      hasCode(
        { ...fresh(), activeFrontier: [IDEA_CAPTURE, IDEA_CAPTURE] },
        'STATE_FRONTIER_DUPLICATE',
      ),
    ).toBe(true);
    expect(hasCode({ ...fresh(), activeFrontier: [] }, 'STATE_FRONTIER_STATUS_MISMATCH')).toBe(
      true,
    );
  });

  it('pending decision 与节点状态/类型不一致 → 拒绝', () => {
    const s = {
      ...fresh(),
      pendingHumanDecision: {
        nodeId: 'CANDIDATE_GATE' as never,
        decisionType: 'candidate_gate' as const,
      },
    };
    expect(hasCode(s, 'STATE_PENDING_DECISION_INCONSISTENT')).toBe(true);
  });

  it('terminal run frontier 必须为空；completed 时终止节点必须 succeeded', () => {
    const notEmpty = { ...fresh(), terminalStatus: 'completed' as const };
    expect(hasCode(notEmpty, 'STATE_TERMINAL_FRONTIER_NOT_EMPTY')).toBe(true);

    const nodeStatuses = { ...fresh().nodeStatuses, EXPORT_READY: 'pending' };
    const completed = {
      ...fresh(),
      nodeStatuses,
      activeFrontier: [],
      terminalStatus: 'completed' as const,
    };
    expect(hasCode(completed, 'STATE_TERMINAL_NODE_NOT_SUCCEEDED')).toBe(true);
  });

  it('attemptBudget 缺预算键 / 含未知键 / 计数非法 → 拒绝', () => {
    const attemptBudget = Object.fromEntries(
      Object.entries(fresh().attemptBudget).filter(([k]) => k !== 'rewrite'),
    ) as unknown as IdeaToNovelGraphRunState['attemptBudget'];
    expect(hasCode({ ...fresh(), attemptBudget }, 'STATE_BUDGET_KEY_SET_INCOMPLETE')).toBe(true);

    const unknownBudget = {
      ...fresh(),
      attemptBudget: { ...fresh().attemptBudget, bogus: 0 },
    } as unknown as IdeaToNovelGraphRunState;
    expect(hasCode(unknownBudget, 'STATE_BUDGET_KEY_SET_UNKNOWN')).toBe(true);

    const negative = {
      ...fresh(),
      attemptBudget: { ...fresh().attemptBudget, rewrite: -1 },
    };
    expect(hasCode(negative, 'STATE_BUDGET_COUNT_INVALID')).toBe(true);
  });

  it('artifacts 缺槽位 / 引用不匹配 / 空 ID → 拒绝', () => {
    const artifacts = { ...fresh().artifacts };
    delete (artifacts as Record<string, unknown>).idea;
    expect(hasCode({ ...fresh(), artifacts }, 'STATE_ARTIFACT_SLOT_INCOMPLETE')).toBe(true);

    const mismatched = {
      ...fresh(),
      artifacts: { ...fresh().artifacts, idea: artifactRef('manuscript', 'ms-x') },
    } as unknown as IdeaToNovelGraphRunState;
    expect(hasCode(mismatched, 'STATE_ARTIFACT_REF_MISMATCH')).toBe(true);
  });

  it('invalidatedArtifacts 重复 → 拒绝', () => {
    const invalidatedArtifacts = [
      artifactRef('storyBlueprint', 'bp-1'),
      artifactRef('storyBlueprint', 'bp-1'),
    ];
    expect(hasCode({ ...fresh(), invalidatedArtifacts }, 'STATE_INVALIDATED_DUPLICATE')).toBe(true);
  });

  it('拒绝额外 top-level 键（prototype 安全）', () => {
    const s = { ...fresh(), __proto__: {}, extra: 1 } as unknown as IdeaToNovelGraphRunState;
    expect(hasCode(s, 'STATE_EXTRA_KEY')).toBe(true);
  });

  it('空 ID → 拒绝', () => {
    expect(
      hasCode({ ...fresh(), projectId: '   ' as unknown as ProjectId }, 'STATE_EMPTY_ID'),
    ).toBe(true);
  });
});
