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
    <section className="candidate-view" aria-labelledby="candidate-heading">
      <div className="candidate-header">
        <h4 id="candidate-heading">{candidate.title}</h4>
        <span className="candidate-meta">
          第 {candidate.revisionNo} 版 · {candidateSourceLabel(candidate.source)}
        </span>
      </div>

      <div className="candidate-content">
        {paragraphs.map((paragraph, index) => (
          <p key={`${index}-${paragraph.slice(0, 8)}`}>{paragraph}</p>
        ))}
      </div>

      {critiques.length > 0 && (
        <div className="candidate-critiques">
          <button
            type="button"
            className="btn-link"
            onClick={onToggleCritiques}
            aria-expanded={showCritiques}
          >
            {showCritiques ? '收起自查意见' : `查看自查意见（${issueCount} 条）`}
          </button>
          {showCritiques && (
            <ul className="critique-list">
              {critiques.map((critique) => (
                <li key={critique.dimension} className="critique-item">
                  <div className="critique-head">
                    <span className="critique-dimension">
                      {critiqueDimensionLabel(critique.dimension)}
                    </span>
                    <span className="critique-verdict">
                      {critique.verdict === 'pass' ? '没有阻塞问题' : '建议修改'}
                    </span>
                  </div>
                  <p className="critique-summary">{critique.summary}</p>
                  {critique.issues.length > 0 && (
                    <ul className="critique-issues">
                      {critique.issues.map((issue, index) => (
                        <li key={`${critique.dimension}-${index}`}>
                          <span className="issue-problem">{issue.problem}</span>
                          {issue.excerpt.length > 0 && (
                            <span className="issue-excerpt">原文：{issue.excerpt}</span>
                          )}
                          <span className="issue-suggestion">建议：{issue.suggestion}</span>
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
