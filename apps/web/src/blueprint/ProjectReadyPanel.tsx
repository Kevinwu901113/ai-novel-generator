/**
 * PROJECT_READY 终态展示（B8）。
 *
 * 蓝图被显式接受后项目进入就绪状态（Graph 的 PROJECT_READY 终态节点）。
 * 本面板只做状态陈述 + 下一步说明——章节生成入口属 GE-6/B10，尚未接线，
 * 这里不放按钮（D-B8-7 同一原则：没有后端的按钮就是空承诺）。
 */

export interface ProjectReadyPanelProps {
  /** 章节数（蓝图正文可用时展示，让"接下来要写多少"具体可感） */
  readonly chapterCount: number | null;
}

export function ProjectReadyPanel({ chapterCount }: ProjectReadyPanelProps) {
  return (
    <div
      className="max-w-[640px] space-y-1 rounded-lg border border-border bg-secondary px-4 py-3"
      role="status"
    >
      <p className="font-semibold">✓ 蓝图已确认，项目就绪</p>
      <p>
        {chapterCount !== null && chapterCount > 0
          ? `蓝图规划了 ${chapterCount} 章。逐章生成正文的功能还在开发中，完成后可以从下面的章节结构直接开始写。`
          : '逐章生成正文的功能还在开发中。'}
      </p>
    </div>
  );
}
