/**
 * StoryBlueprint 查看组件（B8）。
 *
 * 展示策略（D-B8-8）：
 * - `ending`（结局方向）**默认折叠**并需显式点开——剧透保护，作者自己也常想先看
 *   前面几节再决定要不要看结局；
 * - `world` / `conflict` / `characters[].description` 超长默认截断可展开
 *   （复用 B6 的截断范式）；
 * - `chapters` 默认只列序号 + 标题，点开单章看 goal，并为 GE-6"从本章发起生成"
 *   预留入口位（本批次只留布局位，不放按钮——按钮无接线就是空承诺）。
 *
 * 失效（stale）时仍完整渲染内容，仅在容器上加标记类：用户必须看到旧内容才能
 * 判断要不要重新生成（D-B8-4）。
 */

import { useState } from 'react';
import type {
  BlueprintCharacterDto,
  BlueprintChapterDto,
  StoryBlueprintDto,
} from '@ai-novel/contracts';

export interface BlueprintViewProps {
  readonly blueprint: StoryBlueprintDto;
  readonly stale: boolean;
}

/** 长文默认截断长度（与 B6 的事实笔记同量级） */
const LONG_TEXT_TRUNCATE_LENGTH = 160;

function LongText({ text, label }: { readonly text: string; readonly label: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncate = text.length > LONG_TEXT_TRUNCATE_LENGTH;
  const shown = expanded || !needsTruncate ? text : `${text.slice(0, LONG_TEXT_TRUNCATE_LENGTH)}…`;
  return (
    <>
      <p className="blueprint-text">{shown}</p>
      {needsTruncate && (
        <button
          type="button"
          className="blueprint-toggle-btn"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? `收起${label}` : `展开${label}`}
        </button>
      )}
    </>
  );
}

function CharacterItem({ character }: { readonly character: BlueprintCharacterDto }) {
  return (
    <li className="blueprint-character">
      <div className="blueprint-character-head">
        <strong className="blueprint-character-name">{character.name}</strong>
        <span className="blueprint-character-role">{character.role}</span>
      </div>
      <LongText text={character.description} label="人物介绍" />
    </li>
  );
}

function ChapterItem({
  chapter,
  index,
}: {
  readonly chapter: BlueprintChapterDto;
  readonly index: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="blueprint-chapter">
      <button
        type="button"
        className="blueprint-chapter-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="blueprint-chapter-index" aria-hidden="true">
          {index + 1}
        </span>
        <span className="blueprint-chapter-title">{chapter.title}</span>
      </button>
      {open && (
        <div className="blueprint-chapter-detail">
          <p className="blueprint-chapter-goal">{chapter.goal}</p>
          {/* GE-6 预留：从本章发起生成的入口位（B10 接线，本批次不放按钮） */}
          <div className="blueprint-chapter-actions" data-reserved-for="GE-6" />
        </div>
      )}
    </li>
  );
}

export function BlueprintView({ blueprint, stale }: BlueprintViewProps) {
  const [endingRevealed, setEndingRevealed] = useState(false);

  return (
    <div
      className={`blueprint-view${stale ? ' blueprint-view-stale' : ''}`}
      data-testid="blueprint-view"
    >
      <div className="blueprint-header">
        <span className="blueprint-version">版本 v{blueprint.version}</span>
      </div>

      <section className="blueprint-section" aria-labelledby="blueprint-premise-heading">
        <h3 id="blueprint-premise-heading">故事前提</h3>
        <p className="blueprint-text">{blueprint.premise}</p>
      </section>

      <section className="blueprint-section" aria-labelledby="blueprint-characters-heading">
        <h3 id="blueprint-characters-heading">人物（{blueprint.characters.length}）</h3>
        {blueprint.characters.length === 0 ? (
          <p className="blueprint-empty">这一版蓝图没有列出人物。</p>
        ) : (
          <ul className="blueprint-character-list">
            {blueprint.characters.map((c, i) => (
              <CharacterItem key={`${c.name}-${i}`} character={c} />
            ))}
          </ul>
        )}
      </section>

      <section className="blueprint-section" aria-labelledby="blueprint-relationships-heading">
        <h3 id="blueprint-relationships-heading">人物关系</h3>
        {blueprint.relationships.length === 0 ? (
          <p className="blueprint-empty">这一版蓝图没有列出人物关系。</p>
        ) : (
          <ul className="blueprint-relationship-list">
            {blueprint.relationships.map((r, i) => (
              <li key={`${r}-${i}`}>{r}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="blueprint-section" aria-labelledby="blueprint-world-heading">
        <h3 id="blueprint-world-heading">世界设定</h3>
        <LongText text={blueprint.world} label="世界设定" />
      </section>

      <section className="blueprint-section" aria-labelledby="blueprint-conflict-heading">
        <h3 id="blueprint-conflict-heading">核心冲突</h3>
        <LongText text={blueprint.conflict} label="核心冲突" />
      </section>

      <section className="blueprint-section" aria-labelledby="blueprint-plotlines-heading">
        <h3 id="blueprint-plotlines-heading">情节线（{blueprint.plotlines.length}）</h3>
        {blueprint.plotlines.length === 0 ? (
          <p className="blueprint-empty">这一版蓝图没有列出情节线。</p>
        ) : (
          <ul className="blueprint-plotline-list">
            {blueprint.plotlines.map((p, i) => (
              <li key={`${p.name}-${i}`}>
                <strong className="blueprint-plotline-name">{p.name}</strong>
                <span className="blueprint-plotline-summary">{p.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="blueprint-section" aria-labelledby="blueprint-chapters-heading">
        <h3 id="blueprint-chapters-heading">章节结构（{blueprint.chapters.length} 章）</h3>
        {blueprint.chapters.length === 0 ? (
          <p className="blueprint-empty">这一版蓝图没有章节结构。</p>
        ) : (
          <ol className="blueprint-chapter-list">
            {blueprint.chapters.map((c, i) => (
              <ChapterItem key={c.id} chapter={c} index={i} />
            ))}
          </ol>
        )}
      </section>

      {/* D-B8-8：结局方向默认折叠（剧透保护），需显式点开 */}
      <section className="blueprint-section" aria-labelledby="blueprint-ending-heading">
        <h3 id="blueprint-ending-heading">结局方向</h3>
        {endingRevealed ? (
          <>
            <p className="blueprint-text">{blueprint.ending}</p>
            <button
              type="button"
              className="blueprint-toggle-btn"
              onClick={() => setEndingRevealed(false)}
              aria-expanded={true}
            >
              收起结局方向
            </button>
          </>
        ) : (
          <>
            <p className="blueprint-ending-hidden">结局方向已折叠，点开会看到故事怎么收尾。</p>
            <button
              type="button"
              className="blueprint-toggle-btn"
              onClick={() => setEndingRevealed(true)}
              aria-expanded={false}
            >
              查看结局方向
            </button>
          </>
        )}
      </section>
    </div>
  );
}
