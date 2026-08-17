/**
 * BLUEPRINT_ESCALATION 人工决策面板（B8）。
 *
 * 改写预算耗尽后到达；四选项（domain 闭合枚举 EscalationDecision）：
 * accept_current / modify_requirements / continue_later / cancel。
 *
 * D-B8-4 同样适用：蓝图已失效时 accept_current 会被后端 fail-closed 拒绝
 * （它与 gate 的 accept 走同一条 accept 副作用，见 D-B7-2），故一并禁用。
 */

import { BLUEPRINT_ESCALATION_OPTIONS } from './blueprint-logic';

export interface BlueprintEscalationPanelProps {
  readonly busy: boolean;
  /** 蓝图已失效：禁用 accept_current（D-B8-4） */
  readonly invalidated: boolean;
  /**
   * 待决策的蓝图正文当前不可见（拉取失败/尚未取到/无 ref）：同样禁用 accept_current
   * （B8 独立复查坐实）——"就用现在这版蓝图"是对内容的终局决定，内容不可见时放行
   * 就是让用户接受一版他从未看到的蓝图；其余三个选项不依赖看到内容，保持可用。
   */
  readonly contentUnavailable: boolean;
  readonly onChoose: (outcome: string) => void | Promise<void>;
}

export function BlueprintEscalationPanel({
  busy,
  invalidated,
  contentUnavailable,
  onChoose,
}: BlueprintEscalationPanelProps) {
  return (
    <div className="max-w-[640px]">
      <p>蓝图已经重新生成了几次仍未确认，接下来想怎么做？</p>
      {invalidated && (
        <p className="mt-1 text-[13px] text-status-attention" role="status">
          创作要求已变更，现有这版蓝图不能再被接受。
        </p>
      )}
      {!invalidated && contentUnavailable && (
        <p className="mt-1 text-[13px] text-status-attention" role="status">
          蓝图内容当前无法显示，暂不能直接接受这一版；可先重试加载，或选择其他选项。
        </p>
      )}
      <div className="mt-2 flex flex-col gap-2">
        {BLUEPRINT_ESCALATION_OPTIONS.map((opt) => {
          const disabled =
            busy || ((invalidated || contentUnavailable) && opt.outcome === 'accept_current');
          return (
            <button
              key={opt.outcome}
              type="button"
              className="flex flex-col items-start gap-0.5 rounded-md border border-border bg-card px-3 py-2.5 text-left font-[inherit] text-foreground hover:border-primary disabled:cursor-not-allowed disabled:opacity-55"
              onClick={() => void onChoose(opt.outcome)}
              disabled={disabled}
              aria-disabled={disabled}
            >
              <strong>{opt.label}</strong>
              <span className="text-xs text-muted-foreground">{opt.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
