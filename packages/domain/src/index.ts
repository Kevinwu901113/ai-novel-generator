/**
 * @ai-novel/domain
 *
 * 纯 TypeScript 领域模型和规则。
 * 不依赖 Electron、React、Node.js 专有 API、SQLite 或具体模型提供商。
 * 不负责随机 ID 生成 —— ID 由调用方注入。
 */

/** 项目唯一标识符 */
export type ProjectId = string & { readonly __brand: 'ProjectId' };

/** 项目状态 */
export type ProjectStatus =
  | 'idea' // 模糊想法阶段
  | 'grill-me' // 需求澄清中
  | 'research' // 资料研究中
  | 'contract' // 创作契约阶段
  | 'planning' // 规划中
  | 'drafting' // 正文创作中
  | 'reviewing' // 审稿中
  | 'completed'; // 已完成

/** 任务状态 */
export type TaskStatus =
  | 'pending' // 待处理
  | 'in-progress' // 进行中
  | 'blocked' // 被阻塞
  | 'completed' // 已完成
  | 'failed'; // 失败

/** 决策范围 */
export type DecisionScope =
  | 'project' // 项目级决策
  | 'chapter' // 章节级决策
  | 'scene' // 场景级决策
  | 'line'; // 行级决策

/** 变更集 —— 跨模块更新的最小单位 */
export interface ChangeSet {
  readonly id: string;
  readonly scope: DecisionScope;
  readonly targetId: string;
  readonly changes: ReadonlyArray<ChangeEntry>;
  readonly createdAt: string;
  readonly reason: string;
}

/** 变更条目 */
export interface ChangeEntry {
  readonly field: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

/** 创建 ProjectId（验证，不生成） */
export function createProjectId(raw: string): ProjectId {
  if (!raw || raw.trim().length === 0) {
    throw new Error('ProjectId 不能为空');
  }
  return raw as ProjectId;
}

/**
 * 创建 ChangeSet。
 *
 * id 和 createdAt 由调用方注入，domain 不负责随机 ID 生成。
 * 这样 Node 基础设施侧可用 crypto.randomUUID()，测试可注入固定值。
 */
export function createChangeSet(
  id: string,
  scope: DecisionScope,
  targetId: string,
  changes: ReadonlyArray<ChangeEntry>,
  reason: string,
  createdAt: string,
): ChangeSet {
  if (!id || id.trim().length === 0) {
    throw new Error('ChangeSet id 不能为空');
  }
  return { id, scope, targetId, changes, createdAt, reason };
}
