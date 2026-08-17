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
import { HelpCircle, Link2, NotebookPen } from 'lucide-react';
import type {
  FactNoteDto,
  ResearchBundleDto,
  ResearchQuestionDto,
  ResearchSourceRecordDto,
} from '@ai-novel/contracts';
import { depthLabel, orderBundleChain } from './research-logic';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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

function formatBundleTimestamp(createdAt: string): string {
  const utc = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(createdAt);
  return utc ? `${utc[1]} ${utc[2]} UTC` : createdAt;
}

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
  const versionCounts = new Map<number, number>();
  for (const item of chain) {
    versionCounts.set(item.version, (versionCounts.get(item.version) ?? 0) + 1);
  }
  const hasDuplicateVersion = (version: number) => (versionCounts.get(version) ?? 0) > 1;

  return (
    <div
      className={cn(
        'flex w-full max-w-[820px] flex-col gap-4',
        stale &&
          'research-bundle-view-stale rounded-lg border border-dashed border-status-attention/40 p-3',
      )}
      data-testid="research-bundle-view"
    >
      <div className="flex items-center gap-2.5">
        {/* 复查随行修复：强度徽标必须跟随正在查看的版本（displayed），而不是
            始终锁定当前 bundle——否则切到历史版本时，版本号/问题/笔记/结论都
            换了，唯独强度徽标原地不动，造成"这版是什么强度"的错误印象。 */}
        <span
          className="inline-flex items-center rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground"
          data-depth={displayed.depth}
        >
          {depthLabel(displayed.depth)}
        </span>
        <span className="text-xs text-muted-foreground">
          版本 v{displayed.version}
          {hasDuplicateVersion(displayed.version) &&
            ` · ${formatBundleTimestamp(displayed.createdAt)}`}
          {!isViewingCurrent && '（历史版本）'}
        </span>
      </div>

      {chain.length > 1 && (
        <nav aria-label="资料包版本历史">
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {chain.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  className={cn(
                    'rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground',
                    b.id === displayed.id && 'border-primary bg-primary text-primary-foreground',
                  )}
                  aria-current={b.id === displayed.id ? 'true' : undefined}
                  onClick={() => setViewingId(b.id === bundle.id ? null : b.id)}
                >
                  v{b.version}
                  {hasDuplicateVersion(b.version) && ` · ${formatBundleTimestamp(b.createdAt)}`}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {!isViewingCurrent && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          正在查看历史版本 v{displayed.version}
          {hasDuplicateVersion(displayed.version) &&
            ` · ${formatBundleTimestamp(displayed.createdAt)}`}
          。
          <button
            type="button"
            className="border-none bg-transparent p-0 font-[inherit] text-primary underline"
            onClick={() => setViewingId(null)}
          >
            回到当前版本 v{bundle.version}
          </button>
        </p>
      )}

      <section aria-labelledby="research-questions-heading">
        <h3 id="research-questions-heading" className="mb-1.5 text-sm">
          调研问题
        </h3>
        {displayed.questions.length === 0 ? (
          <EmptyState
            icon={HelpCircle}
            message="暂无调研问题"
            hint="调研完成后会显示在这里。"
            className="items-start py-4 text-left"
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
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
        <h3 id="research-fact-notes-heading" className="mb-1.5 text-sm">
          事实笔记
        </h3>
        {displayed.factNotes.length === 0 ? (
          <EmptyState
            icon={NotebookPen}
            message="暂无事实笔记"
            hint="调研完成后会显示在这里。"
            className="items-start py-4 text-left"
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {displayed.factNotes.map((note) => (
              <FactNoteItem key={note.id} note={note} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="research-conclusion-heading">
        <h3 id="research-conclusion-heading" className="mb-1.5 text-sm">
          结论
        </h3>
        <p className="leading-relaxed whitespace-pre-wrap">{displayed.conclusion || '暂无结论'}</p>
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
    <li className="rounded-lg border border-border bg-card p-3">
      <p className="mb-1.5 font-medium">{question.text}</p>
      <button
        type="button"
        className="rounded border border-border bg-transparent px-2 py-0.5 text-xs text-foreground hover:border-primary"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? '收起来源' : `展开来源（${question.sources.length}）`}
      </button>
      {expanded && (
        <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
          {question.sources.length === 0 ? (
            <EmptyState icon={Link2} message="暂无来源" className="items-start py-2 text-left" />
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
    <li
      className={cn(
        'flex items-start justify-between gap-2.5 rounded-md border border-border bg-background p-2.5',
        excluded && 'opacity-65',
      )}
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
          {source.title || source.url}
          {excluded && (
            <span
              role="status"
              className="rounded-full bg-destructive px-1.5 py-px text-[11px] text-destructive-foreground"
            >
              已排除
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs break-all text-muted-foreground">{source.url}</p>
        {source.excerpt && <p className="mt-1 text-xs text-muted-foreground">{source.excerpt}</p>}
      </div>
      <Button
        type="button"
        size="sm"
        variant={excluded ? 'destructive' : 'outline'}
        className="shrink-0"
        aria-pressed={excluded}
        disabled={busy}
        onClick={() => void onToggleExclusion(source.url, !excluded)}
      >
        {excluded ? '取消排除' : '排除此来源'}
      </Button>
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
    <li className="rounded-lg border border-border bg-card p-3">
      <p className="mb-1.5 whitespace-pre-wrap">{displayText}</p>
      {isLong && (
        <button
          type="button"
          className="rounded border border-border bg-transparent px-2 py-0.5 text-xs text-foreground hover:border-primary"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
      {note.sourceUrls.length > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">来源：{note.sourceUrls.join('、')}</p>
      )}
    </li>
  );
}
