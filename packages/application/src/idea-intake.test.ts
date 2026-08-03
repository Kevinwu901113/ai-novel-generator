/**
 * Idea Intake 适配测试（GE-3）。
 *
 * - createIntakeSessionFromIdea：把 initial_idea 播种进 intake 会话目标（复用 grill_sessions）；
 * - getActiveIntakeSession：读取最新 ACTIVE 会话；
 * - propagateCreationSpecInvalidation：CreationSpec 更新 → researchBundle/storyBlueprint 失效；
 * - applyArtifactChange：仅对 Project run 生效；chapter run 不适用（kind 校验）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyArtifactChange,
  createIntakeSessionFromIdea,
  createProjectRun,
  getActiveIntakeSession,
  propagateCreationSpecInvalidation,
  runFakeUntilHumanOrTerminal,
  type FakeExecutorConfig,
} from './index.js';
import { createTestDeps } from './graph-run-test-fakes.js';
import { BLUEPRINT_USER_GATE, RESEARCH_DECISION } from '@ai-novel/domain';
import type { GrillSessionData, GrillSessionRepositoryPort } from './grill-types.js';
import type { GrillSessionDeps } from './grill-session.js';
import type { IdeaToNovelProjectRunState } from '@ai-novel/domain';

const NOW = '2026-08-04T00:00:00.000Z';

function fakeGrillDeps(): GrillSessionDeps {
  const sessions = new Map<string, GrillSessionData>();
  const sessionRepo: GrillSessionRepositoryPort = {
    create(data) {
      sessions.set(data.id, {
        id: data.id,
        projectId: data.projectId,
        status: 'DRAFT',
        version: 1,
        goal: data.goal,
        createdAt: NOW,
        updatedAt: NOW,
        startedAt: null,
        completedAt: null,
        abandonedAt: null,
      });
    },
    getById(id) {
      return sessions.get(id) ?? null;
    },
    listByProject(projectId) {
      return [...sessions.values()].filter((s) => s.projectId === projectId);
    },
    transitionStatus(id, expectedVersion, newStatus) {
      const s = sessions.get(id);
      if (!s || s.version !== expectedVersion) return false;
      sessions.set(id, { ...s, status: newStatus, updatedAt: NOW });
      return true;
    },
    bumpVersion(id, expectedVersion) {
      const s = sessions.get(id);
      if (!s || s.version !== expectedVersion) return false;
      sessions.set(id, { ...s, version: expectedVersion + 1, updatedAt: NOW });
      return true;
    },
  };
  return {
    idGenerator: { generate: () => 'sess-1' },
    clock: { now: () => NOW },
    sessionRepo,
    questionRepo: {
      create: () => undefined,
      getById: () => null,
      listBySession: () => [],
      markAsked: () => true,
      markAnswered: () => true,
      markSkipped: () => true,
      markSuperseded: () => true,
      getMaxSequence: () => 0,
    },
    answerRepo: {
      create: () => undefined,
      getById: () => null,
      getCurrentByQuestion: () => null,
      listByQuestion: () => [],
      listCurrentBySession: () => [],
      supersedeCurrent: () => true,
    },
    proposalRepo: {
      create: () => undefined,
      getById: () => null,
      listBySession: () => [],
      markAccepted: () => true,
      markRejected: () => true,
      markSuperseded: () => true,
    },
    transaction: <T>(fn: () => T) => fn(),
  };
}

describe('Idea Intake adaptation', () => {
  let graph: ReturnType<typeof createTestDeps>;
  let deps: ReturnType<typeof createTestDeps>['deps'];

  beforeEach(() => {
    graph = createTestDeps();
    deps = graph.deps;
  });

  it('createIntakeSessionFromIdea 把 initial_idea 播种进会话目标并 ACTIVE', () => {
    const grillDeps = fakeGrillDeps();
    const session = createIntakeSessionFromIdea(
      { grillDeps, graphDeps: deps },
      { projectId: 'p1', initialIdea: '一个侦探在雨夜调查悬案' },
    );
    expect(session.goal).toBe('一个侦探在雨夜调查悬案');
    expect(session.status).toBe('ACTIVE');

    const active = getActiveIntakeSession({ grillDeps, graphDeps: deps }, { projectId: 'p1' });
    expect(active?.id).toBe(session.id);
  });

  it('propagateCreationSpecInvalidation：CreationSpec 更新 → researchBundle/storyBlueprint 失效', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c1' });
    // 用 research=light 跑到蓝图 gate（researchBundle 已产出）
    const config: FakeExecutorConfig = { [RESEARCH_DECISION]: { outcome: 'light' } };
    const stop = runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, config);
    expect(stop.state.pendingHumanDecision?.nodeId).toBe(BLUEPRINT_USER_GATE);

    const results = propagateCreationSpecInvalidation(
      { grillDeps: fakeGrillDeps(), graphDeps: deps },
      { projectId: 'p1', creationSpecVersionId: 'spec-v2' },
    );
    expect(results).toHaveLength(1);
    expect(results[0].runId).toBe(run.workflowRunId);
    expect(results[0].invalidatedKinds).toEqual(
      expect.arrayContaining(['researchBundle', 'storyBlueprint']),
    );

    const after = deps.tx.runInTransaction((repos) =>
      repos.graphRunRepo.getById(run.workflowRunId),
    )!.state as IdeaToNovelProjectRunState;
    expect(after.invalidatedArtifacts.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['researchBundle', 'storyBlueprint']),
    );
    expect(after.artifacts.creationSpec?.artifactId).toBe('spec-v2');
  });

  it('applyArtifactChange 对已完成 researchBundle 的 run：再播种 spec 后 researchBundle 仍失效', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c2' });
    const config: FakeExecutorConfig = { [RESEARCH_DECISION]: { outcome: 'light' } };
    runFakeUntilHumanOrTerminal(deps, 'p1', run.workflowRunId, config);

    const res = applyArtifactChange(deps, {
      projectId: 'p1',
      runId: run.workflowRunId,
      artifactKind: 'creationSpec',
      artifactId: 'spec-v3',
      idempotencyKey: 'spec-apply',
    }).run as IdeaToNovelProjectRunState;
    expect(res.artifacts.creationSpec?.artifactId).toBe('spec-v3');
    expect(res.invalidatedArtifacts.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['researchBundle', 'storyBlueprint']),
    );
  });

  it('propagate 幂等：同一 spec 版本重复传播 → deduped，不重复叠加', () => {
    const { run } = createProjectRun(deps, { projectId: 'p1', idempotencyKey: 'c3' });
    advanceToBlueprint(deps, run.workflowRunId);
    const a = propagateCreationSpecInvalidation(
      { grillDeps: fakeGrillDeps(), graphDeps: deps },
      { projectId: 'p1', creationSpecVersionId: 'spec-v4' },
    );
    const b = propagateCreationSpecInvalidation(
      { grillDeps: fakeGrillDeps(), graphDeps: deps },
      { projectId: 'p1', creationSpecVersionId: 'spec-v4' },
    );
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    const state = deps.tx.runInTransaction((repos) =>
      repos.graphRunRepo.getById(run.workflowRunId),
    )!.state as IdeaToNovelProjectRunState;
    expect(state.invalidatedArtifacts.length).toBeGreaterThan(0);
  });
});

function advanceToBlueprint(deps: ReturnType<typeof createTestDeps>['deps'], runId: string): void {
  const config: FakeExecutorConfig = { [RESEARCH_DECISION]: { outcome: 'none' } };
  runFakeUntilHumanOrTerminal(deps, 'p1', runId, config);
}
