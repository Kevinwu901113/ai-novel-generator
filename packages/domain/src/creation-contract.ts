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

function canonicalize(value: unknown): unknown {
  if (value === undefined) throw new Error('canonical serialization 不允许 undefined');
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical serialization 不允许非有限数');
    return value;
  }
  if (typeof value === 'string') return nfc(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined)
        throw new Error(`canonical serialization 不允许 key "${key}" 为 undefined`);
      result[key] = canonicalize(v);
    }
    return result;
  }
  throw new Error(`canonical serialization 不支持类型: ${typeof value}`);
}

export function canonicalSerializeContractSections(sections: CreationContractSections): string {
  return JSON.stringify(canonicalize(sections));
}

export function canonicalSerializeLockedFieldPaths(paths: readonly string[]): string {
  const normalized = paths.map((p) => nfc(p));
  const seen = new Set<string>();
  for (const p of normalized) {
    if (seen.has(p)) throw new Error(`重复的 lock path: "${p}"`);
    seen.add(p);
  }
  const sorted = [...normalized].sort();
  return JSON.stringify(sorted);
}

export function canonicalSerializeContractSnapshot(input: {
  sections: CreationContractSections;
  lockedFieldPaths: readonly string[];
  schemaVersion: number;
}): string {
  const normalizedPaths = input.lockedFieldPaths.map((p) => nfc(p));
  const seen = new Set<string>();
  for (const p of normalizedPaths) {
    if (seen.has(p)) throw new Error(`重复的 lock path: "${p}"`);
    seen.add(p);
  }
  const sortedPaths = [...normalizedPaths].sort();

  return JSON.stringify(
    canonicalize({
      sections: input.sections,
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

  // Required fields
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

  // Optional fields
  const themes =
    obj.themes !== undefined ? validateStringArray(obj.themes, 'themes', 0, 10, 100) : undefined;
  const targetLength =
    obj.targetLength !== undefined ? validateTargetLength(obj.targetLength) : undefined;
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

  // characterKey uniqueness
  const allCharKeys = new Set<string>();
  allCharKeys.add(protagonist.characterKey);
  if (supportingCharacters) {
    for (const char of supportingCharacters) {
      if (allCharKeys.has(char.characterKey)) {
        throw new Error(`重复的 characterKey: "${char.characterKey}"`);
      }
      if (char.characterKey === protagonist.characterKey) {
        throw new Error(`supporting character key "${char.characterKey}" 与 protagonist key 冲突`);
      }
      allCharKeys.add(char.characterKey);
    }
  }

  // relationshipKey uniqueness + character reference integrity
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

  // Top-level section path
  if (segments.length === 1) return { section };

  // Structured section or protagonist with child field
  const structuredChildren = STRUCTURED_CHILDREN.get(section);
  if (structuredChildren) {
    if (segments.length > 2) throw new Error(`路径过深: "${path}"`);
    const field = segments[1];
    if (!structuredChildren.has(field)) {
      throw new Error(`未知子字段: "${section}/${field}"`);
    }
    return { section, field };
  }

  // Collection section with entity key
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

  // Scalar or list section with child path → invalid
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

export function validateNewLockPath(
  path: string,
  existingLocks: readonly string[],
  snapshot: CreationContractSections | null,
): void {
  const canonicalPath = canonicalizeContractFieldPath(path);
  const parsed = parseContractFieldPath(canonicalPath);

  // Check overlap with existing locks
  for (const existingLock of existingLocks) {
    if (pathsOverlap(canonicalPath, existingLock)) {
      throw new Error(`lock path "${canonicalPath}" 与现有 lock "${existingLock}" 重叠`);
    }
  }

  // Check entity existence for collection descendant paths
  if (parsed.entityKey !== undefined && snapshot !== null) {
    if (parsed.section === 'supportingCharacters') {
      const chars = snapshot.supportingCharacters ?? [];
      if (!chars.some((c) => c.characterKey === parsed.entityKey)) {
        throw new Error(`角色 "${parsed.entityKey}" 不存在于 snapshot 中`);
      }
    }
    if (parsed.section === 'relationships') {
      const rels = snapshot.relationships ?? [];
      if (!rels.some((r) => r.relationshipKey === parsed.entityKey)) {
        throw new Error(`关系 "${parsed.entityKey}" 不存在于 snapshot 中`);
      }
    }
  }
}

export function validateUnlockPath(path: string, existingLocks: readonly string[]): void {
  const canonicalPath = canonicalizeContractFieldPath(path);
  if (!existingLocks.includes(canonicalPath)) {
    throw new Error(`路径 "${canonicalPath}" 未被锁定`);
  }
}

// ── ContractPatchOperation ─────────────────────────────────────

export interface SetScalarFieldOperation {
  readonly kind: 'set-scalar';
  readonly path: string;
  readonly value: string | number;
}

export interface SetStringListFieldOperation {
  readonly kind: 'set-string-list';
  readonly path: string;
  readonly value: readonly string[];
}

export interface SetStructuredFieldOperation {
  readonly kind: 'set-structured';
  readonly path: string;
  readonly value: TargetLength | ContentBoundaries;
}

export interface RemoveOptionalFieldOperation {
  readonly kind: 'remove-field';
  readonly path: string;
}

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
  value: TargetLength | ContentBoundaries,
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
    // Remove top-level optional section
    const copy = { ...(snapshot as unknown as Record<string, unknown>) };
    delete copy[parsed.section];
    return copy as unknown as CreationContractSections;
  }

  if (parsed.entityKey === undefined && parsed.field !== undefined) {
    // Remove optional child of structured section
    const snapshotRec = snapshot as unknown as Record<string, unknown>;
    const section = snapshotRec[parsed.section];
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      throw new Error(`无法从非对象 section "${parsed.section}" 移除子字段`);
    }
    const copy = { ...(section as Record<string, unknown>) };
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
      const existing = snapshot.supportingCharacters ?? [];
      const index = existing.findIndex((c) => c.characterKey === op.target);
      let newChars: readonly SupportingCharacter[];
      if (index === -1) {
        newChars = [...existing, op.value];
      } else {
        newChars = existing.map((c, i) => (i === index ? op.value : c));
      }
      return { ...snapshot, supportingCharacters: newChars };
    }
    case 'remove-character': {
      const existing = snapshot.supportingCharacters ?? [];
      return {
        ...snapshot,
        supportingCharacters: existing.filter((c) => c.characterKey !== op.target),
      };
    }
    case 'upsert-relationship': {
      const existing = snapshot.relationships ?? [];
      const index = existing.findIndex((r) => r.relationshipKey === op.target);
      let newRels: readonly RelationshipEntry[];
      if (index === -1) {
        newRels = [...existing, op.value];
      } else {
        newRels = existing.map((r, i) => (i === index ? op.value : r));
      }
      return { ...snapshot, relationships: newRels };
    }
    case 'remove-relationship': {
      const existing = snapshot.relationships ?? [];
      return {
        ...snapshot,
        relationships: existing.filter((r) => r.relationshipKey !== op.target),
      };
    }
  }
}

/**
 * 验证并应用 ChangeSet。
 *
 * Operations 是无序原子集合。验证结果与输入顺序无关。
 * 任一步失败，不返回部分 snapshot。
 */
export function applyContractPatchOperations(
  operations: ReadonlyArray<ContractPatchOperation>,
  currentSnapshot: CreationContractSections,
  lockedPaths: readonly string[],
): CreationContractSections {
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

  // Step 3: Stable key modification check
  for (const op of operations) {
    if (op.kind === 'upsert-protagonist') {
      if (op.value.characterKey !== currentSnapshot.protagonist.characterKey) {
        throw new Error(
          `protagonist characterKey 不可修改: "${currentSnapshot.protagonist.characterKey}" -> "${op.value.characterKey}"`,
        );
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

  // Step 6: Tentatively apply all operations
  let snapshot = deepClone(currentSnapshot);
  for (const op of operations) {
    snapshot = applySingleOperation(snapshot, op);
  }

  // Step 7: Validate final snapshot schema
  validateCreationContractSections(snapshot);

  // Step 8: Relationship integrity check on final snapshot
  if (snapshot.relationships) {
    const allCharKeys = new Set<string>();
    allCharKeys.add(snapshot.protagonist.characterKey);
    if (snapshot.supportingCharacters) {
      for (const char of snapshot.supportingCharacters) {
        allCharKeys.add(char.characterKey);
      }
    }
    for (const rel of snapshot.relationships) {
      if (!allCharKeys.has(rel.fromCharacterKey)) {
        throw new Error(`最终 snapshot 中 relationship 引用未知角色: "${rel.fromCharacterKey}"`);
      }
      if (!allCharKeys.has(rel.toCharacterKey)) {
        throw new Error(`最终 snapshot 中 relationship 引用未知角色: "${rel.toCharacterKey}"`);
      }
    }
  }

  return snapshot;
}
