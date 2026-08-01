/**
 * CLI 测试（fake invoke + fake fs，永不触网）。
 *
 * 覆盖：help / generate / run / dry-run / 默认 provider / 未知 provider /
 * 禁止选项 / max-cases（generate 允许、run 拒绝）/ 无自动重试 / partial failure 非零退出 /
 * stdout-stderr 分离 / 确定性序列化 / LIVE gate / Keychain 未配置。
 */

import { describe, it, expect } from 'vitest';
import { getBaselineSuite } from '@ai-novel/writing-evaluation';
import { fixedClock } from '@ai-novel/writing-evaluation';
import { runCli, type CliDeps } from './cli.js';
import {
  createFakeFs,
  createQueuedInvoke,
  errorOutput,
  okOutput,
  type FakeFs,
} from './test-util.js';

function seqId(values: readonly string[]): () => string {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

interface CliHarness {
  fs: FakeFs;
  out: string[];
  err: string[];
  invoke: ReturnType<typeof createQueuedInvoke>;
  deps: CliDeps;
  run: (argv: readonly string[]) => Promise<number>;
}

function makeCli(
  extra: Partial<CliDeps> = {},
  outputs: readonly ReturnType<typeof okOutput>[] = [okOutput('深夜站台，雨落下来。')],
): CliHarness {
  const fs = createFakeFs();
  const suite = getBaselineSuite();
  fs.writeFile('/tmp/source.json', JSON.stringify(suite));
  const out: string[] = [];
  const err: string[] = [];
  const invoke = createQueuedInvoke(outputs);
  const deps: CliDeps = {
    defaultClock: fixedClock('2026-08-02T00:00:00.000Z'),
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    exists: fs.exists,
    mkdir: fs.mkdir,
    renameDir: fs.renameDir,
    removeDir: fs.removeDir,
    invoke,
    getApiKey: async () => 'sk-dummy',
    idGenerator: seqId(['exp-1', 'run-1', 'tok-1']),
    gitCommit: 'abc123',
    ...extra,
  };
  const run = (argv: readonly string[]): Promise<number> => runCli(argv, deps);
  return { fs, out, err, invoke, deps, run };
}

describe('parse / usage errors', () => {
  it('help 输出到 stdout，exit 0', async () => {
    const h = makeCli();
    const code = await h.run(['help']);
    expect(code).toBe(0);
    expect(h.out.join('')).toContain('writing-experiment');
    expect(h.out.join('')).toContain('generate');
    expect(h.out.join('')).toContain('run');
  });

  it('未知命令 → exit 2', async () => {
    const h = makeCli();
    const code = await h.run(['frobnicate']);
    expect(code).toBe(2);
    expect(h.err.join('')).toContain('未知命令');
  });

  it('未知选项 → exit 2', async () => {
    const h = makeCli();
    const code = await h.run([
      'generate',
      '--suite',
      '/tmp/source.json',
      '--output',
      '/o',
      '--bogus',
    ]);
    expect(code).toBe(2);
    expect(h.err.join('')).toContain('未知选项');
  });

  it('缺少必需选项 --suite → 非零退出', async () => {
    const h = makeCli();
    const code = await h.run(['generate', '--output', '/o']);
    expect(code).toBe(1);
    expect(h.err.join('')).toContain('--suite');
  });
});

describe('禁止选项', () => {
  const forbidden = [
    '--api-key',
    '--base-url',
    '--model',
    '--keychain-service',
    '--keychain-account',
    '--provider-file',
    '--provider',
  ];
  for (const opt of forbidden) {
    it(`拒绝 ${opt}`, async () => {
      const h = makeCli();
      const code = await h.run([
        'generate',
        '--suite',
        '/tmp/source.json',
        '--output',
        '/o',
        opt,
        'x',
      ]);
      expect(code).toBe(2);
      expect(h.err.join('')).toContain('被禁止');
      expect(h.invoke.calls).toHaveLength(0);
    });
  }
});

describe('generate', () => {
  it('默认 provider + 默认参数 → COMPLETE + 摘要输出 stdout', async () => {
    const h = makeCli();
    const code = await h.run(['generate', '--suite', '/tmp/source.json', '--output', '/out/exp1']);
    expect(code).toBe(0);
    expect(h.out.join('')).toContain('"runStatus": "COMPLETE"');
    expect(h.out.join('')).toContain('"satisfiesQ1": true');
    expect(h.out.join('')).toContain('"mimo-v2.5-pro"');
    // stdout 是机器可读 JSON 摘要；进度在 stderr
    expect(h.out.join('')).toContain('"selectionMode": "FULL_SELECTION"');
    expect(h.err.join('')).toContain('[writing-experiment]');
    // 3 次串行调用（全部 cases）
    expect(h.invoke.calls).toHaveLength(3);
    // invoke 收到固定 baseUrl/model/key
    expect(h.invoke.calls[0].baseUrl).toBe('https://token-plan-cn.xiaomimimo.com/anthropic');
    expect(h.invoke.calls[0].model).toBe('mimo-v2.5-pro');
    expect(h.invoke.calls[0].apiKey).toBe('sk-dummy');
    expect(h.fs.exists('/out/exp1/manifest.private.json')).toBe(true);
  });

  it('未知 provider ID → 前置拒绝，不调用模型', async () => {
    const h = makeCli();
    const code = await h.run([
      'generate',
      '--suite',
      '/tmp/source.json',
      '--output',
      '/o',
      '--provider-id',
      'unknown',
    ]);
    expect(code).toBe(1);
    expect(h.err.join('')).toContain('未知 provider ID');
    expect(h.invoke.calls).toHaveLength(0);
  });

  it('max-cases=1 → PARTIAL_SELECTION + satisfiesQ1=false + exit 0（smoke 成功）', async () => {
    const h = makeCli();
    const code = await h.run([
      'generate',
      '--suite',
      '/tmp/source.json',
      '--output',
      '/out/smoke',
      '--max-cases',
      '1',
    ]);
    expect(code).toBe(0);
    expect(h.out.join('')).toContain('"runStatus": "PARTIAL_SELECTION_SUCCEEDED"');
    expect(h.out.join('')).toContain('"satisfiesQ1": false');
    expect(h.invoke.calls).toHaveLength(1);
    expect(h.fs.exists('/out/smoke/candidates.private.json')).toBe(false);
  });

  it('partial failure → exit 非 0，不宣称 Q1', async () => {
    const h = makeCli({}, [okOutput('正文A'), errorOutput('PROVIDER_TIMEOUT'), okOutput('正文C')]);
    const code = await h.run(['generate', '--suite', '/tmp/source.json', '--output', '/out/exp1']);
    expect(code).toBe(2);
    expect(h.out.join('')).toContain('"runStatus": "PARTIAL_FAILURE"');
    expect(h.out.join('')).toContain('"satisfiesQ1": false');
    expect(h.fs.exists('/out/exp1/evaluation.report.json')).toBe(false);
  });

  it('provider 错误不自动重试（恰好一次调用）', async () => {
    const h = makeCli({}, [errorOutput('PROVIDER_RATE_LIMITED')]);
    const code = await h.run([
      'generate',
      '--suite',
      '/tmp/source.json',
      '--output',
      '/o',
      '--max-cases',
      '1',
    ]);
    expect(code).toBe(2);
    expect(h.invoke.calls).toHaveLength(1);
  });
});

describe('run', () => {
  it('run 全成功 → evaluate + blind 产物 + COMPLETE', async () => {
    const h = makeCli();
    const code = await h.run([
      'run',
      '--suite',
      '/tmp/source.json',
      '--output',
      '/out/run1',
      '--seed',
      'gq2-seed',
    ]);
    expect(code).toBe(0);
    expect(h.out.join('')).toContain('"runStatus": "COMPLETE"');
    expect(h.fs.exists('/out/run1/evaluation.report.json')).toBe(true);
    expect(h.fs.exists('/out/run1/blind.packet.json')).toBe(true);
    expect(h.fs.exists('/out/run1/blind.mapping.private.json')).toBe(true);
    // blind packet 不包含身份字段（candidateId / modelId / strategyId / promptVersion / generationParameters）
    const packetRaw = h.fs.readFile('/out/run1/blind.packet.json');
    expect(packetRaw).not.toContain('"strategyId"');
    expect(packetRaw).not.toContain('"modelId"');
    expect(packetRaw).not.toContain('"candidateId"');
    expect(packetRaw).not.toContain('"promptVersion"');
    expect(packetRaw).not.toContain('"generationParameters"');
    expect(packetRaw).not.toContain('tok-1');
  });

  it('run 拒绝 --max-cases', async () => {
    const h = makeCli();
    const code = await h.run([
      'run',
      '--suite',
      '/tmp/source.json',
      '--output',
      '/o',
      '--seed',
      's',
      '--max-cases',
      '1',
    ]);
    expect(code).toBe(2);
    expect(h.err.join('')).toContain('不支持选项');
  });

  it('run 拒绝 --dry-run', async () => {
    const h = makeCli();
    const code = await h.run([
      'run',
      '--suite',
      '/tmp/source.json',
      '--output',
      '/o',
      '--seed',
      's',
      '--dry-run',
    ]);
    expect(code).toBe(2);
  });

  it('run 缺少 --seed → 非零退出', async () => {
    const h = makeCli();
    const code = await h.run(['run', '--suite', '/tmp/source.json', '--output', '/o']);
    expect(code).toBe(1);
    expect(h.err.join('')).toContain('--seed');
  });
});

describe('dry-run', () => {
  it('dry-run 零调用、零 artifact、无需 key', async () => {
    const h = makeCli({ getApiKey: async () => null });
    const code = await h.run([
      'generate',
      '--suite',
      '/tmp/source.json',
      '--output',
      '/o',
      '--dry-run',
    ]);
    expect(code).toBe(0);
    expect(h.invoke.calls).toHaveLength(0);
    expect(h.out.join('')).toContain('"dryRun": true');
    expect(h.out.join('')).toContain('"promptHash"');
    expect(h.fs.exists('/o')).toBe(false);
  });
});

describe('LIVE gate 与 Keychain', () => {
  it('未设置 LIVE 且未注入 fake invoke → 拒绝真实调用', async () => {
    const h = makeCli({ invoke: undefined, getApiKey: undefined, live: false });
    const code = await h.run(['generate', '--suite', '/tmp/source.json', '--output', '/o']);
    expect(code).toBe(1);
    expect(h.err.join('')).toContain('WRITING_EXPERIMENT_LIVE=1');
  });

  it('Keychain 未配置密钥 → LIVE_BLOCKED_KEY_NOT_CONFIGURED，不调用模型', async () => {
    const h = makeCli({ getApiKey: async () => null });
    const code = await h.run(['generate', '--suite', '/tmp/source.json', '--output', '/o']);
    expect(code).toBe(1);
    expect(h.err.join('')).toContain('LIVE_BLOCKED_KEY_NOT_CONFIGURED');
    expect(h.invoke.calls).toHaveLength(0);
  });
});

describe('stdout / stderr 分离与确定性', () => {
  it('stdout 只有机器可读 JSON 摘要，进度与警告在 stderr', async () => {
    const h = makeCli();
    await h.run(['generate', '--suite', '/tmp/source.json', '--output', '/out/exp1']);
    const stdoutText = h.out.join('');
    expect(() => JSON.parse(stdoutText)).not.toThrow();
    expect(h.err.join('')).toContain('[writing-experiment]');
    // 错误消息不回显 candidate 正文 / prompt
    expect(h.err.join('')).not.toContain('深夜站台');
  });

  it('同一 fake 数据 → 确定性 stdout 摘要', async () => {
    const runOnce = async (): Promise<string> => {
      const h = makeCli();
      await h.run(['generate', '--suite', '/tmp/source.json', '--output', '/out/exp1']);
      return h.out.join('');
    };
    const a = await runOnce();
    const b = await runOnce();
    expect(a).toBe(b);
  });
});
