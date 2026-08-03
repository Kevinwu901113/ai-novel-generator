/**
 * ResearchBundle 持久化仓库（GE-4）。
 *
 * research_bundles 表（migration v9）：问题计划、来源、事实笔记与结论，版本化。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ResearchBundle } from '@ai-novel/research-engine';
import type { ResearchBundleRepositoryPort } from '@ai-novel/application';

interface DbResearchBundleRow {
  id: string;
  project_id: string;
  version: number;
  depth: 'none' | 'light' | 'deep';
  bundle_json: string;
  created_at: string;
}

function decodeBundle(row: DbResearchBundleRow): ResearchBundle {
  const parsed: unknown = JSON.parse(row.bundle_json);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`research_bundles ${row.id} bundle_json 损坏`);
  }
  return parsed as ResearchBundle;
}

export class ResearchBundleRepositoryImpl implements ResearchBundleRepositoryPort {
  constructor(private readonly db: DatabaseSync) {}

  save(bundle: ResearchBundle, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO research_bundles (id, project_id, version, depth, bundle_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        bundle.id,
        bundle.projectId,
        bundle.version,
        bundle.depth,
        JSON.stringify(bundle),
        updatedAt,
      );
  }

  getById(projectId: string, bundleId: string): ResearchBundle | null {
    const row = this.db
      .prepare(
        'SELECT * FROM research_bundles WHERE project_id = ? AND id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(projectId, bundleId) as DbResearchBundleRow | undefined;
    if (!row) return null;
    return decodeBundle(row);
  }

  listByProject(projectId: string): ReadonlyArray<ResearchBundle> {
    const rows = this.db
      .prepare('SELECT * FROM research_bundles WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as unknown as ReadonlyArray<DbResearchBundleRow>;
    return rows.map(decodeBundle);
  }
}
