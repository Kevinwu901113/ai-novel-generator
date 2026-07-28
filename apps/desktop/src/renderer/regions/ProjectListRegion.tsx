/**
 * 项目列表区域组件。
 *
 * 独立渲染左栏项目列表，包含：
 * - 数据服务状态判断
 * - 项目列表渲染
 * - 格式化时间显示
 *
 * 此组件被 RendererErrorBoundary 包裹，
 * 崩溃时不影响其他区域。
 */

import type { DataServiceStatus, ProjectListItem } from '@ai-novel/contracts';

interface ProjectListRegionProps {
  dataServiceStatus: DataServiceStatus;
  projects: ReadonlyArray<ProjectListItem>;
  currentProjectId: string | null;
  onRetry: () => void;
  onNewProject: () => void;
  onOpenProject: (projectId: string) => void;
}

/** 格式化时间 */
function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

export function ProjectListRegion({
  dataServiceStatus,
  projects,
  currentProjectId,
  onRetry,
  onNewProject,
  onOpenProject,
}: ProjectListRegionProps) {
  const isDataServiceStarting = dataServiceStatus === 'starting';

  return (
    <>
      <div className="panel-header">
        <h2>项目列表</h2>
        <button
          className="btn-new-project"
          onClick={onNewProject}
          title="新建项目"
          disabled={dataServiceStatus !== 'ready'}
        >
          ＋
        </button>
      </div>
      <div className="panel-content">
        {isDataServiceStarting ? (
          <div className="empty-state">
            <p className="loading-indicator">⟳</p>
            <p>数据服务启动中…</p>
          </div>
        ) : dataServiceStatus === 'failed' || dataServiceStatus === 'disconnected' ? (
          <div className="empty-state">
            <p>数据服务不可用</p>
            <button className="btn-retry" onClick={onRetry}>
              重试数据服务
            </button>
          </div>
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <p>尚未创建项目</p>
            <p className="empty-hint">在中间栏创建第一个项目</p>
          </div>
        ) : (
          <ul className="project-list">
            {projects.map((p) => (
              <li
                key={p.id}
                className={`project-item ${currentProjectId === p.id ? 'active' : ''} ${p.isMissing ? 'missing' : ''}`}
                onClick={() => !p.isMissing && onOpenProject(p.id)}
              >
                <span className="project-item-name">{p.name}</span>
                {p.isMissing && <span className="project-item-badge">缺失</span>}
                <span className="project-item-time">
                  {formatTime(p.lastOpenedAt ?? p.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
