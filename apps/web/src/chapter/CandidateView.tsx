/**
 * 候选正文查看（B10）。
 *
 * 正文按段落渲染（模型输出以换行分段）；自查意见默认折叠——一章三个维度最多 60 条
 * 问题，铺开会把正文挤出首屏，而用户第一需求是读正文。
 */

import type { ChapterCandidateDto, ChapterCritiqueDto } from '@ai-novel/contracts';
import { candidateSourceLabel, critiqueDimensionLabel } from './chapter-logic';

export interface CandidateViewProps {
  readonly candidate: ChapterCandidateDto;
  readonly critiques: ReadonlyArray<ChapterCritiqueDto>;
  readonly showCritiques: boolean;
  readonly onToggleCritiques: () => void;
}

export function CandidateView({
  candidate,
  critiques,
  showCritiques,
  onToggleCritiques,
}: CandidateViewProps) {
  const paragraphs = candidate.content.split('\n').filter((line) => line.trim().length > 0);
  const issueCount = critiques.reduce((sum, c) => sum + c.issues.length, 0);

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-border bg-secondary px-4 py-3.5"
      aria-labelledby="candidate-heading"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h4 id="candidate-heading" className="text-[15px]">
          {candidate.title}
        </h4>
        <span className="text-xs text-muted-foreground">
          第 {candidate.revisionNo} 版 · {candidateSourceLabel(candidate.source)}
        </span>
      </div>

      {/* B18（D-B18-1）：正文排版走 .reading-prose 权威（行宽 40em/17px/1.9），
          不再由 820px 布局容器兜底行宽。 */}
      <div className="reading-prose">
        {paragraphs.map((paragraph, index) => (
          <p key={`${index}-${paragraph.slice(0, 8)}`} className="mb-3">
            {paragraph}
          </p>
        ))}
      </div>

      {critiques.length > 0 && (
        <div>
          <button
            type="button"
            className="border-none bg-transparent p-0 font-[inherit] text-sm text-primary"
            onClick={onToggleCritiques}
            aria-expanded={showCritiques}
          >
            {showCritiques
              ? '收起自查结果'
              : `查看自查结果（${critiques.length} 项，${issueCount} 条问题）`}
          </button>
          {showCritiques && (
            <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
              {critiques.map((critique) => (
                <li key={critique.dimension} className="rounded-md border border-border px-3 py-2">
                  <div className="flex items-baseline gap-2.5 text-[13px]">
                    <span className="font-semibold">
                      {critiqueDimensionLabel(critique.dimension)}
                    </span>
                    <span>{critique.verdict === 'pass' ? '没有阻塞问题' : '建议修改'}</span>
                  </div>
                  <p className="my-1 text-[13px] text-muted-foreground">{critique.summary}</p>
                  {critique.issues.length > 0 && (
                    <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                      {critique.issues.map((issue, index) => (
                        <li
                          key={`${critique.dimension}-${index}`}
                          className="flex flex-col gap-0.5 text-[13px]"
                        >
                          <span>{issue.problem}</span>
                          {issue.excerpt.length > 0 && (
                            <span className="text-muted-foreground">原文：{issue.excerpt}</span>
                          )}
                          <span className="text-muted-foreground">建议：{issue.suggestion}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
