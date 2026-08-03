/**
 * 左栏项目侧边栏（App shell）。
 *
 * 纯展示组合组件：包裹 ProjectListRegion 于 RendererErrorBoundary。
 * 保持与重构前 App.tsx 完全一致的 DOM（aside id="panel-left" aria-label="项目列表"）。
 */

import type { DataServiceStatus, ProjectListItem } from '@ai-novel/contracts';
import { ProjectListRegion } from '../regions/ProjectListRegion';
import { RendererErrorBoundary } from '../safety/RendererErrorBoundary';

interface ProjectSidebarProps {
  dataServiceStatus: DataServiceStatus;
  projects: ReadonlyArray<ProjectListItem>;
  currentProjectId: string | null;
  onRetry: () => void;
  onNewProject: () => void;
  onOpenProject: (projectId: string) => void;
}

export function ProjectSidebar({
  dataServiceStatus,
  projects,
  currentProjectId,
  onRetry,
  onNewProject,
  onOpenProject,
}: ProjectSidebarProps) {
  return (
    <aside id="panel-left" className="panel panel-left" aria-label="项目列表">
      <RendererErrorBoundary label="项目列表">
        <ProjectListRegion
          dataServiceStatus={dataServiceStatus}
          projects={projects}
          currentProjectId={currentProjectId}
          onRetry={onRetry}
          onNewProject={onNewProject}
          onOpenProject={onOpenProject}
        />
      </RendererErrorBoundary>
    </aside>
  );
}
