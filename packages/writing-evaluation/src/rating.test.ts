/**
 * F. 人工评分验证与聚合测试。
 */

import { describe, expect, it } from 'vitest';
import { aggregateRatings, validateRatings, RatingValidationError } from './rating.js';
import { generateBlindPacket } from './blind.js';
import { getBaselineSuite } from './fixtures.js';
import { fixedClockIso } from './test-util.js';
import type { BlindPacketV1, HumanRatingV1 } from './schema.js';

const CLOCK = { now: () => fixedClockIso() };

function makePacket(seed = 'seed-rating'): BlindPacketV1 {
  return generateBlindPacket(getBaselineSuite(), { seed }).packet;
}

function aliasesOf(packet: BlindPacketV1, caseId: string): string[] {
  const c = packet.cases.find((x) => x.caseId === caseId);
  if (!c) throw new Error(`packet 中不存在 case ${caseId}`);
  return c.candidates.map((x) => x.alias);
}

function makeRating(packet: BlindPacketV1, overrides: Partial<HumanRatingV1> = {}): HumanRatingV1 {
  const caseId = overrides.caseId ?? 'restrained-reunion';
  const [a, b] = aliasesOf(packet, caseId);
  return {
    schemaVersion: 1,
    suiteId: packet.suiteId,
    caseId,
    candidateAlias: overrides.candidateAlias ?? a,
    raterId: overrides.raterId ?? 'rater-1',
    preferredRank: overrides.preferredRank ?? (overrides.candidateAlias === b ? 2 : 1),
    notes: '',
    continueReading: 4,
    expectationFit: 3,
    characterCredibility: 4,
    languageNaturalness: 3,
    aiSmellAbsence: 2,
    plotProgression: 4,
    concision: 3,
    continuity: 4,
    ...overrides,
  };
}

function expectRatingError(input: unknown, packet: BlindPacketV1, pattern: RegExp): void {
  expect(() => validateRatings(input, { packet })).toThrow(RatingValidationError);
  expect(() => validateRatings(input, { packet })).toThrow(pattern);
}

describe('validateRatings — 合法输入', () => {
  it('接受合法 ratings（每个 alias 一条）', () => {
    const packet = makePacket();
    const [a, b] = aliasesOf(packet, 'restrained-reunion');
    const ratings = [
      makeRating(packet, { candidateAlias: a, preferredRank: 1 }),
      makeRating(packet, { candidateAlias: b, preferredRank: 2 }),
    ];
    const validated = validateRatings(ratings, { packet });
    expect(validated).toHaveLength(2);
  });
});

describe('validateRatings — 非法输入', () => {
  it('拒绝非数组', () => {
    const packet = makePacket();
    expectRatingError({ foo: 1 }, packet, /必须是数组/);
  });

  it('拒绝非法 score（0 / 6 / 小数）', () => {
    const packet = makePacket();
    for (const score of [0, 6, 2.5]) {
      const r = makeRating(packet, { continueReading: score });
      expectRatingError([r], packet, /continueReading/);
    }
  });

  it('拒绝重复评分（同 rater/case/alias）', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const r1 = makeRating(packet, { candidateAlias: a, preferredRank: 1 });
    const r2 = makeRating(packet, { candidateAlias: a, preferredRank: 2 });
    expectRatingError([r1, r2], packet, /重复评分/);
  });

  it('拒绝未知 alias', () => {
    const packet = makePacket();
    const r = makeRating(packet, { candidateAlias: 'ZZ' });
    expectRatingError([r], packet, /不存在 alias/);
  });

  it('拒绝非法 preferredRank（0 / 越界）', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    expectRatingError(
      [makeRating(packet, { candidateAlias: a, preferredRank: 0 })],
      packet,
      /preferredRank/,
    );
    expectRatingError(
      [makeRating(packet, { candidateAlias: a, preferredRank: 3 })],
      packet,
      /preferredRank/,
    );
  });

  it('拒绝同 (rater, case) 的 preferredRank 重复', () => {
    const packet = makePacket();
    const [a, b] = aliasesOf(packet, 'restrained-reunion');
    const r1 = makeRating(packet, { candidateAlias: a, preferredRank: 1 });
    const r2 = makeRating(packet, { candidateAlias: b, preferredRank: 1 });
    expectRatingError([r1, r2], packet, /preferredRank .* 重复/);
  });

  it('拒绝缺失维度字段', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const r = makeRating(packet, { candidateAlias: a, preferredRank: 1 }) as unknown as Record<
      string,
      unknown
    >;
    delete r.concision;
    expectRatingError([r], packet, /concision/);
  });

  it('拒绝 extra key', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const r = makeRating(packet, { candidateAlias: a, preferredRank: 1 }) as unknown as Record<
      string,
      unknown
    >;
    r.overall = 4;
    expectRatingError([r], packet, /未知字段/);
  });

  it('拒绝超过 notes 上限', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const r = makeRating(packet, { candidateAlias: a, preferredRank: 1, notes: 'x'.repeat(2001) });
    expectRatingError([r], packet, /notes/);
  });

  it('拒绝空 raterId', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const r = makeRating(packet, { candidateAlias: a, preferredRank: 1, raterId: '   ' });
    expectRatingError([r], packet, /raterId/);
  });

  it('拒绝 suiteId 与 blind packet 不一致的 rating', () => {
    const packet = makePacket();
    const r = makeRating(packet, { suiteId: 'completely-different-suite' });
    expectRatingError([r], packet, /suiteId/);
  });

  it('拒绝带 inherited keys 的对象', () => {
    const packet = makePacket();
    const proto = { inherited: 1 };
    const r = Object.assign(Object.create(proto), makeRating(packet, {}));
    expectRatingError([r], packet, /inherited/);
  });
});

describe('aggregateRatings', () => {
  function buildRatings(packet: BlindPacketV1): HumanRatingV1[] {
    const [a, b] = aliasesOf(packet, 'restrained-reunion');
    return [
      makeRating(packet, {
        caseId: 'restrained-reunion',
        candidateAlias: a,
        raterId: 'r1',
        preferredRank: 1,
        continueReading: 5,
        languageNaturalness: 4,
      }),
      makeRating(packet, {
        caseId: 'restrained-reunion',
        candidateAlias: b,
        raterId: 'r1',
        preferredRank: 2,
        continueReading: 3,
        languageNaturalness: 2,
      }),
      makeRating(packet, {
        caseId: 'restrained-reunion',
        candidateAlias: a,
        raterId: 'r2',
        preferredRank: 1,
        continueReading: 4,
        languageNaturalness: 5,
      }),
      makeRating(packet, {
        caseId: 'restrained-reunion',
        candidateAlias: b,
        raterId: 'r2',
        preferredRank: 2,
        continueReading: 2,
        languageNaturalness: 2,
      }),
    ];
  }

  it('均值 / 中位数 / count', () => {
    const packet = makePacket();
    const agg = aggregateRatings({
      packet,
      ratings: buildRatings(packet),
      mapping: null,
      clock: CLOCK,
    });
    const ca = agg.candidateAggregates.find(
      (x) => x.caseId === 'restrained-reunion' && x.alias === 'A',
    );
    expect(ca).toBeDefined();
    expect(ca!.dimensions.continueReading.mean).toBe(4.5);
    expect(ca!.dimensions.continueReading.median).toBe(4.5);
    expect(ca!.dimensions.continueReading.count).toBe(2);
    expect(ca!.raterCount).toBe(2);
  });

  it('rater count 汇总', () => {
    const packet = makePacket();
    const agg = aggregateRatings({
      packet,
      ratings: buildRatings(packet),
      mapping: null,
      clock: CLOCK,
    });
    expect(agg.raterCount).toBe(2);
  });

  it('preferredRank 分布', () => {
    const packet = makePacket();
    const agg = aggregateRatings({
      packet,
      ratings: buildRatings(packet),
      mapping: null,
      clock: CLOCK,
    });
    const ca = agg.candidateAggregates.find(
      (x) => x.caseId === 'restrained-reunion' && x.alias === 'A',
    );
    expect(ca!.rankDistribution[1]).toBe(2);
  });

  it('pairwise wins：A 胜 B', () => {
    const packet = makePacket();
    const agg = aggregateRatings({
      packet,
      ratings: buildRatings(packet),
      mapping: null,
      clock: CLOCK,
    });
    const pw = agg.pairwiseWins.find((x) => x.caseId === 'restrained-reunion');
    expect(pw).toBeDefined();
    // A 被 2 位 rater 排第 1，B 排第 2 → A 赢 B
    expect(pw!.aliasA).toBe('A');
    expect(pw!.aliasB).toBe('B');
    expect(pw!.aliasAWins).toBe(2);
    expect(pw!.aliasBWins).toBe(0);
  });

  it('pairwise wins：B 胜 A 时方向正确', () => {
    const packet = makePacket();
    const [a, b] = aliasesOf(packet, 'restrained-reunion');
    const ratings = [
      makeRating(packet, { candidateAlias: a, raterId: 'r1', preferredRank: 2 }),
      makeRating(packet, { candidateAlias: b, raterId: 'r1', preferredRank: 1 }),
    ];
    const agg = aggregateRatings({ packet, ratings, mapping: null, clock: CLOCK });
    const pw = agg.pairwiseWins.find((x) => x.caseId === 'restrained-reunion');
    expect(pw!.aliasAWins).toBe(0);
    expect(pw!.aliasBWins).toBe(1);
  });

  it('mapping 解析 candidateId', () => {
    const suite = getBaselineSuite();
    const { packet, mapping } = generateBlindPacket(suite, { seed: 'seed-rating' });
    const agg = aggregateRatings({ packet, ratings: buildRatings(packet), mapping, clock: CLOCK });
    const ca = agg.candidateAggregates.find((x) => x.caseId === 'restrained-reunion');
    expect(ca!.candidateId).not.toBeNull();
  });

  it('不计算 default overall score', () => {
    const packet = makePacket();
    const agg = aggregateRatings({
      packet,
      ratings: buildRatings(packet),
      mapping: null,
      clock: CLOCK,
    });
    const json = JSON.stringify(agg);
    expect(json).not.toContain('overallScore');
    expect(json).not.toContain('overallQualityScore');
  });

  it('missingDimensions 字段存在（完整数据下为空）', () => {
    const packet = makePacket();
    const agg = aggregateRatings({
      packet,
      ratings: buildRatings(packet),
      mapping: null,
      clock: CLOCK,
    });
    expect(Array.isArray(agg.missingDimensions)).toBe(true);
  });

  it('样例规模过小时给出 warning', () => {
    const packet = makePacket();
    const agg = aggregateRatings({
      packet,
      ratings: buildRatings(packet).slice(0, 1),
      mapping: null,
      clock: CLOCK,
    });
    expect(agg.warnings.some((w) => w.includes('示例'))).toBe(true);
  });

  it('稳定输出：相同输入两次一致', () => {
    const packet = makePacket();
    const a = JSON.stringify(
      aggregateRatings({ packet, ratings: buildRatings(packet), mapping: null, clock: CLOCK }),
    );
    const b = JSON.stringify(
      aggregateRatings({ packet, ratings: buildRatings(packet), mapping: null, clock: CLOCK }),
    );
    expect(a).toBe(b);
  });
});
