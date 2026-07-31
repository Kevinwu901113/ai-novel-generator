/**
 * 未来生成策略端口。
 *
 * 本 PR 只定义纯接口并使用 fake generator 测试；
 * 不提供 model-gateway adapter，不读取 provider profile，不创建 task，不调用真实模型。
 */

import type {
  WritingCandidateGeneratorPort,
  WritingCandidateV1,
  WritingGenerationExperimentInput,
} from './schema.js';

export type { WritingCandidateGeneratorPort, WritingCandidateV1, WritingGenerationExperimentInput };

/**
 * fake generator（仅测试/演示用）。
 * 从固定候选文本中按 caseId 选择返回，用于验证评测链路而不依赖真实模型。
 */
export function createFakeCandidateGenerator(
  candidateByCase: ReadonlyMap<string, WritingCandidateV1>,
): WritingCandidateGeneratorPort {
  return {
    async generate(input: WritingGenerationExperimentInput): Promise<WritingCandidateV1> {
      const candidate = candidateByCase.get(input.caseId);
      if (!candidate) {
        throw new Error(`fake generator 未配置 case "${input.caseId}"`);
      }
      return candidate;
    },
  };
}
