/**
 * Web Research 页面骨架（调研）。
 *
 * 纯 UI：调研资料包（ResearchBundle）页面的布局与空状态。
 * 不访问 window.desktop / 数据库，不定义本地 ResearchBundle 类型，
 * 不接入真实 Web Research。
 */

import { ProductPageFrame } from '../workflow/ProductPageFrame';

interface ResearchPageProps {
  isActive?: boolean;
  onNavigate?: () => void;
}

export function ResearchPage({ isActive = false, onNavigate }: ResearchPageProps) {
  return (
    <ProductPageFrame
      title="调研"
      description="调研资料包：调研强度判断、调研问题计划、来源记录、事实笔记与调研结论。"
      isActive={isActive}
      onNavigate={onNavigate}
    >
      <p className="empty-hint">Web Research 能力尚未接入，将在主链契约冻结后启用。</p>
    </ProductPageFrame>
  );
}
