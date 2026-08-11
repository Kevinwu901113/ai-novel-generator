/**
 * StoryBlueprint 持久化仓库（GE-5）。
 *
 * story_blueprints 表（migration v10）：版本化 + accepted 标记。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { StoryBlueprint } from '@ai-novel/domain';
import type { StoryBlueprintRepositoryPort } from '@ai-novel/application';

interface DbStoryBlueprintRow {
  id: string;
  project_id: string;
  version: number;
  blueprint_json: string;
  accepted: number;
  created_at: string;
}

function decodeBlueprint(row: DbStoryBlueprintRow): StoryBlueprint {
  const parsed: unknown = JSON.parse(row.blueprint_json);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`story_blueprints ${row.id} blueprint_json 损坏`);
  }
  return parsed as StoryBlueprint;
}

export class StoryBlueprintRepositoryImpl implements StoryBlueprintRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * D-B7-12：此前签名为 `save(blueprint, accepted, updatedAt)`，但 `updatedAt` 参数名与
   * 它实际写入的 `created_at` 列语义错位（该表无 updated_at 列）。blueprint 自带
   * `createdAt` 字段（由调用方在同一事务内以 clock.now() 生成），直接使用即可，
   * 无需重复传参。
   */
  save(blueprint: StoryBlueprint, accepted: boolean): void {
    this.db
      .prepare(
        `INSERT INTO story_blueprints (id, project_id, version, blueprint_json, accepted, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        blueprint.id,
        blueprint.projectId,
        blueprint.version,
        JSON.stringify(blueprint),
        accepted ? 1 : 0,
        blueprint.createdAt,
      );
  }

  getById(
    projectId: string,
    blueprintId: string,
  ): { readonly blueprint: StoryBlueprint; readonly accepted: boolean } | null {
    // D-B7-12：PK 是 (project_id, id) —— 每个 id 在项目内恒单行（新版本 = 新 id，
    // 不是同一 id 多行）。此前的 `ORDER BY version DESC LIMIT 1` 无意义，一并去掉。
    const row = this.db
      .prepare('SELECT * FROM story_blueprints WHERE project_id = ? AND id = ?')
      .get(projectId, blueprintId) as DbStoryBlueprintRow | undefined;
    if (!row) return null;
    return { blueprint: decodeBlueprint(row), accepted: row.accepted === 1 };
  }

  listByProject(projectId: string): ReadonlyArray<StoryBlueprint> {
    const rows = this.db
      .prepare('SELECT * FROM story_blueprints WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as unknown as ReadonlyArray<DbStoryBlueprintRow>;
    return rows.map(decodeBlueprint);
  }

  markAccepted(projectId: string, blueprintId: string): boolean {
    const result = this.db
      .prepare('UPDATE story_blueprints SET accepted = 1 WHERE project_id = ? AND id = ?')
      .run(projectId, blueprintId);
    return result.changes === 1;
  }

  /** D-B7-5：executor 在最终事务内取该项目现有 MAX(version)，+1 作为新版本号；无蓝图时返回 0。 */
  getMaxVersion(projectId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) as v FROM story_blueprints WHERE project_id = ?')
      .get(projectId) as { v: number };
    return row.v;
  }
}
