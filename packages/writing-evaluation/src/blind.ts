/**
 * Deterministic blind review packet。
 *
 * 输入：suite + seed。
 * 输出两个分离文件：
 * 1. blind packet —— 匿名候选 alias（A/B/C...）、候选文本、场景 brief、人工评分 rubric；
 *    不含 candidateId / strategyId / modelId / promptVersion / generationParameters。
 * 2. private mapping —— alias → candidateId，必须与评审者隔离。
 *
 * 排序：SHA-256(seed + suiteId + caseId + candidateId) 十六进制升序决定 alias。
 */

import type {
  BlindCaseCandidate,
  BlindCasePacket,
  BlindPacketV1,
  ManualCriterionConstraint,
  PrivateMappingEntry,
  PrivateMappingV1,
  WritingEvaluationSuiteV1,
} from './schema.js';
import { sha256Hex } from './hash.js';

export interface BlindPacketOptions {
  readonly seed: string;
}

const MAX_ALIASES = 26;

function aliasForIndex(index: number): string {
  if (index < 0 || index >= MAX_ALIASES) {
    throw new Error(`候选数量超过支持范围（最多 ${MAX_ALIASES} 个，当前需要 ${index + 1}）`);
  }
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

export interface BlindPacketResult {
  readonly packet: BlindPacketV1;
  readonly mapping: PrivateMappingV1;
}

/**
 * 生成盲评包与 private mapping。
 * 同 seed 稳定；不同 seed 可改变顺序；alias mapping 无碰撞。
 */
export function generateBlindPacket(
  suite: WritingEvaluationSuiteV1,
  options: BlindPacketOptions,
): BlindPacketResult {
  const { seed } = options;
  const packetCases: BlindCasePacket[] = [];
  const entries: PrivateMappingEntry[] = [];

  for (const c of suite.cases) {
    const manualCriteria: ManualCriterionConstraint[] = c.constraints.filter(
      (con) => con.kind === 'manual-criterion',
    ) as ManualCriterionConstraint[];

    const ordered = [...c.candidates]
      .map((cand) => ({
        candidate: cand,
        key: sha256Hex(`${seed}${suite.suiteId}${c.caseId}${cand.candidateId}`),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const seenKeys = new Set<string>();
    for (const item of ordered) {
      if (seenKeys.has(item.key)) {
        throw new Error(
          `盲评 hash 碰撞: case "${c.caseId}" candidate "${item.candidate.candidateId}"`,
        );
      }
      seenKeys.add(item.key);
    }

    if (ordered.length > MAX_ALIASES) {
      throw new Error(`case "${c.caseId}" 候选数量超过 ${MAX_ALIASES}`);
    }

    const candidates: BlindCaseCandidate[] = [];
    ordered.forEach((item, index) => {
      const alias = aliasForIndex(index);
      candidates.push({ alias, text: item.candidate.text });
      entries.push({
        suiteId: suite.suiteId,
        caseId: c.caseId,
        alias,
        candidateId: item.candidate.candidateId,
      });
    });

    packetCases.push({
      caseId: c.caseId,
      title: c.title,
      sceneBrief: c.sceneBrief,
      manualCriteria,
      candidates,
    });
  }

  const packetId = sha256Hex(`blind-packet:${seed}:${suite.suiteId}`);

  return {
    packet: {
      schemaVersion: 1,
      locale: suite.locale,
      suiteId: suite.suiteId,
      packetId,
      cases: packetCases,
    },
    mapping: {
      schemaVersion: 1,
      suiteId: suite.suiteId,
      seed,
      entries,
    },
  };
}
