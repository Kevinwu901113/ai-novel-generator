/**
 * F. 人工评分验证与聚合测试。
 */

import { describe, expect, it } from 'vitest';
import { aggregateRatings, validateRatings, RatingValidationError } from './rating.js';
import { generateBlindPacket } from './blind.js';
import { getBaselineSuite } from './fixtures.js';
import { fixedClockIso } from './test-util.js';
import { HUMAN_RATING_DIMENSIONS, type BlindPacketV1, type HumanRatingV1 } from './schema.js';

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

  it('接受显式 null 作为未评维度', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const r = makeRating(packet, {
      candidateAlias: a,
      preferredRank: 1,
      continueReading: null,
      expectationFit: null,
      characterCredibility: null,
      languageNaturalness: null,
      aiSmellAbsence: null,
      plotProgression: null,
      concision: null,
      continuity: null,
    });
    const validated = validateRatings([r], { packet });
    expect(validated[0].continueReading).toBeNull();
    expect(validated[0].languageNaturalness).toBeNull();
    expect(validated[0].aiSmellAbsence).toBeNull();
    expect(validated[0].preferredRank).toBe(1);
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

  it('拒绝未知 alias（单字母但不在 packet 中）', () => {
    const packet = makePacket();
    const r = makeRating(packet, { candidateAlias: 'Z' });
    expectRatingError([r], packet, /不存在 alias/);
  });

  it('拒绝非法 alias 格式（AA / ZZ / 小写 / 数字）', () => {
    const packet = makePacket();
    for (const bad of ['AA', 'ZZ', 'a', '1']) {
      const r = makeRating(packet, { candidateAlias: bad });
      expectRatingError([r], packet, /大写单字母/);
    }
  });

  it('拒绝空 alias', () => {
    const packet = makePacket();
    const r = makeRating(packet, { candidateAlias: '' });
    expectRatingError([r], packet, /不能为空|大写单字母/);
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

  it('接受缺失维度字段并规范化为 null', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const r = makeRating(packet, { candidateAlias: a, preferredRank: 1 }) as unknown as Record<
      string,
      unknown
    >;
    delete r.concision;
    const validated = validateRatings([r], { packet });
    expect(validated[0].concision).toBeNull();
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

  it('未评维度不会被当成 0：一个 5 分、一个未评 -> 均值为 5', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const input = [
      makeRating(packet, {
        candidateAlias: a,
        raterId: 'r1',
        preferredRank: 1,
        continueReading: 5,
      }),
      makeRating(packet, {
        candidateAlias: a,
        raterId: 'r2',
        preferredRank: 1,
        continueReading: null,
      }),
    ];
    const ratings = validateRatings(input, { packet });
    const agg = aggregateRatings({ packet, ratings, mapping: null, clock: CLOCK });
    const ca = agg.candidateAggregates.find(
      (x) => x.caseId === 'restrained-reunion' && x.alias === 'A',
    );
    expect(ca!.dimensions.continueReading.mean).toBe(5);
    expect(ca!.dimensions.continueReading.median).toBe(5);
    expect(ca!.dimensions.continueReading.count).toBe(1);
    expect(ca!.dimensions.continueReading.mean).not.toBe(2.5);
  });

  it('某维度全部未评 -> 聚合为 null、alpha 为 null 且不是 0', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const input = [
      makeRating(packet, {
        candidateAlias: a,
        raterId: 'r1',
        preferredRank: 1,
        continueReading: 5,
        expectationFit: null,
      }),
      makeRating(packet, {
        candidateAlias: a,
        raterId: 'r2',
        preferredRank: 1,
        continueReading: 4,
        expectationFit: null,
      }),
    ];
    const ratings = validateRatings(input, { packet });
    const agg = aggregateRatings({ packet, ratings, mapping: null, clock: CLOCK });
    const ca = agg.candidateAggregates.find(
      (x) => x.caseId === 'restrained-reunion' && x.alias === 'A',
    );
    expect(ca!.dimensions.expectationFit.mean).toBeNull();
    expect(ca!.dimensions.expectationFit.median).toBeNull();
    expect(ca!.dimensions.expectationFit.count).toBe(0);
    expect(ca!.dimensions.expectationFit.mean).not.toBe(0);
    expect(agg.agreement.dimensions.expectationFit.alpha).toBeNull();
    expect(agg.agreement.dimensions.expectationFit.alpha).not.toBe(0);
    expect(
      agg.warnings.some((w) => w.includes('维度 "expectationFit"') && w.includes('alpha')),
    ).toBe(true);
  });

  it('混合评分（三维已评、五维未评）完整走通且每维 count 正确', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const input = [
      makeRating(packet, {
        candidateAlias: a,
        raterId: 'r1',
        preferredRank: 1,
        continueReading: 5,
        languageNaturalness: 4,
        aiSmellAbsence: 3,
        expectationFit: null,
        characterCredibility: null,
        plotProgression: null,
        concision: null,
        continuity: null,
      }),
      makeRating(packet, {
        candidateAlias: a,
        raterId: 'r2',
        preferredRank: 1,
        continueReading: 4,
        languageNaturalness: 5,
        aiSmellAbsence: 4,
        expectationFit: null,
        characterCredibility: null,
        plotProgression: null,
        concision: null,
        continuity: null,
      }),
    ];
    const ratings = validateRatings(input, { packet });
    const agg = aggregateRatings({ packet, ratings, mapping: null, clock: CLOCK });
    const ca = agg.candidateAggregates.find(
      (x) => x.caseId === 'restrained-reunion' && x.alias === 'A',
    );
    expect(ca!.dimensions.continueReading.count).toBe(2);
    expect(ca!.dimensions.languageNaturalness.count).toBe(2);
    expect(ca!.dimensions.aiSmellAbsence.count).toBe(2);
    for (const dim of [
      'expectationFit',
      'characterCredibility',
      'plotProgression',
      'concision',
      'continuity',
    ] as const) {
      expect(ca!.dimensions[dim].count).toBe(0);
      expect(ca!.dimensions[dim].mean).toBeNull();
    }
    expect(agg.agreement.dimensions.continueReading.alpha).not.toBeNull();
    expect(agg.agreement.dimensions.expectationFit.alpha).toBeNull();
  });

  it('现有全 8 维评分聚合与一致性行为保持回归', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const ratings = [
      makeRating(packet, {
        candidateAlias: a,
        raterId: 'r1',
        preferredRank: 1,
        continueReading: 5,
        languageNaturalness: 4,
      }),
      makeRating(packet, {
        candidateAlias: a,
        raterId: 'r2',
        preferredRank: 1,
        continueReading: 4,
        languageNaturalness: 5,
      }),
    ];
    const agg = aggregateRatings({ packet, ratings, mapping: null, clock: CLOCK });
    const ca = agg.candidateAggregates.find(
      (x) => x.caseId === 'restrained-reunion' && x.alias === 'A',
    );
    for (const dim of HUMAN_RATING_DIMENSIONS) {
      expect(ca!.dimensions[dim].count).toBe(2);
      expect(ca!.dimensions[dim].mean).not.toBeNull();
    }
    expect(ca!.dimensions.continueReading.mean).toBe(4.5);
    expect(agg.agreement.overallAlpha).not.toBeNull();
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

  it('missingRatingCoverage 字段存在（完整覆盖下为空）', () => {
    const packet = makePacket();
    const agg = aggregateRatings({
      packet,
      ratings: buildRatings(packet),
      mapping: null,
      clock: CLOCK,
    });
    expect(Array.isArray(agg.missingRatingCoverage)).toBe(true);
    expect(agg.missingRatingCoverage).toEqual([]);
  });

  it('missingRatingCoverage 标记未覆盖全部 alias 的 rater', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    // r1 只给 alias a 打分，未覆盖该 case 的另一个 alias
    const ratings = [
      makeRating(packet, {
        caseId: 'restrained-reunion',
        candidateAlias: a,
        raterId: 'r1',
        preferredRank: 1,
      }),
    ];
    const agg = aggregateRatings({ packet, ratings, mapping: null, clock: CLOCK });
    expect(agg.missingRatingCoverage).toContain('restrained-reunion/r1');
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

  function ratingsForHandAlpha(
    packet: BlindPacketV1,
    continueReadingScores: readonly (readonly [number, number])[],
  ): HumanRatingV1[] {
    return packet.cases.slice(0, continueReadingScores.length).flatMap((c, index) => {
      const alias = [...c.candidates].map((cand) => cand.alias).sort()[0];
      const [r1Score, r2Score] = continueReadingScores[index];
      return [
        makeRating(packet, {
          caseId: c.caseId,
          candidateAlias: alias,
          raterId: 'r1',
          preferredRank: 1,
          continueReading: r1Score,
        }),
        makeRating(packet, {
          caseId: c.caseId,
          candidateAlias: alias,
          raterId: 'r2',
          preferredRank: 1,
          continueReading: r2Score,
        }),
      ];
    });
  }

  it('Krippendorff alpha 手算数据：continueReading 为 113/198', () => {
    const packet = makePacket();
    // 三个 (case, candidate) 单元，两个评分者，continueReading 分数：
    // unit1: r1=1, r2=2 -> δ(1,2)
    // unit2: r1=2, r2=3 -> δ(2,3)
    // unit3: r1=3, r2=4 -> δ(3,4)
    // 参与计算的值频数：n1=1, n2=2, n3=2, n4=1，n=6。
    // ordinal δ(c,k) = ((n_c+n_k)/2 + 中间频数)^2：
    // δ12=(1+2)/2=1.5 -> 2.25；δ23=(2+2)/2=2 -> 4；δ34=(2+1)/2=1.5 -> 2.25。
    // 观测不一致 Do = (2.25 + 4 + 2.25) / 3 = 17/6。
    // 期望不一致 De：Σ_{c<k} n_c n_k δ 有
    // 1*2*2.25=4.5, 1*2*12.25=24.5, 1*1*25=25,
    // 2*2*4=16, 2*1*12.25=24.5, 2*1*2.25=4.5，合计 99；
    // 有序对求和 = 2*99=198，De = 198/(6*5) = 33/5。
    // alpha = 1 - (17/6)/(33/5) = 1 - 85/198 = 113/198。
    const agg = aggregateRatings({
      packet,
      ratings: ratingsForHandAlpha(packet, [
        [1, 2],
        [2, 3],
        [3, 4],
      ]),
      mapping: null,
      clock: CLOCK,
    });
    const agreement = agg.agreement.dimensions.continueReading;
    expect(agreement.alpha).toBeCloseTo(113 / 198, 10);
    expect(agreement.exactAgreementRate).toBe(0);
    expect(agreement.withinOneAgreementRate).toBe(1);
    expect(agreement.comparablePairCount).toBe(3);
    expect(agreement.ratingCount).toBe(6);
    expect(agreement.raterCount).toBe(2);
    expect(agreement.caseCount).toBe(3);
    expect(agreement.candidateCount).toBe(3);
  });

  it('完全一致的评分 -> alpha 恰好为 1', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const ratings = [
      makeRating(packet, { candidateAlias: a, raterId: 'r1', preferredRank: 1 }),
      makeRating(packet, { candidateAlias: a, raterId: 'r2', preferredRank: 1 }),
    ];
    const agg = aggregateRatings({ packet, ratings, mapping: null, clock: CLOCK });
    expect(agg.agreement.overallAlpha).toBe(1);
    for (const dim of Object.values(agg.agreement.dimensions)) {
      expect(dim.alpha).toBe(1);
      expect(dim.exactAgreementRate).toBe(1);
      expect(dim.withinOneAgreementRate).toBe(1);
    }
  });

  it('只有 1 个评分者 -> alpha 为 null 且不是 0/1', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const agg = aggregateRatings({
      packet,
      ratings: [makeRating(packet, { candidateAlias: a, raterId: 'r1', preferredRank: 1 })],
      mapping: null,
      clock: CLOCK,
    });
    expect(agg.agreement.overallAlpha).toBeNull();
    expect(agg.agreement.overallAlpha).not.toBe(0);
    expect(agg.agreement.overallAlpha).not.toBe(1);
    expect(agg.agreement.dimensions.continueReading.alpha).toBeNull();
    expect(agg.agreement.dimensions.continueReading.exactAgreementRate).toBeNull();
    expect(agg.agreement.dimensions.continueReading.withinOneAgreementRate).toBeNull();
    expect(agg.warnings.some((w) => w.includes('至少 2 位评分者'))).toBe(true);
  });

  it('系统性极端分歧 -> alpha ≤ 0', () => {
    const packet = makePacket();
    const agg = aggregateRatings({
      packet,
      ratings: ratingsForHandAlpha(packet, [
        [1, 5],
        [5, 1],
      ]),
      mapping: null,
      clock: CLOCK,
    });
    expect(agg.agreement.dimensions.continueReading.alpha).toBeLessThanOrEqual(0);
  });

  it('维度级降级：只有不可比维度为 null', () => {
    const packet = makePacket();
    const [a] = aliasesOf(packet, 'restrained-reunion');
    const r1 = {
      ...makeRating(packet, { candidateAlias: a, raterId: 'r1', preferredRank: 1 }),
    } as unknown as Record<string, unknown>;
    const r2 = {
      ...makeRating(packet, { candidateAlias: a, raterId: 'r2', preferredRank: 1 }),
    } as unknown as Record<string, unknown>;
    delete r1.continuity;
    delete r2.continuity;
    const agg = aggregateRatings({
      packet,
      ratings: [r1, r2] as unknown as HumanRatingV1[],
      mapping: null,
      clock: CLOCK,
    });
    expect(agg.agreement.dimensions.continuity.alpha).toBeNull();
    expect(agg.agreement.dimensions.continuity.exactAgreementRate).toBeNull();
    expect(agg.agreement.dimensions.continuity.withinOneAgreementRate).toBeNull();
    expect(agg.agreement.dimensions.continueReading.alpha).toBe(1);
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
