/**
 * Node CLI：evaluate / blind / aggregate / validate / help。
 *
 * - 不使用外部 CLI dependency；
 * - 严格参数解析：unknown option / missing argument 失败；
 * - exit code：0 成功，非 0 校验或 IO 失败；
 * - 错误消息安全：不回显完整候选文本，不输出 absolute path 到公共错误；
 * - 无网络访问；
 * - 默认不写文件，除非显式提供 output；
 * - 不覆盖已有文件，除非显式 --force；
 * - UTF-8；JSON 输出为确定性的 compact 格式。
 *
 * Programmatic API（evaluateSuite / validateSuite / generateBlindPacket /
 * aggregateRatings 等）与 CLI parser 分离。
 */

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { validateBlindPacket, validatePrivateMapping, validateSuite } from './validate.js';
import { evaluateSuite, type EvaluateOptions } from './evaluate.js';
import { generateBlindPacket } from './blind.js';
import {
  aggregateRatings,
  validateRatings,
  RatingValidationError,
  type AggregateRatingsOptions,
} from './rating.js';
import { renderMarkdownRatingAggregation, renderMarkdownReport } from './markdown.js';
import { EvaluationValidationError } from './validate.js';

// ── 解析 ──────────────────────────────────────────────────────────

export type CliCommand = 'evaluate' | 'blind' | 'aggregate' | 'validate' | 'help';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const VALUE_OPTIONS = new Set([
  'output',
  'format',
  'clock',
  'seed',
  'packet-output',
  'mapping-output',
  'packet',
  'mapping',
  'ratings',
  'type',
]);

const FLAG_OPTIONS = new Set(['force', 'help']);

export interface ParsedCli {
  readonly command: CliCommand;
  readonly positional: readonly string[];
  readonly options: ReadonlyMap<string, string | boolean>;
}

export function parseCliArgs(argv: readonly string[]): ParsedCli {
  const args = [...argv];
  const first = args.shift();
  if (!first) {
    return { command: 'help', positional: [], options: new Map() };
  }
  const command = first as CliCommand;
  if (!['evaluate', 'blind', 'aggregate', 'validate', 'help'].includes(command)) {
    throw new CliUsageError(`未知命令 "${first}"`);
  }

  const positional: string[] = [];
  const options = new Map<string, string | boolean>();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (VALUE_OPTIONS.has(name)) {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new CliUsageError(`选项 --${name} 缺少参数`);
        }
        options.set(name, value);
        i += 1;
      } else if (FLAG_OPTIONS.has(name)) {
        options.set(name, true);
      } else {
        throw new CliUsageError(`未知选项 "--${name}"`);
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, options };
}

// ── 安全路径与文件 IO ─────────────────────────────────────────────

/** 公共错误中只显示文件名，不暴露 absolute path。 */
function safeDisplayPath(p: string): string {
  const base = path.basename(p);
  return base.length > 0 ? base : '<file>';
}

export interface CliDeps {
  readonly defaultClock?: Clock;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly readFile?: (p: string) => string;
  readonly writeFile?: (p: string, content: string) => void;
  readonly exists?: (p: string) => boolean;
  readonly renameFile?: (from: string, to: string) => void;
  readonly removeFile?: (p: string) => void;
}

interface ResolvedDeps {
  readonly clock: Clock;
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly readFile: (p: string) => string;
  readonly writeFile: (p: string, content: string) => void;
  readonly exists: (p: string) => boolean;
  readonly renameFile: (from: string, to: string) => void;
  readonly removeFile: (p: string) => void;
}

function resolveDeps(deps: CliDeps): ResolvedDeps {
  return {
    clock: deps.defaultClock ?? systemClock,
    stdout: deps.stdout ?? ((s) => process.stdout.write(s)),
    stderr: deps.stderr ?? ((s) => process.stderr.write(s)),
    readFile: deps.readFile ?? ((p) => readFileSync(p, 'utf8')),
    writeFile: deps.writeFile ?? ((p, content) => writeFileSync(p, content, 'utf8')),
    exists: deps.exists ?? ((p) => existsSync(p)),
    renameFile: deps.renameFile ?? ((from, to) => renameSync(from, to)),
    removeFile: deps.removeFile ?? ((p) => unlinkSync(p)),
  };
}

/** 安全错误消息白名单：只有受控错误类型才输出 message，其余一律固定文本。 */
function safeErrorMessage(err: unknown): string {
  if (err instanceof CliUsageError) return err.message;
  if (err instanceof EvaluationValidationError) return err.message;
  if (err instanceof RatingValidationError) return err.message;
  return '内部错误（详见本地日志）';
}

function readJson(deps: ResolvedDeps, pathInput: string): unknown {
  let raw: string;
  try {
    raw = deps.readFile(pathInput);
  } catch {
    // 不输出原始 fs error.message（可能含绝对路径 / errno / 密钥）
    throw new CliUsageError(`无法读取文件 "${safeDisplayPath(pathInput)}"（IO 错误）`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new CliUsageError(`无法解析 JSON 文件 "${safeDisplayPath(pathInput)}"（JSON 格式错误）`);
  }
}

function writeJsonOutput(
  deps: ResolvedDeps,
  pathInput: string | undefined,
  content: string,
  force: boolean,
): void {
  if (pathInput === undefined) {
    deps.stdout(content);
    deps.stdout('\n');
    return;
  }
  if (deps.exists(pathInput) && !force) {
    throw new CliUsageError(
      `输出文件 "${safeDisplayPath(pathInput)}" 已存在；如需覆盖请显式使用 --force`,
    );
  }
  try {
    deps.writeFile(pathInput, content);
  } catch {
    throw new CliUsageError(`无法写入文件 "${safeDisplayPath(pathInput)}"（IO 错误）`);
  }
}

// ── 命令实现 ──────────────────────────────────────────────────────

const HELP_TEXT = `writing-evaluation CLI

用法:
  writing-evaluation help
  writing-evaluation validate <suite.json> [--type suite|ratings] [--packet <blind-packet.json>]
  writing-evaluation evaluate <suite.json> [--output <report.json>] [--format json|markdown] [--clock <iso>] [--force]
  writing-evaluation blind <suite.json> --seed <seed> --mapping-output <mapping.json> [--packet-output <packet.json>] [--force]
  writing-evaluation aggregate --packet <packet.json> --mapping <mapping.json> --ratings <ratings.json> [--output <agg.json>] [--format json|markdown] [--clock <iso>] [--force]

说明:
  - 默认不写文件；未提供 output 时 JSON 输出到 stdout。
  - 不覆盖已有文件，除非显式 --force。
  - private mapping 禁止输出到 stdout，必须显式提供 --mapping-output。
  - 报告不是 AI 检测器；自动指标不代表文学质量；没有单一总分。
  - private mapping 不应交给评审者。
  - 工具完全离线，不上传任何文本。
`;

export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const resolved = resolveDeps(deps);

  let parsed: ParsedCli;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      resolved.stderr(`用法错误: ${err.message}\n`);
      resolved.stderr('运行 writing-evaluation help 查看帮助\n');
      return 2;
    }
    throw err;
  }

  try {
    switch (parsed.command) {
      case 'help':
        resolved.stdout(HELP_TEXT);
        return 0;
      case 'validate':
        return runValidate(resolved, parsed);
      case 'evaluate':
        return runEvaluate(resolved, parsed);
      case 'blind':
        return runBlind(resolved, parsed);
      case 'aggregate':
        return runAggregate(resolved, parsed);
    }
  } catch (err) {
    // 只输出白名单错误类型；任何原始 Error 的 message 都不进入 stderr
    resolved.stderr(`错误: ${safeErrorMessage(err)}\n`);
    return 1;
  }

  return 0;
}

function requirePositional(parsed: ParsedCli, index: number, label: string): string {
  const value = parsed.positional[index];
  if (!value) throw new CliUsageError(`缺少参数 ${label}`);
  return value;
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

function resolveClock(parsed: ParsedCli, fallback: Clock): Clock {
  const clockValue = parsed.options.get('clock');
  if (typeof clockValue === 'string') {
    return { now: () => clockValue };
  }
  return fallback;
}

function runValidate(deps: ResolvedDeps, parsed: ParsedCli): number {
  const file = requirePositional(parsed, 0, '<file>');
  const type = optionString(parsed, 'type') ?? 'suite';

  if (type === 'ratings') {
    const packetFile = requireOption(parsed, 'packet');
    const packetInput = readJson(deps, packetFile);
    const ratingsInput = readJson(deps, file);
    const packet = validateBlindPacket(packetInput);
    validateRatings(ratingsInput, { packet });
    deps.stdout(`OK: ratings 有效（${safeDisplayPath(file)}）\n`);
    return 0;
  }
  if (type !== 'suite') {
    throw new CliUsageError(`--type 仅支持 suite 或 ratings，收到 "${type}"`);
  }

  const suiteInput = readJson(deps, file);
  const suite = validateSuite(suiteInput);
  const candidateCount = suite.cases.reduce((acc, c) => acc + c.candidates.length, 0);
  deps.stdout(`OK: suite 有效（${suite.cases.length} 个用例，${candidateCount} 个候选）\n`);
  return 0;
}

function runEvaluate(deps: ResolvedDeps, parsed: ParsedCli): number {
  const file = requirePositional(parsed, 0, '<suite.json>');
  const format = optionString(parsed, 'format') ?? 'json';
  if (format !== 'json' && format !== 'markdown') {
    throw new CliUsageError(`--format 仅支持 json 或 markdown，收到 "${format}"`);
  }
  const force = parsed.options.get('force') === true;
  const output = optionString(parsed, 'output');

  const suiteInput = readJson(deps, file);
  const options: EvaluateOptions = { clock: resolveClock(parsed, deps.clock) };
  const report = evaluateSuite(suiteInput, options);

  const content = format === 'markdown' ? renderMarkdownReport(report) : JSON.stringify(report);

  writeJsonOutput(deps, output, content, force);
  return 0;
}

/** blind 临时文件后缀（staged publication 用）。 */
export const BLIND_TEMP_SUFFIX = '.gq1-tmp';

/** 规范化路径身份：统一相对路径 / ./ / 父级遍历等别名。 */
function resolvePathIdentity(p: string): string {
  return path.resolve(p);
}

/**
 * blind 的 staged publication：
 * 1. 内存生成并验证 packet/mapping；
 * 2. 完成全部路径（含规范化身份）、overwrite 检查；
 * 3. mapping / packet 先写临时文件；
 * 4. 全部临时文件成功后，再逐个 rename 发布正式文件；
 * 5. 任一步失败：清理临时文件与已发布文件（best-effort rollback），不输出 stdout packet，
 *    不显示成功信息；
 * 6. stdout packet 只在 mapping 正式发布成功后输出。
 */
function runBlind(deps: ResolvedDeps, parsed: ParsedCli): number {
  const file = requirePositional(parsed, 0, '<suite.json>');
  const seed = requireOption(parsed, 'seed');
  const force = parsed.options.get('force') === true;
  const packetOutput = optionString(parsed, 'packet-output');
  const mappingOutput = optionString(parsed, 'mapping-output');

  const suite = validateSuite(readJson(deps, file));
  const result = generateBlindPacket(suite, { seed });

  // 防御性校验生成的产物（禁止 cast 充当验证）
  const packet = validateBlindPacket(result.packet);
  const mapping = validatePrivateMapping(result.mapping, result.packet);

  const packetJson = JSON.stringify(packet);
  const mappingJson = JSON.stringify(mapping);

  // private mapping 禁止默认输出到 stdout：必须显式 --mapping-output
  if (mappingOutput === undefined) {
    throw new CliUsageError(
      'private mapping 必须通过 --mapping-output 显式输出（禁止输出到 stdout）',
    );
  }
  // 路径身份判断：使用规范化绝对路径比较（./、父级遍历、相对/绝对别名都识别为同一路径）
  if (
    packetOutput !== undefined &&
    resolvePathIdentity(packetOutput) === resolvePathIdentity(mappingOutput)
  ) {
    throw new CliUsageError('--packet-output 与 --mapping-output 不能指向同一路径');
  }

  // 全部路径与 overwrite 校验（在创建任何临时文件之前）
  const finalTargets: string[] = [];
  if (packetOutput !== undefined) finalTargets.push(packetOutput);
  finalTargets.push(mappingOutput);
  for (const p of finalTargets) {
    if (deps.exists(p) && !force) {
      throw new CliUsageError(
        `输出文件 "${safeDisplayPath(p)}" 已存在；如需覆盖请显式使用 --force`,
      );
    }
  }

  // staged publication：临时文件 + rename 发布，失败时 best-effort rollback
  const createdTempFiles: string[] = [];
  const publishedFiles: string[] = [];
  const backups: Array<{ backup: string; original: string }> = [];

  try {
    const mappingTemp = mappingOutput + BLIND_TEMP_SUFFIX;
    deps.writeFile(mappingTemp, mappingJson);
    createdTempFiles.push(mappingTemp);

    let packetTemp: string | undefined;
    if (packetOutput !== undefined) {
      packetTemp = packetOutput + BLIND_TEMP_SUFFIX;
      deps.writeFile(packetTemp, packetJson);
      createdTempFiles.push(packetTemp);
    }

    // --force 覆盖已有文件时，先把旧文件移到 backup，发布成功后删除 backup；
    // 失败时可恢复旧文件，避免“先破坏旧文件再发现另一个输出失败”。
    if (force && deps.exists(mappingOutput)) {
      const backup = mappingOutput + BLIND_TEMP_SUFFIX + '.bak';
      deps.renameFile(mappingOutput, backup);
      backups.push({ backup, original: mappingOutput });
    }
    if (packetOutput !== undefined && force && deps.exists(packetOutput)) {
      const backup = packetOutput + BLIND_TEMP_SUFFIX + '.bak';
      deps.renameFile(packetOutput, backup);
      backups.push({ backup, original: packetOutput });
    }

    // 先发布 mapping（敏感产物），再发布 packet
    deps.renameFile(mappingTemp, mappingOutput);
    publishedFiles.push(mappingOutput);
    createdTempFiles.splice(createdTempFiles.indexOf(mappingTemp), 1);

    if (packetOutput !== undefined && packetTemp !== undefined) {
      deps.renameFile(packetTemp, packetOutput);
      publishedFiles.push(packetOutput);
      createdTempFiles.splice(createdTempFiles.indexOf(packetTemp), 1);
    }

    // 全部正式文件发布成功后，删除 backups
    for (const b of backups) {
      try {
        deps.removeFile(b.backup);
      } catch {
        // best-effort
      }
    }

    // stdout packet 只在 mapping / packet 全部正式发布成功后输出
    if (packetOutput === undefined) {
      deps.stdout(packetJson);
      deps.stdout('\n');
    }

    deps.stderr('警告: private mapping 不应交给评审者；请将其与 blind packet 分开保管。\n');
    return 0;
  } catch (err) {
    // best-effort rollback：先移除本次已发布的正式文件，再恢复旧文件备份，最后清理临时文件
    for (const p of publishedFiles) {
      try {
        deps.removeFile(p);
      } catch {
        // best-effort
      }
    }
    for (const b of backups) {
      try {
        deps.renameFile(b.backup, b.original);
      } catch {
        // best-effort
      }
    }
    for (const p of createdTempFiles) {
      try {
        deps.removeFile(p);
      } catch {
        // best-effort
      }
    }
    // 原始错误可能含绝对路径 / errno / 密钥：白名单类型原样抛出，其余包装为安全消息
    if (
      err instanceof CliUsageError ||
      err instanceof EvaluationValidationError ||
      err instanceof RatingValidationError
    ) {
      throw err;
    }
    throw new CliUsageError('blind 输出失败（IO 错误）');
  }
}

function runAggregate(deps: ResolvedDeps, parsed: ParsedCli): number {
  const packetFile = requireOption(parsed, 'packet');
  const mappingFile = requireOption(parsed, 'mapping');
  const ratingsFile = requireOption(parsed, 'ratings');
  const format = optionString(parsed, 'format') ?? 'json';
  if (format !== 'json' && format !== 'markdown') {
    throw new CliUsageError(`--format 仅支持 json 或 markdown，收到 "${format}"`);
  }
  const force = parsed.options.get('force') === true;
  const output = optionString(parsed, 'output');

  const packet = validateBlindPacket(readJson(deps, packetFile));
  const mapping = validatePrivateMapping(readJson(deps, mappingFile), packet);
  const ratingsInput = readJson(deps, ratingsFile);

  const ratings = validateRatings(ratingsInput, { packet });
  const aggOptions: AggregateRatingsOptions = {
    packet,
    ratings,
    mapping,
    clock: resolveClock(parsed, deps.clock),
  };
  const agg = aggregateRatings(aggOptions);

  const content =
    format === 'markdown' ? renderMarkdownRatingAggregation(agg) : JSON.stringify(agg);
  writeJsonOutput(deps, output, content, force);
  return 0;
}
