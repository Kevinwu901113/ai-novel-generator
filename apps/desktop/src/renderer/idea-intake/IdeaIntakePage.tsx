/**
 * Idea Intake 页面骨架（想法）。
 *
 * 纯 UI：默认入口目标文案 + 空状态。不访问 window.desktop / 数据库，
 * 不定义本地核心类型，不接入真实 Idea Intake。
 */

import { ProductPageFrame } from '../workflow/ProductPageFrame';

interface IdeaIntakePageProps {
  isActive?: boolean;
  onNavigate?: () => void;
}

export function IdeaIntakePage({ isActive = false, onNavigate }: IdeaIntakePageProps) {
  return (
    <ProductPageFrame
      title="想法"
      description="产品 1.0 默认入口。这里将承载创作访谈：自由文本、多轮补充、跳过问题、直接粘贴已有设定、选择作品形式。"
      isActive={isActive}
      onNavigate={onNavigate}
    >
      <p className="product-page-entry">告诉我你想写什么</p>
      <p className="empty-hint">创作访谈将在 Idea Intake 能力接入后启用。</p>
    </ProductPageFrame>
  );
}
