/**
 * OpenProject 用例。
 *
 * 流程：
 * 1. 从 app.sqlite 定位项目
 * 2. 验证项目目录存在
 * 3. 检查数据库版本
 * 4. 从 project.sqlite 读取正式元数据
 * 5. 更新 app.sqlite 的 last_opened_at
 * 6. 返回完整 Project
 */

import type { Project } from '@ai-novel/domain';
import type {
  Clock,
  ProjectIndexRepository,
  ProjectMetadataStore,
  ProjectFileSystem,
} from './types.js';
import {
  ProjectNotFoundError,
  ProjectDirectoryMissingError,
  ProjectDatabaseInvalidError,
} from './errors.js';

/** OpenProject 用例依赖 */
export interface OpenProjectDeps {
  readonly clock: Clock;
  readonly projectIndexRepo: ProjectIndexRepository;
  readonly projectMetadataStore: ProjectMetadataStore;
  readonly fileSystem: ProjectFileSystem;
}

/** OpenProject 输入 */
export interface OpenProjectInput {
  readonly projectId: string;
}

/**
 * 打开项目。
 *
 * 从 project.sqlite 读取正式元数据（单一事实来源），
 * 同时更新 app.sqlite 的 last_opened_at。
 */
export function openProject(deps: OpenProjectDeps, input: OpenProjectInput): Project {
  const { clock, projectIndexRepo, projectMetadataStore, fileSystem } = deps;
  const { projectId } = input;

  // 1. 从 app.sqlite 定位项目
  const indexRow = projectIndexRepo.getById(projectId);
  if (!indexRow) {
    throw new ProjectNotFoundError(projectId);
  }

  // 2. 验证项目目录存在
  if (!fileSystem.exists(indexRow.projectDirectory)) {
    throw new ProjectDirectoryMissingError();
  }

  // 3. 检查数据库版本（project.sqlite 不存在时抛出 ProjectDatabaseInvalidError）
  try {
    projectMetadataStore.checkVersion(indexRow.projectDirectory);
  } catch {
    throw new ProjectDatabaseInvalidError();
  }

  // 4. 从 project.sqlite 读取正式元数据
  const metadata = projectMetadataStore.read(indexRow.projectDirectory);
  if (!metadata) {
    throw new ProjectDatabaseInvalidError();
  }

  // 5. 更新 last_opened_at
  const now = clock.now();
  projectIndexRepo.updateLastOpened(projectId, now);

  // 6. 返回完整 Project（以 project.sqlite 为正式来源）
  return {
    id: metadata.id as Project['id'],
    name: metadata.name,
    initialIdea: metadata.initialIdea,
    status: metadata.status as Project['status'],
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    lastOpenedAt: now,
  };
}
