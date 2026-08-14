import type { RefObject } from 'react';
import type { DataServiceStatus, ProjectListItem, ProviderPublicState } from '@ai-novel/contracts';
import { CreateProjectRegion } from '../regions/CreateProjectRegion';
import { ProjectListRegion } from '../regions/ProjectListRegion';
import { AppIcon } from '../shell/AppIcon';

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
    <div className="home-page">
      <section ref={createSectionRef} className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-copy">
          <span className="eyebrow">
            <AppIcon name="sparkles" size={16} /> 从一个念头开始
          </span>
          <h1 id="home-title">今天想写什么？</h1>
          <p>不用先想完整。给出一个人物、一种气氛或一句模糊设想，剩下的通过对话慢慢理清。</p>
        </div>

        <div className="home-creation-card">
          <CreateProjectRegion
            variant="home"
            dataServiceStatus={dataServiceStatus}
            onRetry={onRetry}
            onCreate={onCreate}
          />
        </div>

        <div className="service-readiness" aria-label="创作服务状态">
          <button type="button" className="readiness-item" onClick={onOpenSettings}>
            <span
              className={`readiness-dot ${defaultProvider?.hasApiKey ? 'ready' : 'attention'}`}
            />
            <span>
              <strong>默认模型</strong>
              {providerLabel(defaultProvider)}
            </span>
          </button>
          <button type="button" className="readiness-item" onClick={onOpenSettings}>
            <span className={`readiness-dot ${searchConfigured ? 'ready' : 'optional'}`} />
            <span>
              <strong>联网搜索</strong>
              {searchConfigured === null
                ? '正在读取配置'
                : searchConfigured
                  ? 'Tavily 已就绪'
                  : '未配置，可稍后设置'}
            </span>
          </button>
        </div>
      </section>

      <section className="recent-projects" aria-labelledby="recent-projects-title">
        <div className="section-heading-row">
          <div>
            <span className="section-kicker">你的故事</span>
            <h2 id="recent-projects-title">继续创作</h2>
          </div>
          {projects.length > 0 && (
            <span className="project-count">共 {projects.length} 个项目</span>
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
