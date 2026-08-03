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

  it('拒绝额外 top-level 键 / 自定义原型（prototype 安全）', () => {
    expect(
      hasCode({ ...fresh(), extra: 1 } as unknown as IdeaToNovelGraphRunState, 'STATE_EXTRA_KEY'),
    ).toBe(true);
    const customProto = Object.create({});
    Object.assign(customProto, fresh());
    expect(
      hasCode(customProto as unknown as IdeaToNovelGraphRunState, 'STATE_CUSTOM_PROTOTYPE'),
    ).toBe(true);
  });

  it('空 ID → 拒绝', () => {
    expect(
      hasCode({ ...fresh(), projectId: '   ' as unknown as ProjectId }, 'STATE_EMPTY_ID'),
    ).toBe(true);
  });
});

describe('Second Review：state validator 边界', () => {
  it('unknown 输入矩阵永不抛异常', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      42,
      'x',
      [],
      {},
      Object.create({}),
      Object.create(null),
      { ...fresh(), __proto__: {} },
      { ...fresh(), extra: 1 },
      { graphId: 'g', graphVersion: 'v' },
    ];
    for (const input of malformed) {
      expect(() => validateGraphRunState(G, input)).not.toThrow();
    }
  });

  it('缺失必需 top-level 键 → STATE_MISSING_KEY', () => {
    const s = { ...fresh() };
    delete (s as Record<string, unknown>).workflowRunId;
    expect(hasCode(s, 'STATE_MISSING_KEY')).toBe(true);
  });

  it('consumedEdges 未知 / 重复边 → 拒绝', () => {
    expect(hasCode({ ...fresh(), consumedEdges: ['no-such-edge'] }, 'STATE_CONSUMED_UNKNOWN')).toBe(
      true,
    );
    expect(
      hasCode(
        { ...fresh(), consumedEdges: ['idea-capture--spec-extract', 'idea-capture--spec-extract'] },
        'STATE_CONSUMED_DUPLICATE',
      ),
    ).toBe(true);
  });

  it('waiting_without_pending：waiting_for_human 节点必须有对应 pending decision', () => {
    const s = fresh();
    const nodeStatuses = { ...s.nodeStatuses, IDEA_CAPTURE: 'waiting_for_human' as const };
    expect(
      hasCode(
        { ...s, nodeStatuses, activeFrontier: [IDEA_CAPTURE] },
        'STATE_PENDING_DECISION_INCONSISTENT',
      ),
    ).toBe(true);
  });

  it('nodeOutcomes：节点未 succeeded / condition 与契约不一致 / value 非法 → 拒绝', () => {
    const s = fresh();
    const notSucceeded = {
      ...s,
      nodeOutcomes: {
        IDEA_CAPTURE: { condition: 'clarification_remaining', value: 'spec_complete' },
      },
    } as unknown as IdeaToNovelGraphRunState;
    expect(hasCode(notSucceeded, 'STATE_OUTCOME_NODE_NOT_SUCCEEDED')).toBe(true);

    // IDEA_CAPTURE succeeded，但 outcome condition 与其契约（无 outcome）不一致
    const nodeStatuses = { ...s.nodeStatuses, IDEA_CAPTURE: 'succeeded' as const };
    const mismatch = {
      ...s,
      nodeStatuses,
      activeFrontier: [],
      nodeOutcomes: { IDEA_CAPTURE: { condition: 'research_decision', value: 'none' } },
    } as unknown as IdeaToNovelGraphRunState;
    expect(hasCode(mismatch, 'STATE_OUTCOME_CONDITION_MISMATCH')).toBe(true);
  });

  it('pending decision 嵌套 exact keys → STATE_PENDING_KEYS', () => {
    const s = {
      ...fresh(),
      pendingHumanDecision: { nodeId: 'CANDIDATE_GATE', decisionType: 'candidate_gate', extra: 1 },
    } as unknown as IdeaToNovelGraphRunState;
    expect(hasCode(s, 'STATE_PENDING_KEYS')).toBe(true);
  });

  it('artifact ref 嵌套 exact keys → STATE_ARTIFACT_REF_KEYS', () => {
    const artifacts = { ...fresh().artifacts, idea: { kind: 'idea', artifactId: 'i', extra: 1 } };
    const s = { ...fresh(), artifacts } as unknown as IdeaToNovelGraphRunState;
    expect(hasCode(s, 'STATE_ARTIFACT_REF_KEYS')).toBe(true);
  });

  it('createdAt 校验 → STATE_CREATED_AT_INVALID', () => {
    expect(
      hasCode(
        { ...fresh(), createdAt: '' } as unknown as IdeaToNovelGraphRunState,
        'STATE_CREATED_AT_INVALID',
      ),
    ).toBe(true);
  });
});
