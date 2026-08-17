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

import { AlertCircle, BookOpen, Plus } from 'lucide-react';
import type { DataServiceStatus, ProjectListItem } from '@ai-novel/contracts';
import { EmptyState } from '@/components/EmptyState';
import { Spinner } from '@/components/Spinner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
    <div
      role="status"
      className="flex min-h-[200px] flex-col items-center justify-center gap-3 text-center text-muted-foreground"
    >
      <Spinner label={null} size={24} />
      <p className="text-[15px]">数据服务启动中…</p>
    </div>
  ) : dataServiceStatus === 'failed' || dataServiceStatus === 'disconnected' ? (
    <EmptyState
      icon={AlertCircle}
      message="暂时无法读取项目"
      actionLabel="重试数据服务"
      onAction={onRetry}
    />
  ) : projects.length === 0 ? (
    <EmptyState icon={BookOpen} message="还没有项目" hint="先把上面的第一个想法写下来。" />
  ) : (
    <ul
      className={cn(
        'list-none',
        variant === 'cards'
          ? 'grid grid-cols-3 gap-3.5 max-[1080px]:grid-cols-2'
          : 'flex flex-col gap-0.5',
      )}
      role="list"
      aria-label={variant === 'cards' ? '最近项目' : undefined}
      aria-labelledby={variant === 'sidebar' ? 'project-list-heading' : undefined}
    >
      {projects.map((p) => {
        const isActive = currentProjectId === p.id;
        return (
          <li key={p.id}>
            {p.isMissing ? (
              <div
                className={
                  variant === 'cards'
                    ? 'grid min-h-[142px] grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-2xl border border-border bg-panel p-[17px] opacity-50'
                    : 'flex flex-col rounded-md px-3 py-2.5 opacity-50'
                }
                aria-disabled="true"
                aria-label={buildProjectAriaLabel(p)}
              >
                <span className="truncate text-sm font-medium">{p.name}</span>
                <span
                  role="status"
                  className="mt-1 self-start rounded bg-destructive/10 px-1.5 py-px text-[11px] text-destructive"
                >
                  项目文件缺失
                </span>
                <span className="mt-0.5 text-[11px] text-muted-foreground">
                  {formatTime(p.lastOpenedAt ?? p.createdAt)}
                </span>
              </div>
            ) : variant === 'cards' ? (
              <button
                className="group grid min-h-[142px] w-full grid-cols-[auto_minmax(0,1fr)] gap-[13px] rounded-2xl border border-border bg-panel p-[17px] text-left font-inherit text-foreground transition-[transform,border-color,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-[0_12px_32px_var(--color-shadow)]"
                onClick={() => onOpenProject(p.id)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={buildProjectAriaLabel(p)}
                disabled={dataServiceStatus !== 'ready'}
              >
                <span
                  aria-hidden="true"
                  className="grid h-[42px] w-[34px] place-items-center rounded-[5px_9px_9px_5px] bg-accent font-serif font-bold text-accent-foreground"
                >
                  文
                </span>
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="truncate text-sm font-semibold">{p.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    最近打开 · {formatTime(p.lastOpenedAt ?? p.createdAt)}
                  </span>
                  <span
                    aria-hidden="true"
                    className="col-span-2 justify-self-end text-xs text-accent-foreground"
                  >
                    继续创作{' '}
                    <span className="inline-block transition-transform duration-150 group-hover:translate-x-0.5">
                      →
                    </span>
                  </span>
                </span>
              </button>
            ) : (
              <button
                className={cn(
                  'flex w-full flex-col rounded-md px-3 py-2.5 text-left font-inherit',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground hover:bg-secondary disabled:opacity-50',
                )}
                onClick={() => onOpenProject(p.id)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={buildProjectAriaLabel(p)}
                disabled={dataServiceStatus !== 'ready'}
              >
                <span className="truncate text-sm font-medium">{p.name}</span>
                <span
                  className={cn(
                    'mt-0.5 text-[11px]',
                    isActive ? 'text-primary-foreground/70' : 'text-muted-foreground',
                  )}
                >
                  最近打开 · {formatTime(p.lastOpenedAt ?? p.createdAt)}
                </span>
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );

  if (variant === 'cards') {
    return <div aria-label="项目列表">{content}</div>;
  }

  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 id="project-list-heading" className="text-sm font-semibold">
          项目列表
        </h2>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={onNewProject}
          aria-label="新建项目"
          disabled={dataServiceStatus !== 'ready'}
        >
          <Plus size={14} aria-hidden="true" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-4" aria-labelledby="project-list-heading">
        {content}
      </div>
    </>
  );
}
