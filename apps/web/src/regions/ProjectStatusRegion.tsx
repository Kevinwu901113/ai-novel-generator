/**
 * 项目状态区域组件。
 *
 * 独立渲染右栏项目状态信息，包含：
 * - 项目 ID（短格式）
 * - 创建时间
 * - 最近打开时间
 * - 项目状态
 *
 * 此组件被 RendererErrorBoundary 包裹，
 * 崩溃时不影响 TaskCenter。
 */

import type { ReactNode } from 'react';
import type { OpenProjectResult } from '@ai-novel/contracts';

interface ProjectStatusRegionProps {
  currentProject: OpenProjectResult | null;
}

/** 格式化短 ID */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** 格式化时间 */
function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function StatusSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {heading}
      </h3>
      <p className="text-sm text-foreground">{children}</p>
    </div>
  );
}

export function ProjectStatusRegion({ currentProject }: ProjectStatusRegionProps) {
  if (!currentProject) {
    return null;
  }

  return (
    <>
      <StatusSection heading="项目 ID">
        <span className="font-mono text-[13px]">{shortId(currentProject.id)}</span>
      </StatusSection>
      <StatusSection heading="创建时间">{formatTime(currentProject.createdAt)}</StatusSection>
      <StatusSection heading="最近打开">{formatTime(currentProject.lastOpenedAt)}</StatusSection>
      <StatusSection heading="项目状态">{currentProject.status}</StatusSection>
    </>
  );
}
