/**
 * 设置页（B19，D-B19-1/2）。
 *
 * 原右侧抽屉（AppDrawer 'settings' 实例）退役，三个分区（模型服务/联网搜索/
 * 本地运行）原样搬入整页布局：内容列居中限宽，≥768px 左侧锚点导航（sticky，
 * scrollIntoView 容器内滚动，不引入路由），<768px 单列。分区语义、文案与
 * 无障碍结构（section + aria-labelledby）沿用抽屉时代。
 *
 * 焦点管理：挂载时焦点进页标题（tabIndex=-1，与旅程区 h2 同手法）；「返回」
 * 的焦点归还由 App 侧承接（打开一刻捕获 activeElement，关闭后归还）。
 */

import { useEffect, useRef } from 'react';
import { ArrowLeft, Sparkles, Database, Search } from 'lucide-react';
import type {
  ConnectionTestResult,
  CreateProviderProfileInput,
  DataServiceStatus,
  HealthCheckResponse,
  ProviderPublicState,
} from '@ai-novel/contracts';
import { ProviderRegion } from '../regions';
import { SearchKeyPanel } from '../research/SearchKeyPanel';
import { RendererErrorBoundary } from '../safety/RendererErrorBoundary';
import { Button } from '@/components/ui/button';

interface SettingsSectionDef {
  readonly id: string;
  readonly label: string;
}

const SECTIONS: ReadonlyArray<SettingsSectionDef> = [
  { id: 'settings-provider', label: '模型服务' },
  { id: 'settings-search', label: '联网搜索' },
  { id: 'settings-system', label: '本地运行' },
];

export interface SettingsPageProps {
  readonly providers: ReadonlyArray<ProviderPublicState>;
  readonly dataServiceStatus: DataServiceStatus;
  readonly health: HealthCheckResponse | null;
  readonly onBack: () => void;
  readonly onSearchStatusChange: (configured: boolean) => void;
  readonly onCreateProvider: (input: CreateProviderProfileInput) => Promise<void>;
  readonly onSetDefaultProvider: (profileId: string) => Promise<void>;
  readonly onRemoveProvider: (profileId: string) => Promise<void>;
  readonly onSaveApiKey: (profileId: string, apiKey: string) => Promise<void>;
  readonly onDeleteApiKey: (profileId: string) => Promise<void>;
  readonly onTestConnection: (profileId: string) => Promise<ConnectionTestResult | void>;
}

function SectionHeader({
  icon: Icon,
  headingId,
  title,
  description,
}: {
  readonly icon: typeof Sparkles;
  readonly headingId: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="mb-4 flex items-start gap-2.5">
      <Icon size={18} aria-hidden="true" className="mt-0.5 text-accent-foreground" />
      <div>
        <h3 id={headingId} className="text-sm font-semibold">
          {title}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function SettingsPage({
  providers,
  dataServiceStatus,
  health,
  onBack,
  onSearchStatusChange,
  onCreateProvider,
  onSetDefaultProvider,
  onRemoveProvider,
  onSaveApiKey,
  onDeleteApiKey,
  onTestConnection,
}: SettingsPageProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isDataServiceReady = dataServiceStatus === 'ready';

  // 打开设置页时焦点进页标题（抽屉时代由 Radix FocusScope 承接的语义）。
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const scrollToSection = (id: string) => {
    // 即时跳转而非 smooth：容器内 smooth scrollIntoView 在 Chromium 下会被
    // 静默中断（实测滚动量归零），且即时跳转天然符合 prefers-reduced-motion。
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  };

  return (
    <div className="h-full overflow-y-auto px-[clamp(16px,5vw,64px)] py-[30px]">
      <div className="mx-auto w-full max-w-[960px]">
        <button
          type="button"
          className="w-fit border-none bg-transparent p-0 font-[inherit] text-sm text-primary"
          onClick={onBack}
        >
          <ArrowLeft size={14} aria-hidden="true" className="mr-1 inline-block align-[-2px]" />
          返回
        </button>

        <h2 ref={headingRef} tabIndex={-1} className="mt-3 text-xl font-semibold outline-none">
          设置
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">配置生成模型、联网搜索与本地运行状态。</p>

        <div className="mt-6 gap-8 md:grid md:grid-cols-[168px_minmax(0,1fr)]">
          <nav aria-label="设置分区" className="sticky top-0 hidden self-start md:block">
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {SECTIONS.map((section) => (
                <li key={section.id}>
                  <button
                    type="button"
                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
                    onClick={() => scrollToSection(section.id)}
                  >
                    {section.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="flex min-w-0 flex-col gap-6">
            <section
              id="settings-provider"
              aria-labelledby="provider-heading"
              className="rounded-2xl border border-border bg-card p-6"
            >
              <SectionHeader
                icon={Sparkles}
                headingId="provider-heading"
                title="模型提供商"
                description="正文、蓝图和创作要求都使用这里的默认模型。"
              />
              <RendererErrorBoundary label="模型服务">
                <ProviderRegion
                  providers={providers}
                  dataServiceStatus={dataServiceStatus}
                  onCreate={onCreateProvider}
                  onSetDefault={onSetDefaultProvider}
                  onRemove={onRemoveProvider}
                  onSaveApiKey={onSaveApiKey}
                  onDeleteApiKey={onDeleteApiKey}
                  onTestConnection={onTestConnection}
                />
              </RendererErrorBoundary>
            </section>

            <section
              id="settings-search"
              aria-labelledby="search-key-heading"
              className="rounded-2xl border border-border bg-card p-6"
            >
              <SectionHeader
                icon={Search}
                headingId="search-key-heading"
                title="联网搜索"
                description="可选。需要历史或现实资料时，使用 Tavily 完成调研。"
              />
              <RendererErrorBoundary label="搜索服务">
                <SearchKeyPanel
                  dataServiceStatus={dataServiceStatus}
                  onStatusChange={onSearchStatusChange}
                />
              </RendererErrorBoundary>
            </section>

            <section
              id="settings-system"
              aria-labelledby="system-heading"
              className="rounded-2xl border border-border bg-card p-6"
            >
              <SectionHeader
                icon={Database}
                headingId="system-heading"
                title="本地运行"
                description="项目和稿件只保存在这台电脑。"
              />
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-secondary p-2.5">
                  <dt className="text-[11px] text-muted-foreground">数据服务</dt>
                  <dd className="mt-0.5 text-xs font-semibold">
                    {isDataServiceReady ? 'SQLite 已就绪' : '暂不可用'}
                  </dd>
                </div>
                <div className="rounded-lg border border-border bg-secondary p-2.5">
                  <dt className="text-[11px] text-muted-foreground">桌面服务</dt>
                  <dd className="mt-0.5 text-xs font-semibold">{health?.ok ? '正常' : '检查中'}</dd>
                </div>
                {health && (
                  <div className="rounded-lg border border-border bg-secondary p-2.5">
                    <dt className="text-[11px] text-muted-foreground">版本</dt>
                    <dd className="mt-0.5 text-xs font-semibold">{health.version}</dd>
                  </div>
                )}
              </dl>
            </section>

            <div className="pb-2">
              <Button variant="outline" size="sm" onClick={onBack}>
                <ArrowLeft size={14} aria-hidden="true" />
                返回创作
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
