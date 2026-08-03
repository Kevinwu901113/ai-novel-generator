/**
 * 产品页面统一骨架（纯 UI）。
 *
 * 只负责布局、标题、描述、空状态与未来接入点；不访问数据库、不访问 window.desktop、
 * 不定义任何业务核心类型（ResearchBundle / StoryBlueprint / GenerationRun / WorkflowStage）。
 *
 * 允许的 props 均为纯 UI 级：title / description / isActive / onNavigate。
 */

import type { ReactNode } from 'react';

interface ProductPageFrameProps {
  title: string;
  description: string;
  isActive: boolean;
  /** 未来接入点：由 App 装配后提供本页的导航动作。当前骨架不接入。 */
  onNavigate?: () => void;
  children?: ReactNode;
}

export function ProductPageFrame({
  title,
  description,
  isActive,
  onNavigate,
  children,
}: ProductPageFrameProps) {
  return (
    <section
      className={`product-page${isActive ? ' product-page-active' : ''}`}
      aria-current={isActive ? 'step' : undefined}
    >
      <div className="product-page-header">
        <h3 className="product-page-title">{title}</h3>
        <span className="product-page-state" role="status">
          {isActive ? '当前阶段' : '未开始'}
        </span>
      </div>
      <p className="product-page-description">{description}</p>
      <div className="product-page-body">
        {children ?? <p className="empty-hint">该能力尚未接入，将在主链契约冻结后启用。</p>}
      </div>
      {onNavigate && (
        <button type="button" className="product-page-action" onClick={onNavigate}>
          进入{title}
        </button>
      )}
    </section>
  );
}
