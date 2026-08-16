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
 * - escalation：ResearchEscalationPanel 五选项人工决策；
 * - unsettled（复查随行修复）：RESEARCH_RUN 任务已 FAILED 但节点尚未 settle 的
 *   瞬时窗口，兜底文案避免误报"尚未开始调研"（deriveResearchPhase 第 4 参数
 *   hasFailedResearchTask）。
 *
 * frontierStage 经 useResearch 内部对 graph 进度的读取回报给 App（D-B6-7/
 * D-B6-10：RESEARCH_ESCALATION 的多数出口、以及调研完成后 frontier 前进到
 * blueprint，都会让 frontier 离开 research 阶段；App 据此换回 IntakeRegion，
 * 除非 deriveViewStage 判定应回落展示 research——此时 showBeyondResearchNotice
 * 为 true，本 Region 继续挂载并给出说明）。
 */

import { useResearch } from './useResearch';
import { ResearchBundleView } from './ResearchBundleView';
import { ResearchEscalationPanel } from './ResearchEscalationPanel';

export interface ResearchRegionProps {
  readonly projectId: string;
  /**
   * frontier 已越过 research（当前为 blueprint/manuscript）但仍在展示调研内容
   * 时为 true——由 App 据 journey-logic.deriveViewStage 的回落规则计算
   * （D-B6-10）。顶部给出明确说明，避免用户以为流程卡住。
   */
  readonly showBeyondResearchNotice?: boolean;
  /**
   * TD-030-4：人工决策落地后的 App 侧收尾（解除视图锁定 + 刷新探针），
   * 语义与 BlueprintRegion 的 onRefresh 相同。
   */
  readonly onDecisionSettled?: () => void | Promise<void>;
}

export function ResearchRegion({
  projectId,
  showBeyondResearchNotice = false,
  onDecisionSettled,
}: ResearchRegionProps) {
  // D-B8-2：本 Region 不再回报旅程阶段（原 onStageChange）——阶段派生已上提到
  // App 的旅程探针（journey/useJourney）。
  const research = useResearch(projectId, onDecisionSettled);
  const { phase } = research;

  const initialLoading = research.loading && research.state === null;

  return (
    <div className="research-region">
      <div className="research-header">
        <h2 id="research-heading">资料调研</h2>
      </div>

      {showBeyondResearchNotice && (
        <div className="research-info-card" role="status">
          <p>创作旅程已进入后续阶段。以下是本项目当前的调研结果。</p>
        </div>
      )}

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

          {phase.kind === 'unsettled' && (
            <div className="research-status" role="status" aria-live="polite">
              <span className="intake-spinner" aria-hidden="true">
                ⟳
              </span>
              调研状态更新中…
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
