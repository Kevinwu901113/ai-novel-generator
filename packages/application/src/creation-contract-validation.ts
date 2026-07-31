/**
 * 创作契约应用层共享验证。
 *
 * 集中存放 provenance 数组的严格解析与 ISO-8601 时间戳验证，
 * 由查询用例（creation-contract.ts）与 mutation 用例
 * （creation-contract-mutations.ts）共同使用，避免两套会漂移的 parser。
 *
 * 所有解析失败抛 ContractDataCorruptionError（public message 固定安全，
 * 内部细节进入 cause）；时间戳验证失败抛 ValidationError。
 */

import {
  parseContractFieldPath,
  canonicalizeContractFieldPath,
  isLowercaseSha256Hex,
  codePointCompare,
  type ContractFieldProvenance,
  type ProvenanceSource,
} from '@ai-novel/domain';
import { ContractDataCorruptionError, ValidationError } from './errors.js';

// ── Provenance 严格解析 ──────────────────────────────────────────

const PROVENANCE_SOURCES: ReadonlySet<string> = new Set([
  'GRILL_ANSWER',
  'AI_PROPOSAL',
  'USER_EDIT',
  'PREVIOUS_VERSION',
  'DEFAULT',
]);

/** provenance entry 的 canonical key 顺序（与 canonical JSON key 排序一致） */
const PROVENANCE_KEYS: readonly string[] = [
  'sectionKey',
  'source',
  'grillAnswerIds',
  'grillProposalIds',
  'aiTaskId',
  'modelInvocationId',
  'sourceProposalId',
  'previousFieldHash',
  'rationale',
];

/**
 * 严格解析 provenance JSON。
 *
 * 拒绝：非法 JSON / 非数组 / 非对象 entry / 缺失或多余 key /
 * 非 canonical key 顺序 / 非法或非 canonical sectionKey / 非法 source /
 * ID 数组非 string / nullable 字段非 string|null / previousFieldHash 非
 * lowercase SHA-256 / 重复 sectionKey / 未按 code-point 排序。
 *
 * 全部抛出 ContractDataCorruptionError（public message 固定安全，内部细节在 cause）。
 */
export function parseProvenanceArray(
  json: string,
  context: string,
): ReadonlyArray<ContractFieldProvenance> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new ContractDataCorruptionError(`${context}: provenanceJson is not valid JSON`, e);
  }
  if (!Array.isArray(parsed)) {
    throw new ContractDataCorruptionError(`${context}: provenanceJson must be an array`);
  }

  const result: ContractFieldProvenance[] = [];
  const seenKeys = new Set<string>();

  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      throw new ContractDataCorruptionError(`${context}: provenance item is not an object`);
    }
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj);
    // 精确 key 集合 + canonical 顺序（冻结设计要求：canonical JSON）
    if (keys.length !== PROVENANCE_KEYS.length || !keys.every((k, i) => k === PROVENANCE_KEYS[i])) {
      throw new ContractDataCorruptionError(
        `${context}: provenance item has invalid keys (${keys.join(',')})`,
      );
    }

    // sectionKey：非空 string + 符合 field path grammar + canonical
    if (typeof obj.sectionKey !== 'string' || obj.sectionKey.length === 0) {
      throw new ContractDataCorruptionError(`${context}: provenance sectionKey invalid`);
    }
    try {
      parseContractFieldPath(obj.sectionKey);
    } catch (e) {
      throw new ContractDataCorruptionError(
        `${context}: provenance sectionKey is not a valid field path`,
        e,
      );
    }
    if (obj.sectionKey !== canonicalizeContractFieldPath(obj.sectionKey)) {
      throw new ContractDataCorruptionError(`${context}: provenance sectionKey is not canonical`);
    }
    if (seenKeys.has(obj.sectionKey)) {
      throw new ContractDataCorruptionError(
        `${context}: duplicate provenance sectionKey "${obj.sectionKey}"`,
      );
    }
    seenKeys.add(obj.sectionKey);

    // source：完整 ProvenanceSource union
    if (typeof obj.source !== 'string' || !PROVENANCE_SOURCES.has(obj.source)) {
      throw new ContractDataCorruptionError(`${context}: provenance source invalid`);
    }

    // ID 数组：全部 string
    if (
      !Array.isArray(obj.grillAnswerIds) ||
      !obj.grillAnswerIds.every((x: unknown) => typeof x === 'string')
    ) {
      throw new ContractDataCorruptionError(`${context}: provenance grillAnswerIds invalid`);
    }
    if (
      !Array.isArray(obj.grillProposalIds) ||
      !obj.grillProposalIds.every((x: unknown) => typeof x === 'string')
    ) {
      throw new ContractDataCorruptionError(`${context}: provenance grillProposalIds invalid`);
    }

    // nullable 字段：严格 string | null
    if (obj.aiTaskId !== null && typeof obj.aiTaskId !== 'string') {
      throw new ContractDataCorruptionError(`${context}: provenance aiTaskId invalid`);
    }
    if (obj.modelInvocationId !== null && typeof obj.modelInvocationId !== 'string') {
      throw new ContractDataCorruptionError(`${context}: provenance modelInvocationId invalid`);
    }
    if (obj.sourceProposalId !== null && typeof obj.sourceProposalId !== 'string') {
      throw new ContractDataCorruptionError(`${context}: provenance sourceProposalId invalid`);
    }

    // previousFieldHash：null 或 lowercase SHA-256
    if (obj.previousFieldHash !== null) {
      if (
        typeof obj.previousFieldHash !== 'string' ||
        !isLowercaseSha256Hex(obj.previousFieldHash)
      ) {
        throw new ContractDataCorruptionError(`${context}: provenance previousFieldHash invalid`);
      }
    }

    // rationale：null 或 string
    if (obj.rationale !== null && typeof obj.rationale !== 'string') {
      throw new ContractDataCorruptionError(`${context}: provenance rationale invalid`);
    }

    result.push({
      sectionKey: obj.sectionKey,
      source: obj.source as ProvenanceSource,
      grillAnswerIds: obj.grillAnswerIds as ReadonlyArray<string>,
      grillProposalIds: obj.grillProposalIds as ReadonlyArray<string>,
      aiTaskId: obj.aiTaskId as string | null,
      modelInvocationId: obj.modelInvocationId as string | null,
      sourceProposalId: obj.sourceProposalId as string | null,
      previousFieldHash: obj.previousFieldHash as string | null,
      rationale: obj.rationale as string | null,
    });
  }

  // 确定性：entry 必须按 sectionKey code-point 升序（与 generateProvenance 排序一致）
  for (let i = 1; i < result.length; i++) {
    if (codePointCompare(result[i - 1].sectionKey, result[i].sectionKey) >= 0) {
      throw new ContractDataCorruptionError(`${context}: provenance entries are not sorted`);
    }
  }

  return result;
}

// ── ISO-8601 严格验证 ────────────────────────────────────────────

/**
 * 允许格式（与既有范围一致）：
 *   YYYY-MM-DDTHH:mm:ss(.fraction)?Z
 *   YYYY-MM-DDTHH:mm:ss(.fraction)?±HH:mm
 *
 * 严格校验分量范围，禁止 Date 自动归一化非法输入（不依赖 Date.parse）：
 *   - month 01–12
 *   - day 符合具体年月（含 leap year）
 *   - hour 00–23
 *   - minute 00–59
 *   - second 00–59
 *   - offset minute 00–59；offset hour 采用严格 ISO 上限（-12:00..+14:00）
 */
const ISO_8601_STRICT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

const ISO_TIMESTAMP_INVALID_MESSAGE = '必须是有效 ISO-8601 时间戳';

export function validateIso8601Timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`);
  }
  const match = ISO_8601_STRICT_RE.exec(value);
  if (!match) {
    throw new ValidationError(`${field} ${ISO_TIMESTAMP_INVALID_MESSAGE}`);
  }

  const [, yyyy, mm, dd, hh, mi, ss, , zone, sign, ohh, omi] = match;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const hour = Number(hh);
  const minute = Number(mi);
  const second = Number(ss);

  if (month < 1 || month > 12) {
    throw new ValidationError(`${field} ${ISO_TIMESTAMP_INVALID_MESSAGE}`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new ValidationError(`${field} ${ISO_TIMESTAMP_INVALID_MESSAGE}`);
  }
  if (hour > 23) {
    throw new ValidationError(`${field} ${ISO_TIMESTAMP_INVALID_MESSAGE}`);
  }
  if (minute > 59) {
    throw new ValidationError(`${field} ${ISO_TIMESTAMP_INVALID_MESSAGE}`);
  }
  if (second > 59) {
    throw new ValidationError(`${field} ${ISO_TIMESTAMP_INVALID_MESSAGE}`);
  }

  if (zone !== 'Z') {
    const offsetHour = Number(ohh);
    const offsetMinute = Number(omi);
    if (offsetMinute > 59) {
      throw new ValidationError(`${field} ${ISO_TIMESTAMP_INVALID_MESSAGE}`);
    }
    // ISO-8601 合法 offset 范围：-12:00..+14:00（含边界）。
    // 正 offset：hour=14 时 minute 必须为 00；负 offset：hour=12 时 minute 必须为 00。
    if (sign === '+') {
      if (offsetHour > 14 || (offsetHour === 14 && offsetMinute !== 0)) {
        throw new ValidationError(`${field} ${ISO_TIMESTAMP_INVALID_MESSAGE}`);
      }
    } else {
      if (offsetHour > 12 || (offsetHour === 12 && offsetMinute !== 0)) {
        throw new ValidationError(`${field} ${ISO_TIMESTAMP_INVALID_MESSAGE}`);
      }
    }
  }

  return value;
}
