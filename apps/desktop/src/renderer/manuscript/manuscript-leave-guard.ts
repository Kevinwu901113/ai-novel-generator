/**
 * 稿件工作区离开守卫共享模块（MV1-B）。
 *
 * 稿件工作台通过 registerManuscriptLeaveGuard 注册 dirty 查询；
 * App 在切换项目前调用 manuscriptHasDirty() 决定是否弹出离开确认对话框。
 * 不持久化任何未保存正文。
 */

export interface ManuscriptLeaveGuard {
  isDirty(): boolean;
}

const guards = new Set<ManuscriptLeaveGuard>();

export function registerManuscriptLeaveGuard(guard: ManuscriptLeaveGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

export function manuscriptHasDirty(): boolean {
  for (const guard of guards) {
    if (guard.isDirty()) return true;
  }
  return false;
}
