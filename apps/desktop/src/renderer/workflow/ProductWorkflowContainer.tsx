/**
 * 产品工作区容器（骨架）。
 *
 * 按 Idea-to-Novel 主链顺序渲染五个产品页面：
 *   想法 → 调研 → 规划 → 生成 → 稿件
 *
 * 本容器是**后续接入权威 WorkflowStage 的工作区容器**。当前仅为纯 UI 布局：
 * - `activeIndex` 是展示用的步骤序号（0-4），不是业务枚举；
 * - `onNavigate` 是未来导航接入点，当前骨架不接入；
 * - 不访问 window.desktop / 数据库，不定义本地核心类型，不引入 fixture 业务数据。
 *
 * 【Agent B 契约合并后接入点】
 * - 以 @ai-novel/contracts 的 `WorkflowStage` 驱动步骤渲染与当前阶段高亮，
 *   替换当前纯 UI 的 `activeIndex` 顺序；
 * - 各页面经冻结的 DesktopAPI（Idea Intake / Research / Blueprint / Generation）读取数据与执行动作；
 * - 由 App shell（ProjectWorkspaceShell）在项目打开时装配为默认产品工作区。
 * 在契约冻结前，本容器不建立临时业务枚举，也不把产品页接成默认生产流程。
 */

import { BlueprintPage } from '../blueprint/BlueprintPage';
import { GenerationPage } from '../generation/GenerationPage';
import { IdeaIntakePage } from '../idea-intake/IdeaIntakePage';
import { ResearchPage } from '../research/ResearchPage';
import { ProductPageFrame } from './ProductPageFrame';

interface ProductWorkflowContainerProps {
  /** 当前高亮步骤的序号（0-4）。纯 UI 展示用；WorkflowStage 契约后由权威 stage 驱动。 */
  activeIndex?: number | null;
  /** 未来接入点：App 装配后提供的页面导航动作。当前骨架不接入。 */
  onNavigate?: () => void;
}

export function ProductWorkflowContainer({
  activeIndex = null,
  onNavigate,
}: ProductWorkflowContainerProps) {
  return (
    <div className="product-workflow">
      <h2 className="product-workflow-heading">创作主链</h2>
      <p className="product-workflow-hint">想法 → 调研 → 规划 → 生成 → 稿件</p>
      <ol className="product-stage-list">
        <li className="product-stage-item">
          <IdeaIntakePage isActive={activeIndex === 0} onNavigate={onNavigate} />
        </li>
        <li className="product-stage-item">
          <ResearchPage isActive={activeIndex === 1} onNavigate={onNavigate} />
        </li>
        <li className="product-stage-item">
          <BlueprintPage isActive={activeIndex === 2} onNavigate={onNavigate} />
        </li>
        <li className="product-stage-item">
          <GenerationPage isActive={activeIndex === 3} onNavigate={onNavigate} />
        </li>
        <li className="product-stage-item">
          <ProductPageFrame
            title="稿件"
            description="按章组织的正文：查看、修改、重新生成、继续生成与导出。"
            isActive={activeIndex === 4}
            onNavigate={onNavigate}
          >
            <p className="empty-hint">Manuscript 页面暂不从 PR #25 移植。</p>
          </ProductPageFrame>
        </li>
      </ol>
    </div>
  );
}
