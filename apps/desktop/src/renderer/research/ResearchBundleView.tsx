/**
 * ResearchBundle 查看组件（B6）。
 *
 * - 强度徽标（depthLabel）；
 * - 问题列表：每题下挂来源，来源列表默认折叠（避免长列表刷屏）；
 * - 事实笔记：text 可能是多篇 2000 字拼接的长文，默认截断，可展开看全文；
 * - 结论；
 * - 版本链切换：多 bundle 时用 orderBundleChain 排序，可切看历史版本
 *   （来源排除是 project 级设置，不论查看哪个版本都可操作，D-B6-2）；
 * - 每条来源一个"排除"开关，用 useResearch 返回的最新排除列表更新标记，
 *   被排除的来源视觉上明确标记（不仅靠颜色——附文字徽标"已排除"）。
 *
 * 不做外链跳转（渲染进程无 target=_blank/shell.openExternal 处理约定，
 * 来源 URL 以纯文本展示，不做可点击 <a>）。
 */

import { useState } from 'react';
import type {
  FactNoteDto,
  ResearchBundleDto,
  ResearchQuestionDto,
  ResearchSourceRecordDto,
} from '@ai-novel/contracts';
import { depthLabel, orderBundleChain } from './research-logic';

export interface ResearchBundleViewProps {
  readonly bundle: ResearchBundleDto;
  readonly bundles: ReadonlyArray<ResearchBundleDto>;
  readonly stale: boolean;
  readonly exclusions: ReadonlyArray<string>;
  readonly busy: boolean;
  readonly onToggleExclusion: (url: string, excluded: boolean) => Promise<void> | void;
}

/** 事实笔记默认截断长度（多篇 2000 字拼接的长文必须默认折叠） */
const FACT_NOTE_TRUNCATE_LENGTH = 160;

export function ResearchBundleView({
  bundle,
  bundles,
  stale,
  exclusions,
  busy,
  onToggleExclusion,
}: ResearchBundleViewProps) {
  const [viewingId, setViewingId] = useState<string | null>(null);
  const chain = orderBundleChain(bundles.length > 0 ? bundles : [bundle]);
  const displayed = (viewingId && bundles.find((b) => b.id === viewingId)) || bundle;
  const isViewingCurrent = displayed.id === bundle.id;
  const exclusionSet = new Set(exclusions);

  return (
    <div
      className={`research-bundle-view${stale ? ' research-bundle-view-stale' : ''}`}
      data-testid="research-bundle-view"
    >
      <div className="research-bundle-header">
        {/* 复查随行修复：强度徽标必须跟随正在查看的版本（displayed），而不是
            始终锁定当前 bundle——否则切到历史版本时，版本号/问题/笔记/结论都
            换了，唯独强度徽标原地不动，造成"这版是什么强度"的错误印象。 */}
        <span className="research-depth-badge" data-depth={displayed.depth}>
          {depthLabel(displayed.depth)}
        </span>
        <span className="research-bundle-version">
          版本 v{displayed.version}
          {!isViewingCurrent && '（历史版本）'}
        </span>
      </div>

      {chain.length > 1 && (
        <nav className="research-version-chain" aria-label="资料包版本历史">
          <ul>
            {chain.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  className={`research-version-btn${b.id === displayed.id ? ' current' : ''}`}
                  aria-current={b.id === displayed.id ? 'true' : undefined}
                  onClick={() => setViewingId(b.id === bundle.id ? null : b.id)}
                >
                  v{b.version}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {!isViewingCurrent && (
        <p className="research-version-notice" role="status">
          正在查看历史版本 v{displayed.version}。
          <button
            type="button"
            className="research-version-back"
            onClick={() => setViewingId(null)}
          >
            回到当前版本 v{bundle.version}
          </button>
        </p>
      )}

      <section aria-labelledby="research-questions-heading">
        <h3 id="research-questions-heading">调研问题</h3>
        {displayed.questions.length === 0 ? (
          <p className="research-empty-hint">暂无调研问题</p>
        ) : (
          <ul className="research-question-list">
            {displayed.questions.map((q) => (
              <QuestionItem
                key={q.id}
                question={q}
                exclusionSet={exclusionSet}
                busy={busy}
                onToggleExclusion={onToggleExclusion}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="research-fact-notes-heading">
        <h3 id="research-fact-notes-heading">事实笔记</h3>
        {displayed.factNotes.length === 0 ? (
          <p className="research-empty-hint">暂无事实笔记</p>
        ) : (
          <ul className="research-fact-note-list">
            {displayed.factNotes.map((note) => (
              <FactNoteItem key={note.id} note={note} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="research-conclusion-heading">
        <h3 id="research-conclusion-heading">结论</h3>
        <p className="research-conclusion">{displayed.conclusion || '暂无结论'}</p>
      </section>
    </div>
  );
}

// ── 调研问题 + 来源（默认折叠） ───────────────────────────────────

interface QuestionItemProps {
  readonly question: ResearchQuestionDto;
  readonly exclusionSet: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onToggleExclusion: (url: string, excluded: boolean) => Promise<void> | void;
}

function QuestionItem({ question, exclusionSet, busy, onToggleExclusion }: QuestionItemProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="research-question">
      <p className="research-question-text">{question.text}</p>
      <button
        type="button"
        className="research-question-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? '收起来源' : `展开来源（${question.sources.length}）`}
      </button>
      {expanded && (
        <ul className="research-source-list">
          {question.sources.length === 0 ? (
            <li className="research-empty-hint">暂无来源</li>
          ) : (
            question.sources.map((source) => (
              <SourceItem
                key={source.url}
                source={source}
                excluded={exclusionSet.has(source.url)}
                busy={busy}
                onToggleExclusion={onToggleExclusion}
              />
            ))
          )}
        </ul>
      )}
    </li>
  );
}

// ── 单条来源 + 排除开关 ───────────────────────────────────────────

interface SourceItemProps {
  readonly source: ResearchSourceRecordDto;
  readonly excluded: boolean;
  readonly busy: boolean;
  readonly onToggleExclusion: (url: string, excluded: boolean) => Promise<void> | void;
}

function SourceItem({ source, excluded, busy, onToggleExclusion }: SourceItemProps) {
  return (
    <li className={`research-source${excluded ? ' research-source-excluded' : ''}`}>
      <div className="research-source-info">
        <p className="research-source-title">
          {source.title || source.url}
          {excluded && (
            <span className="research-source-excluded-badge" role="status">
              已排除
            </span>
          )}
        </p>
        <p className="research-source-url">{source.url}</p>
        {source.excerpt && <p className="research-source-excerpt">{source.excerpt}</p>}
      </div>
      <button
        type="button"
        className="research-source-exclude-btn"
        aria-pressed={excluded}
        disabled={busy}
        onClick={() => void onToggleExclusion(source.url, !excluded)}
      >
        {excluded ? '取消排除' : '排除此来源'}
      </button>
    </li>
  );
}

// ── 事实笔记（默认截断，可展开全文） ───────────────────────────────

function FactNoteItem({ note }: { note: FactNoteDto }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = note.text.length > FACT_NOTE_TRUNCATE_LENGTH;
  const displayText =
    expanded || !isLong ? note.text : `${note.text.slice(0, FACT_NOTE_TRUNCATE_LENGTH)}…`;

  return (
    <li className="research-fact-note">
      <p className="research-fact-note-text">{displayText}</p>
      {isLong && (
        <button
          type="button"
          className="research-fact-note-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
      {note.sourceUrls.length > 0 && (
        <p className="research-fact-note-sources">来源：{note.sourceUrls.join('、')}</p>
      )}
    </li>
  );
}
