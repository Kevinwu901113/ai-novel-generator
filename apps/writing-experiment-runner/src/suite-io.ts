/**
 * Source suite 读取与 generated output suite 构造。
 *
 * Source 语义：输入必须是通过现有 validateSuite 的合法 WritingEvaluationSuiteV1。
 * Runner 只使用 suiteId / caseId / title / description / contract / sceneBrief / constraints；
 * source 原有的 candidates 与 expectedRelations 不参与真实生成，也不复制进 output suite。
 *
 * Output 语义：仅当所有选定 case 成功且 FULL_SELECTION 时构造新的合法 suite：
 * - fixtures 从 source 复制；
 * - candidates 只包含本次真实生成的候选（每 case 恰 1 个）；
 * - expectedRelations 省略；
 * - suiteId = <source-suite-id>--<strategy-id>--<experiment-id>；
 * - 必须通过 validateSuite。
 */

import { codePointCompare } from '@ai-novel/domain';
import {
  canonicalSerializeSuite,
  sha256Hex,
  validateSuite,
  type WritingCandidateV1,
  type WritingEvaluationCaseV1,
  type WritingEvaluationSuiteV1,
} from '@ai-novel/writing-evaluation';
import { CliUsageError, ExperimentError, safeDisplayPath } from './safe-error.js';

export interface SourceSuiteRef {
  readonly suite: WritingEvaluationSuiteV1;
  readonly suiteHash: string;
}

export function readSourceSuite(
  readFile: (path: string) => string,
  pathInput: string,
): SourceSuiteRef {
  let raw: string;
  try {
    raw = readFile(pathInput);
  } catch {
    throw new CliUsageError(`无法读取文件 "${safeDisplayPath(pathInput)}"（IO 错误）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CliUsageError(`无法解析 JSON 文件 "${safeDisplayPath(pathInput)}"（JSON 格式错误）`);
  }
  let suite: WritingEvaluationSuiteV1;
  try {
    suite = validateSuite(parsed);
  } catch (err) {
    throw new CliUsageError(
      `source suite 无效：${err instanceof Error ? err.message : '校验失败'}`,
    );
  }
  const suiteHash = sha256Hex(canonicalSerializeSuite(suite));
  return { suite, suiteHash };
}

/** 构造 generated output suite（必须由调用方保证所有 case 都有候选）。 */
export function buildOutputSuite(
  source: WritingEvaluationSuiteV1,
  candidatesByCase: ReadonlyMap<string, WritingCandidateV1>,
  experimentId: string,
  strategyId: string,
): WritingEvaluationSuiteV1 {
  const outputSuiteId = `${source.suiteId}--${strategyId}--${experimentId}`;
  const cases = source.cases.map((c) => {
    const candidate = candidatesByCase.get(c.caseId);
    if (!candidate) {
      throw new ExperimentError(`case "${c.caseId}" 缺少本次生成的候选`);
    }
    return {
      caseId: c.caseId,
      title: c.title,
      description: c.description,
      contract: c.contract,
      sceneBrief: c.sceneBrief,
      constraints: c.constraints,
      candidates: [candidate],
    };
  });
  const built: unknown = {
    schemaVersion: 1,
    suiteId: outputSuiteId,
    title: source.title,
    description: source.description,
    locale: 'zh-CN',
    cases,
  };
  const validated = validateSuite(built);
  return validated;
}

/**
 * 合并多份 generated output suite，得到「每 case 含 N 个候选」的单一 suite。
 *
 * 设计背景：buildOutputSuite 每个 case 只产 1 个候选；A/B 需要 2 策略 × 2 seed
 * 得到 4 份 output suite。generateBlindPacket 只接受一个 suite，因此必须先合并，
 * 让同一个 case 内来自不同策略与 run 的候选一起进入盲评排序，而不是每份 suite 各
 * 打一个包（后者会让评分者看到包间系统差异，盲评失效）。
 *
 * 前置校验：
 * - 每个 suite 必须通过 validateSuite；
 * - suiteId 必须是 buildOutputSuite 产出的
 *   `<source-suite-id>--<strategy-id>--<experiment-id>` 形状；
 * - 所有 suite 解析出的 sourceSuiteId 必须一致；
 * - 所有 suite 的 caseId 集合、locale、schemaVersion 必须一致；
 * - 不接收重复的 suiteId。
 *
 * 候选身份：
 * - 合并后的 candidateId 使用 SHA-256(source suiteId + caseId + original candidateId)
 *   生成，保证跨 suite 重复的原 candidateId 也不会碰撞，且不把 strategy/seed 编码在
 *   盲评排序键里；
 * - candidateOrigins 保留每个合并 candidateId 的 strategyId / promptVersion /
 *   generationParameters.seed / 原 candidateId / 来源 suiteId。
 *
 * 顺序：输入 suite 按 suiteId 排序，case 按 caseId 排序，case 内候选按合并 candidateId
 * 排序；合并 suiteId 只由排序后的输入 suiteId 集合决定，因此对输入顺序不敏感。
 */

export interface OutputSuiteIdParts {
  readonly sourceSuiteId: string;
  readonly strategyId: string;
  readonly experimentId: string;
}

export interface MergedSuiteCandidateOrigin {
  /** 合并后 suite 中的候选 ID。 */
  readonly candidateId: string;
  readonly caseId: string;
  /** 来源 output suite 的完整 suiteId。 */
  readonly suiteId: string;
  /** 来源 output suite 解析出的 sourceSuiteId。 */
  readonly sourceSuiteId: string;
  readonly strategyId: string;
  readonly promptVersion: string;
  /** 来源候选 generationParameters.seed（当前 runner 生成候选为 null 时保留 null）。 */
  readonly seed: string | null;
  /** 来源 suite 中的原 candidateId。 */
  readonly originalCandidateId: string;
}

export interface MergeOutputSuitesResult {
  readonly suite: WritingEvaluationSuiteV1;
  readonly candidateOrigins: readonly MergedSuiteCandidateOrigin[];
}

interface MergeEntry {
  readonly suite: WritingEvaluationSuiteV1;
  readonly parts: OutputSuiteIdParts;
}

interface CollectedCandidate {
  readonly candidate: WritingCandidateV1;
  readonly origin: MergedSuiteCandidateOrigin;
}

export function parseOutputSuiteId(suiteId: string): OutputSuiteIdParts | null {
  const first = suiteId.indexOf('--');
  if (first <= 0) return null;
  const second = suiteId.indexOf('--', first + 2);
  if (second <= first) return null;
  const sourceSuiteId = suiteId.slice(0, first);
  const strategyId = suiteId.slice(first + 2, second);
  const experimentId = suiteId.slice(second + 2);
  if (sourceSuiteId.length === 0 || strategyId.length === 0 || experimentId.length === 0) {
    return null;
  }
  return { sourceSuiteId, strategyId, experimentId };
}

function sortedCaseIds(suite: WritingEvaluationSuiteV1): string[] {
  return suite.cases.map((c) => c.caseId).sort(codePointCompare);
}

function caseIdDiff(expected: readonly string[], actual: readonly string[]): string | null {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((id) => !actualSet.has(id));
  const extra = actual.filter((id) => !expectedSet.has(id));
  if (missing.length === 0 && extra.length === 0) return null;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`缺少 caseId "${missing.join('", "')}"`);
  if (extra.length > 0) parts.push(`多出 caseId "${extra.join('", "')}"`);
  return parts.join('；');
}

function buildMergedCandidateId(
  suiteId: string,
  caseId: string,
  originalCandidateId: string,
): string {
  return sha256Hex(
    `writing-experiment-merged-candidate:${suiteId}\n${caseId}\n${originalCandidateId}`,
  );
}

function buildMergedSuiteId(sourceSuiteId: string, sortedSuiteIds: readonly string[]): string {
  return `ab-merged--${sha256Hex(
    `writing-experiment-merged-suite:${sourceSuiteId}\n${sortedSuiteIds.join('\n')}`,
  )}`;
}

function copyCandidate(candidate: WritingCandidateV1, candidateId: string): WritingCandidateV1 {
  return {
    candidateId,
    strategyId: candidate.strategyId,
    modelId: candidate.modelId,
    promptVersion: candidate.promptVersion,
    generationParameters: {
      temperature: candidate.generationParameters.temperature,
      maxTokens: candidate.generationParameters.maxTokens,
      seed: candidate.generationParameters.seed,
    },
    text: candidate.text,
  };
}

function buildMergedCase(
  template: WritingEvaluationCaseV1,
  candidates: readonly WritingCandidateV1[],
): WritingEvaluationCaseV1 {
  return {
    caseId: template.caseId,
    title: template.title,
    description: template.description,
    contract: template.contract,
    sceneBrief: template.sceneBrief,
    constraints: template.constraints,
    candidates,
  };
}

export function mergeOutputSuites(
  suites: readonly WritingEvaluationSuiteV1[],
): MergeOutputSuitesResult {
  if (suites.length === 0) {
    throw new ExperimentError('无法合并 output suites：至少需要 1 份 suite');
  }

  const validatedSuites = suites.map((suite) => validateSuite(suite));
  const sortedSuites = [...validatedSuites].sort((a, b) => codePointCompare(a.suiteId, b.suiteId));

  const seenSuiteIds = new Set<string>();
  const entries: MergeEntry[] = [];
  for (const suite of sortedSuites) {
    if (seenSuiteIds.has(suite.suiteId)) {
      throw new ExperimentError(`output suite 重复：suiteId "${suite.suiteId}"`);
    }
    seenSuiteIds.add(suite.suiteId);

    const parts = parseOutputSuiteId(suite.suiteId);
    if (parts === null) {
      throw new ExperimentError(
        `无法合并 output suite：suiteId "${suite.suiteId}" 不符合 <source-suite-id>--<strategy-id>--<experiment-id> 格式`,
      );
    }
    entries.push({ suite, parts });
  }

  const first = entries[0];

  for (const entry of entries) {
    if (entry.suite.schemaVersion !== first.suite.schemaVersion) {
      throw new ExperimentError(
        `schemaVersion 不一致：期望 "${first.suite.schemaVersion}"，但 suite "${entry.suite.suiteId}" 为 "${entry.suite.schemaVersion}"`,
      );
    }
    if (entry.suite.locale !== first.suite.locale) {
      throw new ExperimentError(
        `locale 不一致：期望 "${first.suite.locale}"，但 suite "${entry.suite.suiteId}" 为 "${entry.suite.locale}"`,
      );
    }
    if (entry.parts.sourceSuiteId !== first.parts.sourceSuiteId) {
      throw new ExperimentError(
        `sourceSuiteId 不一致：期望 "${first.parts.sourceSuiteId}"，但 suite "${entry.suite.suiteId}" 为 "${entry.parts.sourceSuiteId}"`,
      );
    }
    const diff = caseIdDiff(sortedCaseIds(first.suite), sortedCaseIds(entry.suite));
    if (diff !== null) {
      throw new ExperimentError(`caseId 集合不一致：suite "${entry.suite.suiteId}" ${diff}`);
    }
  }

  const firstCaseById = new Map(first.suite.cases.map((c) => [c.caseId, c]));
  const caseIds = [...firstCaseById.keys()].sort(codePointCompare);
  const collectedByCase = new Map<string, CollectedCandidate[]>(
    caseIds.map((caseId) => [caseId, []]),
  );

  for (const entry of entries) {
    for (const c of entry.suite.cases) {
      const collected = collectedByCase.get(c.caseId);
      if (collected === undefined) {
        // 前面的 caseId 集合校验已保证不会发生；保留为防御性分支。
        throw new ExperimentError(`case "${c.caseId}" 不在合并 case 集合中`);
      }
      for (const candidate of c.candidates) {
        const candidateId = buildMergedCandidateId(
          entry.suite.suiteId,
          c.caseId,
          candidate.candidateId,
        );
        collected.push({
          candidate: copyCandidate(candidate, candidateId),
          origin: {
            candidateId,
            caseId: c.caseId,
            suiteId: entry.suite.suiteId,
            sourceSuiteId: entry.parts.sourceSuiteId,
            strategyId: candidate.strategyId,
            promptVersion: candidate.promptVersion,
            seed: candidate.generationParameters.seed,
            originalCandidateId: candidate.candidateId,
          },
        });
      }
    }
  }

  let expectedCandidateCount: number | null = null;
  for (const caseId of caseIds) {
    const collected = collectedByCase.get(caseId) ?? [];
    if (expectedCandidateCount === null) {
      expectedCandidateCount = collected.length;
    } else if (collected.length !== expectedCandidateCount) {
      throw new ExperimentError(
        `候选数不平衡：case "${caseId}" 有 ${collected.length} 个候选，而其他 case 有 ${expectedCandidateCount} 个`,
      );
    }
  }

  const mergedCases: WritingEvaluationCaseV1[] = [];
  const candidateOrigins: MergedSuiteCandidateOrigin[] = [];

  for (const caseId of caseIds) {
    const template = firstCaseById.get(caseId);
    if (template === undefined) {
      throw new ExperimentError(`case "${caseId}" 不存在于首个 output suite`);
    }
    const collected = collectedByCase.get(caseId) ?? [];
    collected.sort((a, b) => codePointCompare(a.candidate.candidateId, b.candidate.candidateId));
    mergedCases.push(
      buildMergedCase(
        template,
        collected.map((item) => item.candidate),
      ),
    );
    candidateOrigins.push(...collected.map((item) => item.origin));
  }

  candidateOrigins.sort((a, b) => codePointCompare(a.candidateId, b.candidateId));

  const mergedSuiteId = buildMergedSuiteId(
    first.parts.sourceSuiteId,
    sortedSuites.map((s) => s.suiteId),
  );
  const builtSuite = validateSuite({
    schemaVersion: 1,
    suiteId: mergedSuiteId,
    title: first.suite.title,
    description: first.suite.description,
    locale: first.suite.locale,
    cases: mergedCases,
  });

  return { suite: builtSuite, candidateOrigins };
}

export function outputSuiteHash(suite: WritingEvaluationSuiteV1): string {
  return sha256Hex(canonicalSerializeSuite(suite));
}
