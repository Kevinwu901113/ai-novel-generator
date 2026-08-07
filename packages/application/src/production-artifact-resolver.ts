/**
 * RW-1-R5 生产 artifact 边界：transaction-scoped resolver（TD-019 抽取为共享实现）。
 *
 * 从**持久化 provenance**（而非调用方字段）校验 kind/id/version/project/run/node/execution；
 * 删除旧的 artifactId===executionId 伪校验。
 * - researchBundle / storyBlueprint：provenance 行 + 真实表（research_bundles / story_blueprints）；
 * - generationRun：权威 execution-bound durable envelope（按真实 artifactId 可寻址）；
 * - idea / creationSpec / manuscript：provenance 行校验 producer 归属（GE-3/GE-7 接底层存储）。
 *
 * 此实现原为 apps/worker/src/index.ts 内的对象字面量；packages/database 的集成测试曾手写一份
 * 等价逻辑（realResolver），两者一度在 idea/creationSpec/manuscript 放行分支上漂移。现抽成
 * 唯一权威实现，worker 与测试共同引用，禁止再各写一份。
 */

import { isArtifactKind } from '@ai-novel/domain';
import type { ArtifactResolverPort } from './node-execution-types.js';

export const productionArtifactResolver: ArtifactResolverPort = {
  resolve(repos, input) {
    if (!isArtifactKind(input.proposed.kind)) throw new Error('非法 artifact kind');
    if (input.proposed.producerNodeId !== input.nodeId) {
      throw new Error('producer node 不匹配');
    }
    // 公共 provenance 校验：execution 必须是该 artifact 的真实产出者
    if (input.proposed.kind !== 'generationRun') {
      const prov = repos.artifactProvenanceRepo.getByArtifact(
        input.proposed.kind,
        input.proposed.artifactId,
      );
      if (!prov)
        throw new Error(
          `artifact ${input.proposed.kind}:${input.proposed.artifactId} 无 provenance`,
        );
      if (
        prov.executionId !== input.executionId ||
        prov.graphRunId !== input.graphRunId ||
        prov.nodeId !== input.nodeId ||
        prov.projectId !== input.projectId ||
        prov.version !== input.proposed.version
      ) {
        throw new Error('artifact provenance 与当前 execution/run/node 不匹配');
      }
    }
    switch (input.proposed.kind) {
      case 'researchBundle': {
        const bundle = repos.researchBundleRepo.getById(input.projectId, input.proposed.artifactId);
        if (!bundle) throw new Error('researchBundle 不存在');
        if (bundle.version !== input.proposed.version) {
          throw new Error('researchBundle version 不匹配');
        }
        break;
      }
      case 'storyBlueprint': {
        const bp = repos.storyBlueprintRepo.getById(input.projectId, input.proposed.artifactId);
        if (!bp) throw new Error('storyBlueprint 不存在');
        if (bp.blueprint.version !== input.proposed.version) {
          throw new Error('storyBlueprint version 不匹配');
        }
        break;
      }
      case 'generationRun': {
        // 按真实 artifactId 可寻址（Blocker 5）+ execution 归属校验
        const envelope = repos.nodeExecutionResultStore.getByArtifactId(input.proposed.artifactId);
        if (!envelope) throw new Error('generationRun 无权威 result envelope（按 artifactId）');
        if (envelope.executionId !== input.executionId) {
          throw new Error('generationRun 非当前 execution 产出');
        }
        if (envelope.artifactVersion !== input.proposed.version) {
          throw new Error('generationRun version 不匹配');
        }
        if (envelope.projectId !== input.projectId || envelope.graphRunId !== input.graphRunId) {
          throw new Error('generationRun project/run 不匹配');
        }
        break;
      }
      case 'idea':
      case 'creationSpec':
      case 'manuscript':
        // provenance 已校验 producer 归属；底层权威存储属于 GE-3 / GE-7
        break;
    }
    return {
      kind: input.proposed.kind,
      artifactId: input.proposed.artifactId,
      producerNodeId: input.proposed.producerNodeId,
      projectId: input.projectId,
      graphRunId: input.graphRunId,
      graphVersion: input.graphVersion,
      version: input.proposed.version,
    };
  },
};
