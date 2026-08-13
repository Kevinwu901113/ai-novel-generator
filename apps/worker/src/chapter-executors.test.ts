/**
 * 章节生成节点 executor 注册与 prepareTask 测试（GE-6 / B9）。
 *
 * - 注册覆盖：图上除人工 Gate 与 MANUSCRIPT_COMMIT 之外的所有节点都能查到 executor
 *   （结构性守卫：将来图上加节点而忘了注册 executor 即红）；
 * - MANUSCRIPT_COMMIT 有意不注册（GE-7 才接线）——这条断言防止"顺手补齐"越过
 *   锁定不变量第 5 条；
 * - prepareTask：payload 只带三个循环预算计数，不含任何身份字段（D-B9-2）；
 * - CRITIQUE_JOIN：sync executor 恒返回 {}（D-B9-4：outcome 由 domain 聚合，
 *   自带 outcome 会被 completeNode 直接拒绝）。
 */

import { describe, it, expect } from 'vitest';
import { ExecutorRegistry, type NodeExecutorRunner } from '@ai-novel/application';
import type {
  NodeExecutionInputContext,
  SyncNodeExecutor,
  TaskBackedNodeExecutor,
} from '@ai-novel/application';
import {
  CANDIDATE_ESCALATION,
  CANDIDATE_GATE,
  CHAPTER_GENERATION_GRAPH_V1,
  CHAPTER_PLAN,
  CONTINUITY_CRITIC,
  CRITIQUE_JOIN,
  DRAFT,
  MANUSCRIPT_COMMIT,
  REQUIREMENT_CRITIC,
  REWRITE,
  STYLE_CRITIC,
} from '@ai-novel/domain';
import { registerChapterExecutors } from './chapter-executors.js';

const clock = { now: () => '2026-08-13T00:00:00.000Z' };
const idGenerator = { generate: () => 'id-1' };

function buildRegistry() {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
  registerChapterExecutors(registry, runners, {
    getProjectDb: () => {
      throw new Error('本测试不触碰数据库');
    },
    idGenerator,
    clock,
  });
  return { registry, runners };
}

function ctxWithBudget(budget: Record<string, unknown>): NodeExecutionInputContext {
  return {
    projectId: 'p1',
    graphRunId: 'run-1',
    nodeId: DRAFT,
    executionId: 'exec-1',
    activationNo: 1,
    attemptNo: 1,
    inputSnapshot: { budget },
    inputHash: 'h'.repeat(64),
  };
}

describe('registerChapterExecutors', () => {
  it('图上除人工 Gate 与 MANUSCRIPT_COMMIT 外的节点都注册了 executor', () => {
    const { registry } = buildRegistry();
    const humanNodes = new Set<string>([CANDIDATE_GATE, CANDIDATE_ESCALATION]);
    const missing = CHAPTER_GENERATION_GRAPH_V1.nodes
      .filter((n) => !humanNodes.has(n.id) && n.id !== MANUSCRIPT_COMMIT)
      .filter((n) => registry.get({ graphKind: 'chapter', nodeId: n.id }) === null)
      .map((n) => n.id);
    expect(missing).toEqual([]);
  });

  it('MANUSCRIPT_COMMIT 有意不注册（写入权威稿件属 GE-7）', () => {
    const { registry } = buildRegistry();
    expect(registry.get({ graphKind: 'chapter', nodeId: MANUSCRIPT_COMMIT })).toBeNull();
  });

  it('三个终止节点均已注册 sync executor（TD-029-4）', () => {
    const { registry } = buildRegistry();
    for (const node of CHAPTER_GENERATION_GRAPH_V1.nodes.filter((n) => n.kind === 'TERMINAL')) {
      const descriptor = registry.get({ graphKind: 'chapter', nodeId: node.id });
      expect(descriptor).not.toBeNull();
      expect(descriptor!.kind).toBe('sync');
    }
  });

  it('task-backed 节点的任务类型映射正确', () => {
    const { registry } = buildRegistry();
    const expected: ReadonlyArray<readonly [string, string]> = [
      [CHAPTER_PLAN, 'CHAPTER_PLAN'],
      [DRAFT, 'CHAPTER_DRAFT'],
      [CONTINUITY_CRITIC, 'CHAPTER_CRITIQUE'],
      [STYLE_CRITIC, 'CHAPTER_CRITIQUE'],
      [REQUIREMENT_CRITIC, 'CHAPTER_CRITIQUE'],
      [REWRITE, 'CHAPTER_REWRITE'],
    ];
    const { runners } = buildRegistry();
    for (const [nodeId, taskType] of expected) {
      const descriptor = registry.get({ graphKind: 'chapter', nodeId })!;
      expect(descriptor.kind).toBe('task_backed');
      const runner = runners.get(descriptor.executorId) as TaskBackedNodeExecutor;
      expect(runner.prepareTask(ctxWithBudget({})).taskType).toBe(taskType);
    }
  });

  it('prepareTask 只带循环预算计数，不含任何身份字段（D-B9-2）', () => {
    const { registry, runners } = buildRegistry();
    const descriptor = registry.get({ graphKind: 'chapter', nodeId: REWRITE })!;
    const runner = runners.get(descriptor.executorId) as TaskBackedNodeExecutor;
    const spec = runner.prepareTask(
      ctxWithBudget({ rewrite: 2, candidateRewrite: 1, regenerate: 0 }),
    );
    expect(JSON.parse(spec.payloadJson)).toEqual({
      rewriteAttempt: 2,
      candidateRewriteAttempt: 1,
      regenerateAttempt: 0,
    });
  });

  it('未声明的预算键读 0（节点 input 契约即隔离边界）', () => {
    const { registry, runners } = buildRegistry();
    const descriptor = registry.get({ graphKind: 'chapter', nodeId: CONTINUITY_CRITIC })!;
    const runner = runners.get(descriptor.executorId) as TaskBackedNodeExecutor;
    const spec = runner.prepareTask(ctxWithBudget({ rewrite: 3 }));
    expect(JSON.parse(spec.payloadJson)).toEqual({
      rewriteAttempt: 3,
      candidateRewriteAttempt: 0,
      regenerateAttempt: 0,
    });
  });

  it('CRITIQUE_JOIN 恒返回空产出（outcome 由 domain 聚合，自带会被拒绝）', () => {
    const { registry, runners } = buildRegistry();
    const descriptor = registry.get({ graphKind: 'chapter', nodeId: CRITIQUE_JOIN })!;
    expect(descriptor.kind).toBe('sync');
    const runner = runners.get(descriptor.executorId) as SyncNodeExecutor;
    expect(runner.execute(ctxWithBudget({}))).toEqual({});
  });
});
