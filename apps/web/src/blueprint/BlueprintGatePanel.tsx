/**
 * BLUEPRINT_USER_GATE 人工确认面板（B8）。
 *
 * 两选项（domain 闭合枚举 BlueprintGateDecision）：accept / request_rewrite。
 *
 * D-B8-4：蓝图已失效（创作要求变更）时**禁用"接受"**并给出失效说明——后端
 * D-B7-8 会 fail-closed 抛 GRAPH_RUN_STATE_CONFLICT，让用户先撞一次错误再解释
 * 是坏交互；出路只留"重新生成一版"。
 *
 * D-B8-7：request_rewrite 不带改写意见输入框（TD-029-1）——图的 BLUEPRINT_GENERATE.input
 * 不含 storyBlueprint，后端无处消费意见，加了就是空承诺。按钮文案如实说明"重新生成一版"。
 */

import { BLUEPRINT_GATE_OPTIONS, gateRewriteOptionCopy, rewriteRemaining } from './blueprint-logic';
import { cn } from '@/lib/utils';

export interface BlueprintGatePanelProps {
  readonly busy: boolean;
  /** 蓝图已失效：禁用接受，只留重新生成（D-B8-4） */
  readonly invalidated: boolean;
  /** 已用改写次数（BLUEPRINT_REWRITE_LIMIT 为上限；耗尽后走 escalation） */
  readonly rewriteUsed: number;
  readonly onChoose: (outcome: string) => void | Promise<void>;
}

export function BlueprintGatePanel({
  busy,
  invalidated,
  rewriteUsed,
  onChoose,
}: BlueprintGatePanelProps) {
  const remaining = rewriteRemaining(rewriteUsed);
  return (
    <div className="max-w-[640px]">
      <p className="mb-2 text-sm">
        {invalidated
          ? remaining > 0
            ? '创作要求已变更，这份蓝图不能再被接受，请重新生成一版。'
            : '创作要求已变更，这份蓝图不能再被接受；重新生成次数已用完，请提交进入后续决策。'
          : '这份蓝图看下来可以吗？确认后项目就进入就绪状态。'}
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {BLUEPRINT_GATE_OPTIONS.map((opt) => {
          const isAccept = opt.outcome === 'accept';
          const isRewrite = opt.outcome === 'request_rewrite';
          // 失效时禁用接受。改写次数耗尽时 request_rewrite **不禁用**：Graph 的
          // gate→escalation 边要求"提交 request_rewrite 且预算已耗尽"才路由进
          // 升级四选项——这次提交是进入 escalation 的唯一入口，禁用它 gate 就成
          // 死端（B8 独立复查坐实的 blocker）。按钮文案随之如实变化。
          const disabled = busy || (isAccept && invalidated);
          const copy = isRewrite ? gateRewriteOptionCopy(remaining) : opt;
          return (
            <button
              key={opt.outcome}
              type="button"
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-md border border-border bg-card px-3 py-2.5 text-left font-[inherit] text-foreground hover:border-primary disabled:cursor-not-allowed disabled:opacity-55',
                isAccept && 'border-primary',
              )}
              onClick={() => void onChoose(opt.outcome)}
              disabled={disabled}
              aria-disabled={disabled}
            >
              <strong>{copy.label}</strong>
              <span className="text-xs text-muted-foreground">{copy.description}</span>
              {isRewrite && (
                <span className="mt-0.5 text-xs text-muted-foreground">
                  {remaining > 0 ? `还可以重新生成 ${remaining} 次` : '重新生成次数已用完'}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
