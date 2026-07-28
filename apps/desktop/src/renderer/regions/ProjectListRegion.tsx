/**
 * 项目列表区域组件。
 *
 * 独立渲染左栏项目列表，包含：
 * - 数据服务状态判断
 * - 项目列表渲染（使用真实 button）
 * - 格式化时间显示
 *
 * 此组件被 RendererErrorBoundary 包裹，
 * 崩溃时不影响其他区域。
 *
 * 无障碍特性：
 * - 可打开项目使用真实 button（Enter/Space 原生行为）
 * - 当前项目使用 aria-current="page"
 * - 缺失项目不可操作，状态通过文本表达
 * - 新建项目按钮有明确 aria-label
 * - 项目名称、时间、缺失状态组合成可访问名称
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

/**
 * 构建项目的可访问名称。
 * 组合项目名称、时间和缺失状态。
 */
function buildProjectAriaLabel(p: ProjectListItem): string {
  const parts: string[] = [p.name];
  if (p.isMissing) {
    parts.push('（缺失）');
  }
  const time = p.lastOpenedAt ?? p.createdAt;
  if (time) {
    parts.push(`，${formatTime(time)}`);
  }
  return parts.join('');
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
        <h2 id="project-list-heading">项目列表</h2>
        <button
          className="btn-new-project"
          onClick={onNewProject}
          aria-label="新建项目"
          disabled={dataServiceStatus !== 'ready'}
        >
          ＋
        </button>
      </div>
      <div className="panel-content" aria-labelledby="project-list-heading">
        {isDataServiceStarting ? (
          <div className="empty-state" role="status">
            <p className="loading-indicator" aria-hidden="true">
              ⟳
            </p>
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
          <ul className="project-list" role="list" aria-labelledby="project-list-heading">
            {projects.map((p) => (
              <li key={p.id} className="project-item-wrapper">
                {p.isMissing ? (
                  <div
                    className={`project-item missing`}
                    aria-disabled="true"
                    aria-label={buildProjectAriaLabel(p)}
                  >
                    <span className="project-item-name">{p.name}</span>
                    <span className="project-item-badge" role="status">
                      缺失
                    </span>
                    <span className="project-item-time">
                      {formatTime(p.lastOpenedAt ?? p.createdAt)}
                    </span>
                  </div>
                ) : (
                  <button
                    className={`project-item ${currentProjectId === p.id ? 'active' : ''}`}
                    onClick={() => onOpenProject(p.id)}
                    aria-current={currentProjectId === p.id ? 'page' : undefined}
                    aria-label={buildProjectAriaLabel(p)}
                    disabled={dataServiceStatus !== 'ready'}
                  >
                    <span className="project-item-name">{p.name}</span>
                    <span className="project-item-time">
                      {formatTime(p.lastOpenedAt ?? p.createdAt)}
                    </span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
