/**
 * 人工评分数据模型与聚合。
 *
 * - 八个 1–5 整数维度；
 * - alias 必须存在于 blind packet；
 * - 同 rater/case/alias 不得重复；
 * - preferredRank 在 case 内（同 rater）无重复；
 * - 不计算默认 overall score；
 * - 不得把 sample ratings 描述为真实用户研究。
 */

import type {
  BlindPacketV1,
  CandidateRatingAggregate,
  DimensionAggregate,
  HumanRatingDimension,
  HumanRatingV1,
  PairwiseWin,
  PrivateMappingV1,
  RatingAggregationReport,
} from './schema.js';
import {
  BLIND_ALIAS_ERROR,
  DEFAULT_TOOL_VERSION,
  HUMAN_RATING_DIMENSIONS,
  isValidBlindAlias,
} from './schema.js';
import type { Clock } from './clock.js';
import { codePointCompare } from '@ai-novel/domain';

const RATING_SCORE_MIN = 1;
const RATING_SCORE_MAX = 5;
const MAX_NOTES_CODE_POINTS = 2000;
const MIN_RATERS_FOR_STABLE_STATS = 3;

export class RatingValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`[writing-evaluation] ${path}: ${message}`);
    this.name = 'RatingValidationError';
    this.path = path;
  }
}

const RATING_KEYS = new Set([
  'schemaVersion',
  'suiteId',
  'caseId',
  'candidateAlias',
  'raterId',
  'preferredRank',
  'notes',
  ...HUMAN_RATING_DIMENSIONS,
]);

interface CaseAliasIndex {
  readonly validAliases: ReadonlySet<string>;
  readonly candidateCount: number;
}

function buildCaseIndex(packet: BlindPacketV1): Map<string, CaseAliasIndex> {
  const index = new Map<string, CaseAliasIndex>();
  for (const c of packet.cases) {
    const aliases = new Set(c.candidates.map((cand) => cand.alias));
    index.set(c.caseId, { validAliases: aliases, candidateCount: c.candidates.length });
  }
  return index;
}

function validateSingleRating(
  value: unknown,
  path: string,
  caseIndex: Map<string, CaseAliasIndex>,
  expectedSuiteId: string,
): HumanRatingV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RatingValidationError(path, '必须是对象');
  }
  const obj = value as Record<string, unknown>;
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    throw new RatingValidationError(path, '拒绝带自定义原型（含 inherited keys）的对象');
  }

  const own = Object.keys(obj);
  const ownSet = new Set(own);
  for (const key of own) {
    if (!RATING_KEYS.has(key)) throw new RatingValidationError(`${path}.${key}`, '未知字段');
  }
  for (const key of RATING_KEYS) {
    if (!ownSet.has(key)) throw new RatingValidationError(path, `缺少必需字段 "${key}"`);
  }

  if (obj.schemaVersion !== 1) {
    throw new RatingValidationError(`${path}.schemaVersion`, '当前仅支持 schemaVersion = 1');
  }

  const suiteId = requireNonEmptyString(obj.suiteId, `${path}.suiteId`);
  if (suiteId !== expectedSuiteId) {
    throw new RatingValidationError(
      `${path}.suiteId`,
      `与 blind packet 的 suiteId "${expectedSuiteId}" 不一致`,
    );
  }
  const caseId = requireNonEmptyString(obj.caseId, `${path}.caseId`);
  const candidateAlias = requireNonEmptyString(obj.candidateAlias, `${path}.candidateAlias`);
  const raterId = requireNonEmptyString(obj.raterId, `${path}.raterId`);

  if (!isValidBlindAlias(candidateAlias)) {
    throw new RatingValidationError(
      `${path}.candidateAlias`,
      `非法 alias "${candidateAlias}"：${BLIND_ALIAS_ERROR}`,
    );
  }

  const caseInfo = caseIndex.get(caseId);
  if (!caseInfo) {
    throw new RatingValidationError(`${path}.caseId`, `blind packet 中不存在该 case "${caseId}"`);
  }
  if (!caseInfo.validAliases.has(candidateAlias)) {
    throw new RatingValidationError(
      `${path}.candidateAlias`,
      `blind packet 的 case "${caseId}" 中不存在 alias "${candidateAlias}"`,
    );
  }

  const preferredRank = obj.preferredRank;
  if (
    typeof preferredRank !== 'number' ||
    !Number.isSafeInteger(preferredRank) ||
    preferredRank < 1 ||
    preferredRank > caseInfo.candidateCount
  ) {
    throw new RatingValidationError(
      `${path}.preferredRank`,
      `必须是 [1, ${caseInfo.candidateCount}] 的整数`,
    );
  }

  const notes = requireString(obj.notes, `${path}.notes`);
  if (Array.from(notes).length > MAX_NOTES_CODE_POINTS) {
    throw new RatingValidationError(
      `${path}.notes`,
      `notes 不能超过 ${MAX_NOTES_CODE_POINTS} 个 code points`,
    );
  }

  const dimensions: Record<HumanRatingDimension, number> = {} as Record<
    HumanRatingDimension,
    number
  >;
  for (const dim of HUMAN_RATING_DIMENSIONS) {
    const score = obj[dim];
    if (
      typeof score !== 'number' ||
      !Number.isSafeInteger(score) ||
      score < RATING_SCORE_MIN ||
      score > RATING_SCORE_MAX
    ) {
      throw new RatingValidationError(
        `${path}.${dim}`,
        `必须是 [${RATING_SCORE_MIN}, ${RATING_SCORE_MAX}] 的整数`,
      );
    }
    dimensions[dim] = score;
  }

  return {
    schemaVersion: 1,
    suiteId,
    caseId,
    candidateAlias,
    raterId,
    preferredRank,
    notes,
    ...dimensions,
  };
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new RatingValidationError(path, '必须是字符串');
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const raw = requireString(value, path);
  const trimmed = raw.trim().normalize('NFC');
  if (trimmed.length === 0) throw new RatingValidationError(path, 'trim 后不能为空');
  return trimmed;
}

export interface ValidateRatingsOptions {
  readonly packet: BlindPacketV1;
}

/**
 * 验证一组 ratings（JSON 数组）。返回规范化后的 rating 列表。
 * 同时校验：
 * - 同 rater/case/alias 不得重复；
 * - 同 (rater, case) 的 preferredRank 无重复。
 */
export function validateRatings(input: unknown, options: ValidateRatingsOptions): HumanRatingV1[] {
  if (!Array.isArray(input)) {
    throw new RatingValidationError('ratings', '必须是数组');
  }
  const caseIndex = buildCaseIndex(options.packet);

  const ratings = input.map((r, i) =>
    validateSingleRating(r, `ratings[${i}]`, caseIndex, options.packet.suiteId),
  );

  const seen = new Set<string>();
  for (const r of ratings) {
    const key = JSON.stringify([r.raterId, r.caseId, r.candidateAlias]);
    if (seen.has(key)) {
      throw new RatingValidationError(
        'ratings',
        `重复评分: rater "${r.raterId}" case "${r.caseId}" alias "${r.candidateAlias}"`,
      );
    }
    seen.add(key);
  }

  const rankKeys = new Set<string>();
  for (const r of ratings) {
    const key = JSON.stringify([r.raterId, r.caseId, r.preferredRank]);
    if (rankKeys.has(key)) {
      throw new RatingValidationError(
        'ratings',
        `同一位 rater 在 case "${r.caseId}" 中 preferredRank ${r.preferredRank} 重复`,
      );
    }
    rankKeys.add(key);
  }

  return ratings;
}

// ── 聚合 ──────────────────────────────────────────────────────────

export interface AggregateRatingsOptions {
  readonly packet: BlindPacketV1;
  readonly ratings: readonly HumanRatingV1[];
  readonly mapping?: PrivateMappingV1 | null;
  readonly clock: Clock;
  readonly toolVersion?: string;
}

function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function dimensionAggregate(values: number[]): DimensionAggregate {
  return { count: values.length, mean: meanOf(values), median: medianOf(values) };
}

/**
 * 聚合人工评分。不计算默认 overall score。
 * 约定：调用方必须先通过 validateRatings 校验（aggregateRatings 不再重复校验）。
 */
export function aggregateRatings(options: AggregateRatingsOptions): RatingAggregationReport {
  const { packet, ratings, clock } = options;
  const toolVersion = options.toolVersion ?? DEFAULT_TOOL_VERSION;
  const generatedAt = clock.now();

  const mappingByKey = new Map<string, string>();
  if (options.mapping) {
    for (const entry of options.mapping.entries) {
      mappingByKey.set(JSON.stringify([entry.caseId, entry.alias]), entry.candidateId);
    }
  }

  const raterIds = new Set(ratings.map((r) => r.raterId));
  const raterCount = raterIds.size;

  const candidateAggregates: CandidateRatingAggregate[] = [];
  const warnings: string[] = [];
  const missingRatingCoverage: string[] = [];

  // case 内按 alias code-point 顺序遍历，保证稳定
  for (const c of packet.cases) {
    const aliases = c.candidates.map((cand) => cand.alias).sort(codePointCompare);
    for (const alias of aliases) {
      const caseRatings = ratings.filter(
        (r) => r.caseId === c.caseId && r.candidateAlias === alias,
      );
      if (caseRatings.length === 0) continue;

      const dims = {} as Record<HumanRatingDimension, DimensionAggregate>;
      for (const dim of HUMAN_RATING_DIMENSIONS) {
        const values = caseRatings.map((r) => r[dim]);
        dims[dim] = dimensionAggregate(values);
      }

      const rankDistribution: Record<number, number> = {};
      for (const r of caseRatings) {
        rankDistribution[r.preferredRank] = (rankDistribution[r.preferredRank] ?? 0) + 1;
      }

      const candidateId = mappingByKey.get(JSON.stringify([c.caseId, alias])) ?? null;

      candidateAggregates.push({
        caseId: c.caseId,
        alias,
        candidateId,
        dimensions: dims,
        rankDistribution,
        raterCount: caseRatings.length,
      });

      if (caseRatings.length < MIN_RATERS_FOR_STABLE_STATS) {
        warnings.push(
          `case "${c.caseId}" alias "${alias}" 评分人数 ${caseRatings.length} 低于 ${MIN_RATERS_FOR_STABLE_STATS}，均值/中位数统计意义有限`,
        );
      }
    }
  }

  // pairwise wins：只统计同时给两个候选打过分的 rater
  const pairwiseWins: PairwiseWin[] = [];
  for (const c of packet.cases) {
    const aliases = c.candidates.map((cand) => cand.alias).sort(codePointCompare);
    for (let i = 0; i < aliases.length; i += 1) {
      for (let j = i + 1; j < aliases.length; j += 1) {
        const a = aliases[i];
        const b = aliases[j];
        const ratingsByRater = new Map<string, { aRank?: number; bRank?: number }>();
        for (const r of ratings) {
          if (r.caseId !== c.caseId) continue;
          let rec = ratingsByRater.get(r.raterId);
          if (!rec) {
            rec = {};
            ratingsByRater.set(r.raterId, rec);
          }
          if (r.candidateAlias === a) rec.aRank = r.preferredRank;
          if (r.candidateAlias === b) rec.bRank = r.preferredRank;
        }
        let wins = 0;
        let losses = 0;
        let ties = 0;
        for (const rec of ratingsByRater.values()) {
          if (rec.aRank === undefined || rec.bRank === undefined) continue;
          if (rec.aRank < rec.bRank) wins += 1;
          else if (rec.aRank > rec.bRank) losses += 1;
          else ties += 1;
        }
        pairwiseWins.push({
          caseId: c.caseId,
          aliasA: a,
          aliasB: b,
          aliasAWins: wins,
          aliasBWins: losses,
          ties,
        });
      }
    }
  }

  // missingRatingCoverage：某 (case, rater) 未覆盖该 case 内全部 alias
  for (const c of packet.cases) {
    const aliasCount = c.candidates.length;
    const aliasesByRater = new Map<string, Set<string>>();
    for (const r of ratings) {
      if (r.caseId !== c.caseId) continue;
      let set = aliasesByRater.get(r.raterId);
      if (!set) {
        set = new Set();
        aliasesByRater.set(r.raterId, set);
      }
      set.add(r.candidateAlias);
    }
    const raterIds = [...aliasesByRater.keys()].sort(codePointCompare);
    for (const raterId of raterIds) {
      if ((aliasesByRater.get(raterId)?.size ?? 0) < aliasCount) {
        missingRatingCoverage.push(`${c.caseId}/${raterId}`);
      }
    }
  }

  if (raterCount < MIN_RATERS_FOR_STABLE_STATS) {
    warnings.push(
      `总评分数人数 ${raterCount} 低于 ${MIN_RATERS_FOR_STABLE_STATS}，任何结论都只能视为示例，不代表真实用户研究`,
    );
  }

  return {
    schemaVersion: 1,
    suiteId: packet.suiteId,
    generatedAt,
    toolVersion,
    candidateAggregates,
    pairwiseWins,
    raterCount,
    missingRatingCoverage,
    warnings,
  };
}
