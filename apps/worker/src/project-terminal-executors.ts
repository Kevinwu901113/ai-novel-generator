/**
 * Project Graph 终止节点 executor（B7 随行修复）。
 *
 * 侦察缺口：`driveRun` 对 TERMINAL kind 节点没有特殊豁免——和其它节点一样必须经
 * registry 查到已注册 executor 才能被 claim + settle（node-runner.ts `dispatchNode`
 * → `claimAndDispatch` 一律走 `deps.registry.get(...)`；无特殊分支）。PROJECT_READY /
 * PROJECT_CANCELLED / PROJECT_BLOCKED 三个终止节点自图诞生起从未被注册过 executor——
 * 此前所有批次（B1..B6）的测试都止步于人工 Gate 或某个 unregistered 节点，从未真正
 * 驱动到终止节点，这个空白一直没被触发。
 *
 * 设计文档"节点执行策略"表把 TERMINAL 行标为"既有机制，无需新代码"——该假设基于
 * `applyNodeSuccess` transition 对 TERMINAL 节点会写 `terminalStatus`（这部分确实是
 * 既有机制，见 idea-to-novel-graph-transitions.ts），但遗漏了"谁来触发这次
 * applyNodeSuccess"这一层：driveRun 仍然要求该节点有注册 executor 才会 claim 它。
 * 本文件补齐这道最后一公里——三个终止节点各自一个平凡 sync executor（无 outcome、
 * 无 artifact，`output: noOut` 已在图定义强制），产出恒为 `{}`。
 *
 * 这不是 D-B7-1..12 中的任何一条决策，是实现 GE-5 "PROJECT_READY 原子闭环"退出条件
 * （必须真正到达 PROJECT_READY/CANCELLED/BLOCKED）过程中发现的前置阻塞，随批次一并
 * 修复；同样的空白对 Chapter Graph 终止节点（CHAPTER_READY 等）依然存在，但 GE-6
 * 尚未接线真实 executor，不在本批次触发范围内，未处理。
 */

import type {
  ExecutorRegistry,
  NodeExecutorDescriptor,
  NodeExecutorRunner,
} from '@ai-novel/application';
import { IDEA_TO_NOVEL_PROJECT_GRAPH_V1 } from '@ai-novel/domain';

const PROJECT_TERMINAL_NODE_IDS: ReadonlyArray<string> = IDEA_TO_NOVEL_PROJECT_GRAPH_V1.nodes
  .filter((n) => n.kind === 'TERMINAL')
  .map((n) => n.id);

/** 把 Project Graph 全部 TERMINAL 节点注册为平凡 sync executor（worker 启动时调用一次） */
export function registerProjectTerminalExecutors(
  registry: ExecutorRegistry,
  runners: Map<string, NodeExecutorRunner>,
): void {
  for (const nodeId of PROJECT_TERMINAL_NODE_IDS) {
    const descriptor: NodeExecutorDescriptor = {
      executorId: `project-terminal-${nodeId.toLowerCase()}-v1`,
      executorVersion: 'v1',
      graphKind: 'project',
      nodeId: nodeId as never,
      kind: 'sync',
      recoveryPolicy: 'replayable',
    };
    registry.register(descriptor);
    runners.set(descriptor.executorId, {
      descriptor,
      execute: () => ({}),
    } as NodeExecutorRunner);
  }
}
