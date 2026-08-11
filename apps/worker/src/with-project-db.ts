/**
 * TD-023 连接纪律（sync executor 版）：`getProjectDb` 每次调用都新开一条
 * project.sqlite 连接（见 index.ts getProjectDb——不是缓存）。sync executor 在
 * execute 内自开自关：结束（含抛错）在 finally 关闭，连接不逃逸出本次节点执行。
 * 与 graph-handlers withGraphDeps / grill·blueprint handlers 的每命令开关同纪律。
 *
 * 关闭安全性：`runSyncAndSettle`（application node-runner.ts）在任何事务之外调用
 * `runner.execute(ctx)`，且 NodeOutput 只含纯数据（outcome / artifact ref），
 * 执行结束即关不影响后续 settle。
 */

import type { ProjectDatabase } from '@ai-novel/database';

export function withProjectDb<T>(
  getProjectDb: (projectId: string) => ProjectDatabase,
  projectId: string,
  fn: (projDb: ProjectDatabase) => T,
): T {
  const projDb = getProjectDb(projectId);
  try {
    return fn(projDb);
  } finally {
    projDb.close();
  }
}
