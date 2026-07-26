/**
 * @ai-novel/application
 *
 * 应用用例和流程接口的占位结构。
 * 不依赖 Electron UI。
 */

export type { ProjectId, ProjectStatus, TaskStatus } from '@ai-novel/domain';

/** ID 生成器接口 —— 基础设施侧实现，测试可注入固定值 */
export interface IdGenerator {
  generate(): string;
}
