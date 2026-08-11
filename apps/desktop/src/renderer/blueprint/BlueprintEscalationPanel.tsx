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
  readonly onChoose: (outcome: string) => void | Promise<void>;
}

export function BlueprintEscalationPanel({
  busy,
  invalidated,
  onChoose,
}: BlueprintEscalationPanelProps) {
  return (
    <div className="blueprint-escalation">
      <p>蓝图已经重新生成了几次仍未确认，接下来想怎么做？</p>
      {invalidated && (
        <p className="blueprint-escalation-notice" role="status">
          创作要求已变更，现有这版蓝图不能再被接受。
        </p>
      )}
      <div className="blueprint-escalation-options">
        {BLUEPRINT_ESCALATION_OPTIONS.map((opt) => {
          const disabled = busy || (invalidated && opt.outcome === 'accept_current');
          return (
            <button
              key={opt.outcome}
              type="button"
              className="blueprint-escalation-option"
              onClick={() => void onChoose(opt.outcome)}
              disabled={disabled}
              aria-disabled={disabled}
            >
              <strong>{opt.label}</strong>
              <span>{opt.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
