/**
 * Executor Registry（RW-1）。
 *
 * 按 graph kind + nodeId 查找 executor 描述符。registry 为 Application/Worker 内部
 * 能力，不进入 Renderer、不作为用户可配置 DAG。
 * 未注册 executor 的节点 → runner 走 fail-closed（applyNodeFailure）。
 */

import type { NodeExecutorDescriptor, ExecutorKey } from './node-execution-types.js';

export class ExecutorRegistry {
  private readonly descriptors = new Map<string, NodeExecutorDescriptor>();

  register(descriptor: NodeExecutorDescriptor): void {
    const key = keyOf({ graphKind: descriptor.graphKind, nodeId: descriptor.nodeId });
    if (this.descriptors.has(key)) {
      throw new Error(`executor 重复注册: ${key}`);
    }
    this.descriptors.set(key, descriptor);
  }

  get(key: ExecutorKey): NodeExecutorDescriptor | null {
    return this.descriptors.get(keyOf(key)) ?? null;
  }

  has(key: ExecutorKey): boolean {
    return this.descriptors.has(keyOf(key));
  }

  /** 全部已注册描述符（调试/恢复扫描） */
  list(): ReadonlyArray<NodeExecutorDescriptor> {
    return [...this.descriptors.values()];
  }
}

function keyOf(key: ExecutorKey): string {
  return `${key.graphKind}:${key.nodeId}`;
}
