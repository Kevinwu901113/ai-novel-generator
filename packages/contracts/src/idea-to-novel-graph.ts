/**
 * @ai-novel/contracts - Idea-to-Novel Graph 跨进程契约（DTO + 运行时校验）
 *
 * 只包含类型定义和验证函数，供 Main / Preload / Renderer / Worker 共享。
 * 不含业务逻辑 —— 逻辑在 @ai-novel/domain 的 pure transition / validator 中。
 *
 * 本模块是纯自包含：不导入任何包，校验器为手写（与仓库惯例一致）。
 *
 * 说明：共享状态（GraphRunState）的权威校验在 @ai-novel/domain 的
 * `validateGraphRunState`（graph-aware，exact-key / fail-closed）。
 * contracts 不暴露 graph-aware 状态 validator —— 避免伪严格边界。
 */

// ── UI 阶段（派生映射）───────────────────────────────────────────

/** 节点 → UI 阶段的派生枚举（不是图，不能用于推导下一节点） */
export type WorkflowStage =
  'idea' | 'clarify' | 'research' | 'blueprint' | 'generate' | 'manuscript' | 'done';

export function isValidWorkflowStage(value: unknown): value is WorkflowStage {
  return (
    value === 'idea' ||
    value === 'clarify' ||
    value === 'research' ||
    value === 'blueprint' ||
    value === 'generate' ||
    value === 'manuscript' ||
    value === 'done'
  );
}
