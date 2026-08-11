/**
 * BLUEPRINT_GENERATE executor 单测（B7）：prepareTask 引导字段提取 + researchBundle
 * 缺失分支（D-B7-7）+ skip_research 分支（D-B7-14）。执行链路（claim/envelope/
 * 最终事务/gate accept 原子闭环）见 apps/worker/src/blueprint-e2e.integration.test.ts。
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

  it('prepareTask：提取 ideaSessionId / creationSpecVersionId（必需）+ researchBundleId + rewriteAttempt（无 RESEARCH_ESCALATION outcome 时 researchSkippedByUser=false）', () => {
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
      researchSkippedByUser: false,
      rewriteAttempt: 2,
    });
  });

  it('D-B7-7：researchBundle 缺失时 researchBundleId=null（none 路径），不抛错', () => {
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
    expect(payload.researchSkippedByUser).toBe(false);
    // 无 budget.blueprintRewrite 时按首次生成计（0 次改写）
    expect(payload.rewriteAttempt).toBe(0);
  });

  it('D-B7-14：outcomes.RESEARCH_ESCALATION 缺失（研究计划 none / 直接 valid 路径未经过 escalation）时按"未跳过"处理，不抛错', () => {
    const prepareTask = prepareTaskOf(buildRunners());
    const spec = prepareTask(
      ctx({
        artifacts: {
          idea: { artifactId: 'idea-1' },
          creationSpec: { artifactId: 'spec-1' },
          researchBundle: { artifactId: 'bundle-1' },
        },
        // outcomes 字段本身缺失（未声明快照）——等价于 RESEARCH_ESCALATION 未产出
        budget: {},
      }),
    );
    const payload = JSON.parse(spec.payloadJson) as Record<string, unknown>;
    expect(payload.researchSkippedByUser).toBe(false);
    expect(payload.researchBundleId).toBe('bundle-1');
  });

  it('D-B7-14：outcome=skip_research 时不传 researchBundleId，即使 artifacts.researchBundle 非空', () => {
    const prepareTask = prepareTaskOf(buildRunners());
    const spec = prepareTask(
      ctx({
        artifacts: {
          idea: { artifactId: 'idea-1' },
          creationSpec: { artifactId: 'spec-1' },
          researchBundle: { artifactId: 'bundle-1' },
        },
        budget: {},
        outcomes: {
          RESEARCH_ESCALATION: {
            condition: 'research_escalation_decision',
            value: 'skip_research',
          },
        },
      }),
    );
    const payload = JSON.parse(spec.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      creationSpecVersionId: 'spec-1',
      ideaSessionId: 'idea-1',
      researchBundleId: null,
      researchSkippedByUser: true,
      rewriteAttempt: 0,
    });
  });

  it('D-B7-14：outcome=use_current_research 时正常传 researchBundleId（researchSkippedByUser=false）', () => {
    const prepareTask = prepareTaskOf(buildRunners());
    const spec = prepareTask(
      ctx({
        artifacts: {
          idea: { artifactId: 'idea-1' },
          creationSpec: { artifactId: 'spec-1' },
          researchBundle: { artifactId: 'bundle-1' },
        },
        budget: {},
        outcomes: {
          RESEARCH_ESCALATION: {
            condition: 'research_escalation_decision',
            value: 'use_current_research',
          },
        },
      }),
    );
    const payload = JSON.parse(spec.payloadJson) as Record<string, unknown>;
    expect(payload.researchSkippedByUser).toBe(false);
    expect(payload.researchBundleId).toBe('bundle-1');
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
