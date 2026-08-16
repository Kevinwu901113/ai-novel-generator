/**
 * StoryBlueprint 旅程区域（B8 中栏主体，blueprint 阶段）。
 *
 * 相位驱动（blueprint-logic.deriveBlueprintPhase）：
 * - no-run / not-started：还没有 run，或蓝图尚未产出；
 * - generating：BLUEPRINT_GENERATE 节点在跑；
 * - stale：现行蓝图已因创作要求变更失效——失效横幅 + 降级展示旧内容 +
 *   **禁用接受**（D-B8-4）；
 * - gate：BlueprintView + BlueprintGatePanel（accept / request_rewrite）；
 * - escalation：BlueprintEscalationPanel 四选项 + 同屏展示待决策的那一版正文
 *   （第一条选项就是"就用现在这版蓝图"）；
 * - ready：BlueprintView + ProjectReadyPanel（项目就绪）；
 * - terminal：run 已终态但蓝图未被接受（blocked/cancelled）——若当时已生成过一版，
 *   终态说明之外仍只读展示那一版内容。
 *
 * D-B8-2：本 Region **不回报阶段**——蓝图态与 run 位置由 App 的旅程探针
 * （useJourney）统一读取并以 props 下发，Region 只渲染与拉自己的正文
 * （D-B8-5：正文仅在 blueprintRef 变化时拉一次）。
 */

import type { BlueprintStateDto, RunTerminalStatusDto } from '@ai-novel/contracts';
import { useBlueprint } from './useBlueprint';
import { BlueprintView } from './BlueprintView';
import { BlueprintGatePanel } from './BlueprintGatePanel';
import { BlueprintEscalationPanel } from './BlueprintEscalationPanel';
import { ProjectReadyPanel } from './ProjectReadyPanel';
import {
  deriveBlueprintPhase,
  showsBlueprintContent,
  terminalStatusLabel,
} from './blueprint-logic';

export interface BlueprintRegionProps {
  readonly projectId: string;
  /** 蓝图态（App 探针下发；null 表示尚未取到） */
  readonly state: BlueprintStateDto | null;
  /** 当前 project run 的终态（非终态为 null） */
  readonly terminalStatus: RunTerminalStatusDto | null;
  /** BLUEPRINT_GENERATE 节点是否 active（App 由 progress 投影计算） */
  readonly generating: boolean;
  /** 探针首轮尚未返回 */
  readonly stateLoading: boolean;
  /**
   * 人工决策落地后的收尾（App 侧：解除用户视图锁定 + 立即刷新探针）。
   * 返回的 promise 须在探针新状态落地后才 resolve——useBlueprint 用它护航 busy，
   * 防止按钮以旧态提前重新可点（B8 独立复查）。
   */
  readonly onRefresh: () => void | Promise<void>;
}

export function BlueprintRegion({
  projectId,
  state,
  terminalStatus,
  generating,
  stateLoading,
  onRefresh,
}: BlueprintRegionProps) {
  const phase = deriveBlueprintPhase(state, terminalStatus, generating);
  const blueprintRef = showsBlueprintContent(phase) ? (state?.blueprintRef ?? null) : null;
  const blueprint = useBlueprint(projectId, blueprintRef, state?.runId ?? null, onRefresh);

  const initialLoading = stateLoading && state === null;
  const stale = phase.kind === 'stale';

  return (
    <div className="blueprint-region">
      <div className="blueprint-region-header">
        <h2 id="blueprint-heading">故事蓝图</h2>
      </div>

      {blueprint.error && (
        <div className="blueprint-error" role="alert">
          <span>{blueprint.error}</span>
          {/* 正文只在 blueprintRef 变化时拉一次，瞬时故障后必须有重试入口——
              否则 gate 确认按钮（藏在内容真值分支内）在当前屏永远不可达
              （B8 独立复查）。 */}
          <button
            type="button"
            className="btn-retry-inline"
            onClick={blueprint.actions.retryFetch}
            disabled={blueprint.loading}
          >
            重试
          </button>
        </div>
      )}

      {initialLoading ? (
        <div className="blueprint-status" role="status" aria-live="polite">
          <span className="intake-spinner" aria-hidden="true">
            ⟳
          </span>
          正在加载蓝图状态…
        </div>
      ) : (
        <>
          {phase.kind === 'no-run' && (
            <div className="blueprint-status" role="status">
              创作旅程还没有开始。
            </div>
          )}

          {phase.kind === 'not-started' && (
            <div className="blueprint-status" role="status">
              蓝图还没有生成，请先完成前面的阶段。
            </div>
          )}

          {phase.kind === 'generating' && (
            <div className="blueprint-status" role="status" aria-live="polite">
              <span className="intake-spinner" aria-hidden="true">
                ⟳
              </span>
              正在生成故事蓝图…
            </div>
          )}

          {phase.kind === 'terminal' && (
            <div className="blueprint-info-card" role="status">
              <p>{terminalStatusLabel(phase.status)}</p>
              <p>
                {phase.blueprintRef !== null
                  ? '这次流程结束时蓝图还没有被确认，以下是当时生成的那一版。'
                  : '这次流程结束时蓝图还没有生成。'}
              </p>
              {phase.status !== 'completed' && (
                /* 如实的继续指引（B8 独立复查）：blocked/cancelled 是终态，没有
                   原地恢复的界面——继续的唯一出路是回"想法"阶段重新开始流程。 */
                <p>如需继续这个项目，请回到"想法"阶段重新开始创作流程。</p>
              )}
            </div>
          )}

          {stale && (
            <div className="blueprint-stale-banner" role="status">
              此蓝图已作废（创作要求已变更），需要重新生成后才能确认
            </div>
          )}

          {phase.kind === 'escalation' && (
            <>
              {blueprint.decisionError && (
                <div className="blueprint-error" role="alert">
                  {blueprint.decisionError}
                </div>
              )}
              <BlueprintEscalationPanel
                busy={blueprint.busy}
                invalidated={state?.blueprintInvalidated ?? false}
                contentUnavailable={blueprint.blueprint === null}
                onChoose={blueprint.actions.chooseEscalation}
              />
            </>
          )}

          {showsBlueprintContent(phase) &&
            (blueprint.blueprint ? (
              <>
                {phase.kind === 'ready' && (
                  <ProjectReadyPanel chapterCount={blueprint.blueprint.chapters.length} />
                )}
                <BlueprintView blueprint={blueprint.blueprint} stale={stale} />
                {/* 只有 gate 真的在等人工时才给决策按钮——stale 也可能出现在
                    非 gate 态（如等待重新生成），那时提交 gate 决策必然被后端拒。 */}
                {state?.gateActive === true ? (
                  <>
                    {blueprint.decisionError && (
                      <div className="blueprint-error" role="alert">
                        {blueprint.decisionError}
                      </div>
                    )}
                    <BlueprintGatePanel
                      busy={blueprint.busy}
                      invalidated={state?.blueprintInvalidated ?? false}
                      rewriteUsed={state?.rewriteUsed ?? 0}
                      onChoose={blueprint.actions.chooseGate}
                    />
                  </>
                ) : (
                  phase.kind === 'gate' && (
                    /* P9 兜底展示窗口（如 escalation 决策刚提交、后端在推进）：
                       没有决策按钮是正确的，但要说明现状，否则像死机
                       （B8 独立复查）。 */
                    <div className="blueprint-status" role="status" aria-live="polite">
                      蓝图流程正在推进，稍候会自动更新。
                    </div>
                  )
                )}
              </>
            ) : (
              <div className="blueprint-status" role="status" aria-live="polite">
                {blueprint.loading ? '正在加载蓝图…' : '蓝图内容暂时不可用。'}
              </div>
            ))}
        </>
      )}
    </div>
  );
}
