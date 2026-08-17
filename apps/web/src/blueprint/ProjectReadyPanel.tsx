/**
 * PROJECT_READY 终态展示（B8；文案 B18 更正）。
 *
 * 蓝图被显式接受后项目进入就绪状态（Graph 的 PROJECT_READY 终态节点）。
 * B8 时代章节生成尚未接线，文案承诺"功能还在开发中"；GE-6/GE-7 上线后该文案
 * 反向失实（能力已有而文案说没有），B18（D-B18-4）更正为指路"成稿"阶段。
 * 跳转按钮涉及 App 级导航接线，留给 B20 一起设计——本面板仍只做状态陈述。
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
          ? `蓝图规划了 ${chapterCount} 章。去上方"成稿"阶段逐章生成正文，每章生成完由你确认。`
          : '可以去上方"成稿"阶段逐章生成正文了，每章生成完由你确认。'}
      </p>
    </div>
  );
}
