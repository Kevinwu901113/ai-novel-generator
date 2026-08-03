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

  save(blueprint: StoryBlueprint, accepted: boolean, updatedAt: string): void {
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
        updatedAt,
      );
  }

  getById(
    projectId: string,
    blueprintId: string,
  ): { readonly blueprint: StoryBlueprint; readonly accepted: boolean } | null {
    const row = this.db
      .prepare(
        'SELECT * FROM story_blueprints WHERE project_id = ? AND id = ? ORDER BY version DESC LIMIT 1',
      )
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
}
