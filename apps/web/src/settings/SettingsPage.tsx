/**
 * 设置页（B19，D-B19-1/2；B19b 分页化，D-B19-5）。
 *
 * B19 首版是单页 + 锚点滚动；负责人验收反馈「分区好，但不要都在一个页面里」，
 * 改为分区即子页：
 * - 桌面（≥768px）：左侧导航切换活动分区，右侧一次只渲染一个分区卡（默认
 *   「模型服务」）；
 * - 移动（<768px）：设置根页是分区列表，点入子页，子页顶部「← 设置」回列表。
 * 不引入路由——分区是本地状态，返回创作后重进设置回到默认分区。
 *
 * 焦点管理：进入设置页焦点落页标题；移动端进入子页焦点落该分区容器
 * （tabIndex=-1），回列表焦点落页标题（与进入语义对称）。
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Sparkles, Database, Search } from 'lucide-react';
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
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';

type SettingsSectionId = 'provider' | 'search' | 'system';

interface SettingsSectionDef {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly description: string;
  readonly icon: typeof Sparkles;
  readonly headingId: string;
  /** 分区卡的可见标题（与导航短标签可不同，如「模型服务」→「模型提供商」） */
  readonly title: string;
}

const SECTIONS: ReadonlyArray<SettingsSectionDef> = [
  {
    id: 'provider',
    label: '模型服务',
    title: '模型提供商',
    description: '正文、蓝图和创作要求都使用这里的默认模型。',
    icon: Sparkles,
    headingId: 'provider-heading',
  },
  {
    id: 'search',
    label: '联网搜索',
    title: '联网搜索',
    description: '可选。需要历史或现实资料时，使用 Tavily 完成调研。',
    icon: Search,
    headingId: 'search-key-heading',
  },
  {
    id: 'system',
    label: '本地运行',
    title: '本地运行',
    description: '项目和稿件只保存在这台电脑。',
    icon: Database,
    headingId: 'system-heading',
  },
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
  const sectionRef = useRef<HTMLElement>(null);
  const isMobile = useMediaQuery('(max-width: 767.98px)');
  // null = 未显式选择：桌面回落到第一个分区，移动端显示分区列表。
  const [selected, setSelected] = useState<SettingsSectionId | null>(null);
  const activeId = selected ?? (isMobile ? null : 'provider');
  const active = SECTIONS.find((s) => s.id === activeId) ?? null;
  const isDataServiceReady = dataServiceStatus === 'ready';

  // 打开设置页焦点进页标题（抽屉时代由 Radix FocusScope 承接的语义）。
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // 移动端进入子页时焦点进分区容器；回列表（selected 变 null）焦点回页标题。
  const prevSelectedRef = useRef<SettingsSectionId | null>(null);
  useEffect(() => {
    if (!isMobile) return;
    if (selected !== null && prevSelectedRef.current === null) {
      sectionRef.current?.focus();
    } else if (selected === null && prevSelectedRef.current !== null) {
      headingRef.current?.focus();
    }
    prevSelectedRef.current = selected;
  }, [isMobile, selected]);

  const sectionCard = (def: SettingsSectionDef) => (
    <section
      ref={sectionRef}
      id={`settings-${def.id}`}
      aria-labelledby={def.headingId}
      tabIndex={-1}
      className="rounded-2xl border border-border bg-card p-6 outline-none"
    >
      <div className="mb-4 flex items-start gap-2.5">
        <def.icon size={18} aria-hidden="true" className="mt-0.5 text-accent-foreground" />
        <div>
          <h3 id={def.headingId} className="text-sm font-semibold">
            {def.title}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{def.description}</p>
        </div>
      </div>

      {def.id === 'provider' && (
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
      )}

      {def.id === 'search' && (
        <RendererErrorBoundary label="搜索服务">
          <SearchKeyPanel
            dataServiceStatus={dataServiceStatus}
            onStatusChange={onSearchStatusChange}
          />
        </RendererErrorBoundary>
      )}

      {def.id === 'system' && (
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
      )}
    </section>
  );

  return (
    <div className="h-full overflow-y-auto px-[clamp(16px,5vw,64px)] py-[30px]">
      <div className="mx-auto w-full max-w-[960px]">
        {/* 移动端子页里顶部动作是「← 设置」（回分区列表）；其余情形是「← 返回」（回创作） */}
        {isMobile && active !== null ? (
          <button
            type="button"
            className="w-fit border-none bg-transparent p-0 font-[inherit] text-sm text-primary"
            onClick={() => setSelected(null)}
          >
            <ArrowLeft size={14} aria-hidden="true" className="mr-1 inline-block align-[-2px]" />
            设置
          </button>
        ) : (
          <button
            type="button"
            className="w-fit border-none bg-transparent p-0 font-[inherit] text-sm text-primary"
            onClick={onBack}
          >
            <ArrowLeft size={14} aria-hidden="true" className="mr-1 inline-block align-[-2px]" />
            返回
          </button>
        )}

        {(!isMobile || active === null) && (
          <>
            <h2 ref={headingRef} tabIndex={-1} className="mt-3 text-xl font-semibold outline-none">
              设置
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              配置生成模型、联网搜索与本地运行状态。
            </p>
          </>
        )}

        {isMobile ? (
          active === null ? (
            // 移动端：分区列表
            <nav aria-label="设置分区" className="mt-6">
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {SECTIONS.map((def) => (
                  <li key={def.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-left"
                      onClick={() => setSelected(def.id)}
                    >
                      <def.icon size={18} aria-hidden="true" className="text-accent-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-sm font-semibold">{def.label}</span>
                        <span className="text-xs text-muted-foreground">{def.description}</span>
                      </span>
                      <ChevronRight
                        size={16}
                        aria-hidden="true"
                        className="shrink-0 text-muted-foreground"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          ) : (
            <div className="mt-4">{sectionCard(active)}</div>
          )
        ) : (
          // 桌面：左导航切换活动分区，右侧一次只渲染一个分区
          <div className="mt-6 grid grid-cols-[168px_minmax(0,1fr)] gap-8">
            <nav aria-label="设置分区" className="sticky top-0 self-start">
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {SECTIONS.map((def) => (
                  <li key={def.id}>
                    <button
                      type="button"
                      aria-current={activeId === def.id ? 'true' : undefined}
                      className={cn(
                        'w-full rounded-lg px-3 py-2 text-left text-sm',
                        activeId === def.id
                          ? 'bg-secondary font-semibold text-foreground'
                          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                      )}
                      onClick={() => setSelected(def.id)}
                    >
                      {def.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="flex min-w-0 flex-col gap-4">
              {active !== null && sectionCard(active)}
              <div>
                <Button variant="outline" size="sm" onClick={onBack}>
                  <ArrowLeft size={14} aria-hidden="true" />
                  返回创作
                </Button>
              </div>
            </div>
          </div>
        )}

        {isMobile && active === null && (
          <div className="mt-6">
            <Button variant="outline" size="sm" onClick={onBack}>
              <ArrowLeft size={14} aria-hidden="true" />
              返回创作
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
