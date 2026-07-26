/**
 * ListProjects 用例。
 *
 * 从 app.sqlite 获取项目列表，按 last_opened_at 降序排列。
 * 缺失项目目录时标记为损坏/缺失状态，不崩溃。
 */

import type { ProjectSummary } from '@ai-novel/domain';
import type { ProjectIndexRepository, ProjectFileSystem } from './types.js';

/** ListProjects 用例依赖 */
export interface ListProjectsDeps {
  readonly projectIndexRepo: ProjectIndexRepository;
  readonly fileSystem: ProjectFileSystem;
}

/** 项目列表项（含缺失标记） */
export interface ProjectListItem extends ProjectSummary {
  readonly isMissing: boolean;
}

/**
 * 列出所有项目。
 *
 * 返回值中 isMissing=true 表示项目目录或 project.sqlite 已丢失。
 */
export function listProjects(deps: ListProjectsDeps): ReadonlyArray<ProjectListItem> {
  const { projectIndexRepo, fileSystem } = deps;

  const rows = projectIndexRepo.list();

  return rows.map((row) => {
    const isMissing = !fileSystem.exists(row.projectDirectory);
    return {
      id: row.id as ProjectListItem['id'],
      name: row.name,
      status: row.status as ProjectListItem['status'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastOpenedAt: row.lastOpenedAt,
      isMissing,
    };
  });
}
