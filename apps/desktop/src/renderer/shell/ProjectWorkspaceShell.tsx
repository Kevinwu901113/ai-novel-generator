/**
 * 项目工作区（App shell）—— 有项目时的中栏工作区。
 *
 * 纯展示组合组件：当前打开项目的产品工作区插槽。
 * 今天渲染既有 Grill 工作台（保持与重构前 App.tsx 完全一致的 DOM，
 * section aria-label="Grill 工作台" + style={{ padding: 0 }}，ref=grillSectionRef 由 App 注入）。
 *
 * 【产品工作区插槽】Agent B 的 WorkflowStage 契约冻结后，在此装配
 * ProductWorkflowContainer（Idea → Research → Blueprint → Generation → Manuscript）。
 * 在契约合并前，本插槽不访问任何新 DesktopAPI，也不把产品页接成默认生产流程。
 */

import type { RefObject } from 'react';
import { GrillWorkbench } from '../grill/GrillWorkbench';
import { RendererErrorBoundary } from '../safety/RendererErrorBoundary';

interface ProjectWorkspaceShellProps {
  projectId: string;
  sectionRef: RefObject<HTMLElement | null>;
}

export function ProjectWorkspaceShell({ projectId, sectionRef }: ProjectWorkspaceShellProps) {
  return (
    <section
      ref={sectionRef}
      className="panel panel-center"
      style={{ padding: 0 }}
      aria-label="Grill 工作台"
    >
      <RendererErrorBoundary label="Grill 工作台">
        <GrillWorkbench projectId={projectId} />
      </RendererErrorBoundary>
    </section>
  );
}
