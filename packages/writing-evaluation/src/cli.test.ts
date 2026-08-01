/**
 * G. CLI 测试矩阵。
 */

import { describe, expect, it } from 'vitest';
import {
  runCli,
  parseCliArgs,
  CliUsageError,
  BLIND_TEMP_SUFFIX,
  deriveBlindPublicationPaths,
} from './cli.js';
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

  renameFile(from: string, to: string): void {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.delete(from);
    this.files.set(to, content);
  }

  removeFile(p: string): void {
    if (!this.files.has(p)) throw new Error(`ENOENT: ${p}`);
    this.files.delete(p);
  }

  tempArtifacts(): string[] {
    return [...this.files.keys()].filter((k) => k.includes(BLIND_TEMP_SUFFIX));
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
      renameFile: (from: string, to: string) => fs.renameFile(from, to),
      removeFile: (p: string) => fs.removeFile(p),
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

  it('blind 缺少 --mapping-output 明确失败', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(['blind', 'suite.json', '--seed', 's'], h.deps);
    expect(code).toBeGreaterThan(0);
    expect(h.err.join('')).toContain('--mapping-output');
    // 不允许把 mapping 输出到 stdout
    expect(h.out.join('')).not.toContain('candidateId');
  });

  it('blind 无 --packet-output 时 packet 输出到 stdout，mapping 只在文件', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(
      ['blind', 'suite.json', '--seed', 's', '--mapping-output', 'mapping.json'],
      h.deps,
    );
    expect(code).toBe(0);
    const stdout = h.out.join('');
    expect(stdout).toContain('"packetId"');
    // stdout 只有一个合法 JSON document（packet），不含 mapping
    expect(stdout).not.toContain('candidateId');
    // mapping 写入文件
    expect(h.fs.files.get('mapping.json')).toContain('candidateId');
  });

  it('blind 拒绝 packet-output 与 mapping-output 同路径', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'same.json',
        '--mapping-output',
        'same.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.err.join('')).toContain('同一路径');
  });

  it('blind 在写入失败时不产生误导性成功', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const originalWrite = h.deps.writeFile;
    h.deps.writeFile = (p: string, content: string) => {
      if (p === 'mapping.json.gq1-tmp') {
        throw new Error('EACCES: permission denied /Users/secret/dir');
      }
      originalWrite(p, content);
    };
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    // 错误消息安全：不暴露绝对路径 / 原始 errno
    expect(h.err.join('')).not.toContain('/Users/secret');
    expect(h.err.join('')).not.toContain('EACCES');
    // 不产生误导性成功：无 packet 文件、无 mapping 文件
    expect(h.fs.files.has('packet.json')).toBe(false);
    expect(h.fs.files.has('mapping.json')).toBe(false);
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

describe('runCli — blind 路径身份（规范化绝对路径比较）', () => {
  const ABS = process.cwd();

  async function expectSamePathRejected(packetOut: string, mappingOut: string, force = false) {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const args = [
      'blind',
      'suite.json',
      '--seed',
      's',
      '--packet-output',
      packetOut,
      '--mapping-output',
      mappingOut,
    ];
    if (force) args.push('--force');
    const code = await runCli(args, h.deps);
    expect(code).toBeGreaterThan(0);
    expect(h.err.join('')).toContain('同一路径');
    // 错误消息只显示 basename，不泄露规范化后的绝对路径
    expect(h.err.join('')).not.toContain(ABS);
  }

  it('exact same path 拒绝', async () => {
    await expectSamePathRejected('packet.json', 'packet.json');
  });

  it('./path alias 拒绝', async () => {
    await expectSamePathRejected('./packet.json', 'packet.json');
  });

  it('父级遍历 alias 拒绝（out/../packet.json）', async () => {
    await expectSamePathRejected('out/../packet.json', 'packet.json');
  });

  it('相对路径与对应绝对路径 alias 拒绝', async () => {
    await expectSamePathRejected('packet.json', `${ABS}/packet.json`);
  });

  it('使用 --force 时同路径也拒绝', async () => {
    await expectSamePathRejected('./packet.json', 'packet.json', true);
  });

  it('mapping 不得覆盖 packet', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'out/../packet.json',
        '--mapping-output',
        'packet.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    // 同路径被拒，mapping 不会覆盖 packet
    expect(h.fs.files.get('packet.json')).toBeUndefined();
  });
});

describe('runCli — blind 原子（staged）发布与 rollback', () => {
  function failOnWrite(
    h: ReturnType<typeof makeHarness>,
    pathIncludes: string,
  ): ReturnType<typeof makeHarness>['deps']['writeFile'] {
    const origWrite = h.deps.writeFile;
    return (p: string, c: string) => {
      if (p.includes(pathIncludes)) throw new Error('EACCES /Users/kevin/secret.json');
      origWrite(p, c);
    };
  }

  it('mapping 临时写失败：无 packet / mapping 文件，stdout 为空', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    h.deps.writeFile = failOnWrite(h, 'mapping.json.gq1-tmp');
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.fs.files.has('packet.json')).toBe(false);
    expect(h.fs.files.has('mapping.json')).toBe(false);
    expect(h.out.join('')).toBe('');
    expect(h.fs.tempArtifacts()).toEqual([]);
  });

  it('packet 临时写失败：无新正式文件，stdout 为空', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    h.deps.writeFile = failOnWrite(h, 'packet.json.gq1-tmp');
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.fs.files.has('packet.json')).toBe(false);
    expect(h.fs.files.has('mapping.json')).toBe(false);
    expect(h.out.join('')).toBe('');
    expect(h.fs.tempArtifacts()).toEqual([]);
  });

  it('mapping publish 失败：无正式文件，stdout 为空', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const origRename = h.deps.renameFile;
    h.deps.renameFile = (from: string, to: string) => {
      if (to === 'mapping.json') throw new Error('EACCES publish');
      origRename(from, to);
    };
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.fs.files.has('packet.json')).toBe(false);
    expect(h.fs.files.has('mapping.json')).toBe(false);
    expect(h.out.join('')).toBe('');
    expect(h.fs.tempArtifacts()).toEqual([]);
  });

  it('packet publish 失败：rollback 移除已发布 mapping，stdout 为空', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const origRename = h.deps.renameFile;
    h.deps.renameFile = (from: string, to: string) => {
      if (to === 'packet.json') throw new Error('EACCES publish');
      origRename(from, to);
    };
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    // mapping 已发布但随后失败 → rollback 移除 mapping
    expect(h.fs.files.has('mapping.json')).toBe(false);
    expect(h.fs.files.has('packet.json')).toBe(false);
    expect(h.out.join('')).toBe('');
    expect(h.fs.tempArtifacts()).toEqual([]);
  });

  it('stdout 模式 mapping publish 失败：stdout 为空', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const origRename = h.deps.renameFile;
    h.deps.renameFile = (from: string, to: string) => {
      if (to === 'mapping.json') throw new Error('EACCES publish');
      origRename(from, to);
    };
    const code = await runCli(
      ['blind', 'suite.json', '--seed', 's', '--mapping-output', 'mapping.json'],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.out.join('')).toBe('');
    expect(h.fs.files.has('mapping.json')).toBe(false);
  });

  it('--force 失败时不损坏原有 packet/mapping', async () => {
    const h = makeHarness({
      'suite.json': SUITE_JSON,
      'packet.json': 'old-packet',
      'mapping.json': 'old-mapping',
    });
    const origRename = h.deps.renameFile;
    let publishAttempted = false;
    h.deps.renameFile = (from: string, to: string) => {
      // 只让首次发布失败，rollback 的恢复 rename 正常执行
      if (to === 'packet.json' && !publishAttempted) {
        publishAttempted = true;
        throw new Error('EACCES publish');
      }
      origRename(from, to);
    };
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
        '--force',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    // rollback 恢复旧文件
    expect(h.fs.files.get('mapping.json')).toBe('old-mapping');
    expect(h.fs.files.get('packet.json')).toBe('old-packet');
    expect(h.fs.tempArtifacts()).toEqual([]);
  });

  it('成功时两个正式文件正确且无临时文件', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBe(0);
    expect(JSON.parse(h.fs.files.get('packet.json')!)).toHaveProperty('packetId');
    expect(JSON.parse(h.fs.files.get('mapping.json')!)).toHaveProperty('entries');
    expect(h.fs.tempArtifacts()).toEqual([]);
  });

  it('公共错误不含绝对路径 / Bearer / API_KEY / errno', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    h.deps.writeFile = failOnWrite(h, 'mapping.json.gq1-tmp');
    const code = await runCli(
      ['blind', 'suite.json', '--seed', 's', '--mapping-output', 'mapping.json'],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    const all = h.out.join('') + h.err.join('');
    expect(all).not.toContain('/Users/kevin');
    expect(all).not.toContain('Bearer');
    expect(all).not.toContain('API_KEY');
    expect(all).not.toContain('EACCES');
    expect(all).toContain('IO 错误');
  });
});

describe('deriveBlindPublicationPaths — 输出角色派生', () => {
  it('双文件模式派生全部 final/temp/backup 角色', () => {
    expect(deriveBlindPublicationPaths('packet.json', 'mapping.json')).toEqual({
      mappingFinal: 'mapping.json',
      mappingTemp: 'mapping.json.gq1-tmp',
      mappingBackup: 'mapping.json.gq1-tmp.bak',
      packetFinal: 'packet.json',
      packetTemp: 'packet.json.gq1-tmp',
      packetBackup: 'packet.json.gq1-tmp.bak',
    });
  });

  it('stdout packet 模式下无 packet 文件角色', () => {
    const roles = deriveBlindPublicationPaths(undefined, 'mapping.json');
    expect(roles.packetFinal).toBeNull();
    expect(roles.packetTemp).toBeNull();
    expect(roles.packetBackup).toBeNull();
    expect(roles.mappingFinal).toBe('mapping.json');
  });
});

describe('runCli — blind 派生输出路径角色碰撞（任何 IO 之前拒绝）', () => {
  async function expectRoleCollisionRejected(
    packetOut: string,
    mappingOut: string,
    opts: { force?: boolean; preexisting?: Record<string, string> } = {},
  ) {
    const h = makeHarness({ 'suite.json': SUITE_JSON, ...(opts.preexisting ?? {}) });
    const args = [
      'blind',
      'suite.json',
      '--seed',
      's',
      '--packet-output',
      packetOut,
      '--mapping-output',
      mappingOut,
    ];
    if (opts.force) args.push('--force');
    const code = await runCli(args, h.deps);
    expect(code).toBeGreaterThan(0);
    expect(h.err.join('')).toContain('路径角色冲突');
    expect(h.err.join('')).toContain('同一路径');
    // 错误不泄露规范化绝对路径
    expect(h.err.join('')).not.toContain(process.cwd());
    expect(h.out.join('')).toBe('');
    return h;
  }

  it('mapping.final == packet.temp 被拒绝（packet-output X.json / mapping-output X.json.gq1-tmp）', async () => {
    const h = await expectRoleCollisionRejected('pkt.json', 'pkt.json.gq1-tmp');
    expect(h.fs.files.has('pkt.json')).toBe(false);
    expect(h.fs.files.has('pkt.json.gq1-tmp')).toBe(false);
    expect(h.fs.tempArtifacts()).toEqual([]);
  });

  it('packet.final == mapping.temp 被拒绝（packet-output X.json.gq1-tmp / mapping-output X.json）', async () => {
    const h = await expectRoleCollisionRejected('pkt.json.gq1-tmp', 'pkt.json');
    expect(h.fs.files.has('pkt.json')).toBe(false);
    expect(h.fs.files.has('pkt.json.gq1-tmp')).toBe(false);
    expect(h.fs.tempArtifacts()).toEqual([]);
  });

  it('packet.backup == mapping.final 被拒绝（packet-output X.json / mapping-output X.json.gq1-tmp.bak）', async () => {
    const h = await expectRoleCollisionRejected('pkt.json', 'pkt.json.gq1-tmp.bak');
    expect(h.fs.files.has('pkt.json')).toBe(false);
    expect(h.fs.files.has('pkt.json.gq1-tmp.bak')).toBe(false);
    expect(h.fs.tempArtifacts()).toEqual([]);
  });

  it('packet.final == mapping.backup 被拒绝（packet-output X.json.gq1-tmp.bak / mapping-output X.json）', async () => {
    const h = await expectRoleCollisionRejected('pkt.json.gq1-tmp.bak', 'pkt.json');
    expect(h.fs.files.has('pkt.json')).toBe(false);
    expect(h.fs.files.has('pkt.json.gq1-tmp.bak')).toBe(false);
    expect(h.fs.tempArtifacts()).toEqual([]);
  });

  it('--force 下路径角色碰撞同样前置拒绝，且不破坏已有 final 文件', async () => {
    const h = await expectRoleCollisionRejected('pkt.json', 'pkt.json.gq1-tmp', {
      force: true,
      preexisting: { 'pkt.json': 'old-packet', 'pkt.json.gq1-tmp': 'old-mapping' },
    });
    expect(h.fs.files.get('pkt.json')).toBe('old-packet');
    expect(h.fs.files.get('pkt.json.gq1-tmp')).toBe('old-mapping');
    // 文件集合保持原样，未创建任何新输出/临时/备份
    expect([...h.fs.files.keys()].sort()).toEqual(['pkt.json', 'pkt.json.gq1-tmp', 'suite.json']);
  });

  it('backup 后缀碰撞在 --force 下前置拒绝，旧文件 byte-identical', async () => {
    const h = await expectRoleCollisionRejected('pkt.json', 'pkt.json.gq1-tmp.bak', {
      force: true,
      preexisting: { 'pkt.json': 'old-packet', 'pkt.json.gq1-tmp.bak': 'old-mapping' },
    });
    expect(h.fs.files.get('pkt.json')).toBe('old-packet');
    expect(h.fs.files.get('pkt.json.gq1-tmp.bak')).toBe('old-mapping');
    // 文件集合保持原样，未创建任何新输出/临时/备份
    expect([...h.fs.files.keys()].sort()).toEqual([
      'pkt.json',
      'pkt.json.gq1-tmp.bak',
      'suite.json',
    ]);
  });

  it('路径角色碰撞错误不含绝对路径 / Bearer / API_KEY / errno', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        `${process.cwd()}/pkt.json`,
        '--mapping-output',
        'pkt.json.gq1-tmp',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    const all = h.out.join('') + h.err.join('');
    expect(all).not.toContain(process.cwd());
    expect(all).not.toContain('Bearer');
    expect(all).not.toContain('API_KEY');
    expect(all).not.toContain('EACCES');
    expect(all).not.toContain('ENOENT');
  });
});

describe('runCli — blind 辅助路径存在性保护', () => {
  it('预先存在 mapping temp 文件时拒绝且不覆盖', async () => {
    const h = makeHarness({
      'suite.json': SUITE_JSON,
      'mapping.json.gq1-tmp': 'foreign-temp',
    });
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.err.join('')).toContain('临时文件');
    expect(h.err.join('')).toContain('已存在');
    expect(h.fs.files.get('mapping.json.gq1-tmp')).toBe('foreign-temp');
    expect(h.fs.files.has('mapping.json')).toBe(false);
    expect(h.fs.files.has('packet.json')).toBe(false);
    expect(h.out.join('')).toBe('');
  });

  it('预先存在 packet temp 文件时拒绝且不覆盖', async () => {
    const h = makeHarness({
      'suite.json': SUITE_JSON,
      'packet.json.gq1-tmp': 'foreign-temp',
    });
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.err.join('')).toContain('临时文件');
    expect(h.fs.files.get('packet.json.gq1-tmp')).toBe('foreign-temp');
    expect(h.fs.files.has('packet.json')).toBe(false);
    expect(h.fs.files.has('mapping.json')).toBe(false);
    expect(h.fs.tempArtifacts()).toEqual(['packet.json.gq1-tmp']);
  });

  it('--force 下预先存在 mapping backup 文件时拒绝且不覆盖', async () => {
    const h = makeHarness({
      'suite.json': SUITE_JSON,
      'mapping.json': 'old-mapping',
      'mapping.json.gq1-tmp.bak': 'foreign-backup',
    });
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--force',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.err.join('')).toContain('备份文件');
    expect(h.fs.files.get('mapping.json')).toBe('old-mapping');
    expect(h.fs.files.get('mapping.json.gq1-tmp.bak')).toBe('foreign-backup');
    expect(h.fs.files.has('mapping.json.gq1-tmp')).toBe(false);
    expect(h.out.join('')).toBe('');
  });

  it('--force 下预先存在 packet backup 文件时拒绝且不覆盖', async () => {
    const h = makeHarness({
      'suite.json': SUITE_JSON,
      'packet.json': 'old-packet',
      'packet.json.gq1-tmp.bak': 'foreign-backup',
    });
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--force',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.err.join('')).toContain('备份文件');
    expect(h.fs.files.get('packet.json')).toBe('old-packet');
    expect(h.fs.files.get('packet.json.gq1-tmp.bak')).toBe('foreign-backup');
    expect(h.fs.files.has('packet.json.gq1-tmp')).toBe(false);
    expect(h.out.join('')).toBe('');
  });

  it('辅助路径错误不含绝对路径', async () => {
    const h = makeHarness({
      'suite.json': SUITE_JSON,
      'sub/mapping.json.gq1-tmp': 'foreign-temp',
    });
    const code = await runCli(
      ['blind', 'suite.json', '--seed', 's', '--mapping-output', 'sub/mapping.json'],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    const all = h.out.join('') + h.err.join('');
    expect(all).not.toContain(process.cwd());
  });
});

describe('runCli — blind temp 部分写入失败清理', () => {
  it('mapping temp 写入产生部分文件后抛错：该 temp 被清理，无正式文件，stdout 空', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const origWrite = h.deps.writeFile;
    h.deps.writeFile = (p: string, c: string) => {
      if (p === 'mapping.json.gq1-tmp') {
        // 模拟“先产生部分文件再失败”
        h.fs.files.set(p, 'partial-mapping');
        throw new Error('EACCES /Users/kevin/secret.json');
      }
      origWrite(p, c);
    };
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.fs.files.has('mapping.json.gq1-tmp')).toBe(false);
    expect(h.fs.files.has('mapping.json')).toBe(false);
    expect(h.fs.files.has('packet.json')).toBe(false);
    expect(h.out.join('')).toBe('');
    const all = h.out.join('') + h.err.join('');
    expect(all).not.toContain('/Users/kevin');
    expect(all).not.toContain('EACCES');
    expect(all).toContain('IO 错误');
  });

  it('packet temp 写入产生部分文件后抛错：该 temp 被清理，无正式文件', async () => {
    const h = makeHarness({ 'suite.json': SUITE_JSON });
    const origWrite = h.deps.writeFile;
    h.deps.writeFile = (p: string, c: string) => {
      if (p === 'packet.json.gq1-tmp') {
        h.fs.files.set(p, 'partial-packet');
        throw new Error('EACCES /Users/kevin/secret.json');
      }
      origWrite(p, c);
    };
    const code = await runCli(
      [
        'blind',
        'suite.json',
        '--seed',
        's',
        '--packet-output',
        'packet.json',
        '--mapping-output',
        'mapping.json',
      ],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.fs.files.has('packet.json.gq1-tmp')).toBe(false);
    expect(h.fs.files.has('mapping.json')).toBe(false);
    expect(h.fs.files.has('packet.json')).toBe(false);
    expect(h.out.join('')).toBe('');
    const all = h.out.join('') + h.err.join('');
    expect(all).not.toContain('/Users/kevin');
    expect(all).not.toContain('EACCES');
    expect(all).toContain('IO 错误');
  });
});

describe('runCli — blind alias 规则', () => {
  it('拒绝多字母 alias（AA）', async () => {
    const { packetJson } = packetFiles();
    const bad = JSON.parse(packetJson);
    bad.cases[0].candidates[0].alias = 'AA';
    const h = makeHarness({
      'bad-packet.json': JSON.stringify(bad),
      'ratings.json': '[]',
    });
    const code = await runCli(
      ['validate', 'ratings.json', '--type', 'ratings', '--packet', 'bad-packet.json'],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    expect(h.err.join('')).toContain('大写单字母');
  });

  it('生成的单字母 alias 通过校验', () => {
    const { packetJson } = packetFiles();
    const packet = JSON.parse(packetJson) as BlindPacketV1;
    const aliases = packet.cases.flatMap((c) => c.candidates.map((x) => x.alias));
    expect(aliases.length).toBeGreaterThan(0);
    expect(aliases.every((a) => /^[A-Z]$/.test(a))).toBe(true);
  });
});

describe('runCli — IO 错误安全（不泄漏绝对路径 / 密钥 / errno）', () => {
  const SECRET_ERROR = (op: string) =>
    new Error(
      `${op} failed: /Users/kevin/private/secret.json ENOENT Bearer secret-token API_KEY=secret`,
    );

  function secretHarness(overrides: Partial<ReturnType<typeof makeHarness>['deps']> = {}) {
    const baseDeps = makeHarness({ 'suite.json': SUITE_JSON });
    return {
      ...baseDeps,
      deps: {
        ...baseDeps.deps,
        ...overrides,
      },
    };
  }

  it('读取失败不泄漏错误内容', async () => {
    const h = secretHarness({
      readFile: () => {
        throw SECRET_ERROR('read');
      },
    });
    const code = await runCli(['validate', 'suite.json'], h.deps);
    expect(code).toBeGreaterThan(0);
    const all = h.out.join('') + h.err.join('');
    expect(all).not.toContain('/Users/kevin');
    expect(all).not.toContain('Bearer secret-token');
    expect(all).not.toContain('API_KEY=secret');
    expect(all).not.toContain('ENOENT');
    expect(all).toContain('IO 错误');
  });

  it('写入失败不泄漏错误内容', async () => {
    const h = secretHarness({
      writeFile: () => {
        throw SECRET_ERROR('write');
      },
    });
    const code = await runCli(
      ['evaluate', 'suite.json', '--output', 'report.json', '--clock', fixedClockIso()],
      h.deps,
    );
    expect(code).toBeGreaterThan(0);
    const all = h.out.join('') + h.err.join('');
    expect(all).not.toContain('/Users/kevin');
    expect(all).not.toContain('Bearer secret-token');
    expect(all).not.toContain('API_KEY=secret');
    expect(all).toContain('IO 错误');
  });

  it('JSON 解析失败不泄漏原文内容', async () => {
    const h = secretHarness();
    h.fs.files.set('bad.json', 'Bearer secret-token { not json /Users/kevin/private/secret.json');
    const code = await runCli(['validate', 'bad.json'], h.deps);
    expect(code).toBeGreaterThan(0);
    const all = h.out.join('') + h.err.join('');
    expect(all).not.toContain('Bearer secret-token');
    expect(all).not.toContain('/Users/kevin');
    expect(all).toContain('JSON 格式错误');
  });
});
