/**
 * 项目列表区域组件。
 *
 * 独立渲染项目列表，支持首页卡片与兼容的侧栏形态，包含：
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
  variant?: 'sidebar' | 'cards';
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
  variant = 'sidebar',
  dataServiceStatus,
  projects,
  currentProjectId,
  onRetry,
  onNewProject,
  onOpenProject,
}: ProjectListRegionProps) {
  const isDataServiceStarting = dataServiceStatus === 'starting';

  const content = isDataServiceStarting ? (
    <div className="empty-state project-empty-state" role="status">
      <p className="loading-indicator" aria-hidden="true">
        ⟳
      </p>
      <p>数据服务启动中…</p>
    </div>
  ) : dataServiceStatus === 'failed' || dataServiceStatus === 'disconnected' ? (
    <div className="empty-state project-empty-state">
      <p>暂时无法读取项目</p>
      <button className="btn-retry" onClick={onRetry}>
        重试数据服务
      </button>
    </div>
  ) : projects.length === 0 ? (
    <div className="empty-state project-empty-state">
      <p>还没有项目</p>
      <p className="empty-hint">先把上面的第一个想法写下来。</p>
    </div>
  ) : (
    <ul
      className={variant === 'cards' ? 'project-card-grid' : 'project-list'}
      role="list"
      aria-label={variant === 'cards' ? '最近项目' : undefined}
      aria-labelledby={variant === 'sidebar' ? 'project-list-heading' : undefined}
    >
      {projects.map((p) => (
        <li
          key={p.id}
          className={variant === 'cards' ? 'project-card-wrapper' : 'project-item-wrapper'}
        >
          {p.isMissing ? (
            <div
              className={`${variant === 'cards' ? 'project-card' : 'project-item'} missing`}
              aria-disabled="true"
              aria-label={buildProjectAriaLabel(p)}
            >
              <span className="project-item-name">{p.name}</span>
              <span className="project-item-badge" role="status">
                项目文件缺失
              </span>
              <span className="project-item-time">{formatTime(p.lastOpenedAt ?? p.createdAt)}</span>
            </div>
          ) : (
            <button
              className={`${variant === 'cards' ? 'project-card' : 'project-item'} ${
                currentProjectId === p.id ? 'active' : ''
              }`}
              onClick={() => onOpenProject(p.id)}
              aria-current={currentProjectId === p.id ? 'page' : undefined}
              aria-label={buildProjectAriaLabel(p)}
              disabled={dataServiceStatus !== 'ready'}
            >
              {variant === 'cards' && (
                <span className="project-card-mark" aria-hidden="true">
                  文
                </span>
              )}
              <span className="project-card-body">
                <span className="project-item-name">{p.name}</span>
                <span className="project-item-time">
                  最近打开 · {formatTime(p.lastOpenedAt ?? p.createdAt)}
                </span>
              </span>
              {variant === 'cards' && (
                <span className="project-card-action" aria-hidden="true">
                  继续创作 <span>→</span>
                </span>
              )}
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  if (variant === 'cards') {
    return <div aria-label="项目列表">{content}</div>;
  }

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
        {content}
      </div>
    </>
  );
}
