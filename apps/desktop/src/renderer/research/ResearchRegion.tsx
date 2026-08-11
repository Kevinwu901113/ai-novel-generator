/**
 * Web Research 旅程区域（B6 中栏主体，research 阶段）。
 *
 * 相位驱动（research-logic.deriveResearchPhase）：
 * - no-run / not-started：区分"还没有 run"与"run 存在但决策未产出"（尚未调研）；
 * - skipped-none：本项目无需调研（说明卡，非空态，D-B6-4）；
 * - running：调研执行中；
 * - key-missing：任务在等待，但缺搜索服务 key（内联引导，D-B6-5）；
 * - stale：现行 bundleRef 已因创作要求变更失效，作废横幅 + 降级展示（D-B6-9）；
 * - ready：展示 ResearchBundleView；
 * - invalid-retrying：校验未通过，自动重试中；
 * - escalation：ResearchEscalationPanel 五选项人工决策。
 *
 * journeyStage 经 useResearch 内部对 graph 进度的读取回报给 App（D-B6-7：
 * RESEARCH_ESCALATION 的多数出口会让 frontier 离开 research 阶段，此时
 * App 换回 IntakeRegion）。
 */

import { useResearch } from './useResearch';
import { ResearchBundleView } from './ResearchBundleView';
import { ResearchEscalationPanel } from './ResearchEscalationPanel';
import type { JourneyStage } from '../intake/intake-logic';

export interface ResearchRegionProps {
  readonly projectId: string;
  /** 旅程阶段回报（App shell 导航高亮 + Region 互斥挂载，D-B6-7） */
  readonly onStageChange?: (stage: JourneyStage) => void;
}

export function ResearchRegion({ projectId, onStageChange }: ResearchRegionProps) {
  // App 只在 journeyStage 已经是 'research' 时才挂载本 Region（互斥挂载），
  // 故不需要额外的挂载即回报——useResearch 的轮询会在首轮 poll 内确认/回退。
  const research = useResearch(projectId, onStageChange);
  const { phase } = research;

  const initialLoading = research.loading && research.state === null;

  return (
    <div className="research-region">
      <div className="research-header">
        <h2 id="research-heading">资料调研</h2>
      </div>

      {research.error && (
        <div className="research-error" role="alert">
          {research.error}
        </div>
      )}

      {initialLoading ? (
        <div className="research-status" role="status" aria-live="polite">
          <span className="intake-spinner" aria-hidden="true">
            ⟳
          </span>
          正在加载调研状态…
        </div>
      ) : (
        <>
          {phase.kind === 'no-run' && (
            <div className="research-status" role="status">
              调研还没有开始。
            </div>
          )}

          {phase.kind === 'not-started' && (
            <div className="research-status" role="status">
              尚未开始调研。
            </div>
          )}

          {phase.kind === 'skipped-none' && (
            <div className="research-info-card" role="status">
              <p>本项目无需调研，将直接进入蓝图阶段。</p>
            </div>
          )}

          {phase.kind === 'key-missing' && (
            <div className="research-key-missing" role="alert">
              <p>调研任务正在等待中，但还没有配置搜索服务 API Key。</p>
              <p>请在右侧「搜索服务」中配置 Tavily API Key，配置后调研会自动继续。</p>
            </div>
          )}

          {phase.kind === 'running' && (
            <div className="research-status" role="status" aria-live="polite">
              <span className="intake-spinner" aria-hidden="true">
                ⟳
              </span>
              正在调研中…
            </div>
          )}

          {phase.kind === 'invalid-retrying' && (
            <div className="research-status" role="status" aria-live="polite">
              <span className="intake-spinner" aria-hidden="true">
                ⟳
              </span>
              调研结果未通过校验，正在自动重试
              {research.state && research.state.researchRetryUsed > 0
                ? `（已重试 ${research.state.researchRetryUsed} 次）`
                : ''}
              …
            </div>
          )}

          {phase.kind === 'escalation' && (
            <ResearchEscalationPanel
              busy={research.busy}
              onChoose={research.actions.chooseEscalation}
            />
          )}

          {(phase.kind === 'stale' || phase.kind === 'ready') &&
            (research.bundle ? (
              <>
                {phase.kind === 'stale' && (
                  <div className="research-stale-banner" role="status">
                    此资料包已作废（创作要求已变更），将重新调研
                  </div>
                )}
                <ResearchBundleView
                  bundle={research.bundle}
                  bundles={research.bundles}
                  stale={phase.kind === 'stale'}
                  exclusions={research.exclusions}
                  busy={research.busy}
                  onToggleExclusion={research.actions.setSourceExclusion}
                />
              </>
            ) : (
              <div className="research-status" role="status">
                资料包暂时不可用。
              </div>
            ))}
        </>
      )}
    </div>
  );
}
