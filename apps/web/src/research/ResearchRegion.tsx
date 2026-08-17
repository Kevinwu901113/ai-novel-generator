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
import { InlineError } from '@/components/InlineError';
import { Spinner } from '@/components/Spinner';

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
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-[clamp(16px,5vw,64px)] py-[30px]">
      <div>
        <h2 id="research-heading" className="text-lg">
          资料调研
        </h2>
      </div>

      {/* B18（D-B18-4）：回看横幅按"是否真有调研资料"分文——原文案无条件承诺
          "以下是调研结果"，与跳过调研项目同屏的"调研还没有开始"自相矛盾。 */}
      {showBeyondResearchNotice && (
        <div
          className="max-w-[760px] rounded-lg border border-border bg-secondary px-4 py-3"
          role="status"
        >
          <p>
            {phase.kind === 'ready' || phase.kind === 'stale'
              ? '创作旅程已进入后续阶段。以下是本项目当时的调研结果。'
              : '创作旅程已进入后续阶段。本项目没有留下调研资料。'}
          </p>
        </div>
      )}

      {research.error && <InlineError className="max-w-[760px]">{research.error}</InlineError>}

      {initialLoading ? (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Spinner label={null} size={14} />
          正在加载调研状态…
        </div>
      ) : (
        <>
          {/* B18（D-B18-4）：回看态（已越过调研阶段）改过去时陈述——"还没有开始"
              是未来时，在已进入后续阶段的项目里误导用户以为流程卡在这里。 */}
          {phase.kind === 'no-run' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              {showBeyondResearchNotice ? '本项目没有进行过调研。' : '调研还没有开始。'}
            </div>
          )}

          {phase.kind === 'not-started' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              {showBeyondResearchNotice ? '本项目没有进行过调研。' : '尚未开始调研。'}
            </div>
          )}

          {phase.kind === 'unsettled' && (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <Spinner label={null} size={14} />
              调研状态更新中…
            </div>
          )}

          {phase.kind === 'skipped-none' && (
            <div
              className="max-w-[760px] rounded-lg border border-border bg-secondary px-4 py-3"
              role="status"
            >
              <p>本项目无需调研，将直接进入蓝图阶段。</p>
            </div>
          )}

          {phase.kind === 'key-missing' && (
            <div
              className="max-w-[760px] space-y-1 rounded-lg border border-status-attention/30 bg-status-attention/10 px-4 py-3 text-status-attention"
              role="alert"
            >
              <p>调研任务正在等待中，但还没有配置搜索服务 API Key。</p>
              <p>请在右侧「搜索服务」中配置 Tavily API Key，配置后调研会自动继续。</p>
            </div>
          )}

          {phase.kind === 'running' && (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <Spinner label={null} size={14} />
              正在调研中…
            </div>
          )}

          {phase.kind === 'invalid-retrying' && (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <Spinner label={null} size={14} />
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
                  <div
                    className="max-w-[760px] rounded-md border border-status-attention/30 bg-status-attention/10 px-3.5 py-2.5 text-sm font-semibold text-status-attention"
                    role="status"
                  >
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
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                资料包暂时不可用。
              </div>
            ))}
        </>
      )}
    </div>
  );
}
