/**
 * 运行时验证（不信任 TypeScript 类型）。
 *
 * 规则：
 * - exact keys，拒绝 inherited keys 与 extra keys；
 * - ID trim 后非空，长度按 Unicode code point 计算；
 * - suite/case/candidate ID 唯一；
 * - safe integer、finite number；
 * - NFC 规范化；
 * - 文本规范化后不得为空；
 * - contract 使用当前 Domain 的真实完整验证；
 * - 不 mutation 输入；
 * - 错误消息稳定且不回显完整文章。
 */

import { validateCreationContractSections, type CreationContractSections } from '@ai-novel/domain';
import type {
  EvaluationConstraintV1,
  EvaluationSceneBriefV1,
  ExpectedMetricRelationV1,
  WritingCandidateV1,
  WritingEvaluationCaseV1,
  WritingEvaluationSuiteV1,
} from './schema.js';
import { METRIC_IDS } from './schema.js';
import { normalizeText } from './text.js';

// ── 长度上限 ──────────────────────────────────────────────────────

const MAX_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_PHRASE_LENGTH = 200;
const MAX_RUBRIC_LENGTH = 5000;
const MAX_STRING_ARRAY_ITEM_LENGTH = 200;

const EXPECTED_RELATION_OPERATORS = new Set(['LT', 'LTE', 'GT', 'GTE', 'EQ']);

export class EvaluationValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`[writing-evaluation] ${path}: ${message}`);
    this.name = 'EvaluationValidationError';
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new EvaluationValidationError(path, message);
}

// ── 基础守卫 ──────────────────────────────────────────────────────

function expectPlainObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, '必须是对象');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(path, '拒绝带自定义原型（含 inherited keys）的对象');
  }
  return value as Record<string, unknown>;
}

/**
 * 检查对象 key：
 * - allowed：允许出现的 key 集合（拒绝 extra keys）；
 * - required：必须出现的 key 集合（缺失即失败）。
 * 可选字段只出现在 allowed，不出现在 required。
 */
function expectKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  path: string,
): void {
  const own = Object.keys(obj);
  const ownSet = new Set(own);
  for (const key of own) {
    if (!allowed.has(key)) fail(`${path}.${key}`, '未知字段');
  }
  for (const key of required) {
    if (!ownSet.has(key)) fail(path, `缺少必需字段 "${key}"`);
  }
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, '必须是字符串');
  return value;
}

function normalizeId(value: unknown, path: string): string {
  const raw = expectString(value, path);
  const trimmed = raw.trim().normalize('NFC');
  if (trimmed.length === 0) fail(path, 'trim 后不能为空');
  if (Array.from(trimmed).length > MAX_ID_LENGTH) {
    fail(path, `不能超过 ${MAX_ID_LENGTH} 个 code points`);
  }
  return trimmed;
}

function normalizeTextValue(value: unknown, path: string): string {
  const raw = expectString(value, path);
  const normalized = normalizeText(raw);
  if (normalized.length === 0) fail(path, '规范化后不能为空');
  return normalized;
}

function normalizeShortText(value: unknown, path: string, maxLength: number): string {
  const raw = expectString(value, path);
  const trimmed = raw.trim().normalize('NFC');
  if (trimmed.length === 0) fail(path, 'trim 后不能为空');
  if (Array.from(trimmed).length > maxLength) {
    fail(path, `不能超过 ${maxLength} 个 code points`);
  }
  return trimmed;
}

function expectStringArray(value: unknown, path: string, maxItems: number): readonly string[] {
  if (!Array.isArray(value)) fail(path, '必须是数组');
  if (value.length > maxItems) fail(path, `最多 ${maxItems} 项`);
  return value.map((item, i) =>
    normalizeShortText(item, `${path}[${i}]`, MAX_STRING_ARRAY_ITEM_LENGTH),
  );
}

function expectSafeInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail(path, '必须是 safe integer');
  }
  if (value < min || value > max) {
    fail(path, `必须落在 [${min}, ${max}] 范围`);
  }
  return value;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, '必须是有限数字');
  }
  return value;
}

// ── 场景简报 ──────────────────────────────────────────────────────

const SCENE_BRIEF_KEYS = new Set([
  'sceneGoal',
  'participants',
  'location',
  'entryState',
  'exitState',
  'conflict',
  'requiredFacts',
  'forbiddenFacts',
  'targetLength',
]);

function validateSceneBrief(value: unknown, path: string): EvaluationSceneBriefV1 {
  const obj = expectPlainObject(value, path);
  expectKeys(obj, SCENE_BRIEF_KEYS, SCENE_BRIEF_KEYS, path);

  const sceneGoal = normalizeShortText(obj.sceneGoal, `${path}.sceneGoal`, 1000);
  const participants = expectStringArray(obj.participants, `${path}.participants`, 20);
  const location = normalizeShortText(obj.location, `${path}.location`, 300);
  const entryState = expectStringArray(obj.entryState, `${path}.entryState`, 50);
  const exitState = expectStringArray(obj.exitState, `${path}.exitState`, 50);
  const conflict = normalizeShortText(obj.conflict, `${path}.conflict`, 1000);

  const requiredFacts = expectStringArray(obj.requiredFacts, `${path}.requiredFacts`, 50);
  const forbiddenFacts = expectStringArray(obj.forbiddenFacts, `${path}.forbiddenFacts`, 50);

  const tl = expectPlainObject(obj.targetLength, `${path}.targetLength`);
  const tlKeys = new Set(['minCodePoints', 'maxCodePoints']);
  expectKeys(tl, tlKeys, tlKeys, `${path}.targetLength`);
  const minCodePoints = expectSafeInteger(
    tl.minCodePoints,
    `${path}.targetLength.minCodePoints`,
    0,
    1_000_000,
  );
  const maxCodePoints = expectSafeInteger(
    tl.maxCodePoints,
    `${path}.targetLength.maxCodePoints`,
    0,
    1_000_000,
  );
  if (minCodePoints > maxCodePoints) {
    fail(`${path}.targetLength`, 'minCodePoints 不能大于 maxCodePoints');
  }

  return {
    sceneGoal,
    participants,
    location,
    entryState,
    exitState,
    conflict,
    requiredFacts,
    forbiddenFacts,
    targetLength: { minCodePoints, maxCodePoints },
  };
}

// ── 约束 ──────────────────────────────────────────────────────────

function validateConstraint(value: unknown, path: string): EvaluationConstraintV1 {
  const obj = expectPlainObject(value, path);
  const kind = expectString(obj.kind, `${path}.kind`);
  const constraintId = normalizeId(obj.constraintId, `${path}.constraintId`);

  switch (kind) {
    case 'required-phrase': {
      const allowed = new Set(['kind', 'constraintId', 'phrase', 'minOccurrences']);
      expectKeys(obj, allowed, allowed, path);
      const phrase = normalizeShortText(obj.phrase, `${path}.phrase`, MAX_PHRASE_LENGTH);
      const minOccurrences = expectSafeInteger(
        obj.minOccurrences,
        `${path}.minOccurrences`,
        1,
        1_000_000,
      );
      return { kind, constraintId, phrase, minOccurrences };
    }
    case 'forbidden-phrase': {
      const allowed = new Set(['kind', 'constraintId', 'phrase']);
      expectKeys(obj, allowed, allowed, path);
      const phrase = normalizeShortText(obj.phrase, `${path}.phrase`, MAX_PHRASE_LENGTH);
      return { kind, constraintId, phrase };
    }
    case 'phrase-max-count': {
      const allowed = new Set(['kind', 'constraintId', 'phrase', 'maxOccurrences']);
      expectKeys(obj, allowed, allowed, path);
      const phrase = normalizeShortText(obj.phrase, `${path}.phrase`, MAX_PHRASE_LENGTH);
      const maxOccurrences = expectSafeInteger(
        obj.maxOccurrences,
        `${path}.maxOccurrences`,
        0,
        1_000_000,
      );
      return { kind, constraintId, phrase, maxOccurrences };
    }
    case 'text-length-range': {
      const allowed = new Set(['kind', 'constraintId', 'minCodePoints', 'maxCodePoints']);
      expectKeys(obj, allowed, allowed, path);
      const minCodePoints = expectSafeInteger(
        obj.minCodePoints,
        `${path}.minCodePoints`,
        0,
        1_000_000,
      );
      const maxCodePoints = expectSafeInteger(
        obj.maxCodePoints,
        `${path}.maxCodePoints`,
        0,
        1_000_000,
      );
      if (minCodePoints > maxCodePoints) {
        fail(path, 'minCodePoints 不能大于 maxCodePoints');
      }
      return { kind, constraintId, minCodePoints, maxCodePoints };
    }
    case 'dialogue-ratio-range': {
      const allowed = new Set(['kind', 'constraintId', 'minRatio', 'maxRatio']);
      expectKeys(obj, allowed, allowed, path);
      const minRatio = expectFiniteNumber(obj.minRatio, `${path}.minRatio`);
      const maxRatio = expectFiniteNumber(obj.maxRatio, `${path}.maxRatio`);
      if (minRatio < 0 || maxRatio > 1 || minRatio > maxRatio) {
        fail(path, '比例必须落在 [0,1] 且 minRatio <= maxRatio');
      }
      return { kind, constraintId, minRatio, maxRatio };
    }
    case 'manual-criterion': {
      const allowed = new Set(['kind', 'constraintId', 'title', 'rubric']);
      expectKeys(obj, allowed, allowed, path);
      const title = normalizeShortText(obj.title, `${path}.title`, 300);
      const rubric = normalizeShortText(obj.rubric, `${path}.rubric`, MAX_RUBRIC_LENGTH);
      return { kind, constraintId, title, rubric };
    }
    default:
      fail(`${path}.kind`, `未知约束类型 "${String(kind)}"`);
  }
}

// ── 候选 ──────────────────────────────────────────────────────────

const GENERATION_PARAMS_KEYS = new Set(['temperature', 'maxTokens', 'seed']);

function validateGenerationParameters(
  value: unknown,
  path: string,
): WritingCandidateV1['generationParameters'] {
  const obj = expectPlainObject(value, path);
  expectKeys(obj, GENERATION_PARAMS_KEYS, GENERATION_PARAMS_KEYS, path);

  let temperature: number | null;
  if (obj.temperature === null) {
    temperature = null;
  } else {
    temperature = expectFiniteNumber(obj.temperature, `${path}.temperature`);
  }

  let maxTokens: number | null;
  if (obj.maxTokens === null) {
    maxTokens = null;
  } else {
    maxTokens = expectSafeInteger(obj.maxTokens, `${path}.maxTokens`, 1, 10_000_000);
  }

  let seed: string | null;
  if (obj.seed === null) {
    seed = null;
  } else {
    seed = expectString(obj.seed, `${path}.seed`);
    if (seed.trim().length === 0) fail(`${path}.seed`, 'seed 不能为空字符串');
  }

  return { temperature, maxTokens, seed };
}

function validateCandidate(value: unknown, path: string): WritingCandidateV1 {
  const obj = expectPlainObject(value, path);
  const allowed = new Set([
    'candidateId',
    'strategyId',
    'modelId',
    'promptVersion',
    'generationParameters',
    'text',
  ]);
  expectKeys(obj, allowed, allowed, path);

  const candidateId = normalizeId(obj.candidateId, `${path}.candidateId`);
  const strategyId = normalizeId(obj.strategyId, `${path}.strategyId`);
  const modelId = normalizeId(obj.modelId, `${path}.modelId`);
  const promptVersion = normalizeId(obj.promptVersion, `${path}.promptVersion`);
  const generationParameters = validateGenerationParameters(
    obj.generationParameters,
    `${path}.generationParameters`,
  );
  const text = normalizeTextValue(obj.text, `${path}.text`);

  return {
    candidateId,
    strategyId,
    modelId,
    promptVersion,
    generationParameters,
    text,
  };
}

// ── 期望关系 ──────────────────────────────────────────────────────

function validateExpectedRelation(value: unknown, path: string): ExpectedMetricRelationV1 {
  const obj = expectPlainObject(value, path);
  const allowed = new Set(['metricId', 'leftCandidateId', 'operator', 'rightCandidateId']);
  expectKeys(obj, allowed, allowed, path);
  const metricId = normalizeId(obj.metricId, `${path}.metricId`);
  if (!(METRIC_IDS as readonly string[]).includes(metricId)) {
    fail(`${path}.metricId`, `未知指标 "${metricId}"`);
  }
  const leftCandidateId = normalizeId(obj.leftCandidateId, `${path}.leftCandidateId`);
  const rightCandidateId = normalizeId(obj.rightCandidateId, `${path}.rightCandidateId`);
  const operator = expectString(obj.operator, `${path}.operator`);
  if (!EXPECTED_RELATION_OPERATORS.has(operator)) {
    fail(`${path}.operator`, `未知关系运算符 "${operator}"`);
  }
  if (leftCandidateId === rightCandidateId) {
    fail(path, 'leftCandidateId 不能等于 rightCandidateId');
  }
  return {
    metricId,
    leftCandidateId,
    operator: operator as ExpectedMetricRelationV1['operator'],
    rightCandidateId,
  };
}

// ── 用例 ──────────────────────────────────────────────────────────

const CASE_ALLOWED_KEYS = new Set([
  'caseId',
  'title',
  'description',
  'contract',
  'sceneBrief',
  'constraints',
  'candidates',
  'expectedRelations',
]);

/** expectedRelations 可选，其余为必需字段。 */
const CASE_REQUIRED_KEYS = new Set([
  'caseId',
  'title',
  'description',
  'contract',
  'sceneBrief',
  'constraints',
  'candidates',
]);

function validateCase(value: unknown, path: string): WritingEvaluationCaseV1 {
  const obj = expectPlainObject(value, path);
  expectKeys(obj, CASE_ALLOWED_KEYS, CASE_REQUIRED_KEYS, path);

  const caseId = normalizeId(obj.caseId, `${path}.caseId`);
  const title = normalizeShortText(obj.title, `${path}.title`, MAX_TITLE_LENGTH);
  const description = normalizeShortText(
    obj.description,
    `${path}.description`,
    MAX_DESCRIPTION_LENGTH,
  );
  let contract: CreationContractSections;
  try {
    contract = validateCreationContractSections(
      obj.contract,
    ) as unknown as CreationContractSections;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`${path}.contract`, message);
  }
  const sceneBrief = validateSceneBrief(obj.sceneBrief, `${path}.sceneBrief`);

  if (!Array.isArray(obj.constraints)) fail(`${path}.constraints`, '必须是数组');
  const constraints = obj.constraints.map((c, i) =>
    validateConstraint(c, `${path}.constraints[${i}]`),
  );
  const constraintIds = new Set<string>();
  for (const c of constraints) {
    if (constraintIds.has(c.constraintId)) {
      fail(`${path}.constraints`, `重复的 constraintId "${c.constraintId}"`);
    }
    constraintIds.add(c.constraintId);
  }

  if (!Array.isArray(obj.candidates)) fail(`${path}.candidates`, '必须是数组');
  if (obj.candidates.length === 0) fail(`${path}.candidates`, '至少需要 1 个候选');
  const candidates = obj.candidates.map((c, i) => validateCandidate(c, `${path}.candidates[${i}]`));

  let expectedRelations: readonly ExpectedMetricRelationV1[] | undefined;
  if (obj.expectedRelations !== undefined) {
    if (!Array.isArray(obj.expectedRelations)) {
      fail(`${path}.expectedRelations`, '必须是数组');
    }
    expectedRelations = obj.expectedRelations.map((r, i) =>
      validateExpectedRelation(r, `${path}.expectedRelations[${i}]`),
    );
    const candidateIds = new Set(candidates.map((c) => c.candidateId));
    for (const rel of expectedRelations) {
      if (!candidateIds.has(rel.leftCandidateId)) {
        fail(`${path}.expectedRelations`, `引用未知候选 "${rel.leftCandidateId}"`);
      }
      if (!candidateIds.has(rel.rightCandidateId)) {
        fail(`${path}.expectedRelations`, `引用未知候选 "${rel.rightCandidateId}"`);
      }
    }
  }

  return {
    caseId,
    title,
    description,
    contract,
    sceneBrief,
    constraints,
    candidates,
    ...(expectedRelations !== undefined && { expectedRelations }),
  };
}

// ── 套件 ──────────────────────────────────────────────────────────

const SUITE_KEYS = new Set(['schemaVersion', 'suiteId', 'title', 'description', 'locale', 'cases']);

/**
 * 验证并规范化一个 suite。
 * 返回新对象，不 mutation 输入。
 */
export function validateSuite(input: unknown): WritingEvaluationSuiteV1 {
  const obj = expectPlainObject(input, 'suite');
  expectKeys(obj, SUITE_KEYS, SUITE_KEYS, 'suite');

  if (obj.schemaVersion !== 1) {
    fail('suite.schemaVersion', '当前仅支持 schemaVersion = 1');
  }
  const suiteId = normalizeId(obj.suiteId, 'suite.suiteId');
  const title = normalizeShortText(obj.title, 'suite.title', MAX_TITLE_LENGTH);
  const description = normalizeShortText(
    obj.description,
    'suite.description',
    MAX_DESCRIPTION_LENGTH,
  );
  if (obj.locale !== 'zh-CN') {
    fail('suite.locale', '当前仅支持 locale = zh-CN');
  }

  if (!Array.isArray(obj.cases)) fail('suite.cases', '必须是数组');
  if (obj.cases.length === 0) fail('suite.cases', '至少需要 1 个用例');

  const cases = obj.cases.map((c, i) => validateCase(c, `suite.cases[${i}]`));

  const caseIds = new Set<string>();
  const allCandidateIds = new Set<string>();
  for (const c of cases) {
    if (caseIds.has(c.caseId)) fail('suite.cases', `重复的 caseId "${c.caseId}"`);
    caseIds.add(c.caseId);
    for (const cand of c.candidates) {
      if (allCandidateIds.has(cand.candidateId)) {
        fail('suite.cases', `重复的 candidateId "${cand.candidateId}"`);
      }
      allCandidateIds.add(cand.candidateId);
    }
  }

  return {
    schemaVersion: 1,
    suiteId,
    title,
    description,
    locale: 'zh-CN',
    cases,
  };
}

/** 宽松地判断一个值看起来是否像 suite（供 CLI 参数错误提示使用）。 */
export function looksLikeSuite(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).cases === 'object' &&
    (value as Record<string, unknown>).cases !== null
  );
}
