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

import {
  canonicalSerializeSuite,
  sha256Hex,
  validateSuite,
  type WritingCandidateV1,
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

export function outputSuiteHash(suite: WritingEvaluationSuiteV1): string {
  return sha256Hex(canonicalSerializeSuite(suite));
}
