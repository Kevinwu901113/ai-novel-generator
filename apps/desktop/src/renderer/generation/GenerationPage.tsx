/**
 * Generation 页面骨架（生成）。
 *
 * 纯 UI：章节生成页面的布局与空状态。
 * 不访问 window.desktop / 数据库，不定义本地 GenerationRun 类型，
 * 不接入真实 Generation。
 */

import { ProductPageFrame } from '../workflow/ProductPageFrame';

interface GenerationPageProps {
  isActive?: boolean;
  onNavigate?: () => void;
}

export function GenerationPage({ isActive = false, onNavigate }: GenerationPageProps) {
  return (
    <ProductPageFrame
      title="生成"
      description="章节生成：按创作要求与故事蓝图生成章节，写入稿件前保留用户手写正文不被静默覆盖。"
      isActive={isActive}
      onNavigate={onNavigate}
    >
      <p className="empty-hint">章节生成尚未接入，将在主链契约冻结后启用。</p>
    </ProductPageFrame>
  );
}
