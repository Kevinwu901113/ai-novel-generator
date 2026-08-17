import type { RefObject } from 'react';
import { Sparkles } from 'lucide-react';
import type { DataServiceStatus, ProjectListItem, ProviderPublicState } from '@ai-novel/contracts';
import { CreateProjectRegion } from '../regions/CreateProjectRegion';
import { ProjectListRegion } from '../regions/ProjectListRegion';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface HomePageProps {
  readonly dataServiceStatus: DataServiceStatus;
  readonly projects: ReadonlyArray<ProjectListItem>;
  readonly defaultProvider: ProviderPublicState | null;
  readonly searchConfigured: boolean | null;
  readonly createSectionRef: RefObject<HTMLElement | null>;
  readonly onRetry: () => void;
  readonly onCreate: (name: string, idea: string) => Promise<boolean>;
  readonly onOpenProject: (projectId: string) => void;
  readonly onOpenSettings: () => void;
}

function providerLabel(provider: ProviderPublicState | null): string {
  if (!provider) return '尚未配置模型';
  if (!provider.hasApiKey) return `${provider.label} 缺少密钥`;
  return `${provider.label} 已就绪`;
}

/** 服务就绪状态点：ready=绿，attention=琥珀，其余（含 null 加载中）为中性灰。 */
function ReadinessDot({ tone }: { readonly tone: 'ready' | 'attention' | 'neutral' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-2 flex-none rounded-full ring-4',
        tone === 'ready' && 'bg-status-ready ring-status-ready/12',
        tone === 'attention' && 'bg-status-attention ring-status-attention/12',
        tone === 'neutral' && 'bg-status-neutral ring-status-neutral/12',
      )}
    />
  );
}

export function HomePage({
  dataServiceStatus,
  projects,
  defaultProvider,
  searchConfigured,
  createSectionRef,
  onRetry,
  onCreate,
  onOpenProject,
  onOpenSettings,
}: HomePageProps) {
  return (
    <div className="h-full overflow-y-auto px-[clamp(34px,6vw,92px)] pt-[62px] pb-[72px]">
      <section
        ref={createSectionRef}
        className="mx-auto grid w-full max-w-[1080px] grid-cols-[minmax(0,1fr)_minmax(420px,1.25fr)] items-center gap-x-[clamp(44px,7vw,96px)] gap-y-[22px]"
        aria-labelledby="home-title"
      >
        <div>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-[0.08em] text-accent-foreground">
            <Sparkles size={16} aria-hidden="true" /> 从一个念头开始
          </span>
          <h1
            id="home-title"
            className="mt-3 mb-3.5 font-serif text-[clamp(34px,4vw,52px)] leading-[1.12] font-semibold tracking-[-0.035em]"
          >
            今天想写什么？
          </h1>
          <p className="max-w-[390px] text-sm leading-[1.8] text-muted-foreground">
            不用先想完整。给出一个人物、一种气氛或一句模糊设想，剩下的通过对话慢慢理清。
          </p>
        </div>

        <Card className="gap-0 rounded-[20px] p-[26px] shadow-[0_24px_70px_var(--shadow-color)]">
          <CreateProjectRegion
            variant="home"
            dataServiceStatus={dataServiceStatus}
            onRetry={onRetry}
            onCreate={onCreate}
          />
        </Card>

        <div className="col-start-2 grid grid-cols-2 gap-2.5" aria-label="创作服务状态">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2.5 rounded-[10px] border border-border bg-panel/72 px-3 py-2.5 text-left text-[11px] text-muted-foreground hover:border-primary/50"
            onClick={onOpenSettings}
          >
            <ReadinessDot tone={defaultProvider?.hasApiKey ? 'ready' : 'attention'} />
            <span className="flex min-w-0 flex-col">
              <strong className="text-[11px] text-foreground">默认模型</strong>
              {providerLabel(defaultProvider)}
            </span>
          </button>
          <button
            type="button"
            className="flex min-w-0 items-center gap-2.5 rounded-[10px] border border-border bg-panel/72 px-3 py-2.5 text-left text-[11px] text-muted-foreground hover:border-primary/50"
            onClick={onOpenSettings}
          >
            <ReadinessDot tone={searchConfigured ? 'ready' : 'neutral'} />
            <span className="flex min-w-0 flex-col">
              <strong className="text-[11px] text-foreground">联网搜索</strong>
              {searchConfigured === null
                ? '正在读取配置'
                : searchConfigured
                  ? 'Tavily 已就绪'
                  : '未配置，可稍后设置'}
            </span>
          </button>
        </div>
      </section>

      <section
        className="mx-auto mt-12 w-full max-w-[1080px]"
        aria-labelledby="recent-projects-title"
      >
        <div className="mb-[18px] flex items-end justify-between gap-[18px]">
          <div>
            <span className="text-[11px] tracking-[0.1em] text-muted-foreground">你的故事</span>
            <h2 id="recent-projects-title" className="mt-[3px] font-serif text-2xl">
              继续创作
            </h2>
          </div>
          {projects.length > 0 && (
            <span className="text-xs text-muted-foreground">共 {projects.length} 个项目</span>
          )}
        </div>

        <ProjectListRegion
          variant="cards"
          dataServiceStatus={dataServiceStatus}
          projects={projects}
          currentProjectId={null}
          onRetry={onRetry}
          onNewProject={() => {}}
          onOpenProject={onOpenProject}
        />
      </section>
    </div>
  );
}
