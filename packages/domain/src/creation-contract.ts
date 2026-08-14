/**
 * @ai-novel/domain - Creation Contract Domain
 *
 * V1 typed domain schema for creation contracts.
 * Pure TypeScript — no Electron, SQLite, Node.js, or Renderer dependencies.
 */

// ── Constants ──────────────────────────────────────────────────

export const CREATION_CONTRACT_SCHEMA_VERSION = 1;

// ── Enums ──────────────────────────────────────────────────────

export type NarrativePov = 'FIRST' | 'THIRD_LIMITED' | 'THIRD_OMNISCIENT' | 'SECOND' | 'OTHER';
export type Tense = 'PAST' | 'PRESENT' | 'MIXED';
export type TargetLengthUnit = 'words' | 'chapters';
export type ProposalStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED' | 'STALE';
export type ContractVersionCreatedBy = 'user' | 'ai-proposal-accepted' | 'lock' | 'unlock';
export type ProvenanceSource =
  'GRILL_ANSWER' | 'AI_PROPOSAL' | 'USER_EDIT' | 'PREVIOUS_VERSION' | 'DEFAULT';

// ── Branded Types ──────────────────────────────────────────────

export type CharacterKey = string & { readonly __brand: 'CharacterKey' };
export type RelationshipKey = string & { readonly __brand: 'RelationshipKey' };

const STABLE_KEY_RE = /^[a-z0-9_-]{1,50}$/;

export function createCharacterKey(raw: string): CharacterKey {
  if (!STABLE_KEY_RE.test(raw)) {
    throw new Error(`非法 characterKey 格式: "${raw}"`);
  }
  return raw as CharacterKey;
}

export function createRelationshipKey(raw: string): RelationshipKey {
  if (!STABLE_KEY_RE.test(raw)) {
    throw new Error(`非法 relationshipKey 格式: "${raw}"`);
  }
  return raw as RelationshipKey;
}

// ── Schema Types ───────────────────────────────────────────────

export interface TargetLength {
  readonly unit: TargetLengthUnit;
  readonly value: number;
}

/**
 * 单章正文篇幅。与 targetLength（全书总字数/总章节数）分离，避免把“单章 15000 字”
 * 塞进自由文本 structure 后再靠正则猜测。
 *
 * minimum/maximum 仅在用户明确给出范围时保存；只给“约 N 字”时由章节执行器使用
 * 统一容差计算运行时硬边界。
 */
export interface ChapterLength {
  readonly targetCharacters: number;
  readonly minimumCharacters?: number;
  readonly maximumCharacters?: number;
}

export interface ProtagonistCharacter {
  readonly characterKey: CharacterKey;
  readonly name: string;
  readonly role?: string;
  readonly motivation?: string;
  readonly arc?: string;
  readonly traits?: readonly string[];
}

export interface SupportingCharacter {
  readonly characterKey: CharacterKey;
  readonly name: string;
  readonly role?: string;
  readonly relationship?: string;
  readonly traits?: readonly string[];
}

export interface RelationshipEntry {
  readonly relationshipKey: RelationshipKey;
  readonly fromCharacterKey: CharacterKey;
  readonly toCharacterKey: CharacterKey;
  readonly type: string;
  readonly dynamic?: string;
}

export interface ContentBoundaries {
  readonly rating?: string;
  readonly allowedContent?: readonly string[];
  readonly prohibitedContent?: readonly string[];
  readonly notes?: string;
}

export interface CreationContractSections {
  readonly premise: string;
  readonly genre: readonly string[];
  readonly tone: readonly string[];
  readonly themes?: readonly string[];
  readonly targetAudience: string;
  readonly narrativePov: NarrativePov;
  readonly tense: Tense;
  readonly targetLength?: TargetLength;
  readonly chapterLength?: ChapterLength;
  readonly structure?: string;
  readonly protagonist: ProtagonistCharacter;
  readonly supportingCharacters?: readonly SupportingCharacter[];
  readonly relationships?: readonly RelationshipEntry[];
  readonly worldRules?: readonly string[];
  readonly mustInclude?: readonly string[];
  readonly mustAvoid?: readonly string[];
  readonly contentBoundaries?: ContentBoundaries;
  readonly unresolvedQuestions?: readonly string[];
}

// ── Domain Models ──────────────────────────────────────────────

export interface ContractBaselineRef {
  readonly contractVersionId: string | null;
  readonly contractVersion: number | null;
  readonly contractSnapshotHash: string | null;
}

export interface CreationContractProposal {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly status: ProposalStatus;
  readonly baseGrillSessionId: string;
  readonly baseGrillSessionVersion: number;
  readonly baseContractVersion: number | null;
  readonly schemaVersion: number;
  readonly sectionsJson: string;
  readonly sectionsHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreationContractVersion {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly sourceProposalId: string | null;
  readonly basedOnGrillSessionId: string | null;
  readonly basedOnGrillSessionVersion: number | null;
  readonly sectionsJson: string;
  readonly lockedFieldPathsJson: string;
  readonly contractSnapshotHash: string;
  readonly provenanceJson: string;
  readonly createdAt: string;
  readonly createdBy: ContractVersionCreatedBy;
}

export interface ContractFieldProvenance {
  readonly sectionKey: string;
  readonly source: ProvenanceSource;
  readonly grillAnswerIds: readonly string[];
  readonly grillProposalIds: readonly string[];
  readonly aiTaskId: string | null;
  readonly modelInvocationId: string | null;
  readonly sourceProposalId: string | null;
  readonly previousFieldHash: string | null;
  readonly rationale: string | null;
}

export interface CreationContractLockEvent {
  readonly id: string;
  readonly projectId: string;
  readonly fieldPath: string;
  readonly action: 'LOCK' | 'UNLOCK';
  readonly versionId: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

// ── Internal Helpers ───────────────────────────────────────────

function nfc(s: string): string {
  return s.normalize('NFC');
}

function normalizeAndTrim(s: unknown, label: string): string {
  if (typeof s !== 'string') throw new Error(`${label} 必须是字符串`);
  const trimmed = nfc(s.trim());
  if (trimmed.length === 0) throw new Error(`${label} 不能为空`);
  return trimmed;
}

function validateOptionalString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  const trimmed = nfc(value.trim());
  if (trimmed.length === 0) throw new Error(`${label} trim 后不能为空`);
  if ([...trimmed].length > maxLength) throw new Error(`${label} 超过 ${maxLength} 字符`);
  return trimmed;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function isLowercaseSha256Hex(hash: string): boolean {
  return SHA256_HEX_RE.test(hash);
}

// ── ContractBaselineRef Validation ─────────────────────────────

export function validateContractBaselineRef(input: unknown): ContractBaselineRef {
  if (typeof input !== 'object' || input === null) {
    throw new Error('ContractBaselineRef 必须是对象');
  }
  const obj = input as Record<string, unknown>;
  const { contractVersionId, contractVersion, contractSnapshotHash } = obj;

  const allNull =
    contractVersionId === null && contractVersion === null && contractSnapshotHash === null;
  const allPresent =
    contractVersionId !== null && contractVersion !== null && contractSnapshotHash !== null;

  if (!allNull && !allPresent) {
    throw new Error('ContractBaselineRef: 所有字段必须全为 null 或全非 null');
  }

  if (allNull) {
    return { contractVersionId: null, contractVersion: null, contractSnapshotHash: null };
  }

  if (typeof contractVersionId !== 'string' || contractVersionId.trim().length === 0) {
    throw new Error('ContractBaselineRef: contractVersionId 必须是非空字符串');
  }
  if (
    typeof contractVersion !== 'number' ||
    !Number.isSafeInteger(contractVersion) ||
    contractVersion < 1
  ) {
    throw new Error('ContractBaselineRef: contractVersion 必须是正整数');
  }
  if (typeof contractSnapshotHash !== 'string' || !isLowercaseSha256Hex(contractSnapshotHash)) {
    throw new Error('ContractBaselineRef: contractSnapshotHash 必须是 lowercase SHA-256 hex');
  }

  return { contractVersionId, contractVersion, contractSnapshotHash };
}

// ── ProposalStatus State Machine ───────────────────────────────

const ALLOWED_PROPOSAL_TRANSITIONS = new Map<ProposalStatus, Set<ProposalStatus>>([
  ['PROPOSED', new Set<ProposalStatus>(['ACCEPTED', 'REJECTED', 'SUPERSEDED', 'STALE'])],
  ['ACCEPTED', new Set<ProposalStatus>()],
  ['REJECTED', new Set<ProposalStatus>()],
  ['SUPERSEDED', new Set<ProposalStatus>()],
  ['STALE', new Set<ProposalStatus>()],
]);

export function isValidProposalStatusTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  const allowed = ALLOWED_PROPOSAL_TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

export function assertValidProposalStatusTransition(
  from: ProposalStatus,
  to: ProposalStatus,
): void {
  if (!isValidProposalStatusTransition(from, to)) {
    throw new Error(`非法 ProposalStatus 转换: ${from} -> ${to}`);
  }
}

// ── Canonical Serialization ────────────────────────────────────

function codePointCompare(a: string, b: string): number {
  const na = nfc(a);
  const nb = nfc(b);
  if (na === nb) return 0;
  const ca = [...na];
  const cb = [...nb];
  const len = Math.min(ca.length, cb.length);
  for (let i = 0; i < len; i++) {
    const pa = ca[i].codePointAt(0)!;
    const pb = cb[i].codePointAt(0)!;
    if (pa !== pb) return pa - pb;
  }
  return ca.length - cb.length;
}

export { codePointCompare };

/**
 * 仓库统一 canonical JSON 序列化（RW-1-R5 复用，供 application 层 input hash / 幂等指纹）。
 *
 * 语义（强于普通 JSON.stringify）：
 * - 字符串 NFC 规范化；key 排序用 code-point 比较（含 astral code point），非 localeCompare；
 * - NFC 后 key 冲突（两个不同 raw key 规范化到同一 key）→ 抛错；
 * - undefined / BigInt / Symbol / function / 非有限数（NaN/Infinity）→ 抛错；
 * - 数组保序，对象递归。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) throw new Error('canonical 序列化不支持 undefined');
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical 序列化不允许非有限数');
    return value;
  }
  if (typeof value === 'string') return nfc(value);
  if (typeof value === 'bigint') throw new Error('canonical 序列化不支持 BigInt');
  if (typeof value === 'symbol') throw new Error('canonical 序列化不支持 Symbol');
  if (typeof value === 'function') throw new Error('canonical 序列化不支持 function');
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const rawKeys = Object.keys(obj);
    const nfcKeys = rawKeys.map((k) => ({ raw: k, nfc: nfc(k) }));
    const nfcSet = new Set<string>();
    for (const { nfc: nk } of nfcKeys) {
      if (nfcSet.has(nk)) {
        throw new Error(`canonical 序列化: NFC 后 key 冲突 "${nk}"`);
      }
      nfcSet.add(nk);
    }
    nfcKeys.sort((a, b) => codePointCompare(a.nfc, b.nfc));
    const result: Record<string, unknown> = {};
    for (const { raw, nfc: nk } of nfcKeys) {
      const v = obj[raw];
      if (v === undefined) throw new Error(`canonical 序列化不允许 key "${nk}" 为 undefined`);
      result[nk] = canonicalize(v);
    }
    return result;
  }
  throw new Error(`canonical 序列化不支持类型: ${typeof value}`);
}

export function canonicalSerializeContractSections(sections: CreationContractSections): string {
  const validated = validateCreationContractSections(sections);
  return JSON.stringify(canonicalize(validated));
}

export function canonicalSerializeLockedFieldPaths(paths: readonly string[]): string {
  const parsed = paths.map((p) => {
    const canonical = canonicalizeContractFieldPath(p);
    parseContractFieldPath(canonical);
    return nfc(canonical);
  });
  const seen = new Set<string>();
  for (const p of parsed) {
    if (seen.has(p)) throw new Error(`重复的 lock path: "${p}"`);
    seen.add(p);
  }
  const sorted = [...parsed].sort(codePointCompare);
  return JSON.stringify(sorted);
}

export function canonicalSerializeContractFieldValue(value: unknown): string {
  if (value === undefined) throw new Error('field value 不能是 undefined');
  return JSON.stringify(canonicalize(value));
}

export function canonicalSerializeContractSnapshot(input: {
  sections: CreationContractSections;
  lockedFieldPaths: readonly string[];
  schemaVersion: number;
}): string {
  if (
    typeof input.schemaVersion !== 'number' ||
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion < 1
  ) {
    throw new Error('schemaVersion 必须是正安全整数');
  }

  const validatedSections = validateCreationContractSections(input.sections);

  const parsedPaths = input.lockedFieldPaths.map((p) => {
    const canonical = canonicalizeContractFieldPath(p);
    parseContractFieldPath(canonical);
    return nfc(canonical);
  });
  const seen = new Set<string>();
  for (const p of parsedPaths) {
    if (seen.has(p)) throw new Error(`重复的 lock path: "${p}"`);
    seen.add(p);
  }
  const sortedPaths = [...parsedPaths].sort(codePointCompare);

  return JSON.stringify(
    canonicalize({
      sections: validatedSections,
      lockedFieldPaths: sortedPaths,
      schemaVersion: input.schemaVersion,
    }),
  );
}

// ── CreationContractSections Validation ────────────────────────

const NARRATIVE_POV_SET: ReadonlySet<string> = new Set([
  'FIRST',
  'THIRD_LIMITED',
  'THIRD_OMNISCIENT',
  'SECOND',
  'OTHER',
]);
const TENSE_SET: ReadonlySet<string> = new Set(['PAST', 'PRESENT', 'MIXED']);
const TARGET_LENGTH_UNIT_SET: ReadonlySet<string> = new Set(['words', 'chapters']);

function validateStringArray(
  value: unknown,
  label: string,
  minItems: number,
  maxItems: number,
  maxItemLength: number,
): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  if (value.length < minItems) throw new Error(`${label} 至少需要 ${minItems} 项`);
  if (value.length > maxItems) throw new Error(`${label} 最多 ${maxItems} 项`);
  return value.map((item, i) => {
    if (typeof item !== 'string') throw new Error(`${label}[${i}] 必须是字符串`);
    const normalized = nfc(item.trim());
    if (normalized.length === 0) throw new Error(`${label}[${i}] 不能为空`);
    if ([...normalized].length > maxItemLength) {
      throw new Error(`${label}[${i}] 超过 ${maxItemLength} 字符`);
    }
    return normalized;
  });
}

function validateTargetLength(value: unknown): TargetLength {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('targetLength 必须是对象');
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 2 || !('unit' in obj) || !('value' in obj)) {
    throw new Error('targetLength 必须恰好包含 "unit" 和 "value"');
  }
  if (typeof obj.unit !== 'string' || !TARGET_LENGTH_UNIT_SET.has(obj.unit)) {
    throw new Error('targetLength.unit 必须是 "words" 或 "chapters"');
  }
  if (
    typeof obj.value !== 'number' ||
    !Number.isFinite(obj.value) ||
    !Number.isSafeInteger(obj.value) ||
    obj.value <= 0
  ) {
    throw new Error('targetLength.value 必须是正整数');
  }
  if (obj.unit === 'words' && obj.value > 10_000_000) {
    throw new Error('targetLength.value (words) 超过上限 10,000,000');
  }
  if (obj.unit === 'chapters' && obj.value > 5000) {
    throw new Error('targetLength.value (chapters) 超过上限 5,000');
  }
  return { unit: obj.unit as TargetLengthUnit, value: obj.value };
}

function validateChapterLength(value: unknown): ChapterLength {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('chapterLength 必须是对象');
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set(['targetCharacters', 'minimumCharacters', 'maximumCharacters']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error(`chapterLength 包含未知字段: "${key}"`);
  }
  const readCharacters = (field: string, required: boolean): number | undefined => {
    const raw = obj[field];
    if (raw === undefined && !required) return undefined;
    if (
      typeof raw !== 'number' ||
      !Number.isFinite(raw) ||
      !Number.isSafeInteger(raw) ||
      raw < 500 ||
      raw > 40_000
    ) {
      throw new Error(`chapterLength.${field} 必须是 500..40000 的整数`);
    }
    return raw;
  };
  const targetCharacters = readCharacters('targetCharacters', true)!;
  const minimumCharacters = readCharacters('minimumCharacters', false);
  const maximumCharacters = readCharacters('maximumCharacters', false);
  if (minimumCharacters !== undefined && minimumCharacters > targetCharacters) {
    throw new Error('chapterLength.minimumCharacters 不得大于 targetCharacters');
  }
  if (maximumCharacters !== undefined && maximumCharacters < targetCharacters) {
    throw new Error('chapterLength.maximumCharacters 不得小于 targetCharacters');
  }
  if (
    minimumCharacters !== undefined &&
    maximumCharacters !== undefined &&
    minimumCharacters > maximumCharacters
  ) {
    throw new Error('chapterLength.minimumCharacters 不得大于 maximumCharacters');
  }
  return {
    targetCharacters,
    ...(minimumCharacters !== undefined && { minimumCharacters }),
    ...(maximumCharacters !== undefined && { maximumCharacters }),
  };
}

function validateProtagonistCharacter(value: unknown): ProtagonistCharacter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('protagonist 必须是对象');
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set(['characterKey', 'name', 'role', 'motivation', 'arc', 'traits']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error(`protagonist 包含未知字段: "${key}"`);
  }
  if (typeof obj.characterKey !== 'string')
    throw new Error('protagonist.characterKey 必须是字符串');
  const characterKey = createCharacterKey(nfc(obj.characterKey));
  const name = normalizeAndTrim(obj.name, 'protagonist.name');
  if ([...name].length > 100) throw new Error('protagonist.name 超过 100 字符');

  const role = validateOptionalString(obj.role, 'protagonist.role', 200);
  const motivation = validateOptionalString(obj.motivation, 'protagonist.motivation', 500);
  const arc = validateOptionalString(obj.arc, 'protagonist.arc', 500);
  const traits =
    obj.traits !== undefined
      ? validateStringArray(obj.traits, 'protagonist.traits', 0, 10, 100)
      : undefined;

  return {
    characterKey,
    name,
    ...(role !== undefined && { role }),
    ...(motivation !== undefined && { motivation }),
    ...(arc !== undefined && { arc }),
    ...(traits !== undefined && { traits }),
  };
}

function validateSupportingCharacterItem(value: unknown, index: number): SupportingCharacter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`supportingCharacters[${index}] 必须是对象`);
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set(['characterKey', 'name', 'role', 'relationship', 'traits']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`supportingCharacters[${index}] 包含未知字段: "${key}"`);
    }
  }
  if (typeof obj.characterKey !== 'string') {
    throw new Error(`supportingCharacters[${index}].characterKey 必须是字符串`);
  }
  const characterKey = createCharacterKey(nfc(obj.characterKey));
  const name = normalizeAndTrim(obj.name, `supportingCharacters[${index}].name`);
  if ([...name].length > 100) {
    throw new Error(`supportingCharacters[${index}].name 超过 100 字符`);
  }

  const role = validateOptionalString(obj.role, `supportingCharacters[${index}].role`, 200);
  const relationship = validateOptionalString(
    obj.relationship,
    `supportingCharacters[${index}].relationship`,
    200,
  );
  const traits =
    obj.traits !== undefined
      ? validateStringArray(obj.traits, `supportingCharacters[${index}].traits`, 0, 10, 100)
      : undefined;

  return {
    characterKey,
    name,
    ...(role !== undefined && { role }),
    ...(relationship !== undefined && { relationship }),
    ...(traits !== undefined && { traits }),
  };
}

function validateRelationshipEntryItem(value: unknown, index: number): RelationshipEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`relationships[${index}] 必须是对象`);
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set([
    'relationshipKey',
    'fromCharacterKey',
    'toCharacterKey',
    'type',
    'dynamic',
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`relationships[${index}] 包含未知字段: "${key}"`);
    }
  }
  if (typeof obj.relationshipKey !== 'string') {
    throw new Error(`relationships[${index}].relationshipKey 必须是字符串`);
  }
  const relationshipKey = createRelationshipKey(nfc(obj.relationshipKey));
  if (typeof obj.fromCharacterKey !== 'string') {
    throw new Error(`relationships[${index}].fromCharacterKey 必须是字符串`);
  }
  const fromCharacterKey = createCharacterKey(nfc(obj.fromCharacterKey));
  if (typeof obj.toCharacterKey !== 'string') {
    throw new Error(`relationships[${index}].toCharacterKey 必须是字符串`);
  }
  const toCharacterKey = createCharacterKey(nfc(obj.toCharacterKey));
  const type = normalizeAndTrim(obj.type, `relationships[${index}].type`);
  if ([...type].length > 100) throw new Error(`relationships[${index}].type 超过 100 字符`);
  const dynamic = validateOptionalString(obj.dynamic, `relationships[${index}].dynamic`, 300);

  return {
    relationshipKey,
    fromCharacterKey,
    toCharacterKey,
    type,
    ...(dynamic !== undefined && { dynamic }),
  };
}

function validateContentBoundaries(value: unknown): ContentBoundaries {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('contentBoundaries 必须是对象');
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set(['rating', 'allowedContent', 'prohibitedContent', 'notes']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error(`contentBoundaries 包含未知字段: "${key}"`);
  }
  const rating = validateOptionalString(obj.rating, 'contentBoundaries.rating', 50);
  const allowedContent =
    obj.allowedContent !== undefined
      ? validateStringArray(obj.allowedContent, 'contentBoundaries.allowedContent', 0, 20, 200)
      : undefined;
  const prohibitedContent =
    obj.prohibitedContent !== undefined
      ? validateStringArray(
          obj.prohibitedContent,
          'contentBoundaries.prohibitedContent',
          0,
          20,
          200,
        )
      : undefined;
  const notes = validateOptionalString(obj.notes, 'contentBoundaries.notes', 500);

  return {
    ...(rating !== undefined && { rating }),
    ...(allowedContent !== undefined && { allowedContent }),
    ...(prohibitedContent !== undefined && { prohibitedContent }),
    ...(notes !== undefined && { notes }),
  };
}

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'premise',
  'genre',
  'tone',
  'themes',
  'targetAudience',
  'narrativePov',
  'tense',
  'targetLength',
  'chapterLength',
  'structure',
  'protagonist',
  'supportingCharacters',
  'relationships',
  'worldRules',
  'mustInclude',
  'mustAvoid',
  'contentBoundaries',
  'unresolvedQuestions',
]);

export function validateCreationContractSections(input: unknown): CreationContractSections {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('CreationContractSections 必须是对象');
  }
  const obj = input as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`未知 section: "${key}"`);
    }
  }

  const premise = normalizeAndTrim(obj.premise, 'premise');
  if ([...premise].length > 2000) throw new Error('premise 超过 2000 字符');
  const genre = validateStringArray(obj.genre, 'genre', 1, 5, 50);
  const tone = validateStringArray(obj.tone, 'tone', 1, 5, 50);
  const targetAudience = normalizeAndTrim(obj.targetAudience, 'targetAudience');
  if ([...targetAudience].length > 200) throw new Error('targetAudience 超过 200 字符');
  if (typeof obj.narrativePov !== 'string' || !NARRATIVE_POV_SET.has(obj.narrativePov)) {
    throw new Error('narrativePov 必须是有效的枚举值');
  }
  if (typeof obj.tense !== 'string' || !TENSE_SET.has(obj.tense)) {
    throw new Error('tense 必须是有效的枚举值');
  }
  const protagonist = validateProtagonistCharacter(obj.protagonist);

  const themes =
    obj.themes !== undefined ? validateStringArray(obj.themes, 'themes', 0, 10, 100) : undefined;
  const targetLength =
    obj.targetLength !== undefined ? validateTargetLength(obj.targetLength) : undefined;
  const chapterLength =
    obj.chapterLength !== undefined ? validateChapterLength(obj.chapterLength) : undefined;
  const structure = validateOptionalString(obj.structure, 'structure', 500);

  let supportingCharacters: readonly SupportingCharacter[] | undefined;
  if (obj.supportingCharacters !== undefined) {
    if (!Array.isArray(obj.supportingCharacters)) {
      throw new Error('supportingCharacters 必须是数组');
    }
    if (obj.supportingCharacters.length > 20) {
      throw new Error('supportingCharacters 最多 20 项');
    }
    supportingCharacters = obj.supportingCharacters.map((item, i) =>
      validateSupportingCharacterItem(item, i),
    );
  }

  let relationships: readonly RelationshipEntry[] | undefined;
  if (obj.relationships !== undefined) {
    if (!Array.isArray(obj.relationships)) {
      throw new Error('relationships 必须是数组');
    }
    if (obj.relationships.length > 30) {
      throw new Error('relationships 最多 30 项');
    }
    relationships = obj.relationships.map((item, i) => validateRelationshipEntryItem(item, i));
  }

  const worldRules =
    obj.worldRules !== undefined
      ? validateStringArray(obj.worldRules, 'worldRules', 0, 20, 300)
      : undefined;
  const mustInclude =
    obj.mustInclude !== undefined
      ? validateStringArray(obj.mustInclude, 'mustInclude', 0, 20, 200)
      : undefined;
  const mustAvoid =
    obj.mustAvoid !== undefined
      ? validateStringArray(obj.mustAvoid, 'mustAvoid', 0, 20, 200)
      : undefined;
  const contentBoundaries =
    obj.contentBoundaries !== undefined
      ? validateContentBoundaries(obj.contentBoundaries)
      : undefined;
  const unresolvedQuestions =
    obj.unresolvedQuestions !== undefined
      ? validateStringArray(obj.unresolvedQuestions, 'unresolvedQuestions', 0, 20, 300)
      : undefined;

  const allCharKeys = new Set<string>();
  allCharKeys.add(protagonist.characterKey);
  if (supportingCharacters) {
    for (const char of supportingCharacters) {
      if (allCharKeys.has(char.characterKey)) {
        throw new Error(`重复的 characterKey: "${char.characterKey}"`);
      }
      allCharKeys.add(char.characterKey);
    }
  }

  if (relationships) {
    const relKeys = new Set<string>();
    for (const rel of relationships) {
      if (relKeys.has(rel.relationshipKey)) {
        throw new Error(`重复的 relationshipKey: "${rel.relationshipKey}"`);
      }
      relKeys.add(rel.relationshipKey);
      if (!allCharKeys.has(rel.fromCharacterKey)) {
        throw new Error(`relationship 引用未知角色: "${rel.fromCharacterKey}"`);
      }
      if (!allCharKeys.has(rel.toCharacterKey)) {
        throw new Error(`relationship 引用未知角色: "${rel.toCharacterKey}"`);
      }
    }
  }

  return {
    premise,
    genre,
    tone,
    targetAudience,
    narrativePov: obj.narrativePov as NarrativePov,
    tense: obj.tense as Tense,
    protagonist,
    ...(themes !== undefined && { themes }),
    ...(targetLength !== undefined && { targetLength }),
    ...(chapterLength !== undefined && { chapterLength }),
    ...(structure !== undefined && { structure }),
    ...(supportingCharacters !== undefined && { supportingCharacters }),
    ...(relationships !== undefined && { relationships }),
    ...(worldRules !== undefined && { worldRules }),
    ...(mustInclude !== undefined && { mustInclude }),
    ...(mustAvoid !== undefined && { mustAvoid }),
    ...(contentBoundaries !== undefined && { contentBoundaries }),
    ...(unresolvedQuestions !== undefined && { unresolvedQuestions }),
  };
}

// ── Field Path Grammar ─────────────────────────────────────────

const VALID_SECTIONS: ReadonlySet<string> = new Set([
  'premise',
  'genre',
  'tone',
  'themes',
  'targetAudience',
  'narrativePov',
  'tense',
  'targetLength',
  'chapterLength',
  'structure',
  'protagonist',
  'supportingCharacters',
  'relationships',
  'worldRules',
  'mustInclude',
  'mustAvoid',
  'contentBoundaries',
  'unresolvedQuestions',
]);

const STRUCTURED_CHILDREN: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['targetLength', new Set(['unit', 'value'])],
  ['chapterLength', new Set(['targetCharacters', 'minimumCharacters', 'maximumCharacters'])],
  ['contentBoundaries', new Set(['rating', 'allowedContent', 'prohibitedContent', 'notes'])],
  ['protagonist', new Set(['characterKey', 'name', 'role', 'motivation', 'arc', 'traits'])],
]);

const COLLECTION_CHILDREN: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['supportingCharacters', new Set(['characterKey', 'name', 'role', 'relationship', 'traits'])],
  [
    'relationships',
    new Set(['relationshipKey', 'fromCharacterKey', 'toCharacterKey', 'type', 'dynamic']),
  ],
]);

export interface ParsedFieldPath {
  readonly section: string;
  readonly entityKey?: string;
  readonly field?: string;
}

export function parseContractFieldPath(path: string): ParsedFieldPath {
  if (!path.startsWith('/')) throw new Error('field path 必须以 / 开头');
  const segments = path.split('/').slice(1);
  if (segments.length === 0) throw new Error('field path 不能为空');

  const section = segments[0];
  if (!VALID_SECTIONS.has(section)) throw new Error(`未知 section: "${section}"`);

  if (segments.length === 1) return { section };

  const structuredChildren = STRUCTURED_CHILDREN.get(section);
  if (structuredChildren) {
    if (segments.length > 2) throw new Error(`路径过深: "${path}"`);
    const field = segments[1];
    if (!structuredChildren.has(field)) {
      throw new Error(`未知子字段: "${section}/${field}"`);
    }
    return { section, field };
  }

  const collectionChildren = COLLECTION_CHILDREN.get(section);
  if (collectionChildren) {
    if (segments.length < 2) throw new Error(`collection section 需要 entity key: "${path}"`);
    const entityKey = segments[1];
    if (!STABLE_KEY_RE.test(entityKey)) {
      throw new Error(`非法 entity key: "${entityKey}"`);
    }
    if (segments.length === 2) return { section, entityKey };
    if (segments.length > 3) throw new Error(`路径过深: "${path}"`);
    const field = segments[2];
    if (!collectionChildren.has(field)) {
      throw new Error(`未知子字段: "${section}/${field}"`);
    }
    return { section, entityKey, field };
  }

  throw new Error(`section "${section}" 不支持子路径`);
}

export function canonicalizeContractFieldPath(path: string): string {
  const parsed = parseContractFieldPath(path);
  if (parsed.entityKey !== undefined && parsed.field !== undefined) {
    return `/${parsed.section}/${parsed.entityKey}/${parsed.field}`;
  }
  if (parsed.entityKey !== undefined) {
    return `/${parsed.section}/${parsed.entityKey}`;
  }
  if (parsed.field !== undefined) {
    return `/${parsed.section}/${parsed.field}`;
  }
  return `/${parsed.section}`;
}

// ── Path Overlap ───────────────────────────────────────────────

export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

// ── Lock Validation ────────────────────────────────────────────

const STRUCTURED_OPTIONAL_CHILDREN: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['protagonist', new Set(['role', 'motivation', 'arc', 'traits'])],
  ['targetLength', new Set<string>()],
  ['chapterLength', new Set(['minimumCharacters', 'maximumCharacters'])],
  ['contentBoundaries', new Set(['rating', 'allowedContent', 'prohibitedContent', 'notes'])],
]);

const COLLECTION_OPTIONAL_CHILDREN: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['supportingCharacters', new Set(['role', 'relationship', 'traits'])],
  ['relationships', new Set(['dynamic'])],
]);

function findCollectionEntity(
  snapshot: CreationContractSections,
  section: string,
  entityKey: string,
): Record<string, unknown> | null {
  if (section === 'supportingCharacters') {
    const found = (snapshot.supportingCharacters ?? []).find((c) => c.characterKey === entityKey);
    return found ? (found as unknown as Record<string, unknown>) : null;
  }
  if (section === 'relationships') {
    const found = (snapshot.relationships ?? []).find((r) => r.relationshipKey === entityKey);
    return found ? (found as unknown as Record<string, unknown>) : null;
  }
  return null;
}

export function validateNewLockPath(
  path: string,
  existingLocks: readonly string[],
  snapshot: CreationContractSections | null,
): void {
  const canonicalPath = nfc(canonicalizeContractFieldPath(path));
  const parsed = parseContractFieldPath(canonicalPath);

  const validatedExisting: string[] = [];
  const seenExisting = new Set<string>();
  for (const lp of existingLocks) {
    const c = nfc(canonicalizeContractFieldPath(lp));
    parseContractFieldPath(c);
    if (seenExisting.has(c)) {
      throw new Error(`现有 lock 中存在重复 path: "${c}"`);
    }
    seenExisting.add(c);
    validatedExisting.push(c);
  }
  for (let i = 0; i < validatedExisting.length; i++) {
    for (let j = i + 1; j < validatedExisting.length; j++) {
      if (pathsOverlap(validatedExisting[i], validatedExisting[j])) {
        throw new Error(
          `现有 lock 中存在重叠 path: "${validatedExisting[i]}" 与 "${validatedExisting[j]}"`,
        );
      }
    }
  }

  for (const existingLock of validatedExisting) {
    if (pathsOverlap(canonicalPath, existingLock)) {
      throw new Error(`lock path "${canonicalPath}" 与现有 lock "${existingLock}" 重叠`);
    }
  }

  if (snapshot === null) {
    if (parsed.entityKey !== undefined || parsed.field !== undefined) {
      throw new Error(`snapshot 为空时只允许锁定顶层 section path: "${canonicalPath}"`);
    }
    return;
  }

  if (parsed.entityKey === undefined && parsed.field === undefined) {
    return;
  }

  if (parsed.entityKey !== undefined) {
    const entity = findCollectionEntity(snapshot, parsed.section, parsed.entityKey);
    if (entity === null) {
      throw new Error(
        `entity "${parsed.entityKey}" 不存在于 snapshot 的 "${parsed.section}" 中，不允许锁定其路径`,
      );
    }
    if (parsed.field === undefined) return;
    if (entity[parsed.field] !== undefined) return;
    const optionalChildren = COLLECTION_OPTIONAL_CHILDREN.get(parsed.section);
    if (!optionalChildren || !optionalChildren.has(parsed.field)) {
      throw new Error(`字段 "${canonicalPath}" 当前缺失且不是 optional 子字段，不允许锁定`);
    }
    return;
  }

  const snapshotRec = snapshot as unknown as Record<string, unknown>;
  const sectionValue = snapshotRec[parsed.section];
  if (sectionValue === undefined) {
    throw new Error(`${parsed.section} 不存在时不允许锁定其子字段`);
  }
  if (typeof sectionValue !== 'object' || sectionValue === null || Array.isArray(sectionValue)) {
    throw new Error(`section "${parsed.section}" 不支持 field-level lock`);
  }
  if ((sectionValue as Record<string, unknown>)[parsed.field!] !== undefined) {
    return;
  }
  const optionalChildren = STRUCTURED_OPTIONAL_CHILDREN.get(parsed.section);
  if (!optionalChildren || !optionalChildren.has(parsed.field!)) {
    throw new Error(`字段 "${canonicalPath}" 当前缺失且不是 optional 子字段，不允许锁定`);
  }
  return;
}

export function validateUnlockPath(path: string, existingLocks: readonly string[]): void {
  const canonicalPath = canonicalizeContractFieldPath(path);
  if (!existingLocks.includes(canonicalPath)) {
    throw new Error(`路径 "${canonicalPath}" 未被锁定`);
  }
}

// ── Closed ContractPatchOperation ──────────────────────────────

const SCALAR_STRING_PATHS: ReadonlySet<string> = new Set([
  '/premise',
  '/targetAudience',
  '/structure',
  '/protagonist/name',
  '/protagonist/role',
  '/protagonist/motivation',
  '/protagonist/arc',
  '/contentBoundaries/rating',
  '/contentBoundaries/notes',
]);

const SCALAR_ENUM_PATHS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['/narrativePov', NARRATIVE_POV_SET],
  ['/tense', TENSE_SET],
  ['/targetLength/unit', new Set(['words', 'chapters'])],
]);

const SCALAR_NUMBER_PATHS: ReadonlySet<string> = new Set([
  '/targetLength/value',
  '/chapterLength/targetCharacters',
  '/chapterLength/minimumCharacters',
  '/chapterLength/maximumCharacters',
]);

const SUPPORTING_CHAR_SCALAR_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'role',
  'relationship',
]);

const RELATIONSHIP_SCALAR_FIELDS: ReadonlySet<string> = new Set(['type', 'dynamic']);

const STRING_LIST_PATHS: ReadonlySet<string> = new Set([
  '/genre',
  '/tone',
  '/themes',
  '/worldRules',
  '/mustInclude',
  '/mustAvoid',
  '/unresolvedQuestions',
  '/protagonist/traits',
  '/contentBoundaries/allowedContent',
  '/contentBoundaries/prohibitedContent',
]);

const STRUCTURED_PATHS: ReadonlySet<string> = new Set([
  '/targetLength',
  '/chapterLength',
  '/contentBoundaries',
]);

const REMOVE_FIELD_PATHS: ReadonlySet<string> = new Set([
  '/themes',
  '/targetLength',
  '/chapterLength',
  '/structure',
  '/supportingCharacters',
  '/relationships',
  '/worldRules',
  '/mustInclude',
  '/mustAvoid',
  '/contentBoundaries',
  '/unresolvedQuestions',
  '/protagonist/role',
  '/protagonist/motivation',
  '/protagonist/arc',
  '/protagonist/traits',
  '/contentBoundaries/rating',
  '/contentBoundaries/allowedContent',
  '/contentBoundaries/prohibitedContent',
  '/contentBoundaries/notes',
]);

const FORBIDDEN_SCALAR_PATHS: ReadonlySet<string> = new Set([
  '/protagonist/characterKey',
  '/relationships/fromCharacterKey',
  '/relationships/toCharacterKey',
]);

export type SetScalarFieldOperation =
  | { readonly kind: 'set-scalar'; readonly path: '/premise'; readonly value: string }
  | { readonly kind: 'set-scalar'; readonly path: '/targetAudience'; readonly value: string }
  | { readonly kind: 'set-scalar'; readonly path: '/narrativePov'; readonly value: NarrativePov }
  | { readonly kind: 'set-scalar'; readonly path: '/tense'; readonly value: Tense }
  | { readonly kind: 'set-scalar'; readonly path: '/structure'; readonly value: string }
  | { readonly kind: 'set-scalar'; readonly path: '/protagonist/name'; readonly value: string }
  | { readonly kind: 'set-scalar'; readonly path: '/protagonist/role'; readonly value: string }
  | {
      readonly kind: 'set-scalar';
      readonly path: '/protagonist/motivation';
      readonly value: string;
    }
  | { readonly kind: 'set-scalar'; readonly path: '/protagonist/arc'; readonly value: string }
  | {
      readonly kind: 'set-scalar';
      readonly path: '/targetLength/unit';
      readonly value: TargetLengthUnit;
    }
  | { readonly kind: 'set-scalar'; readonly path: '/targetLength/value'; readonly value: number }
  | {
      readonly kind: 'set-scalar';
      readonly path:
        | '/chapterLength/targetCharacters'
        | '/chapterLength/minimumCharacters'
        | '/chapterLength/maximumCharacters';
      readonly value: number;
    }
  | {
      readonly kind: 'set-scalar';
      readonly path: '/contentBoundaries/rating';
      readonly value: string;
    }
  | {
      readonly kind: 'set-scalar';
      readonly path: '/contentBoundaries/notes';
      readonly value: string;
    }
  | {
      readonly kind: 'set-scalar';
      readonly path: `/supportingCharacters/${string}/${'name' | 'role' | 'relationship'}`;
      readonly value: string;
    }
  | {
      readonly kind: 'set-scalar';
      readonly path: `/relationships/${string}/${'type' | 'dynamic'}`;
      readonly value: string;
    };

export type SetStringListFieldOperation =
  | { readonly kind: 'set-string-list'; readonly path: '/genre'; readonly value: readonly string[] }
  | { readonly kind: 'set-string-list'; readonly path: '/tone'; readonly value: readonly string[] }
  | {
      readonly kind: 'set-string-list';
      readonly path: '/themes';
      readonly value: readonly string[];
    }
  | {
      readonly kind: 'set-string-list';
      readonly path: '/worldRules';
      readonly value: readonly string[];
    }
  | {
      readonly kind: 'set-string-list';
      readonly path: '/mustInclude';
      readonly value: readonly string[];
    }
  | {
      readonly kind: 'set-string-list';
      readonly path: '/mustAvoid';
      readonly value: readonly string[];
    }
  | {
      readonly kind: 'set-string-list';
      readonly path: '/unresolvedQuestions';
      readonly value: readonly string[];
    }
  | {
      readonly kind: 'set-string-list';
      readonly path: '/protagonist/traits';
      readonly value: readonly string[];
    }
  | {
      readonly kind: 'set-string-list';
      readonly path: '/contentBoundaries/allowedContent';
      readonly value: readonly string[];
    }
  | {
      readonly kind: 'set-string-list';
      readonly path: '/contentBoundaries/prohibitedContent';
      readonly value: readonly string[];
    }
  | {
      readonly kind: 'set-string-list';
      readonly path: `/supportingCharacters/${string}/traits`;
      readonly value: readonly string[];
    };

export type SetStructuredFieldOperation =
  | {
      readonly kind: 'set-structured';
      readonly path: '/targetLength';
      readonly value: TargetLength;
    }
  | {
      readonly kind: 'set-structured';
      readonly path: '/chapterLength';
      readonly value: ChapterLength;
    }
  | {
      readonly kind: 'set-structured';
      readonly path: '/contentBoundaries';
      readonly value: ContentBoundaries;
    };

export type RemoveOptionalFieldOperation = {
  readonly kind: 'remove-field';
  readonly path:
    | '/themes'
    | '/targetLength'
    | '/chapterLength'
    | '/structure'
    | '/supportingCharacters'
    | '/relationships'
    | '/worldRules'
    | '/mustInclude'
    | '/mustAvoid'
    | '/contentBoundaries'
    | '/unresolvedQuestions'
    | '/protagonist/role'
    | '/protagonist/motivation'
    | '/protagonist/arc'
    | '/protagonist/traits'
    | '/contentBoundaries/rating'
    | '/contentBoundaries/allowedContent'
    | '/contentBoundaries/prohibitedContent'
    | '/contentBoundaries/notes';
};

export interface UpsertProtagonistOperation {
  readonly kind: 'upsert-protagonist';
  readonly value: ProtagonistCharacter;
}

export interface UpsertSupportingCharacterOperation {
  readonly kind: 'upsert-supporting-character';
  readonly target: CharacterKey;
  readonly value: SupportingCharacter;
}

export interface RemoveCharacterOperation {
  readonly kind: 'remove-character';
  readonly target: CharacterKey;
}

export interface UpsertRelationshipOperation {
  readonly kind: 'upsert-relationship';
  readonly target: RelationshipKey;
  readonly value: RelationshipEntry;
}

export interface RemoveRelationshipOperation {
  readonly kind: 'remove-relationship';
  readonly target: RelationshipKey;
}

export type ContractPatchOperation =
  | SetScalarFieldOperation
  | SetStringListFieldOperation
  | SetStructuredFieldOperation
  | RemoveOptionalFieldOperation
  | UpsertProtagonistOperation
  | UpsertSupportingCharacterOperation
  | RemoveCharacterOperation
  | UpsertRelationshipOperation
  | RemoveRelationshipOperation;

// ── Runtime Operation Parser ───────────────────────────────────

function expectObject(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} 必须是对象`);
  }
  return input as Record<string, unknown>;
}

function expectExactKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (!allowed.has(k)) throw new Error(`${label}: 未知字段 "${k}"`);
  }
  for (const k of allowed) {
    if (!(k in obj)) throw new Error(`${label}: 缺少必需字段 "${k}"`);
  }
}

function expectString(v: unknown, label: string): string {
  if (typeof v !== 'string') throw new Error(`${label} 必须是字符串`);
  return v;
}

function expectStringArray(v: unknown, label: string): readonly string[] {
  if (!Array.isArray(v)) throw new Error(`${label} 必须是数组`);
  return v.map((item, i) => {
    if (typeof item !== 'string') throw new Error(`${label}[${i}] 必须是字符串`);
    return item;
  });
}

function matchCollectionScalarPath(
  path: string,
  collection: string,
  allowedFields: ReadonlySet<string>,
): { entityKey: string; field: string } | null {
  const prefix = `/${collection}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) return null;
  const entityKey = rest.slice(0, slashIdx);
  const field = rest.slice(slashIdx + 1);
  if (!STABLE_KEY_RE.test(entityKey)) return null;
  if (field.includes('/')) return null;
  if (!allowedFields.has(field)) return null;
  return { entityKey, field };
}

function parseSetScalar(input: Record<string, unknown>): SetScalarFieldOperation {
  expectExactKeys(input, new Set(['kind', 'path', 'value']), 'set-scalar');
  const path = expectString(input.path, 'set-scalar.path');

  if (FORBIDDEN_SCALAR_PATHS.has(path)) {
    throw new Error(`set-scalar 不允许修改路径: "${path}"`);
  }

  if (SCALAR_STRING_PATHS.has(path)) {
    const value = expectString(input.value, 'set-scalar.value');
    return { kind: 'set-scalar', path, value } as SetScalarFieldOperation;
  }

  const enumValues = SCALAR_ENUM_PATHS.get(path);
  if (enumValues) {
    const value = expectString(input.value, 'set-scalar.value');
    if (!enumValues.has(value)) {
      throw new Error(`set-scalar ${path}: 无效枚举值 "${value}"`);
    }
    return { kind: 'set-scalar', path, value } as SetScalarFieldOperation;
  }

  if (SCALAR_NUMBER_PATHS.has(path)) {
    const value = input.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`set-scalar ${path}: value 必须是有限数字`);
    }
    return { kind: 'set-scalar', path, value } as SetScalarFieldOperation;
  }

  const supportingMatch = matchCollectionScalarPath(
    path,
    'supportingCharacters',
    SUPPORTING_CHAR_SCALAR_FIELDS,
  );
  if (supportingMatch) {
    const value = expectString(input.value, 'set-scalar.value');
    return {
      kind: 'set-scalar',
      path: `/supportingCharacters/${supportingMatch.entityKey}/${supportingMatch.field}`,
      value,
    } as SetScalarFieldOperation;
  }

  const relMatch = matchCollectionScalarPath(path, 'relationships', RELATIONSHIP_SCALAR_FIELDS);
  if (relMatch) {
    const value = expectString(input.value, 'set-scalar.value');
    return {
      kind: 'set-scalar',
      path: `/relationships/${relMatch.entityKey}/${relMatch.field}`,
      value,
    } as SetScalarFieldOperation;
  }

  throw new Error(`set-scalar: 未知路径 "${path}"`);
}

function parseSetStringList(input: Record<string, unknown>): SetStringListFieldOperation {
  expectExactKeys(input, new Set(['kind', 'path', 'value']), 'set-string-list');
  const path = expectString(input.path, 'set-string-list.path');

  if (STRING_LIST_PATHS.has(path)) {
    const value = expectStringArray(input.value, 'set-string-list.value');
    return { kind: 'set-string-list', path, value } as SetStringListFieldOperation;
  }

  const prefix = '/supportingCharacters/';
  if (path.startsWith(prefix)) {
    const rest = path.slice(prefix.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx !== -1) {
      const entityKey = rest.slice(0, slashIdx);
      const field = rest.slice(slashIdx + 1);
      if (STABLE_KEY_RE.test(entityKey) && field === 'traits' && !field.includes('/')) {
        const value = expectStringArray(input.value, 'set-string-list.value');
        return {
          kind: 'set-string-list',
          path: `/supportingCharacters/${entityKey}/traits`,
          value,
        } as SetStringListFieldOperation;
      }
    }
  }

  throw new Error(`set-string-list: 未知路径 "${path}"`);
}

function parseSetStructured(input: Record<string, unknown>): SetStructuredFieldOperation {
  expectExactKeys(input, new Set(['kind', 'path', 'value']), 'set-structured');
  const path = expectString(input.path, 'set-structured.path');

  if (!STRUCTURED_PATHS.has(path)) {
    throw new Error(`set-structured: 未知路径 "${path}"`);
  }

  if (path === '/targetLength') {
    const validated = validateTargetLength(input.value);
    return { kind: 'set-structured', path: '/targetLength', value: validated };
  }

  if (path === '/chapterLength') {
    const validated = validateChapterLength(input.value);
    return { kind: 'set-structured', path: '/chapterLength', value: validated };
  }

  if (typeof input.value !== 'object' || input.value === null || Array.isArray(input.value)) {
    throw new Error('set-structured /contentBoundaries: value 必须是对象');
  }
  const validated = validateContentBoundaries(input.value);
  return { kind: 'set-structured', path: '/contentBoundaries', value: validated };
}

function parseRemoveField(input: Record<string, unknown>): RemoveOptionalFieldOperation {
  expectExactKeys(input, new Set(['kind', 'path']), 'remove-field');
  const path = expectString(input.path, 'remove-field.path');

  if (!REMOVE_FIELD_PATHS.has(path)) {
    throw new Error(`remove-field: 未知或不允许的路径 "${path}"`);
  }

  return { kind: 'remove-field', path } as RemoveOptionalFieldOperation;
}

function parseUpsertProtagonist(input: Record<string, unknown>): UpsertProtagonistOperation {
  expectExactKeys(input, new Set(['kind', 'value']), 'upsert-protagonist');
  const validated = validateProtagonistCharacter(input.value);
  return { kind: 'upsert-protagonist', value: validated };
}

function parseUpsertSupportingCharacter(
  input: Record<string, unknown>,
): UpsertSupportingCharacterOperation {
  expectExactKeys(input, new Set(['kind', 'target', 'value']), 'upsert-supporting-character');
  const target = createCharacterKey(nfc(expectString(input.target, 'target')));
  const valueObj = expectObject(input.value, 'value');
  const validated = validateSupportingCharacterItem(valueObj, 0);
  if (validated.characterKey !== target) {
    throw new Error(
      `upsert-supporting-character: value.characterKey "${validated.characterKey}" 必须等于 target "${target}"`,
    );
  }
  return { kind: 'upsert-supporting-character', target, value: validated };
}

function parseRemoveCharacter(input: Record<string, unknown>): RemoveCharacterOperation {
  expectExactKeys(input, new Set(['kind', 'target']), 'remove-character');
  const target = createCharacterKey(nfc(expectString(input.target, 'target')));
  return { kind: 'remove-character', target };
}

function parseUpsertRelationship(input: Record<string, unknown>): UpsertRelationshipOperation {
  expectExactKeys(input, new Set(['kind', 'target', 'value']), 'upsert-relationship');
  const target = createRelationshipKey(nfc(expectString(input.target, 'target')));
  const valueObj = expectObject(input.value, 'value');
  const validated = validateRelationshipEntryItem(valueObj, 0);
  if (validated.relationshipKey !== target) {
    throw new Error(
      `upsert-relationship: value.relationshipKey "${validated.relationshipKey}" 必须等于 target "${target}"`,
    );
  }
  return { kind: 'upsert-relationship', target, value: validated };
}

function parseRemoveRelationship(input: Record<string, unknown>): RemoveRelationshipOperation {
  expectExactKeys(input, new Set(['kind', 'target']), 'remove-relationship');
  const target = createRelationshipKey(nfc(expectString(input.target, 'target')));
  return { kind: 'remove-relationship', target };
}

export function parseContractPatchOperation(input: unknown): ContractPatchOperation {
  const obj = expectObject(input, 'ContractPatchOperation');
  const kind = expectString(obj.kind, 'kind');

  switch (kind) {
    case 'set-scalar':
      return parseSetScalar(obj);
    case 'set-string-list':
      return parseSetStringList(obj);
    case 'set-structured':
      return parseSetStructured(obj);
    case 'remove-field':
      return parseRemoveField(obj);
    case 'upsert-protagonist':
      return parseUpsertProtagonist(obj);
    case 'upsert-supporting-character':
      return parseUpsertSupportingCharacter(obj);
    case 'remove-character':
      return parseRemoveCharacter(obj);
    case 'upsert-relationship':
      return parseUpsertRelationship(obj);
    case 'remove-relationship':
      return parseRemoveRelationship(obj);
    default:
      throw new Error(`未知 operation kind: "${kind}"`);
  }
}

// ── Write-Set Computation ──────────────────────────────────────

export function getCanonicalTargetPath(op: ContractPatchOperation): string {
  switch (op.kind) {
    case 'set-scalar':
    case 'set-string-list':
    case 'set-structured':
    case 'remove-field':
      return canonicalizeContractFieldPath(op.path);
    case 'upsert-protagonist':
      return '/protagonist';
    case 'upsert-supporting-character':
    case 'remove-character':
      return `/supportingCharacters/${op.target}`;
    case 'upsert-relationship':
    case 'remove-relationship':
      return `/relationships/${op.target}`;
  }
}

export function operationWriteSetConflictsWithLocks(
  op: ContractPatchOperation,
  lockedPaths: readonly string[],
): boolean {
  const targetPath = getCanonicalTargetPath(op);
  return lockedPaths.some((lockedPath) => pathsOverlap(targetPath, lockedPath));
}

// ── ChangeSet Engine ───────────────────────────────────────────

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export interface ContractPatchContext {
  readonly sourceSections: CreationContractSections;
  readonly authoritativeBaseSections: CreationContractSections | null;
  readonly lockedFieldPaths: readonly string[];
}

function applySetScalarField(
  snapshot: CreationContractSections,
  path: string,
  value: string | number,
): CreationContractSections {
  const parsed = parseContractFieldPath(path);

  if (parsed.entityKey === undefined && parsed.field === undefined) {
    return { ...snapshot, [parsed.section]: value };
  }

  if (parsed.entityKey === undefined && parsed.field !== undefined) {
    const snapshotRec = snapshot as unknown as Record<string, unknown>;
    const section = snapshotRec[parsed.section];
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      throw new Error(`无法对非对象 section "${parsed.section}" 设置子字段`);
    }
    return {
      ...snapshot,
      [parsed.section]: { ...(section as Record<string, unknown>), [parsed.field]: value },
    };
  }

  if (parsed.entityKey !== undefined && parsed.field !== undefined) {
    const snapshotRec = snapshot as unknown as Record<string, unknown>;
    const collection = snapshotRec[parsed.section];
    if (!Array.isArray(collection)) {
      throw new Error(`无法对非数组 section "${parsed.section}" 设置子字段`);
    }
    const keyField = parsed.section === 'supportingCharacters' ? 'characterKey' : 'relationshipKey';
    const index = collection.findIndex(
      (item) => (item as Record<string, unknown>)[keyField] === parsed.entityKey,
    );
    if (index === -1) {
      throw new Error(`entity "${parsed.entityKey}" 不存在于 "${parsed.section}"`);
    }
    const newCollection = [...collection];
    newCollection[index] = {
      ...(newCollection[index] as Record<string, unknown>),
      [parsed.field!]: value,
    };
    return { ...snapshot, [parsed.section]: newCollection };
  }

  throw new Error(`无效的 set-scalar 路径: "${path}"`);
}

function applySetStringListField(
  snapshot: CreationContractSections,
  path: string,
  value: readonly string[],
): CreationContractSections {
  const parsed = parseContractFieldPath(path);

  if (parsed.entityKey === undefined && parsed.field === undefined) {
    return { ...snapshot, [parsed.section]: value };
  }

  if (parsed.entityKey === undefined && parsed.field !== undefined) {
    const snapshotRec = snapshot as unknown as Record<string, unknown>;
    const section = snapshotRec[parsed.section];
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      throw new Error(`无法对非对象 section "${parsed.section}" 设置子字段`);
    }
    return {
      ...snapshot,
      [parsed.section]: { ...(section as Record<string, unknown>), [parsed.field]: value },
    };
  }

  if (parsed.entityKey !== undefined && parsed.field !== undefined) {
    const snapshotRec = snapshot as unknown as Record<string, unknown>;
    const collection = snapshotRec[parsed.section];
    if (!Array.isArray(collection)) {
      throw new Error(`无法对非数组 section "${parsed.section}" 设置子字段`);
    }
    const keyField = parsed.section === 'supportingCharacters' ? 'characterKey' : 'relationshipKey';
    const index = collection.findIndex(
      (item) => (item as Record<string, unknown>)[keyField] === parsed.entityKey,
    );
    if (index === -1) {
      throw new Error(`entity "${parsed.entityKey}" 不存在于 "${parsed.section}"`);
    }
    const newCollection = [...collection];
    newCollection[index] = {
      ...(newCollection[index] as Record<string, unknown>),
      [parsed.field!]: value,
    };
    return { ...snapshot, [parsed.section]: newCollection };
  }

  throw new Error(`无效的 set-string-list 路径: "${path}"`);
}

function applySetStructuredField(
  snapshot: CreationContractSections,
  path: string,
  value: TargetLength | ChapterLength | ContentBoundaries,
): CreationContractSections {
  const parsed = parseContractFieldPath(path);
  if (parsed.entityKey !== undefined || parsed.field !== undefined) {
    throw new Error(`set-structured 只能用于顶层 structured section: "${path}"`);
  }
  return { ...snapshot, [parsed.section]: value };
}

function applyRemoveField(
  snapshot: CreationContractSections,
  path: string,
): CreationContractSections {
  const parsed = parseContractFieldPath(path);

  if (parsed.entityKey === undefined && parsed.field === undefined) {
    const copy = { ...(snapshot as unknown as Record<string, unknown>) };
    if (!(parsed.section in copy)) {
      throw new Error(`remove-field: 字段 "${path}" 不存在`);
    }
    delete copy[parsed.section];
    return copy as unknown as CreationContractSections;
  }

  if (parsed.entityKey === undefined && parsed.field !== undefined) {
    const snapshotRec = snapshot as unknown as Record<string, unknown>;
    const section = snapshotRec[parsed.section];
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      throw new Error(`无法从非对象 section "${parsed.section}" 移除子字段`);
    }
    const sectionObj = section as Record<string, unknown>;
    if (!(parsed.field in sectionObj)) {
      throw new Error(`remove-field: 字段 "${path}" 不存在`);
    }
    const copy = { ...sectionObj };
    delete copy[parsed.field];
    return { ...snapshot, [parsed.section]: copy };
  }

  throw new Error(`remove-field 不支持路径: "${path}"`);
}

function applySingleOperation(
  snapshot: CreationContractSections,
  op: ContractPatchOperation,
): CreationContractSections {
  switch (op.kind) {
    case 'set-scalar':
      return applySetScalarField(snapshot, op.path, op.value);
    case 'set-string-list':
      return applySetStringListField(snapshot, op.path, op.value);
    case 'set-structured':
      return applySetStructuredField(snapshot, op.path, op.value);
    case 'remove-field':
      return applyRemoveField(snapshot, op.path);
    case 'upsert-protagonist':
      return { ...snapshot, protagonist: op.value };
    case 'upsert-supporting-character': {
      const existing = [...(snapshot.supportingCharacters ?? [])];
      const index = existing.findIndex((c) => c.characterKey === op.target);
      if (index === -1) {
        return { ...snapshot, supportingCharacters: [...existing, op.value] };
      }
      return {
        ...snapshot,
        supportingCharacters: existing.map((c, i) => (i === index ? op.value : c)),
      };
    }
    case 'remove-character': {
      const existing = snapshot.supportingCharacters;
      if (!existing || !existing.some((c) => c.characterKey === op.target)) {
        throw new Error(`remove-character: 角色 "${op.target}" 不存在`);
      }
      return {
        ...snapshot,
        supportingCharacters: existing.filter((c) => c.characterKey !== op.target),
      };
    }
    case 'upsert-relationship': {
      const existing = [...(snapshot.relationships ?? [])];
      const index = existing.findIndex((r) => r.relationshipKey === op.target);
      if (index === -1) {
        return { ...snapshot, relationships: [...existing, op.value] };
      }
      return {
        ...snapshot,
        relationships: existing.map((r, i) => (i === index ? op.value : r)),
      };
    }
    case 'remove-relationship': {
      const existing = snapshot.relationships;
      if (!existing || !existing.some((r) => r.relationshipKey === op.target)) {
        throw new Error(`remove-relationship: 关系 "${op.target}" 不存在`);
      }
      return {
        ...snapshot,
        relationships: existing.filter((r) => r.relationshipKey !== op.target),
      };
    }
  }
}

export function applyContractPatchOperations(
  operations: ReadonlyArray<ContractPatchOperation>,
  currentSnapshot: CreationContractSections,
  context: ContractPatchContext,
): CreationContractSections {
  const lockedPaths = context.lockedFieldPaths;

  // Step 1: Duplicate target check
  const targetPaths = operations.map(getCanonicalTargetPath);
  const seen = new Set<string>();
  for (const tp of targetPaths) {
    if (seen.has(tp)) throw new Error(`重复的 target path: "${tp}"`);
    seen.add(tp);
  }

  // Step 2: Overlapping write-set check
  for (let i = 0; i < targetPaths.length; i++) {
    for (let j = i + 1; j < targetPaths.length; j++) {
      if (pathsOverlap(targetPaths[i], targetPaths[j])) {
        throw new Error(`write-set 重叠: "${targetPaths[i]}" 和 "${targetPaths[j]}"`);
      }
    }
  }

  // Step 3: Stable key modification check (authoritative baseline)
  const authBase = context.authoritativeBaseSections;
  for (const op of operations) {
    if (op.kind === 'upsert-protagonist') {
      if (authBase !== null) {
        if (op.value.characterKey !== authBase.protagonist.characterKey) {
          throw new Error(
            `protagonist characterKey 不可修改: "${authBase.protagonist.characterKey}" -> "${op.value.characterKey}"`,
          );
        }
      }
    }
    if (op.kind === 'upsert-supporting-character') {
      if (op.value.characterKey !== op.target) {
        throw new Error(
          `supporting character value.characterKey "${op.value.characterKey}" 必须等于 target "${op.target}"`,
        );
      }
    }
    if (op.kind === 'upsert-relationship') {
      if (op.value.relationshipKey !== op.target) {
        throw new Error(
          `relationship value.relationshipKey "${op.value.relationshipKey}" 必须等于 target "${op.target}"`,
        );
      }
    }
  }

  // Step 4: Supporting/protagonist key conflict check
  let protagonistKey = currentSnapshot.protagonist.characterKey;
  for (const op of operations) {
    if (op.kind === 'upsert-protagonist') {
      protagonistKey = op.value.characterKey;
    }
  }
  for (const op of operations) {
    if (op.kind === 'upsert-supporting-character') {
      if (op.value.characterKey === protagonistKey) {
        throw new Error(
          `supporting character key "${op.value.characterKey}" 与 protagonist key 冲突`,
        );
      }
    }
  }

  // Step 5: Lock conflict check
  for (const op of operations) {
    if (operationWriteSetConflictsWithLocks(op, lockedPaths)) {
      throw new Error(`操作与锁定字段冲突: ${getCanonicalTargetPath(op)}`);
    }
  }

  // Step 6: Sort operations by canonical target path for determinism
  const sorted = [...operations].sort((a, b) =>
    codePointCompare(getCanonicalTargetPath(a), getCanonicalTargetPath(b)),
  );

  // Step 7: Tentatively apply all operations in canonical order
  let snapshot = deepClone(currentSnapshot);
  for (const op of sorted) {
    snapshot = applySingleOperation(snapshot, op);
  }

  // Step 8: Validate final snapshot schema and normalize
  const normalized = validateCreationContractSections(snapshot);

  // Step 9: Relationship integrity check on final snapshot
  if (normalized.relationships) {
    const allCharKeys = new Set<string>();
    allCharKeys.add(normalized.protagonist.characterKey);
    if (normalized.supportingCharacters) {
      for (const char of normalized.supportingCharacters) {
        allCharKeys.add(char.characterKey);
      }
    }
    for (const rel of normalized.relationships) {
      if (!allCharKeys.has(rel.fromCharacterKey)) {
        throw new Error(`最终 snapshot 中 relationship 引用未知角色: "${rel.fromCharacterKey}"`);
      }
      if (!allCharKeys.has(rel.toCharacterKey)) {
        throw new Error(`最终 snapshot 中 relationship 引用未知角色: "${rel.toCharacterKey}"`);
      }
    }
  }

  return normalized;
}
