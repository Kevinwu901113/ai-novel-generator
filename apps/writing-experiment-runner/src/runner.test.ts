/**
 * Runner 端到端测试（fake invoke + 内存 fs，永不触网）。
 *
 * 覆盖：FULL_SELECTION 全成功（byte-stable 序列化）/ 多 case 顺序与聚合 /
 * invalid output / provider 错误 / partial failure / --max-cases（PARTIAL_SELECTION）/
 * generate vs run（evaluate + blind 产物）/ dry-run / abort / 无 secret / 无 raw error /
 * manifest 不变量。
 */

import { describe, it, expect } from 'vitest';
import {
  getBaselineSuite,
  validateSuite,
  type WritingEvaluationSuiteV1,
} from '@ai-novel/writing-evaluation';
import { runExperiment, type RunnerDeps, type RunOptions, type RunOutcome } from './runner.js';
import {
  createFakeFs,
  createQueuedInvoke,
  errorOutput,
  okOutput,
  type FakeFs,
} from './test-util.js';
import { fixedClock } from '@ai-novel/writing-evaluation';

function makeSourceSuite(caseIds: readonly string[]): WritingEvaluationSuiteV1 {
  const base = getBaselineSuite();
  const cases = base.cases.filter((c) => caseIds.includes(c.caseId));
  return validateSuite({ ...base, cases });
}

function writeSource(fs: FakeFs, suite: WritingEvaluationSuiteV1): string {
  const p = '/tmp/source.json';
  fs.writeFile(p, JSON.stringify(suite));
  return p;
}

function seqId(values: readonly string[]): () => string {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

interface RunHarness {
  fs: FakeFs;
  invoke: ReturnType<typeof createQueuedInvoke>;
  deps: RunnerDeps;
  run: (options?: Partial<RunOptions>) => Promise<RunOutcome>;
}

function makeHarness(
  suite: WritingEvaluationSuiteV1,
  outputs: readonly ReturnType<typeof okOutput>[],
  extra: {
    getApiKey?: () => Promise<string | null>;
    abort?: { aborted: boolean };
    idSequence?: readonly string[];
    clock?: string;
  } = {},
): RunHarness {
  const fs = createFakeFs();
  const sourcePath = writeSource(fs, suite);
  const invoke = createQueuedInvoke(outputs);
  const clock = fixedClock(extra.clock ?? '2026-08-02T00:00:00.000Z');
  const deps: RunnerDeps = {
    clock,
    idGenerator: extra.idSequence !== undefined ? seqId(extra.idSequence) : () => 'tok',
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    exists: fs.exists,
    mkdir: fs.mkdir,
    renameDir: fs.renameDir,
    removeDir: fs.removeDir,
    invoke,
    getApiKey: extra.getApiKey ?? (async () => 'sk-dummy'),
    abort: extra.abort ?? { aborted: false },
    log: () => {},
  };
  const run = (options: Partial<RunOptions> = {}): Promise<RunOutcome> =>
    runExperiment(deps, {
      command: 'generate',
      sourceSuitePath: sourcePath,
      outputDir: '/out/exp1',
      strategy: 'baseline-one-shot-v1',
      providerId: 'mimo-token-plan-cn',
      temperature: 0.7,
      maxTokens: 8192,
      force: false,
      dryRun: false,
      gitCommit: 'abc123',
      ...options,
    });
  return { fs, invoke, deps, run };
}

describe('策略注册表接入 runner', () => {
  it('antislop-v1 从注册表选中并写入 manifest / output suite', async () => {
    const suite = makeSourceSuite(['restrained-reunion']);
    const { fs, invoke, run } = makeHarness(suite, [okOutput('深夜站台，雨落了下来。')], {
      idSequence: ['exp-antislop', 'run-1', 'tok-a'],
    });
    const outcome = await run({ strategy: 'antislop-v1' });

    expect(outcome.runStatus).toBe('COMPLETE');
    expect(outcome.outputSuite?.suiteId).toBe('gq1-baseline-v1--antislop-v1--exp-antislop');
    expect(invoke.calls).toHaveLength(1);
    const manifest = JSON.parse(fs.readFile('/out/exp1/manifest.private.json'));
    expect(manifest.strategy).toEqual({
      strategyId: 'antislop-v1',
      strategyVersion: '1',
      promptVersion: 'antislop-v1.p1',
    });
    expect(manifest.cases[0].modelCallCount).toBe(1);
  });

  it('未知 strategy 前置拒绝且列出所有可用 id', async () => {
    const suite = makeSourceSuite(['restrained-reunion']);
    const { invoke, run } = makeHarness(suite, [okOutput('正文A')]);
    await expect(run({ strategy: 'unknown-v9' })).rejects.toThrow(
      /未知 strategy "unknown-v9"；可用: baseline-one-shot-v1, antislop-v1, antislop-v2/,
    );
    expect(invoke.calls).toHaveLength(0);
  });
});

describe('FULL_SELECTION 全成功（generate）', () => {
  it('3 case 串行生成：COMPLETE / satisfiesQ1 / output suite / 无 evaluate-blind / 聚合正确', async () => {
    const suite = makeSourceSuite([
      'restrained-reunion',
      'suspense-corridor',
      'two-voice-dialogue',
    ]);
    const outputs = [
      okOutput('正文一：深夜站台。'),
      okOutput('正文二：走廊尽头有声音。'),
      okOutput('正文三：面馆的灯还亮着。'),
    ];
    const { fs, invoke, run } = makeHarness(suite, outputs, {
      idSequence: ['exp-1', 'run-1', 'tok-a', 'tok-b', 'tok-c'],
      clock: '2026-08-02T00:00:00.000Z',
    });
    const outcome = await run();

    expect(outcome.runStatus).toBe('COMPLETE');
    expect(outcome.selectionMode).toBe('FULL_SELECTION');
    expect(outcome.satisfiesQ1).toBe(true);
    expect(outcome.outputSuite).not.toBeNull();
    expect(outcome.outputSuite?.suiteId).toBe('gq1-baseline-v1--baseline-one-shot-v1--exp-1');
    expect(outcome.exitCode).toBe(0);
    expect(invoke.calls).toHaveLength(3);
    // 串行：按 source 顺序调用
    expect(invoke.calls[0].model).toBe('mimo-v2.5-pro');
    // 聚合
    expect(outcome.aggregate.totalInputTokens).toBe(300);
    expect(outcome.aggregate.totalOutputTokens).toBe(150);
    expect(outcome.aggregate.selectedCount).toBe(3);
    expect(outcome.aggregate.succeededCount).toBe(3);
    expect(outcome.aggregate.failedCount).toBe(0);

    // generate 命令不产出 evaluate / blind
    expect(fs.exists('/out/exp1/evaluation.report.json')).toBe(false);
    expect(fs.exists('/out/exp1/blind.packet.json')).toBe(false);
    // 产出 output suite（candidates.private.json）
    const candidatesRaw = fs.readFile('/out/exp1/candidates.private.json');
    const candidates = validateSuite(JSON.parse(candidatesRaw));
    expect(candidates.suiteId).toBe('gq1-baseline-v1--baseline-one-shot-v1--exp-1');
    expect(candidates.cases.map((c) => c.caseId)).toEqual([
      'restrained-reunion',
      'suspense-corridor',
      'two-voice-dialogue',
    ]);
    // 没有残留 staging / backup
    expect(fs.exists('/out/exp1.gq2-tmp-run-1')).toBe(false);
    expect(fs.exists('/out/exp1.gq2-bak-run-1')).toBe(false);
  });

  it('同一批已捕获数据序列化 byte-stable（两次运行 manifest 相同）', async () => {
    const suite = makeSourceSuite(['restrained-reunion']);
    const outputs = [okOutput('深夜站台，雨落下来。')];
    const runOnce = async () => {
      const h = makeHarness(suite, outputs, {
        idSequence: ['exp-1', 'run-1', 'tok-a'],
        clock: '2026-08-02T00:00:00.000Z',
      });
      const outcome = await h.run();
      expect(outcome.runStatus).toBe('COMPLETE');
      return h.fs.readFile('/out/exp1/manifest.private.json');
    };
    const a = await runOnce();
    const b = await runOnce();
    expect(a).toBe(b);
  });
});

describe('invalid model output / provider 错误', () => {
  it('结构层不合格（空文本）→ PARTIAL_FAILURE + 非零退出 + 无 output suite + 安全错误', async () => {
    const suite = makeSourceSuite(['restrained-reunion']);
    const { fs, run } = makeHarness(suite, [okOutput('')]);
    const outcome = await run();
    expect(outcome.runStatus).toBe('PARTIAL_FAILURE');
    expect(outcome.satisfiesQ1).toBe(false);
    expect(outcome.outputSuite).toBeNull();
    expect(outcome.exitCode).toBe(2);
    expect(fs.exists('/out/exp1/candidates.private.json')).toBe(false);
    expect(fs.exists('/out/exp1/evaluation.report.json')).toBe(false);
    const caseResults = JSON.parse(fs.readFile('/out/exp1/case-results.private.json'));
    expect(caseResults.cases[0].status).toBe('FAILED');
    expect(caseResults.cases[0].safeErrorCode).toBe('MODEL_RESPONSE_INVALID');
    // failed case 不含 candidate 全文
    expect(caseResults.cases[0].candidate).toBeUndefined();
    // 失败诊断快照仍作为完整目录发布
    expect(fs.exists('/out/exp1/manifest.private.json')).toBe(true);
  });

  it('failed case 的 manifest 条目 textHash=null、candidateId=null（不冒充成功）', async () => {
    const suite = makeSourceSuite(['restrained-reunion']);
    const { run } = makeHarness(suite, [okOutput('')]);
    const outcome = await run();
    expect(outcome.runStatus).toBe('PARTIAL_FAILURE');
    expect(outcome.cases[0].status).toBe('FAILED');
    expect(outcome.cases[0].textHash).toBeNull();
    expect(outcome.cases[0].candidateId).toBeNull();
  });

  it('rate limit / timeout / network → 对应安全码，raw provider error 不进入 artifact', async () => {
    const suite = makeSourceSuite(['restrained-reunion', 'suspense-corridor']);
    const { fs, run } = makeHarness(suite, [
      errorOutput('PROVIDER_RATE_LIMITED'),
      errorOutput('PROVIDER_TIMEOUT'),
    ]);
    const outcome = await run();
    expect(outcome.runStatus).toBe('PARTIAL_FAILURE');
    const caseResults = JSON.parse(fs.readFile('/out/exp1/case-results.private.json'));
    expect(caseResults.cases[0].safeErrorCode).toBe('PROVIDER_RATE_LIMITED');
    expect(caseResults.cases[0].safeErrorMessage).toBe('请求频率超限');
    expect(caseResults.cases[1].safeErrorCode).toBe('PROVIDER_TIMEOUT');
    const manifestRaw = fs.readFile('/out/exp1/manifest.private.json');
    expect(manifestRaw).not.toContain('RAW provider error message');
    expect(caseResultsRawNotContain(fs, 'RAW provider error message')).toBe(true);
  });

  it('continue-on-case-error：一个失败其余成功，仍发布诊断快照', async () => {
    const suite = makeSourceSuite([
      'restrained-reunion',
      'suspense-corridor',
      'two-voice-dialogue',
    ]);
    const { fs, run } = makeHarness(suite, [
      okOutput('正文A'),
      errorOutput('NETWORK_UNAVAILABLE'),
      okOutput('正文C'),
    ]);
    const outcome = await run();
    expect(outcome.runStatus).toBe('PARTIAL_FAILURE');
    expect(outcome.aggregate.succeededCount).toBe(2);
    expect(outcome.aggregate.failedCount).toBe(1);
    // 成功 case 的 candidate 全文保留在 private case-results
    const caseResults = JSON.parse(fs.readFile('/out/exp1/case-results.private.json'));
    expect(caseResults.cases[0].candidate.text).toContain('正文A');
    expect(caseResults.cases[2].candidate.text).toContain('正文C');
  });

  it('默认预算 8192 下每 case 恰好一次 invoke；失败不重复调用（无隐藏 retry）', async () => {
    const suite = makeSourceSuite(['restrained-reunion', 'suspense-corridor']);
    const { invoke, run } = makeHarness(suite, [
      okOutput('正文A'),
      errorOutput('PROVIDER_TIMEOUT'),
    ]);
    const outcome = await run(); // 不显式传 maxTokens → 走 harness 默认 8192
    expect(outcome.runStatus).toBe('PARTIAL_FAILURE');
    expect(invoke.calls).toHaveLength(2);
    for (const call of invoke.calls) {
      expect(call.maxTokens).toBe(8192);
    }
  });
});

describe('--max-cases（PARTIAL_SELECTION）', () => {
  it('maxCases=1 → PARTIAL_SELECTION + satisfiesQ1=false + 无 output suite + 无 evaluate/blind', async () => {
    const suite = makeSourceSuite(['restrained-reunion', 'suspense-corridor']);
    const { fs, run } = makeHarness(suite, [okOutput('正文A')], {
      idSequence: ['exp-smoke', 'run-1', 'tok-a'],
    });
    const outcome = await run({ maxCases: 1 });
    expect(outcome.selectionMode).toBe('PARTIAL_SELECTION');
    expect(outcome.selectedCaseIds).toEqual(['restrained-reunion']);
    expect(outcome.runStatus).toBe('PARTIAL_SELECTION_SUCCEEDED');
    expect(outcome.satisfiesQ1).toBe(false);
    expect(outcome.outputSuite).toBeNull();
    expect(outcome.exitCode).toBe(0); // smoke 成功 exit 0
    expect(fs.exists('/out/exp1/candidates.private.json')).toBe(false);
    expect(fs.exists('/out/exp1/evaluation.report.json')).toBe(false);
    const manifest = JSON.parse(fs.readFile('/out/exp1/manifest.private.json'));
    expect(manifest.satisfiesQ1).toBe(false);
    expect(manifest.note).toContain('不满足 Q1');
  });

  it('maxCases 超过 case 总数 → 前置拒绝', async () => {
    const suite = makeSourceSuite(['restrained-reunion']);
    const { run } = makeHarness(suite, [okOutput('x')]);
    await expect(run({ maxCases: 2 })).rejects.toThrow(/超过用例总数/);
  });
});

describe('run 命令（evaluate + blind）', () => {
  it('全成功后产出 evaluation report + blind packet + private mapping', async () => {
    const suite = makeSourceSuite(['restrained-reunion', 'suspense-corridor']);
    const { fs, run } = makeHarness(suite, [okOutput('正文A'), okOutput('正文B')], {
      idSequence: ['exp-r', 'run-1', 'tok-a', 'tok-b'],
    });
    const outcome = await run({ command: 'run', seed: 'gq2-seed' });
    expect(outcome.runStatus).toBe('COMPLETE');
    expect(outcome.satisfiesQ1).toBe(true);
    expect(fs.exists('/out/exp1/evaluation.report.json')).toBe(true);
    expect(fs.exists('/out/exp1/evaluation.report.md')).toBe(true);
    expect(fs.exists('/out/exp1/blind.packet.json')).toBe(true);
    expect(fs.exists('/out/exp1/blind.mapping.private.json')).toBe(true);
    // report 不含 candidate 全文（只含 textHash）
    const report = JSON.parse(fs.readFile('/out/exp1/evaluation.report.json'));
    expect(JSON.stringify(report)).not.toContain('正文A');
    expect(JSON.stringify(report)).toContain('textHash');
    // blind packet 含候选正文，但不含身份字段
    const packetRaw = fs.readFile('/out/exp1/blind.packet.json');
    expect(packetRaw).toContain('正文A');
    expect(packetRaw).not.toContain('tok-a');
    expect(packetRaw).not.toContain('"strategyId"');
    expect(packetRaw).not.toContain('"modelId"');
    expect(packetRaw).not.toContain('"candidateId"');
    // private mapping 不进入 stdout（本测试只验证落盘）
    expect(fs.exists('/out/exp1/blind.mapping.private.json')).toBe(true);
  });

  it('run 缺 --seed 时即使全成功也报错', async () => {
    const suite = makeSourceSuite(['restrained-reunion']);
    const { run } = makeHarness(suite, [okOutput('正文A')]);
    await expect(run({ command: 'run' })).rejects.toThrow(/--seed/);
  });
});

describe('dry-run', () => {
  it('dry-run 不调用模型、不写 artifact、无需 key，返回预览', async () => {
    const suite = makeSourceSuite(['restrained-reunion', 'suspense-corridor']);
    const { invoke, run } = makeHarness(suite, [], { getApiKey: async () => null });
    const outcome = await run({ dryRun: true });
    expect(outcome.dryRun).toBe(true);
    expect(invoke.calls).toHaveLength(0);
    expect(outcome.preview?.cases).toHaveLength(2);
    expect(outcome.preview?.cases[0].promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.preview?.selectedCaseIds).toEqual(['restrained-reunion', 'suspense-corridor']);
  });
});

describe('abort（ABORTED）', () => {
  it('第一个 case 后触发 abort → ABORTED + 部分诊断快照 + 无 output suite', async () => {
    const suite = makeSourceSuite([
      'restrained-reunion',
      'suspense-corridor',
      'two-voice-dialogue',
    ]);
    const abort = { aborted: false };
    const fs = createFakeFs();
    const sourcePath = writeSource(fs, suite);
    const innerInvoke = createQueuedInvoke([
      okOutput('正文A'),
      okOutput('正文B'),
      okOutput('正文C'),
    ]);
    const invoke = async (input: Parameters<typeof innerInvoke>[0]) => {
      const out = await innerInvoke(input);
      abort.aborted = true; // 第一个 case 完成后立即 abort
      return out;
    };
    const deps: RunnerDeps = {
      clock: fixedClock('2026-08-02T00:00:00.000Z'),
      idGenerator: seqId(['exp-a', 'run-1', 'tok-a', 'tok-b', 'tok-c']),
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
      renameDir: fs.renameDir,
      removeDir: fs.removeDir,
      invoke,
      getApiKey: (async () => 'sk-dummy') as RunnerDeps['getApiKey'],
      abort,
      log: () => {},
    };
    const outcome = await runExperiment(deps, {
      command: 'generate',
      sourceSuitePath: sourcePath,
      outputDir: '/out/exp1',
      strategy: 'baseline-one-shot-v1',
      providerId: 'mimo-token-plan-cn',
      temperature: 0.7,
      maxTokens: 8192,
      force: false,
      dryRun: false,
      gitCommit: null,
    });
    expect(outcome.runStatus).toBe('ABORTED');
    expect(outcome.exitCode).toBe(130);
    expect(outcome.satisfiesQ1).toBe(false);
    expect(outcome.aggregate.selectedCount).toBe(1); // 只处理了第一个 case
    expect(outcome.outputSuite).toBeNull();
    expect(fs.exists('/out/exp1/candidates.private.json')).toBe(false);
    // 诊断快照仍发布
    expect(fs.exists('/out/exp1/manifest.private.json')).toBe(true);
    const manifest = JSON.parse(fs.readFile('/out/exp1/manifest.private.json'));
    expect(manifest.runStatus).toBe('ABORTED');
  });
});

describe('安全边界', () => {
  it('artifact 不含 API key', async () => {
    const suite = makeSourceSuite(['restrained-reunion']);
    const { fs, run } = makeHarness(suite, [okOutput('正文A')], {
      getApiKey: async () => 'sk-super-secret-live-key',
    });
    await run();
    for (const p of fs.list('/out/exp1')) {
      const content = fs.readFile(p);
      expect(content).not.toContain('sk-super-secret-live-key');
    }
  });

  it('manifest 不含绝对路径 / 完整 prompt / candidate 全文', async () => {
    const suite = makeSourceSuite(['restrained-reunion']);
    const { fs, run } = makeHarness(suite, [okOutput('某段正文内容XYZ')]);
    await run();
    const manifest = fs.readFile('/out/exp1/manifest.private.json');
    expect(manifest).not.toContain('/tmp/');
    expect(manifest).not.toContain('【创作契约】');
    expect(manifest).not.toContain('某段正文内容XYZ');
    expect(manifest).not.toContain('sk-dummy');
  });
});

function caseResultsRawNotContain(fs: FakeFs, needle: string): boolean {
  const raw = fs.readFile('/out/exp1/case-results.private.json');
  return !raw.includes(needle);
}
