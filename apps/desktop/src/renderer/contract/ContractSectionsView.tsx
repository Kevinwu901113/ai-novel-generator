/**
 * ContractSectionsView — 创作契约 sections 的纯结构化只读展示。
 *
 * 只做展示，不含任何交互或 API 调用。
 * - 中文 labels（contract-labels）
 * - array 使用列表
 * - nested object 使用子卡片
 * - optional section 缺失时不渲染空壳
 * - 长文本完整显示并安全换行（overflow-wrap: anywhere）
 * - 当前版本可传入 lockedFieldPaths，命中的字段显示 🔒 标记（仅信息展示）
 * - 不做逐字符 diff，不渲染原始 JSON
 */

import { useId } from 'react';
import type { CreationContractSectionsPublicData } from '@ai-novel/contracts';
import {
  labelFor,
  SECTION_LABELS,
  FIELD_LABELS,
  NARRATIVE_POV_LABELS,
  TENSE_LABELS,
  formatTargetLength,
  formatChapterLength,
  isLockedFieldPath,
} from './contract-labels';

interface ContractSectionsViewProps {
  readonly sections: CreationContractSectionsPublicData;
  /** 仅当前版本传入；提案不携带锁定信息 */
  readonly lockedFieldPaths?: ReadonlyArray<string>;
}

export function ContractSectionsView({
  sections,
  lockedFieldPaths = [],
}: ContractSectionsViewProps) {
  return (
    <div className="contract-sections-view">
      <CoreSection sections={sections} lockedFieldPaths={lockedFieldPaths} />
      <GenreToneSection sections={sections} lockedFieldPaths={lockedFieldPaths} />
      {sections.targetLength !== undefined && (
        <TargetLengthSection targetLength={sections.targetLength} />
      )}
      {sections.chapterLength !== undefined && (
        <ChapterLengthSection chapterLength={sections.chapterLength} />
      )}
      <ProtagonistSection protagonist={sections.protagonist} lockedFieldPaths={lockedFieldPaths} />
      {sections.supportingCharacters !== undefined && sections.supportingCharacters.length > 0 && (
        <SupportingCharactersSection
          characters={sections.supportingCharacters}
          lockedFieldPaths={lockedFieldPaths}
        />
      )}
      {sections.relationships !== undefined && sections.relationships.length > 0 && (
        <RelationshipsSection relationships={sections.relationships} />
      )}
      {sections.worldRules !== undefined && sections.worldRules.length > 0 && (
        <StringListSection title="世界规则" items={sections.worldRules} />
      )}
      {sections.mustInclude !== undefined && sections.mustInclude.length > 0 && (
        <StringListSection title="必须包含" items={sections.mustInclude} />
      )}
      {sections.mustAvoid !== undefined && sections.mustAvoid.length > 0 && (
        <StringListSection title="必须避免" items={sections.mustAvoid} />
      )}
      {sections.contentBoundaries !== undefined && (
        <ContentBoundariesSection
          contentBoundaries={sections.contentBoundaries}
          lockedFieldPaths={lockedFieldPaths}
        />
      )}
      {sections.unresolvedQuestions !== undefined && sections.unresolvedQuestions.length > 0 && (
        <StringListSection title="未决问题" items={sections.unresolvedQuestions} />
      )}
    </div>
  );
}

// ── 基础组件 ────────────────────────────────────────────────────────

/** 一个分组 section */
function GroupSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section className="contract-section" aria-labelledby={id}>
      <h5 id={id} className="contract-section-title">
        {title}
      </h5>
      {children}
    </section>
  );
}

/** 字段行：label + value；命中锁定路径时显示 🔒 */
function FieldRow({
  label,
  value,
  locked,
}: {
  readonly label: string;
  readonly value: string;
  readonly locked?: boolean;
}) {
  return (
    <div className="contract-field-row">
      <span className="contract-field-label">
        {locked && (
          <span className="contract-lock-marker" aria-label="已锁定">
            🔒
          </span>
        )}
        {label}
      </span>
      <span className="contract-field-value">{value}</span>
    </div>
  );
}

/** 字符串列表 */
function StringListSection({
  title,
  items,
}: {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
}) {
  return (
    <GroupSection title={title}>
      <ul className="contract-field-list">
        {items.map((item, i) => (
          <li key={i} className="contract-field-list-item">
            {item}
          </li>
        ))}
      </ul>
    </GroupSection>
  );
}

// ── 核心 section：前提 / 目标读者 / 叙事视角 / 时态 / 结构 ──────────

function CoreSection({
  sections,
  lockedFieldPaths,
}: {
  readonly sections: CreationContractSectionsPublicData;
  readonly lockedFieldPaths: ReadonlyArray<string>;
}) {
  return (
    <GroupSection title="核心设定">
      <div className="contract-field-block">
        <span className="contract-field-label">
          {isLockedFieldPath('/premise', lockedFieldPaths) && (
            <span className="contract-lock-marker" aria-label="已锁定">
              🔒
            </span>
          )}
          {labelFor(SECTION_LABELS, 'premise')}
        </span>
        <p className="contract-field-longtext">{sections.premise}</p>
      </div>
      <FieldRow
        label={labelFor(SECTION_LABELS, 'targetAudience')}
        value={sections.targetAudience}
        locked={isLockedFieldPath('/targetAudience', lockedFieldPaths)}
      />
      <FieldRow
        label={labelFor(SECTION_LABELS, 'narrativePov')}
        value={labelFor(NARRATIVE_POV_LABELS, sections.narrativePov)}
        locked={isLockedFieldPath('/narrativePov', lockedFieldPaths)}
      />
      <FieldRow
        label={labelFor(SECTION_LABELS, 'tense')}
        value={labelFor(TENSE_LABELS, sections.tense)}
        locked={isLockedFieldPath('/tense', lockedFieldPaths)}
      />
      {sections.structure !== undefined && sections.structure.length > 0 && (
        <div className="contract-field-block">
          <span className="contract-field-label">
            {isLockedFieldPath('/structure', lockedFieldPaths) && (
              <span className="contract-lock-marker" aria-label="已锁定">
                🔒
              </span>
            )}
            {labelFor(SECTION_LABELS, 'structure')}
          </span>
          <p className="contract-field-longtext">{sections.structure}</p>
        </div>
      )}
    </GroupSection>
  );
}

// ── 类型与基调 ──────────────────────────────────────────────────────

function GenreToneSection({
  sections,
  lockedFieldPaths,
}: {
  readonly sections: CreationContractSectionsPublicData;
  readonly lockedFieldPaths: ReadonlyArray<string>;
}) {
  return (
    <GroupSection title="类型与基调">
      <FieldRow
        label={labelFor(SECTION_LABELS, 'genre')}
        value={sections.genre.join('、')}
        locked={isLockedFieldPath('/genre', lockedFieldPaths)}
      />
      <FieldRow
        label={labelFor(SECTION_LABELS, 'tone')}
        value={sections.tone.join('、')}
        locked={isLockedFieldPath('/tone', lockedFieldPaths)}
      />
      {sections.themes !== undefined && sections.themes.length > 0 && (
        <FieldRow
          label={labelFor(SECTION_LABELS, 'themes')}
          value={sections.themes.join('、')}
          locked={isLockedFieldPath('/themes', lockedFieldPaths)}
        />
      )}
    </GroupSection>
  );
}

// ── 目标长度 ────────────────────────────────────────────────────────

function TargetLengthSection({
  targetLength,
}: {
  readonly targetLength: { readonly unit: string; readonly value: number };
}) {
  return (
    <GroupSection title="目标长度">
      <FieldRow
        label={labelFor(SECTION_LABELS, 'targetLength')}
        value={formatTargetLength(targetLength)}
      />
    </GroupSection>
  );
}

function ChapterLengthSection({
  chapterLength,
}: {
  readonly chapterLength: NonNullable<CreationContractSectionsPublicData['chapterLength']>;
}) {
  return (
    <GroupSection title="单章篇幅">
      <FieldRow
        label={labelFor(SECTION_LABELS, 'chapterLength')}
        value={formatChapterLength(chapterLength)}
      />
    </GroupSection>
  );
}

// ── 主角 ────────────────────────────────────────────────────────────

function ProtagonistSection({
  protagonist,
  lockedFieldPaths,
}: {
  readonly protagonist: CreationContractSectionsPublicData['protagonist'];
  readonly lockedFieldPaths: ReadonlyArray<string>;
}) {
  const lock = (field: string) => isLockedFieldPath(`/protagonist/${field}`, lockedFieldPaths);
  return (
    <GroupSection title="主角">
      <div className="contract-sub-card">
        <FieldRow
          label={labelFor(FIELD_LABELS, 'name')}
          value={protagonist.name}
          locked={lock('name')}
        />
        {protagonist.role !== undefined && protagonist.role.length > 0 && (
          <FieldRow
            label={labelFor(FIELD_LABELS, 'role')}
            value={protagonist.role}
            locked={lock('role')}
          />
        )}
        {protagonist.motivation !== undefined && protagonist.motivation.length > 0 && (
          <div className="contract-field-block">
            <span className="contract-field-label">
              {lock('motivation') && (
                <span className="contract-lock-marker" aria-label="已锁定">
                  🔒
                </span>
              )}
              {labelFor(FIELD_LABELS, 'motivation')}
            </span>
            <p className="contract-field-longtext">{protagonist.motivation}</p>
          </div>
        )}
        {protagonist.arc !== undefined && protagonist.arc.length > 0 && (
          <div className="contract-field-block">
            <span className="contract-field-label">
              {lock('arc') && (
                <span className="contract-lock-marker" aria-label="已锁定">
                  🔒
                </span>
              )}
              {labelFor(FIELD_LABELS, 'arc')}
            </span>
            <p className="contract-field-longtext">{protagonist.arc}</p>
          </div>
        )}
        {protagonist.traits !== undefined && protagonist.traits.length > 0 && (
          <div className="contract-field-block">
            <span className="contract-field-label">
              {lock('traits') && (
                <span className="contract-lock-marker" aria-label="已锁定">
                  🔒
                </span>
              )}
              {labelFor(FIELD_LABELS, 'traits')}
            </span>
            <ul className="contract-field-list">
              {protagonist.traits.map((trait, i) => (
                <li key={i} className="contract-field-list-item">
                  {trait}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </GroupSection>
  );
}

// ── 配角 ────────────────────────────────────────────────────────────

function SupportingCharactersSection({
  characters,
  lockedFieldPaths,
}: {
  readonly characters: NonNullable<CreationContractSectionsPublicData['supportingCharacters']>;
  readonly lockedFieldPaths: ReadonlyArray<string>;
}) {
  return (
    <GroupSection title="配角">
      {characters.map((character) => {
        const lock = (field: string) =>
          isLockedFieldPath(
            `/supportingCharacters/${character.characterKey}/${field}`,
            lockedFieldPaths,
          );
        return (
          <div key={character.characterKey} className="contract-sub-card">
            <h6 className="contract-sub-card-title">{character.name}</h6>
            {character.role !== undefined && character.role.length > 0 && (
              <FieldRow
                label={labelFor(FIELD_LABELS, 'role')}
                value={character.role}
                locked={lock('role')}
              />
            )}
            {character.relationship !== undefined && character.relationship.length > 0 && (
              <FieldRow
                label={labelFor(FIELD_LABELS, 'relationship')}
                value={character.relationship}
                locked={lock('relationship')}
              />
            )}
            {character.traits !== undefined && character.traits.length > 0 && (
              <div className="contract-field-block">
                <span className="contract-field-label">
                  {lock('traits') && (
                    <span className="contract-lock-marker" aria-label="已锁定">
                      🔒
                    </span>
                  )}
                  {labelFor(FIELD_LABELS, 'traits')}
                </span>
                <ul className="contract-field-list">
                  {character.traits.map((trait, i) => (
                    <li key={i} className="contract-field-list-item">
                      {trait}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </GroupSection>
  );
}

// ── 人物关系 ────────────────────────────────────────────────────────

function RelationshipsSection({
  relationships,
}: {
  readonly relationships: NonNullable<CreationContractSectionsPublicData['relationships']>;
}) {
  return (
    <GroupSection title="人物关系">
      <ul className="contract-field-list">
        {relationships.map((rel) => (
          <li key={rel.relationshipKey} className="contract-field-list-item">
            {rel.fromCharacterKey} → {rel.toCharacterKey}：{rel.type}
            {rel.dynamic !== undefined && rel.dynamic.length > 0 ? `（${rel.dynamic}）` : ''}
          </li>
        ))}
      </ul>
    </GroupSection>
  );
}

// ── 内容边界 ────────────────────────────────────────────────────────

function ContentBoundariesSection({
  contentBoundaries,
  lockedFieldPaths,
}: {
  readonly contentBoundaries: NonNullable<CreationContractSectionsPublicData['contentBoundaries']>;
  readonly lockedFieldPaths: ReadonlyArray<string>;
}) {
  const lock = (field: string) =>
    isLockedFieldPath(`/contentBoundaries/${field}`, lockedFieldPaths);
  return (
    <GroupSection title="内容边界">
      {contentBoundaries.rating !== undefined && contentBoundaries.rating.length > 0 && (
        <FieldRow
          label={labelFor(FIELD_LABELS, 'rating')}
          value={contentBoundaries.rating}
          locked={lock('rating')}
        />
      )}
      {contentBoundaries.allowedContent !== undefined &&
        contentBoundaries.allowedContent.length > 0 && (
          <div className="contract-field-block">
            <span className="contract-field-label">
              {lock('allowedContent') && (
                <span className="contract-lock-marker" aria-label="已锁定">
                  🔒
                </span>
              )}
              {labelFor(FIELD_LABELS, 'allowedContent')}
            </span>
            <ul className="contract-field-list">
              {contentBoundaries.allowedContent.map((item, i) => (
                <li key={i} className="contract-field-list-item">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      {contentBoundaries.prohibitedContent !== undefined &&
        contentBoundaries.prohibitedContent.length > 0 && (
          <div className="contract-field-block">
            <span className="contract-field-label">
              {lock('prohibitedContent') && (
                <span className="contract-lock-marker" aria-label="已锁定">
                  🔒
                </span>
              )}
              {labelFor(FIELD_LABELS, 'prohibitedContent')}
            </span>
            <ul className="contract-field-list">
              {contentBoundaries.prohibitedContent.map((item, i) => (
                <li key={i} className="contract-field-list-item">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      {contentBoundaries.notes !== undefined && contentBoundaries.notes.length > 0 && (
        <div className="contract-field-block">
          <span className="contract-field-label">
            {lock('notes') && (
              <span className="contract-lock-marker" aria-label="已锁定">
                🔒
              </span>
            )}
            {labelFor(FIELD_LABELS, 'notes')}
          </span>
          <p className="contract-field-longtext">{contentBoundaries.notes}</p>
        </div>
      )}
    </GroupSection>
  );
}
