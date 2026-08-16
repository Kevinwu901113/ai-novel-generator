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

export function ProjectStatusRegion({ currentProject }: ProjectStatusRegionProps) {
  if (!currentProject) {
    return null;
  }

  return (
    <>
      <div className="status-section">
        <h3>项目 ID</h3>
        <p className="mono">{shortId(currentProject.id)}</p>
      </div>
      <div className="status-section">
        <h3>创建时间</h3>
        <p>{formatTime(currentProject.createdAt)}</p>
      </div>
      <div className="status-section">
        <h3>最近打开</h3>
        <p>{formatTime(currentProject.lastOpenedAt)}</p>
      </div>
      <div className="status-section">
        <h3>项目状态</h3>
        <p>{currentProject.status}</p>
      </div>
    </>
  );
}
