/**
 * 评分者间一致性。
 *
 * 选用 Krippendorff's alpha：
 * - 支持多于两位评分者；
 * - 不要求每个评分者覆盖全部 (case, candidate)；
 * - ordinal 差异函数把 1–5 分视为有序等级，而不是名义类别。
 *
 * alpha 在小样本上很不稳定，因此同时报告每个维度的完全一致率与 ±1 内一致率，
 * 并把参与计算的样本量与排除量一并暴露。
 */

import {
  HUMAN_RATING_DIMENSIONS,
  type DimensionAgreement,
  type HumanRatingDimension,
  type HumanRatingV1,
  type RatingAgreementBlock,
  type RatingAgreementSample,
} from './schema.js';

const RATING_SCORE_MIN = 1;
const RATING_SCORE_MAX = 5;

interface AgreementUnit {
  readonly caseId: string;
  readonly alias: string;
  readonly ratings: HumanRatingV1[];
}

export interface RatingAgreementResult {
  readonly agreement: RatingAgreementBlock;
  readonly warnings: string[];
}

function scoreOf(rating: HumanRatingV1, dimension: HumanRatingDimension): number | null {
  const value: unknown = rating[dimension];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < RATING_SCORE_MIN ||
    value > RATING_SCORE_MAX
  ) {
    return null;
  }
  return value;
}

function buildUnits(ratings: readonly HumanRatingV1[]): AgreementUnit[] {
  const byKey = new Map<string, AgreementUnit>();
  for (const rating of ratings) {
    const key = JSON.stringify([rating.caseId, rating.candidateAlias]);
    let unit = byKey.get(key);
    if (!unit) {
      unit = { caseId: rating.caseId, alias: rating.candidateAlias, ratings: [] };
      byKey.set(key, unit);
    }
    unit.ratings.push(rating);
  }
  return [...byKey.values()];
}

function ordinalDistance(a: number, b: number, counts: readonly number[]): number {
  if (a === b) return 0;
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  let sum = 0;
  for (let value = low; value <= high; value += 1) {
    sum += counts[value];
  }
  const distance = sum - (counts[low] + counts[high]) / 2;
  return distance * distance;
}

/**
 * Krippendorff's alpha（ordinal difference）。
 *
 * 单元 = 一个 (case, candidate) 在某个维度上的一组评分。只使用至少 2 个评分的单元；
 * 被排除的单元由调用方通过 sample / warnings 暴露，不在此处静默丢弃。
 */
function computeAlphaOrdinal(unitScores: readonly (readonly number[])[]): number | null {
  const pairable = unitScores.filter((scores) => scores.length >= 2);
  const n = pairable.reduce((sum, scores) => sum + scores.length, 0);
  if (n < 2) return null;

  const counts = new Array<number>(RATING_SCORE_MAX + 1).fill(0);
  for (const scores of pairable) {
    for (const score of scores) {
      counts[score] += 1;
    }
  }

  let observedNumerator = 0;
  for (const scores of pairable) {
    let unorderedSum = 0;
    for (let i = 0; i < scores.length; i += 1) {
      for (let j = i + 1; j < scores.length; j += 1) {
        unorderedSum += ordinalDistance(scores[i], scores[j], counts);
      }
    }
    observedNumerator += (2 * unorderedSum) / (scores.length - 1);
  }
  const observedDisagreement = observedNumerator / n;

  let expectedNumerator = 0;
  for (let c = RATING_SCORE_MIN; c <= RATING_SCORE_MAX; c += 1) {
    for (let k = RATING_SCORE_MIN; k <= RATING_SCORE_MAX; k += 1) {
      expectedNumerator += counts[c] * counts[k] * ordinalDistance(c, k, counts);
    }
  }
  const expectedDisagreement = expectedNumerator / (n * (n - 1));

  if (expectedDisagreement === 0) {
    return observedDisagreement === 0 ? 1 : null;
  }
  return 1 - observedDisagreement / expectedDisagreement;
}

interface PairAgreementRates {
  readonly exact: number | null;
  readonly withinOne: number | null;
  readonly pairCount: number;
}

function computePairAgreementRates(unitScores: readonly (readonly number[])[]): PairAgreementRates {
  let pairCount = 0;
  let exactCount = 0;
  let withinOneCount = 0;
  for (const scores of unitScores) {
    if (scores.length < 2) continue;
    for (let i = 0; i < scores.length; i += 1) {
      for (let j = i + 1; j < scores.length; j += 1) {
        pairCount += 1;
        const distance = Math.abs(scores[i] - scores[j]);
        if (distance === 0) exactCount += 1;
        if (distance <= 1) withinOneCount += 1;
      }
    }
  }
  if (pairCount === 0) {
    return { exact: null, withinOne: null, pairCount: 0 };
  }
  return { exact: exactCount / pairCount, withinOne: withinOneCount / pairCount, pairCount };
}

function computeDimensionAgreement(
  units: readonly AgreementUnit[],
  dimension: HumanRatingDimension,
): DimensionAgreement {
  const rows: { unit: AgreementUnit; scores: number[] }[] = [];
  for (const unit of units) {
    const scores = unit.ratings
      .map((rating) => scoreOf(rating, dimension))
      .filter((value): value is number => value !== null);
    if (scores.length >= 2) {
      rows.push({ unit, scores });
    }
  }

  const unitScores = rows.map((row) => row.scores);
  const alpha = computeAlphaOrdinal(unitScores);
  const rates = computePairAgreementRates(unitScores);

  const raterIds = new Set<string>();
  const caseIds = new Set<string>();
  let ratingCount = 0;
  for (const row of rows) {
    caseIds.add(row.unit.caseId);
    for (const rating of row.unit.ratings) {
      if (scoreOf(rating, dimension) !== null) {
        raterIds.add(rating.raterId);
      }
    }
    ratingCount += row.scores.length;
  }

  return {
    alpha,
    exactAgreementRate: rates.exact,
    withinOneAgreementRate: rates.withinOne,
    comparablePairCount: rates.pairCount,
    ratingCount,
    raterCount: raterIds.size,
    caseCount: caseIds.size,
    candidateCount: rows.length,
  };
}

function computeOverallAlpha(units: readonly AgreementUnit[]): number | null {
  const overallUnitScores: number[][] = [];
  for (const unit of units) {
    for (const dimension of HUMAN_RATING_DIMENSIONS) {
      const scores = unit.ratings
        .map((rating) => scoreOf(rating, dimension))
        .filter((value): value is number => value !== null);
      if (scores.length >= 2) {
        overallUnitScores.push(scores);
      }
    }
  }
  return computeAlphaOrdinal(overallUnitScores);
}

function computeSample(
  units: readonly AgreementUnit[],
  allRaterIds: ReadonlySet<string>,
): RatingAgreementSample {
  const comparableUnits = units.filter((unit) => unit.ratings.length >= 2);
  const comparableRaterIds = new Set<string>();
  const comparableCaseIds = new Set<string>();
  let ratingCount = 0;
  let pairCount = 0;

  for (const unit of comparableUnits) {
    comparableCaseIds.add(unit.caseId);
    for (const rating of unit.ratings) {
      comparableRaterIds.add(rating.raterId);
    }
    ratingCount += unit.ratings.length;
    pairCount += (unit.ratings.length * (unit.ratings.length - 1)) / 2;
  }

  const allCaseIds = new Set(units.map((unit) => unit.caseId));
  const totalRatingCount = units.reduce((sum, unit) => sum + unit.ratings.length, 0);
  const excludedRaterCount = [...allRaterIds].filter((id) => !comparableRaterIds.has(id)).length;
  const excludedCaseCount = [...allCaseIds].filter((id) => !comparableCaseIds.has(id)).length;

  return {
    ratingCount,
    raterCount: comparableRaterIds.size,
    caseCount: comparableCaseIds.size,
    candidateCount: comparableUnits.length,
    comparablePairCount: pairCount,
    excludedRatingCount: totalRatingCount - ratingCount,
    excludedRaterCount,
    excludedCaseCount,
    excludedCandidateCount: units.length - comparableUnits.length,
  };
}

function excludedRaterIds(
  units: readonly AgreementUnit[],
  allRaterIds: ReadonlySet<string>,
): string[] {
  const comparableRaterIds = new Set<string>();
  for (const unit of units) {
    if (unit.ratings.length < 2) continue;
    for (const rating of unit.ratings) {
      comparableRaterIds.add(rating.raterId);
    }
  }
  return [...allRaterIds].filter((id) => !comparableRaterIds.has(id)).sort();
}

function excludedCaseIds(units: readonly AgreementUnit[]): string[] {
  const allCaseIds = new Set(units.map((unit) => unit.caseId));
  const comparableCaseIds = new Set<string>();
  for (const unit of units) {
    if (unit.ratings.length >= 2) comparableCaseIds.add(unit.caseId);
  }
  return [...allCaseIds].filter((id) => !comparableCaseIds.has(id)).sort();
}

function buildWarnings(
  units: readonly AgreementUnit[],
  allRaterIds: ReadonlySet<string>,
  dimensions: Record<HumanRatingDimension, DimensionAgreement>,
  sample: RatingAgreementSample,
): string[] {
  const warnings: string[] = [];
  if (allRaterIds.size < 2) {
    warnings.push(
      `评分者间一致性需要至少 2 位评分者，当前为 ${allRaterIds.size}；alpha 与一致率均置为 null`,
    );
    return warnings;
  }

  if (sample.candidateCount === 0) {
    warnings.push(
      '没有任何 (case, candidate) 被至少 2 位评分者共同评分；alpha 与一致率均置为 null',
    );
    return warnings;
  }

  if (sample.excludedCandidateCount > 0) {
    warnings.push(
      `一致性计算仅使用被至少 2 位评分者共同评分的 (case, candidate)；已排除 ${sample.excludedCandidateCount} 个仅有 1 位评分者的候选单元`,
    );
  }

  for (const raterId of excludedRaterIds(units, allRaterIds)) {
    warnings.push(
      `评分者 "${raterId}" 没有任何评分与其他评分者共同覆盖同一 (case, candidate)，未参与一致性计算`,
    );
  }
  for (const caseId of excludedCaseIds(units)) {
    warnings.push(
      `case "${caseId}" 没有任何 candidate 被至少 2 位评分者共同评分，未参与一致性计算`,
    );
  }
  for (const dimension of HUMAN_RATING_DIMENSIONS) {
    if (dimensions[dimension].alpha === null) {
      warnings.push(`维度 "${dimension}" 没有可比较的 (case, candidate)，alpha 置为 null`);
    }
  }
  return warnings;
}

export function computeRatingAgreement(ratings: readonly HumanRatingV1[]): RatingAgreementResult {
  const units = buildUnits(ratings);
  const allRaterIds = new Set(ratings.map((rating) => rating.raterId));
  const sample = computeSample(units, allRaterIds);

  const dimensions = {} as Record<HumanRatingDimension, DimensionAgreement>;
  for (const dimension of HUMAN_RATING_DIMENSIONS) {
    dimensions[dimension] = computeDimensionAgreement(units, dimension);
  }

  const agreement: RatingAgreementBlock = {
    method: 'krippendorff-alpha',
    metric: 'ordinal',
    rationale:
      '选用 Krippendorff alpha（ordinal difference）：支持多于两位评分者、容忍缺失覆盖，并把 1–5 分视为有序等级而非名义类别。',
    overallAlpha: computeOverallAlpha(units),
    dimensions,
    sample,
  };

  return { agreement, warnings: buildWarnings(units, allRaterIds, dimensions, sample) };
}
