/**
 * G. CLI 测试矩阵。
 */

import { describe, expect, it } from 'vitest';
import { runCli, parseCliArgs, CliUsageError } from './cli.js';
import { getBaselineSuite } from './fixtures.js';
import { fixedClockIso } from './test-util.js';

const FIXED_CLOCK = { now: () => fixedClockIso() };

class MemFs {
  files = new Map<string, string>();

  readFile(p: string): string {
    const content = this.files.get(p);
    if (content === undefined) throw new Error(`ENOENT: ${p}`);
    return content;
  }

  writeFile(p: string, content: string): void {
    this.files.set(p, content);
  }

  exists(p: string): boolean {
    return this.files.has(p);
  }
}

function makeHarness(files: Record<string, string> = {}) {
  const fs = new MemFs();
  for (const [k, v] of Object.entries(files)) fs.files.set(k, v);
  const out: string[] = [];
  const err: string[] = [];
  return {
    fs,
    out,
    err,
    deps: {
      defaultClock: FIXED_CLOCK,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      readFile: (p: string) => fs.readFile(p),
      writeFile: (p: string, c: string) => fs.writeFile(p, c),
      exists: (p: string) => fs.exists(p),
    },
  };
}

const SUITE_JSON = JSON.stringify(getBaselineSuite());
const VALIDATED = getBaselineSuite();

import { generateBlindPacket } from './blind.js';
import type { BlindPacketV1, PrivateMappingV1, HumanRatingV1 } from './schema.js';

function packetFiles(): { packetJson: string; mappingJson: string } {
  const { packet, mapping } = generateBlindPacket(VALIDATED, { seed: 'cli-seed' });
  return { packetJson: JSON.stringify(packet), mappingJson: JSON.stringify(mapping) };
}

function sampleRatings(packet: BlindPacketV1): HumanRatingV1[] {
  return packet.cases.flatMap((c) =>
    c.candidates.map((cand, i) => ({
      schemaVersion: 1,
      suiteId: packet.suiteId,
      caseId: c.caseId,
      candidateAlias: cand.alias,
      raterId: 'cli-rater',
      preferredRank: i + 1,
      notes: '',
      continueReading: 4,
      expectationFit: 3,
      characterCredibility: 4,
      languageNaturalness: 3,
      aiSmellAbsence: 3,
      plotProgression: 4,
      concision: 3,
      continuity: 4,
    })),
  );
}

describe('parseCliArgs', () => {
  it('help 默认命令', () => {
    expect(parseCliArgs([]).command).toBe('help');
  });

  it('未知命令抛出 CliUsageError', () => {
    expect(() => parseCliArgs(['frobnicate'])).toThrow(CliUsageError);
  });

  it('未知选项抛出 CliUsageError', () => {
    expect(() => parseCliArgs(['evaluate', 'suite.json', '--nope'])).toThrow(CliUsageError);
  });

  it('value 选项缺少参数抛出 CliUsageError', () => {
    expect(() => parseCliArgs(['evaluate', 'suite.json', '--output'])).toThrow(CliUsageError);
  });

  it('解析 positional 与 flag', () => {
    const parsed = parseCliArgs([
      'evaluate',
      'suite.json',
      '--force',
      '--clock',
      '2026-01-01T00:00:00.000Z',
    ]);
    expect(parsed.command).toBe('evaluate');
    expect(parsed.positional).toEqual(['suite.json']);
    expect(parsed.options.get('force')).toBe(true);
    expect(parsed.options.get('clock')).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('runCli — help / 错误', () => {
  it('help 输出帮助文本并返回 0', async () => {
    const h = makeHarness();
    const code = await runCli(['help'], h.deps);
    expect(code).toBe(0);
    expect(h.out.join('')).toContain('writing-evaluation CLI');
  });

  it('未知命令返回 2', async () => {
    const h = makeHarness();
    const code = await runCli(['frobnicate'], h.deps);
    expect(code).toBe(2);
    expect(h.err.join('')).toContain('用法错误');
  });

  it('未知选项返回 2', async () => {
    const h = makeHarness();
    const code = await runCli(['evaluate', 'x.json', '--bogus'], h.deps);
    expect(code).toBe(2);
  });

  it('缺少必需 positional 返回非 0', async () => {
    const h = makeHarness();
    const code = await runCli(['evaluate'], h.deps);
    expect(code).toBeGreaterThan(0);
  });

  it('blind 缺少 --seed 返回非 0', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(['blind', 'suite.json'], h.deps);
    expect(code).toBeGreaterThan(0);
  });

  it('无法解析 JSON 返回 1 且错误安全', async () => {
    const h = makeHarness({ 'bad.json': '{ not json' });
    const code = await runCli(['validate', 'bad.json'], h.deps);
    expect(code).toBe(1);
    expect(h.err.join('')).toContain('无法解析 JSON');
    expect(h.err.join('')).not.toContain('{ not json');
  });
});

describe('runCli — validate / evaluate', () => {
  it('validate suite 成功', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(['validate', 'suite.json'], h.deps);
    expect(code).toBe(0);
    expect(h.out.join('')).toContain('OK: suite 有效');
  });

  it('validate 非法 suite 返回 1', async () => {
    const h = makeHarness({ 'suite.json': JSON.stringify({ schemaVersion: 1 }) });
    const code = await runCli(['validate', 'suite.json'], h.deps);
    expect(code).toBe(1);
  });

  it('evaluate 输出 JSON 到 stdout（默认不写文件）', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(['evaluate', 'suite.json', '--clock', fixedClockIso()], h.deps);
    expect(code).toBe(0);
    const report = JSON.parse(h.out.join('')) as Record<string, unknown>;
    expect(report.suiteId).toBe('gq1-baseline-v1');
    expect(report.generatedAt).toBe(fixedClockIso());
  });

  it('evaluate --output 写文件；已存在且无 --force 返回 1', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON, 'report.json': 'old' });
    const codeNoForce = await runCli(
      ['evaluate', 'suite.json', '--output', 'report.json', '--clock', fixedClockIso()],
      h.deps,
    );
    expect(codeNoForce).toBe(1);
    expect(h.err.join('')).toContain('已存在');

    const codeForce = await runCli(
      ['evaluate', 'suite.json', '--output', 'report.json', '--clock', fixedClockIso(), '--force'],
      h.deps,
    );
    expect(codeForce).toBe(0);
    expect(JSON.parse(h.fs.files.get('report.json')!).suiteId).toBe('gq1-baseline-v1');
  });

  it('evaluate --format markdown 输出 markdown', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(
      ['evaluate', 'suite.json', '--format', 'markdown', '--clock', fixedClockIso()],
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.out.join('')).toContain('# 写作评测报告');
  });

  it('同一输入 + 同一 clock 两次 evaluate 输出 byte-identical', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    await runCli(['evaluate', 'suite.json', '--clock', fixedClockIso()], h.deps);
    const first = h.out.join('');
    const h2 = makeHarness({ 'suite.json': SUITE_JSON });
    await runCli(['evaluate', 'suite.json', '--clock', fixedClockIso()], h2.deps);
    expect(first).toBe(h2.out.join(''));
  });

  it('错误不回显候选正文', async () => {
    const bad = JSON.parse(SUITE_JSON) as never;
    (bad as { cases: never[] }).cases[0].candidates[0].text = '';
    const h = makeHarness({ 'suite.json': JSON.stringify(bad) });
    const code = await runCli(['validate', 'suite.json'], h.deps);
    expect(code).toBe(1);
    expect(h.err.join('')).not.toContain('把伞往沈澈那边斜了一点');
  });
});

describe('runCli — blind / aggregate', () => {
  it('blind 生成 packet 与 mapping（分离文件）', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        'cli-seed',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBe(0);
    const packet = JSON.parse(h.fs.files.get('packet.json')!) as BlindPacketV1;
    const mapping = JSON.parse(h.fs.files.get('mapping.json')!) as PrivateMappingV1;
    expect(packet.cases.length).toBe(3);
    expect(JSON.stringify(packet)).not.toContain('candidateId');
    expect(mapping.entries.length).toBe(6);
    expect(h.err.join('')).toContain('private mapping');
  });

  it('blind 未提供输出时打印到 stdout', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(['blind', 'suite.json', '--seed', 's'], h.deps);
    expect(code).toBe(0);
    const stdout = h.out.join('');
    expect(stdout).toContain('"packetId"');
  });

  it('aggregate 成功并解析 candidateId', async () => {
    const { packetJson, mappingJson } = packetFiles();
    const packet = JSON.parse(packetJson) as BlindPacketV1;
    const ratings = sampleRatings(packet);
    const h = makeHarness({
      'suite.json': SUITE_JSON,
      'packet.json': packetJson,
      'mapping.json': mappingJson,
      'ratings.json': JSON.stringify(ratings),
    });
    const code = await runCli(
      [
        'aggregate',
        '--packet',
        'packet.json',
        '--mapping',
        'mapping.json',
        '--ratings',
        'ratings.json',
        '--clock',
        fixedClockIso(),
      ],
      h.deps,
    );
    expect(code).toBe(0);
    const agg = JSON.parse(h.out.join('')) as {
      raterCount: number;
      candidateAggregates: { candidateId: string | null }[];
    };
    expect(agg.raterCount).toBe(1);
    expect(agg.candidateAggregates[0].candidateId).not.toBeNull();
  });

  it('aggregate 校验 ratings：非法 alias 返回非 0', async () => {
    const { packetJson, mappingJson } = packetFiles();
    const h = makeHarness({
      'packet.json': packetJson,
      'mapping.json': mappingJson,
      'ratings.json': JSON.stringify([
        { schemaVersion: 1, caseId: 'x', candidateAlias: 'ZZ', raterId: 'r' },
      ]),
    });
    const code = await runCli(
      [
        'aggregate',
        '--packet',
        'packet.json',
        '--mapping',
        'mapping.json',
        '--ratings',
        'ratings.json',
      ],
      h.deps,
    );
    expect(code).toBe(1);
  });

  it('validate --type ratings 需要 --packet', async () => {
    const h = makeHarness({ 'ratings.json': '[]' });
    const code = await runCli(['validate', 'ratings.json', '--type', 'ratings'], h.deps);
    expect(code).toBeGreaterThan(0);
  });
});
