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
import { cn } from '@/lib/utils';

export interface BlueprintViewProps {
  readonly blueprint: StoryBlueprintDto;
  readonly stale: boolean;
}

/** 长文默认截断长度（与 B6 的事实笔记同量级） */
const LONG_TEXT_TRUNCATE_LENGTH = 160;

const toggleBtnClass = 'mt-1 border-none bg-transparent p-0 font-[inherit] text-xs text-primary';

function LongText({ text, label }: { readonly text: string; readonly label: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncate = text.length > LONG_TEXT_TRUNCATE_LENGTH;
  const shown = expanded || !needsTruncate ? text : `${text.slice(0, LONG_TEXT_TRUNCATE_LENGTH)}…`;
  return (
    <>
      <p className="text-sm leading-relaxed whitespace-pre-wrap">{shown}</p>
      {needsTruncate && (
        <button
          type="button"
          className={toggleBtnClass}
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
    <li className="rounded-md border border-border bg-card px-3 py-2">
      <div className="flex items-baseline gap-2">
        <strong>{character.name}</strong>
        <span className="text-xs text-muted-foreground">{character.role}</span>
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
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md border border-transparent px-2.5 py-1.5 text-left text-[13px] text-foreground hover:border-border hover:bg-secondary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="min-w-6 text-xs text-muted-foreground" aria-hidden="true">
          {index + 1}
        </span>
        <span>{chapter.title}</span>
      </button>
      {open && (
        <div className="py-1 pr-2.5 pl-[42px]">
          <p className="text-[13px] leading-relaxed text-muted-foreground">{chapter.goal}</p>
          {/* GE-6 预留：从本章发起生成的入口位（B10 接线，本批次不放按钮） */}
          <div data-reserved-for="GE-6" />
        </div>
      )}
    </li>
  );
}

export function BlueprintView({ blueprint, stale }: BlueprintViewProps) {
  const [endingRevealed, setEndingRevealed] = useState(false);

  return (
    <div
      className={cn('flex w-full max-w-[820px] flex-col gap-4', stale && 'opacity-75')}
      data-testid="blueprint-view"
    >
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          版本 v{blueprint.version}
        </span>
      </div>

      <section aria-labelledby="blueprint-premise-heading">
        <h3 id="blueprint-premise-heading" className="mb-1.5 text-sm">
          故事前提
        </h3>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{blueprint.premise}</p>
      </section>

      <section aria-labelledby="blueprint-characters-heading">
        <h3 id="blueprint-characters-heading" className="mb-1.5 text-sm">
          人物（{blueprint.characters.length}）
        </h3>
        {blueprint.characters.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">这一版蓝图没有列出人物。</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {blueprint.characters.map((c, i) => (
              <CharacterItem key={`${c.name}-${i}`} character={c} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="blueprint-relationships-heading">
        <h3 id="blueprint-relationships-heading" className="mb-1.5 text-sm">
          人物关系
        </h3>
        {blueprint.relationships.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">这一版蓝图没有列出人物关系。</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {blueprint.relationships.map((r, i) => (
              <li key={`${r}-${i}`} className="text-[13px] leading-relaxed">
                {r}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="blueprint-world-heading">
        <h3 id="blueprint-world-heading" className="mb-1.5 text-sm">
          世界设定
        </h3>
        <LongText text={blueprint.world} label="世界设定" />
      </section>

      <section aria-labelledby="blueprint-conflict-heading">
        <h3 id="blueprint-conflict-heading" className="mb-1.5 text-sm">
          核心冲突
        </h3>
        <LongText text={blueprint.conflict} label="核心冲突" />
      </section>

      <section aria-labelledby="blueprint-plotlines-heading">
        <h3 id="blueprint-plotlines-heading" className="mb-1.5 text-sm">
          情节线（{blueprint.plotlines.length}）
        </h3>
        {blueprint.plotlines.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">这一版蓝图没有列出情节线。</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {blueprint.plotlines.map((p, i) => (
              <li key={`${p.name}-${i}`} className="text-[13px] leading-relaxed">
                <strong className="mr-2">{p.name}</strong>
                <span className="text-muted-foreground">{p.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="blueprint-chapters-heading">
        <h3 id="blueprint-chapters-heading" className="mb-1.5 text-sm">
          章节结构（{blueprint.chapters.length} 章）
        </h3>
        {blueprint.chapters.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">这一版蓝图没有章节结构。</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {blueprint.chapters.map((c, i) => (
              <ChapterItem key={c.id} chapter={c} index={i} />
            ))}
          </ol>
        )}
      </section>

      {/* D-B8-8：结局方向默认折叠（剧透保护），需显式点开 */}
      <section aria-labelledby="blueprint-ending-heading">
        <h3 id="blueprint-ending-heading" className="mb-1.5 text-sm">
          结局方向
        </h3>
        {endingRevealed ? (
          <>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{blueprint.ending}</p>
            <button
              type="button"
              className={toggleBtnClass}
              onClick={() => setEndingRevealed(false)}
              aria-expanded={true}
            >
              收起结局方向
            </button>
          </>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground italic">
              结局方向已折叠，点开会看到故事怎么收尾。
            </p>
            <button
              type="button"
              className={toggleBtnClass}
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
