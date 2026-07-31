/**
 * 创作契约草案 prompt source-of-truth 严格验证。
 *
 * Prompt 上下文来自 SQLite source of truth（questions / current answers /
 * accepted grill proposals）。repository port 可能返回跨 session 数据或损坏数据，
 * 必须在构建 prompt / 调用模型前严格验证，不得静默丢弃或把损坏数据喂给模型。
 *
 * 任一 source-of-truth 损坏 → ContractDataCorruptionError：
 * - task 安全 FAILED；
 * - 不调用模型；
 * - 不创建 proposal；
 * - public message 不包含 answer text / question text / proposal JSON /
 *   内部 ID 关系（detail 进入 cause）。
 *
 * 验证规则：
 * - Questions：id trim 非空；sessionId 匹配；id 唯一；dependsOnQuestionIds 唯一；
 *   每个 dependency 指向同 session 的现有 question；禁止 self-reference；
 *   status 合法。
 * - Current answers：id trim 非空；sessionId 匹配；questionId 指向已加载 question；
 *   answer id 唯一；同一 question 最多一个 current answer；revision 正安全整数；
 *   source 合法。
 * - Grill proposals：id trim 非空；sessionId 匹配；status 合法；id 唯一。
 *   - ACCEPTED（进入 prompt）：proposedValueJson 必须是有效 JSON；
 *     basedOnAnswerIds 唯一；每个 answer id 必须通过 answerRepo.getById 找到
 *     且属于同一 session。
 *   - REJECTED / SUPERSEDED / PROPOSED（不进入 prompt）：进行最小
 *     status / ownership 验证，避免 port 返回跨 session 数据后被静默忽略。
 */

import { ContractDataCorruptionError } from '@ai-novel/application';
import type {
  GrillQuestionData,
  GrillAnswerData,
  GrillProposalData,
  GrillAnswerRepositoryPort,
} from '@ai-novel/application';

// ── 合法枚举 ──────────────────────────────────────────────────────

const GRILL_QUESTION_STATUSES: ReadonlySet<string> = new Set([
  'PLANNED',
  'ASKED',
  'ANSWERED',
  'SKIPPED',
  'SUPERSEDED',
]);

const GRILL_ANSWER_SOURCES: ReadonlySet<string> = new Set(['USER', 'IMPORTED']);

const GRILL_PROPOSAL_STATUSES: ReadonlySet<string> = new Set([
  'PROPOSED',
  'ACCEPTED',
  'REJECTED',
  'SUPERSEDED',
]);

// ── 工具 ──────────────────────────────────────────────────────────

function corrupt(detail: string): ContractDataCorruptionError {
  return new ContractDataCorruptionError(`creation_contract_draft context: ${detail}`);
}

// ── 验证 ──────────────────────────────────────────────────────────

export interface ContractDraftContextDeps {
  readonly sessionId: string;
  readonly questions: ReadonlyArray<GrillQuestionData>;
  readonly answers: ReadonlyArray<GrillAnswerData>;
  readonly proposals: ReadonlyArray<GrillProposalData>;
  readonly answerRepo: GrillAnswerRepositoryPort;
}

export interface ValidatedContractDraftContext {
  readonly questions: ReadonlyArray<GrillQuestionData>;
  readonly answers: ReadonlyArray<GrillAnswerData>;
  readonly acceptedProposals: ReadonlyArray<GrillProposalData>;
}

/**
 * 严格验证 prompt source-of-truth 并返回进入 prompt 的 accepted proposals。
 *
 * 失败抛 ContractDataCorruptionError（code=INTERNAL_ERROR，public message 固定）。
 */
export function validateContractDraftContext(
  deps: ContractDraftContextDeps,
): ValidatedContractDraftContext {
  const { sessionId, questions, answers, proposals, answerRepo } = deps;

  // ── Questions ──
  const questionIds = new Set<string>();
  const questionById = new Map<string, GrillQuestionData>();
  for (const q of questions) {
    if (typeof q.id !== 'string' || q.id.trim().length === 0) throw corrupt('question id 为空');
    if (q.sessionId !== sessionId) throw corrupt('question 不属于当前会话');
    if (questionIds.has(q.id)) throw corrupt('question id 重复');
    questionIds.add(q.id);
    questionById.set(q.id, q);
    if (!GRILL_QUESTION_STATUSES.has(q.status)) throw corrupt('question status 非法');

    const depIds = q.dependsOnQuestionIds;
    if (!Array.isArray(depIds)) throw corrupt('dependsOnQuestionIds 非法');
    const seenDeps = new Set<string>();
    for (const dep of depIds) {
      if (typeof dep !== 'string' || dep.trim().length === 0) throw corrupt('dependency 非法');
      if (dep === q.id) throw corrupt('question 自引用');
      if (seenDeps.has(dep)) throw corrupt('dependency 重复');
      seenDeps.add(dep);
      if (!questionById.has(dep)) throw corrupt('dependency 指向不存在的 question');
    }
  }

  // ── Current answers ──
  const answerIds = new Set<string>();
  const answerByQuestion = new Map<string, GrillAnswerData>();
  for (const a of answers) {
    if (typeof a.id !== 'string' || a.id.trim().length === 0) throw corrupt('answer id 为空');
    if (a.sessionId !== sessionId) throw corrupt('answer 不属于当前会话');
    if (!questionById.has(a.questionId)) throw corrupt('answer 引用不存在的 question');
    if (answerIds.has(a.id)) throw corrupt('answer id 重复');
    answerIds.add(a.id);
    if (answerByQuestion.has(a.questionId)) {
      throw corrupt('同一 question 存在多个 current answer');
    }
    answerByQuestion.set(a.questionId, a);
    if (!Number.isSafeInteger(a.revision) || a.revision < 1) {
      throw corrupt('answer revision 非法');
    }
    if (!GRILL_ANSWER_SOURCES.has(a.source)) throw corrupt('answer source 非法');
  }

  // ── Proposals ──
  const proposalIds = new Set<string>();
  const acceptedProposals: GrillProposalData[] = [];
  for (const p of proposals) {
    if (typeof p.id !== 'string' || p.id.trim().length === 0) throw corrupt('proposal id 为空');
    if (p.sessionId !== sessionId) throw corrupt('proposal 不属于当前会话');
    if (!GRILL_PROPOSAL_STATUSES.has(p.status)) throw corrupt('proposal status 非法');
    if (proposalIds.has(p.id)) throw corrupt('proposal id 重复');
    proposalIds.add(p.id);

    if (p.status === 'ACCEPTED') {
      try {
        JSON.parse(p.proposedValueJson);
      } catch {
        throw corrupt('accepted proposal 的 proposedValueJson 无效');
      }
      const basedOn = p.basedOnAnswerIds;
      if (!Array.isArray(basedOn)) throw corrupt('accepted proposal basedOnAnswerIds 非法');
      const seenAnswers = new Set<string>();
      for (const aid of basedOn) {
        if (typeof aid !== 'string' || aid.trim().length === 0) {
          throw corrupt('basedOnAnswerId 非法');
        }
        if (seenAnswers.has(aid)) throw corrupt('basedOnAnswerId 重复');
        seenAnswers.add(aid);
        const answer = answerRepo.getById(aid);
        if (!answer) throw corrupt('basedOnAnswerId 指向不存在的 answer');
        if (answer.sessionId !== sessionId) throw corrupt('basedOn answer 不属于当前会话');
      }
      acceptedProposals.push(p);
    }
  }

  return { questions, answers, acceptedProposals };
}
