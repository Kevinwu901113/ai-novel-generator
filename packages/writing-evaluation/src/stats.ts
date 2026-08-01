/**
 * 分布统计。
 *
 * 规则（已记录，测试必须覆盖）：
 * - 空输入：min/max/mean/median/p90/std/cv 全部为 null；
 * - 单个值：min=max=mean=median=p90=该值，std=0，cv=0；
 * - median：排序后取中位；偶数个数取中间两数平均；
 * - p90：nearest-rank 法，升序取 ceil(0.9*n) 位置（1-based）；
 * - standardDeviation：总体标准差（除以 n）；
 * - coefficientOfVariation = std / mean；mean 为 0 时返回 null；
 * - 不做四舍五入，输出原始浮点值（JSON 序列化本身确定）。
 */

import type { DistributionStats } from './schema.js';

export function computeDistribution(values: readonly number[]): DistributionStats {
  const n = values.length;
  if (n === 0) {
    return {
      min: null,
      max: null,
      mean: null,
      median: null,
      p90: null,
      standardDeviation: null,
      coefficientOfVariation: null,
    };
  }
  if (n === 1) {
    const v = values[0];
    return {
      min: v,
      max: v,
      mean: v,
      median: v,
      p90: v,
      standardDeviation: 0,
      coefficientOfVariation: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[n - 1];
  const mean = sorted.reduce((acc, v) => acc + v, 0) / n;

  let median: number;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    median = sorted[mid];
  } else {
    median = (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const p90Index = Math.min(n - 1, Math.max(0, Math.ceil(0.9 * n) - 1));
  const p90 = sorted[p90Index];

  const variance = sorted.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / n;
  const standardDeviation = Math.sqrt(variance);
  const coefficientOfVariation = mean === 0 ? null : standardDeviation / mean;

  return {
    min,
    max,
    mean,
    median,
    p90,
    standardDeviation,
    coefficientOfVariation,
  };
}
