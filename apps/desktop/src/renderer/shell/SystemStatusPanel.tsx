/**
 * 右栏系统状态面板（App shell）—— 现有工程状态区域。
 *
 * 纯展示组合组件：本地存储 / 数据服务 / 当前阶段 / 项目状态 / 任务活动 / 模型服务。
 * 保持与重构前 App.tsx 完全一致的 DOM（aside id="panel-right" aria-label="状态面板"，
 * 各 status-section id / aria-labelledby / 文案原样）。
 *
 * 按产品方向（PRODUCT_DIRECTION.md §4.7），工程状态只应出现在高级设置或开发者诊断中；
 * 未来本区域降级为“开发 / 设置入口”，不作为产品 1.0 主体验。
 */

import type {
  DataServiceStatus,
  OpenProjectResult,
  ProviderPublicState,
} from '@ai-novel/contracts';
import { ProjectStatusRegion } from '../regions/ProjectStatusRegion';
import { ProviderRegion } from '../regions/ProviderRegion';
import { RendererErrorBoundary } from '../safety/RendererErrorBoundary';
import { TaskCenter } from '../task-center/TaskCenter';

interface SystemStatusPanelProps {
  dataServiceStatus: DataServiceStatus;
  currentProject: OpenProjectResult | null;
  providerState: ProviderPublicState | null;
  onRetry: () => void;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onDeleteApiKey: () => Promise<void>;
  onTestConnection: () => Promise<void>;
}

export function SystemStatusPanel({
  dataServiceStatus,
  currentProject,
  providerState,
  onRetry,
  onSaveApiKey,
  onDeleteApiKey,
  onTestConnection,
}: SystemStatusPanelProps) {
  const isDataServiceReady = dataServiceStatus === 'ready';
  const isDataServiceStarting = dataServiceStatus === 'starting';

  return (
    <aside id="panel-right" className="panel panel-right" aria-label="状态面板">
      <div className="panel-header">
        <h2 id="status-heading">状态</h2>
      </div>
      <div className="panel-content">
        <section className="status-section" aria-labelledby="status-local-heading">
          <h3 id="status-local-heading">本地存储</h3>
          <p>
            {isDataServiceReady ? 'SQLite 已就绪' : isDataServiceStarting ? '启动中…' : '不可用'}
          </p>
        </section>
        <section className="status-section" aria-labelledby="status-service-heading">
          <h3 id="status-service-heading">数据服务</h3>
          <p>
            {isDataServiceStarting && '启动中…'}
            {isDataServiceReady && '正常运行'}
            {dataServiceStatus === 'failed' && (
              <>
                不可用
                <button className="btn-retry-inline" onClick={onRetry} aria-label="重试数据服务">
                  重试
                </button>
              </>
            )}
            {dataServiceStatus === 'disconnected' && '已断开'}
          </p>
        </section>
        <section className="status-section" aria-labelledby="status-stage-heading">
          <h3 id="status-stage-heading">当前阶段</h3>
          <p>{currentProject ? 'Grill-me 需求澄清' : '—'}</p>
        </section>
        <RendererErrorBoundary label="项目状态">
          <ProjectStatusRegion currentProject={currentProject} />
        </RendererErrorBoundary>

        {/* 任务活动 */}
        <section
          className="status-section task-center-section"
          aria-labelledby="task-center-heading"
        >
          <h3 id="task-center-heading">任务活动</h3>
          <RendererErrorBoundary label="任务中心">
            <TaskCenter projectId={currentProject?.id ?? null} />
          </RendererErrorBoundary>
        </section>

        {/* 模型服务 */}
        <section className="status-section provider-section" aria-labelledby="provider-heading">
          <h3 id="provider-heading">模型服务</h3>
          <RendererErrorBoundary label="模型服务">
            <ProviderRegion
              providerState={providerState}
              dataServiceStatus={dataServiceStatus}
              onSaveApiKey={onSaveApiKey}
              onDeleteApiKey={onDeleteApiKey}
              onTestConnection={onTestConnection}
            />
          </RendererErrorBoundary>
        </section>
      </div>
    </aside>
  );
}
