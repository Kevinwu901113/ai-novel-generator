/**
 * BLUEPRINT_GENERATE executor 单测（B7）：prepareTask 引导字段提取 + researchBundle
 * 缺失分支（D-B7-7）。执行链路（claim/envelope/最终事务/gate accept 原子闭环）见
 * apps/worker/src/blueprint-e2e.integration.test.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  ExecutorRegistry,
  type NodeExecutionInputContext,
  type NodeExecutorRunner,
} from '@ai-novel/application';
import {
  registerBlueprintExecutors,
  BLUEPRINT_GENERATE_DESCRIPTOR,
} from './blueprint-executors.js';

function ctx(inputSnapshot: unknown): NodeExecutionInputContext {
  return {
    projectId: 'p1',
    graphRunId: 'run-1',
    nodeId: 'BLUEPRINT_GENERATE',
    executionId: 'exec-1',
    activationNo: 1,
    attemptNo: 1,
    inputSnapshot,
    inputHash: 'hash-1',
  };
}

function buildRunners(): Map<string, NodeExecutorRunner> {
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
  registerBlueprintExecutors(registry, runners, {
    getProjectDb: () => {
      throw new Error('prepareTask 不应访问数据库');
    },
    idGenerator: { generate: () => 'unused' },
    clock: { now: () => '2026-08-11T00:00:00.000Z' },
  });
  return runners;
}

function prepareTaskOf(runners: Map<string, NodeExecutorRunner>) {
  const runner = runners.get(BLUEPRINT_GENERATE_DESCRIPTOR.executorId);
  if (!runner || !('prepareTask' in runner)) {
    throw new Error('BLUEPRINT_GENERATE executor 未注册为 task_backed');
  }
  return runner.prepareTask.bind(runner);
}

describe('registerBlueprintExecutors', () => {
  it('注册 task_backed descriptor（recoveryPolicy=settle_if_result）', () => {
    const registry = new ExecutorRegistry();
    const runners = new Map<string, NodeExecutorRunner>();
    registerBlueprintExecutors(registry, runners, {
      getProjectDb: () => {
        throw new Error('unused');
      },
      idGenerator: { generate: () => 'unused' },
      clock: { now: () => '2026-08-11T00:00:00.000Z' },
    });
    expect(BLUEPRINT_GENERATE_DESCRIPTOR.kind).toBe('task_backed');
    expect(BLUEPRINT_GENERATE_DESCRIPTOR.recoveryPolicy).toBe('settle_if_result');
    expect(runners.has(BLUEPRINT_GENERATE_DESCRIPTOR.executorId)).toBe(true);
  });

  it('prepareTask：提取 ideaSessionId / creationSpecVersionId（必需）+ researchBundleId + rewriteAttempt', () => {
    const prepareTask = prepareTaskOf(buildRunners());
    const spec = prepareTask(
      ctx({
        artifacts: {
          idea: { artifactId: 'idea-1' },
          creationSpec: { artifactId: 'spec-1' },
          researchBundle: { artifactId: 'bundle-1' },
        },
        budget: { blueprintRewrite: 2 },
      }),
    );
    expect(spec.taskType).toBe('BLUEPRINT_GENERATE');
    const payload = JSON.parse(spec.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      creationSpecVersionId: 'spec-1',
      ideaSessionId: 'idea-1',
      researchBundleId: 'bundle-1',
      rewriteAttempt: 2,
    });
  });

  it('D-B7-7：researchBundle 缺失时 researchBundleId=null（none / skip_research 路径），不抛错', () => {
    const prepareTask = prepareTaskOf(buildRunners());
    const spec = prepareTask(
      ctx({
        artifacts: {
          idea: { artifactId: 'idea-1' },
          creationSpec: { artifactId: 'spec-1' },
        },
        budget: {},
      }),
    );
    const payload = JSON.parse(spec.payloadJson) as Record<string, unknown>;
    expect(payload.researchBundleId).toBeNull();
    // 无 budget.blueprintRewrite 时按首次生成计（0 次改写）
    expect(payload.rewriteAttempt).toBe(0);
  });

  it('缺少必需 artifact（idea）时抛错', () => {
    const prepareTask = prepareTaskOf(buildRunners());
    expect(() =>
      prepareTask(
        ctx({
          artifacts: { creationSpec: { artifactId: 'spec-1' } },
          budget: {},
        }),
      ),
    ).toThrow(/idea/);
  });

  it('缺少必需 artifact（creationSpec）时抛错', () => {
    const prepareTask = prepareTaskOf(buildRunners());
    expect(() =>
      prepareTask(
        ctx({
          artifacts: { idea: { artifactId: 'idea-1' } },
          budget: {},
        }),
      ),
    ).toThrow(/creationSpec/);
  });
});
