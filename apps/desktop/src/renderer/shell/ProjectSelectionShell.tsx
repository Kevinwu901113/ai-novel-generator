/**
 * 无项目视图（App shell）—— 选择 / 创建项目。
 *
 * 纯展示组合组件：无当前项目时渲染中栏新建项目表单。
 * 保持与重构前 App.tsx 完全一致的 DOM
 * （section aria-label="新建项目"，ref=createSectionRef 由 App 注入用于聚焦）。
 *
 * 产品入口将在 Idea-to-Novel 中改为“告诉我你想写什么”，
 * 但本任务不替换现有新建项目 / Grill 流程。
 */

import type { RefObject } from 'react';
import type { DataServiceStatus } from '@ai-novel/contracts';
import { CreateProjectRegion } from '../regions/CreateProjectRegion';
import { RendererErrorBoundary } from '../safety/RendererErrorBoundary';

interface ProjectSelectionShellProps {
  dataServiceStatus: DataServiceStatus;
  sectionRef: RefObject<HTMLElement | null>;
  onRetry: () => void;
  onCreate: (name: string, idea: string) => Promise<boolean>;
}

export function ProjectSelectionShell({
  dataServiceStatus,
  sectionRef,
  onRetry,
  onCreate,
}: ProjectSelectionShellProps) {
  return (
    <section ref={sectionRef} className="panel panel-center" aria-label="新建项目">
      <RendererErrorBoundary label="新建项目">
        <CreateProjectRegion
          dataServiceStatus={dataServiceStatus}
          onRetry={onRetry}
          onCreate={onCreate}
        />
      </RendererErrorBoundary>
    </section>
  );
}
