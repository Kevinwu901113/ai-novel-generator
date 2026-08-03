/**
 * Story Blueprint 页面骨架（规划）。
 *
 * 纯 UI：故事蓝图页面的布局与空状态。
 * 不访问 window.desktop / 数据库，不定义本地 StoryBlueprint 类型，
 * 不接入真实 Blueprint。
 */

import { ProductPageFrame } from '../workflow/ProductPageFrame';

interface BlueprintPageProps {
  isActive?: boolean;
  onNavigate?: () => void;
}

export function BlueprintPage({ isActive = false, onNavigate }: BlueprintPageProps) {
  return (
    <ProductPageFrame
      title="规划"
      description="故事蓝图：核心前提、主角与关键人物、主要关系、世界背景、主要冲突、结局方向、情节线与章节结构。"
      isActive={isActive}
      onNavigate={onNavigate}
    >
      <p className="empty-hint">故事蓝图尚未接入，将在主链契约冻结后启用。</p>
    </ProductPageFrame>
  );
}
