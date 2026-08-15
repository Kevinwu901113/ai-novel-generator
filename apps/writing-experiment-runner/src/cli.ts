/**
 * writing-experiment CLI：help / generate / run。
 *
 * - 不使用外部 CLI dependency；严格参数解析，unknown option / missing argument 失败；
 * - 只接受 allowlisted --provider-id；禁止 --api-key / --base-url / --model /
 *   --keychain-service / --keychain-account / --provider-file / --provider；
 * - 真实模型调用必须显式 WRITING_EXPERIMENT_LIVE=1（或注入 fake invoke 的测试路径）；
 * - run 不接收 ratings、不 aggregate；人工评分继续用 writing-evaluation CLI；
 * - stdout = 机器可读 JSON 摘要；stderr = 人类进度与警告；
 * - 错误消息安全：不回显 secret / 绝对路径 / provider raw error。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Clock } from '@ai-novel/writing-evaluation';
import { systemClock } from '@ai-novel/writing-evaluation';
import type { ModelInvocationInput, ModelInvocationOutput } from '@ai-novel/model-gateway';
import { invokeModel } from '@ai-novel/model-gateway';
import { createMacOSKeychainSecretStore } from '@ai-novel/secret-store';
import { DEFAULT_PROVIDER_ID, resolveProvider } from './providers.js';
import {
  runExperiment,
  type AbortState,
  type RunOptions,
  type RunnerDeps,
  type RunOutcome,
} from './runner.js';
import {
  CliUsageError,
  ExperimentError,
  LIVE_BLOCKED_KEY_NOT_CONFIGURED,
  safeErrorMessage,
} from './safe-error.js';

export type CliCommand = 'help' | 'generate' | 'run';

const GENERATE_VALUE_OPTIONS = new Set([
  'suite',
  'output',
  'strategy',
  'provider-id',
  'temperature',
  'max-tokens',
  'max-cases',
  'clock',
]);
const GENERATE_FLAG_OPTIONS = new Set(['force', 'dry-run']);
const RUN_VALUE_OPTIONS = new Set([
  'suite',
  'output',
  'strategy',
  'provider-id',
  'temperature',
  'max-tokens',
  'seed',
  'clock',
]);
const RUN_FLAG_OPTIONS = new Set(['force']);
const FORBIDDEN_OPTIONS = new Set([
  'api-key',
  'base-url',
  'model',
  'keychain-service',
  'keychain-account',
  'provider-file',
  'provider',
]);
const ALL_VALUE_OPTIONS = new Set([...GENERATE_VALUE_OPTIONS, ...RUN_VALUE_OPTIONS]);
const ALL_FLAG_OPTIONS = new Set([...GENERATE_FLAG_OPTIONS, ...RUN_FLAG_OPTIONS]);

export interface ParsedCli {
  readonly command: CliCommand;
  readonly options: ReadonlyMap<string, string | boolean>;
}

export function parseCliArgs(argv: readonly string[]): ParsedCli {
  const args = [...argv];
  const first = args.shift();
  if (!first || first === 'help') {
    return { command: 'help', options: new Map() };
  }
  if (first.startsWith('-')) {
    throw new CliUsageError(`未知命令 "${first}"`);
  }
  const command = first as CliCommand;
  if (!['generate', 'run'].includes(command)) {
    throw new CliUsageError(`未知命令 "${first}"`);
  }

  const allowedValue = command === 'generate' ? GENERATE_VALUE_OPTIONS : RUN_VALUE_OPTIONS;
  const allowedFlag = command === 'generate' ? GENERATE_FLAG_OPTIONS : RUN_FLAG_OPTIONS;
  const options = new Map<string, string | boolean>();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (FORBIDDEN_OPTIONS.has(name)) {
        throw new CliUsageError(
          `选项 --${name} 被禁止（密钥 / 端点 / Keychain 选择器一律不允许由 CLI 控制）`,
        );
      }
      if (ALL_VALUE_OPTIONS.has(name)) {
        if (!allowedValue.has(name)) {
          throw new CliUsageError(`命令 ${command} 不支持选项 --${name}`);
        }
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new CliUsageError(`选项 --${name} 缺少参数`);
        }
        options.set(name, value);
        i += 1;
      } else if (ALL_FLAG_OPTIONS.has(name)) {
        if (!allowedFlag.has(name)) {
          throw new CliUsageError(`命令 ${command} 不支持选项 --${name}`);
        }
        options.set(name, true);
      } else {
        throw new CliUsageError(`未知选项 "--${name}"`);
      }
    } else {
      throw new CliUsageError(`不支持的参数 "${arg}"（本命令不接受位置参数）`);
    }
  }
  return { command, options };
}

export interface CliDeps {
  readonly defaultClock?: Clock;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly readFile?: (p: string) => string;
  readonly writeFile?: (p: string, content: string) => void;
  readonly exists?: (p: string) => boolean;
  readonly mkdir?: (p: string) => void;
  readonly renameDir?: (from: string, to: string) => void;
  readonly removeDir?: (p: string) => void;
  readonly invoke?: (input: ModelInvocationInput) => Promise<ModelInvocationOutput>;
  readonly getApiKey?: (service: string, account: string) => Promise<string | null>;
  readonly idGenerator?: () => string;
  readonly abort?: AbortState;
  readonly gitCommit?: string | null;
  /** 测试注入：显式覆盖 LIVE gate（默认取 WRITING_EXPERIMENT_LIVE 环境变量）。 */
  readonly live?: boolean;
}

interface ResolvedDeps {
  readonly clock: Clock;
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly readFile: (p: string) => string;
  readonly writeFile: (p: string, content: string) => void;
  readonly exists: (p: string) => boolean;
  readonly mkdir: (p: string) => void;
  readonly renameDir: (from: string, to: string) => void;
  readonly removeDir: (p: string) => void;
  readonly invoke: ((input: ModelInvocationInput) => Promise<ModelInvocationOutput>) | null;
  readonly getApiKey: ((service: string, account: string) => Promise<string | null>) | null;
  readonly idGenerator: () => string;
  readonly abort: AbortState;
  readonly gitCommit: string | null;
  readonly live: boolean;
}

function resolveDeps(deps: CliDeps): ResolvedDeps {
  return {
    clock: deps.defaultClock ?? systemClock,
    stdout: deps.stdout ?? ((s) => process.stdout.write(s)),
    stderr: deps.stderr ?? ((s) => process.stderr.write(s)),
    readFile: deps.readFile ?? ((p) => readFileSync(p, 'utf8')),
    writeFile: deps.writeFile ?? ((p, content) => writeFileSync(p, content, 'utf8')),
    exists: deps.exists ?? ((p) => existsSync(p)),
    mkdir: deps.mkdir ?? ((p) => mkdirSync(p, { recursive: true })),
    renameDir: deps.renameDir ?? ((from, to) => renameSync(from, to)),
    removeDir: deps.removeDir ?? ((p) => rmSync(p, { recursive: true, force: true })),
    invoke: deps.invoke ?? null,
    getApiKey: deps.getApiKey ?? null,
    idGenerator: deps.idGenerator ?? (() => randomUUID().replace(/-/g, '').slice(0, 12)),
    abort: deps.abort ?? { aborted: false },
    gitCommit: deps.gitCommit ?? null,
    live: deps.live ?? process.env.WRITING_EXPERIMENT_LIVE === '1',
  };
}

function requireOption(parsed: ParsedCli, name: string): string {
  const value = parsed.options.get(name);
  if (typeof value !== 'string') throw new CliUsageError(`缺少必需选项 --${name}`);
  return value;
}

function optionString(parsed: ParsedCli, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function optionNumber(parsed: ParsedCli, name: string, fallback: number): number {
  const raw = optionString(parsed, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new CliUsageError(`--${name} 必须是数字`);
  return n;
}

function optionInt(parsed: ParsedCli, name: string, fallback?: number): number | undefined {
  const raw = optionString(parsed, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new CliUsageError(`--${name} 必须是正整数`);
  return n;
}

function resolveClock(parsed: ParsedCli, fallback: Clock): Clock {
  const clockValue = optionString(parsed, 'clock');
  if (clockValue !== undefined) {
    return { now: () => clockValue };
  }
  return fallback;
}

interface InvokeWiring {
  readonly invoke: (input: ModelInvocationInput) => Promise<ModelInvocationOutput>;
  readonly getApiKey: (service: string, account: string) => Promise<string | null>;
}

/**
 * 生产 wiring：仅当 WRITING_EXPERIMENT_LIVE=1（或测试注入 fake invoke/getApiKey）时允许真实调用。
 */
function buildInvokeWiring(resolved: ResolvedDeps, clock: Clock): InvokeWiring {
  if (resolved.invoke !== null && resolved.getApiKey !== null) {
    return { invoke: resolved.invoke, getApiKey: resolved.getApiKey };
  }
  if (!resolved.live) {
    throw new CliUsageError('真实模型调用需要显式设置环境变量 WRITING_EXPERIMENT_LIVE=1');
  }
  const store = createMacOSKeychainSecretStore();
  return {
    invoke: (input) => invokeModel({ fetch: globalThis.fetch, clock }, input),
    getApiKey: (service, account) => store.getSecret(service, account),
  };
}

function buildRunOptions(
  resolved: ResolvedDeps,
  parsed: ParsedCli,
  command: 'generate' | 'run',
): RunOptions {
  const suite = requireOption(parsed, 'suite');
  const output = requireOption(parsed, 'output');
  const strategy = optionString(parsed, 'strategy') ?? 'baseline-one-shot-v1';
  const providerId = optionString(parsed, 'provider-id') ?? DEFAULT_PROVIDER_ID;
  const temperature = optionNumber(parsed, 'temperature', 0.7);
  if (temperature < 0 || temperature > 2) {
    throw new CliUsageError('--temperature 必须在 [0,2] 范围');
  }
  const maxTokens = optionInt(parsed, 'max-tokens', 8192);
  if (maxTokens === undefined || maxTokens < 1 || maxTokens > 1_000_000) {
    throw new CliUsageError('--max-tokens 必须是 [1,1000000] 的正整数');
  }
  const maxCases = command === 'generate' ? optionInt(parsed, 'max-cases') : undefined;
  const force = parsed.options.get('force') === true;
  const dryRun = command === 'generate' && parsed.options.get('dry-run') === true;
  const seed = command === 'run' ? requireOption(parsed, 'seed') : undefined;

  return {
    command,
    sourceSuitePath: suite,
    outputDir: output,
    strategy,
    providerId,
    temperature,
    maxTokens,
    ...(maxCases !== undefined ? { maxCases } : {}),
    force,
    dryRun,
    ...(seed !== undefined ? { seed } : {}),
    gitCommit: resolved.gitCommit,
  };
}

function printSummary(resolved: ResolvedDeps, outcome: RunOutcome): void {
  const summary = {
    dryRun: outcome.dryRun,
    command: outcome.command,
    experimentId: outcome.experimentId,
    runStatus: outcome.runStatus,
    selectionMode: outcome.selectionMode,
    satisfiesQ1: outcome.satisfiesQ1,
    provider: outcome.provider,
    sourceSuite: outcome.sourceSuite,
    outputSuite: outcome.outputSuite,
    aggregate: outcome.aggregate,
    note: outcome.note ?? null,
  };
  resolved.stdout(`${JSON.stringify(summary, null, 2)}\n`);
  if (outcome.runStatus !== 'COMPLETE' && outcome.runStatus !== 'PARTIAL_SELECTION_SUCCEEDED') {
    resolved.stderr(`实验状态: ${outcome.runStatus}（exit ${outcome.exitCode}）\n`);
  }
}

async function runGenerateOrRun(
  resolved: ResolvedDeps,
  parsed: ParsedCli,
  command: 'generate' | 'run',
): Promise<number> {
  const options = buildRunOptions(resolved, parsed, command);
  // 未知 provider ID 在解析阶段前置拒绝
  resolveProvider(options.providerId);

  const clock = resolveClock(parsed, resolved.clock);
  const wiring = options.dryRun
    ? {
        invoke: (() => {
          throw new ExperimentError('dry-run 不应调用模型');
        }) as (input: ModelInvocationInput) => Promise<ModelInvocationOutput>,
        getApiKey: (async () => null) as (
          service: string,
          account: string,
        ) => Promise<string | null>,
      }
    : buildInvokeWiring(resolved, clock);

  const runnerDeps: RunnerDeps = {
    clock,
    idGenerator: resolved.idGenerator,
    readFile: resolved.readFile,
    writeFile: resolved.writeFile,
    exists: resolved.exists,
    mkdir: resolved.mkdir,
    renameDir: resolved.renameDir,
    removeDir: resolved.removeDir,
    invoke: wiring.invoke,
    getApiKey: wiring.getApiKey,
    abort: resolved.abort,
    log: (line) => resolved.stderr(`[writing-experiment] ${line}\n`),
  };

  const outcome = await runExperiment(runnerDeps, options);
  if (outcome.dryRun && outcome.preview !== undefined) {
    resolved.stdout(`${JSON.stringify(outcome.preview, null, 2)}\n`);
    return 0;
  }
  printSummary(resolved, outcome);
  return outcome.exitCode;
}

const HELP_TEXT = `writing-experiment CLI

用法:
  writing-experiment help
  writing-experiment generate \\
    --suite <source-suite.json> --output <dir> \\
    [--strategy baseline-one-shot-v1|antislop-v1] [--provider-id mimo-token-plan-cn] \\
    [--temperature <n>] [--max-tokens <n>] [--max-cases <n>] [--force] [--dry-run] [--clock <iso>]
  writing-experiment run \\
    --suite <source-suite.json> --output <dir> --seed <seed> \\
    [--strategy baseline-one-shot-v1|antislop-v1] [--provider-id mimo-token-plan-cn] \\
    [--temperature <n>] [--max-tokens <n>] [--force] [--clock <iso>]

说明:
  - generate：真实模型生成 → manifest + case-results →（全成功且 FULL_SELECTION 时）generated output suite。
  - run：generate（Q1 模式，全部 cases）+ 仅全部成功时 evaluation report + blind packet + private mapping。
  - run 不接收 ratings、不自动 aggregate；人工评分继续使用 writing-evaluation CLI。
  - 真实模型调用必须显式设置环境变量 WRITING_EXPERIMENT_LIVE=1。
  - 默认参数：--temperature 0.7、--max-tokens 8192（MiMo extended-thinking 输出预算；可显式调整）。
  - 禁止 --api-key / --base-url / --model / --keychain-service / --keychain-account / --provider-file / --provider。
  - --max-cases 只用于受控 smoke/调试；产生 PARTIAL_SELECTION，不满足 Q1。
  - 不覆盖已有输出目录，除非显式 --force。
  - 不自动重试失败调用。
`;

export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const resolved = resolveDeps(deps);

  let parsed: ParsedCli;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      resolved.stderr(`用法错误: ${err.message}\n`);
      resolved.stderr('运行 writing-experiment help 查看帮助\n');
      return 2;
    }
    throw err;
  }

  try {
    switch (parsed.command) {
      case 'help':
        resolved.stdout(HELP_TEXT);
        return 0;
      case 'generate':
        return await runGenerateOrRun(resolved, parsed, 'generate');
      case 'run':
        return await runGenerateOrRun(resolved, parsed, 'run');
    }
  } catch (err) {
    if (err instanceof ExperimentError && err.code === LIVE_BLOCKED_KEY_NOT_CONFIGURED) {
      resolved.stderr(`错误: ${err.message}（${err.code}）\n`);
    } else {
      resolved.stderr(`错误: ${safeErrorMessage(err)}\n`);
    }
    return 1;
  }

  return 0;
}
