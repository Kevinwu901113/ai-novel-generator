/**
 * Grill-me 问题规划器领域模型与验证。
 *
 * 纯 TypeScript，无外部依赖。定义：
 * - 版本化的模型输出 schema（GrillQuestionPlanSchemaV1）；
 * - 严格解析（拒绝非 JSON、markdown fence、JSON 前后额外文本、额外字段）；
 * - 引用完整性验证（existing 问题必须属于当前会话）；
 * - 完整依赖图环检测（Kahn 拓扑排序，覆盖已有问题图 + 本次计划图）。
 *
 * 模型不能控制正式实体字段（id/projectId/sessionId/version/status 等），
 * 这些由应用层生成。模型只提供 key/topic/text/rationale/dependencies。
 */

// ── 常量 ──────────────────────────────────────────────────────────

export const GRILL_QUESTION_PLAN_SCHEMA_VERSION = 1;

export const PLAN_LIMITS = {
  minQuestions: 1,
  maxQuestions: 20,
  maxKeyLength: 64,
  maxTopicLength: 200,
  maxTextLength: 2000,
  maxRationaleLength: 2000,
  maxDependenciesPerQuestion: 10,
  maxQuestionIdLength: 64,
} as const;

// ── 规范化计划类型（持久化结构）──────────────────────────────────

/** 规范化依赖：existing 引用正式问题 ID，planned 引用计划内 key */
export type NormalizedPlanDependency =
  | { readonly kind: 'existing'; readonly questionId: string }
  | { readonly kind: 'planned'; readonly questionKey: string };

/** 规范化计划问题项 */
export interface NormalizedPlanQuestion {
  readonly key: string;
  readonly topic: string;
  readonly text: string;
  readonly rationale: string;
  readonly dependencies: ReadonlyArray<NormalizedPlanDependency>;
}

/** 规范化问题计划（schemaVersion 1） */
export interface NormalizedQuestionPlan {
  readonly schemaVersion: typeof GRILL_QUESTION_PLAN_SCHEMA_VERSION;
  readonly questions: ReadonlyArray<NormalizedPlanQuestion>;
}

// ── 解析结果 ──────────────────────────────────────────────────────

export type PlanErrorCode =
  'GRILL_PLAN_SCHEMA_INVALID' | 'GRILL_PLAN_REFERENCE_INVALID' | 'GRILL_PLAN_CYCLE_DETECTED';

/** 失败阶段：json=输出根本不是合法 JSON 对象；structure=合法 JSON 但违反 schema；reference=引用非法 */
export type PlanParseStage = 'json' | 'structure' | 'reference';

export type PlanParseResult =
  | { readonly ok: true; readonly plan: NormalizedQuestionPlan }
  | {
      readonly ok: false;
      readonly code: PlanErrorCode;
      readonly stage: PlanParseStage;
      readonly message: string;
    };

// ── 工具 ──────────────────────────────────────────────────────────

function codePointLength(str: string): number {
  return [...str].length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(
  code: PlanErrorCode,
  message: string,
  stage: PlanParseStage = 'structure',
): PlanParseResult {
  return { ok: false, code, stage, message };
}

// ── 严格解析 ──────────────────────────────────────────────────────

const TOP_LEVEL_ALLOWED_KEYS: ReadonlySet<string> = new Set(['schemaVersion', 'questions']);
const QUESTION_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'key',
  'topic',
  'text',
  'rationale',
  'dependencies',
]);
const DEPENDENCY_ALLOWED_KEYS: ReadonlySet<string> = new Set(['kind', 'questionId', 'questionKey']);

/**
 * 严格解析模型输出为规范化问题计划。
 *
 * 拒绝：非 JSON、markdown code fence、JSON 前后额外文本、
 * 额外顶层/问题/依赖字段、错误 schemaVersion、超限、空文本、
 * 重复 key、重复依赖、自依赖、引用不存在的计划内 key。
 *
 * JSON.parse 本身会拒绝前后非空白文本与 code fence；
 * 此处额外显式拒绝 code fence 以给出稳定错误。
 */
export function parseQuestionPlanV1(rawText: string): PlanParseResult {
  if (typeof rawText !== 'string') {
    return fail('GRILL_PLAN_SCHEMA_INVALID', '模型输出不是字符串', 'json');
  }

  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return fail('GRILL_PLAN_SCHEMA_INVALID', '模型输出为空', 'json');
  }
  if (trimmed.includes('```')) {
    return fail('GRILL_PLAN_SCHEMA_INVALID', '模型输出包含 markdown 代码块', 'json');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return fail('GRILL_PLAN_SCHEMA_INVALID', '模型输出不是有效 JSON', 'json');
  }

  if (!isPlainObject(parsed)) {
    return fail('GRILL_PLAN_SCHEMA_INVALID', '顶层必须是 JSON 对象', 'json');
  }

  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_ALLOWED_KEYS.has(key)) {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `顶层包含额外字段: ${key}`);
    }
  }

  if (parsed.schemaVersion !== GRILL_QUESTION_PLAN_SCHEMA_VERSION) {
    return fail('GRILL_PLAN_SCHEMA_INVALID', 'schemaVersion 必须精确为 1');
  }

  if (!Array.isArray(parsed.questions)) {
    return fail('GRILL_PLAN_SCHEMA_INVALID', 'questions 必须是数组');
  }

  const questions = parsed.questions as ReadonlyArray<unknown>;
  if (questions.length < PLAN_LIMITS.minQuestions) {
    return fail('GRILL_PLAN_SCHEMA_INVALID', 'questions 不能为空');
  }
  if (questions.length > PLAN_LIMITS.maxQuestions) {
    return fail('GRILL_PLAN_SCHEMA_INVALID', `questions 数量超过上限 ${PLAN_LIMITS.maxQuestions}`);
  }

  const normalized: NormalizedPlanQuestion[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < questions.length; i++) {
    const item = questions[i];
    if (!isPlainObject(item)) {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `第 ${i + 1} 个问题不是对象`);
    }

    for (const key of Object.keys(item)) {
      if (!QUESTION_ALLOWED_KEYS.has(key)) {
        return fail('GRILL_PLAN_SCHEMA_INVALID', `第 ${i + 1} 个问题包含额外字段: ${key}`);
      }
    }

    // key
    if (typeof item.key !== 'string') {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `第 ${i + 1} 个问题缺少 key`);
    }
    const key = item.key.trim();
    if (key.length === 0) {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `第 ${i + 1} 个问题的 key 为空`);
    }
    if (codePointLength(key) > PLAN_LIMITS.maxKeyLength) {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `第 ${i + 1} 个问题的 key 超长`);
    }
    if (seenKeys.has(key)) {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 key 重复: ${key}`);
    }
    seenKeys.add(key);

    // topic
    if (typeof item.topic !== 'string') {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 缺少 topic`);
    }
    const topic = item.topic.trim();
    if (topic.length === 0) {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的 topic 为空`);
    }
    if (codePointLength(topic) > PLAN_LIMITS.maxTopicLength) {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的 topic 超长`);
    }

    // text
    if (typeof item.text !== 'string') {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 缺少 text`);
    }
    const text = item.text.trim();
    if (text.length === 0) {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的 text 为空`);
    }
    if (codePointLength(text) > PLAN_LIMITS.maxTextLength) {
      return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的 text 超长`);
    }

    // rationale（可选）
    let rationale = '';
    if (item.rationale !== undefined) {
      if (typeof item.rationale !== 'string') {
        return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的 rationale 必须是字符串`);
      }
      rationale = item.rationale.trim();
      if (codePointLength(rationale) > PLAN_LIMITS.maxRationaleLength) {
        return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的 rationale 超长`);
      }
    }

    // dependencies（可选）
    const dependencies: NormalizedPlanDependency[] = [];
    if (item.dependencies !== undefined) {
      if (!Array.isArray(item.dependencies)) {
        return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的 dependencies 必须是数组`);
      }
      const deps = item.dependencies as ReadonlyArray<unknown>;
      if (deps.length > PLAN_LIMITS.maxDependenciesPerQuestion) {
        return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的依赖数量超过上限`);
      }

      const seenDeps = new Set<string>();
      for (const dep of deps) {
        if (!isPlainObject(dep)) {
          return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的依赖项不是对象`);
        }
        for (const depKey of Object.keys(dep)) {
          if (!DEPENDENCY_ALLOWED_KEYS.has(depKey)) {
            return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的依赖项包含额外字段: ${depKey}`);
          }
        }
        if (dep.kind !== 'existing' && dep.kind !== 'planned') {
          return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的依赖 kind 非法`);
        }

        if (dep.kind === 'existing') {
          if (dep.questionKey !== undefined) {
            return fail(
              'GRILL_PLAN_SCHEMA_INVALID',
              `问题 ${key} 的 existing 依赖不应含 questionKey`,
            );
          }
          if (typeof dep.questionId !== 'string' || dep.questionId.trim().length === 0) {
            return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的 existing 依赖缺少 questionId`);
          }
          const questionId = dep.questionId.trim();
          if (codePointLength(questionId) > PLAN_LIMITS.maxQuestionIdLength) {
            return fail(
              'GRILL_PLAN_SCHEMA_INVALID',
              `问题 ${key} 的 existing 依赖 questionId 超长`,
            );
          }
          const dedupeToken = `existing:${questionId}`;
          if (seenDeps.has(dedupeToken)) {
            return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的依赖重复: ${dedupeToken}`);
          }
          seenDeps.add(dedupeToken);
          dependencies.push({ kind: 'existing', questionId });
        } else {
          if (dep.questionId !== undefined) {
            return fail(
              'GRILL_PLAN_SCHEMA_INVALID',
              `问题 ${key} 的 planned 依赖不应含 questionId`,
            );
          }
          if (typeof dep.questionKey !== 'string' || dep.questionKey.trim().length === 0) {
            return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的 planned 依赖缺少 questionKey`);
          }
          const questionKey = dep.questionKey.trim();
          if (questionKey === key) {
            return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 不能依赖自己`);
          }
          const dedupeToken = `planned:${questionKey}`;
          if (seenDeps.has(dedupeToken)) {
            return fail('GRILL_PLAN_SCHEMA_INVALID', `问题 ${key} 的依赖重复: ${dedupeToken}`);
          }
          seenDeps.add(dedupeToken);
          dependencies.push({ kind: 'planned', questionKey });
        }
      }
    }

    normalized.push({ key, topic, text, rationale, dependencies });
  }

  // planned 依赖必须引用同一计划内已定义的 key
  for (const question of normalized) {
    for (const dep of question.dependencies) {
      if (dep.kind === 'planned' && !seenKeys.has(dep.questionKey)) {
        return fail(
          'GRILL_PLAN_SCHEMA_INVALID',
          `问题 ${question.key} 依赖了计划内不存在的 key: ${dep.questionKey}`,
        );
      }
    }
  }

  return {
    ok: true,
    plan: { schemaVersion: GRILL_QUESTION_PLAN_SCHEMA_VERSION, questions: normalized },
  };
}

// ── 引用完整性验证 ────────────────────────────────────────────────

/**
 * 验证计划中所有 existing 依赖都属于当前会话的已有问题集合。
 *
 * 覆盖：existing 问题不存在、跨会话引用、跨项目引用
 * （这些引用都不会出现在本会话问题 ID 集合中）。
 */
export function validatePlanReferences(
  plan: NormalizedQuestionPlan,
  existingQuestionIds: ReadonlySet<string>,
): PlanParseResult {
  for (const question of plan.questions) {
    for (const dep of question.dependencies) {
      if (dep.kind === 'existing' && !existingQuestionIds.has(dep.questionId)) {
        return fail(
          'GRILL_PLAN_REFERENCE_INVALID',
          `问题 ${question.key} 依赖了不属于当前会话的问题: ${dep.questionId}`,
          'reference',
        );
      }
    }
  }
  return { ok: true, plan };
}

// ── 完整依赖图环检测 ──────────────────────────────────────────────

export type TopoOrderResult =
  | { readonly ok: true; readonly plannedOrder: ReadonlyArray<string> }
  | { readonly ok: false; readonly code: 'GRILL_PLAN_CYCLE_DETECTED'; readonly message: string };

const EXISTING_PREFIX = 'e:';
const PLANNED_PREFIX = 'p:';

/**
 * 对“已有问题图 + 本次计划问题图”执行完整拓扑排序（Kahn 算法）。
 *
 * 节点：已有问题 ID（命名空间 e:）与计划 key（命名空间 p:）。
 * 边方向为“依赖 → 被依赖者”（依赖必须先插入）。
 *
 * 检测：自环、两节点环、三节点及更长环、跨已有/计划的混合环、
 * 多个 disconnected component 中隐藏的环。
 *
 * 成功时返回计划 key 的拓扑顺序（依赖在前），用于安全插入。
 *
 * @param plan 规范化计划
 * @param existingDeps 已有问题 ID → 其依赖的已有问题 ID 列表
 */
export function topologicalPlanOrder(
  plan: NormalizedQuestionPlan,
  existingDeps: ReadonlyMap<string, ReadonlyArray<string>>,
): TopoOrderResult {
  const nodes = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  const ensureNode = (node: string): void => {
    if (!nodes.has(node)) {
      nodes.add(node);
      adjacency.set(node, new Set());
      inDegree.set(node, 0);
    }
  };

  const addEdge = (from: string, to: string): void => {
    ensureNode(from);
    ensureNode(to);
    const neighbors = adjacency.get(from)!;
    if (!neighbors.has(to)) {
      neighbors.add(to);
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    }
  };

  // 已有问题图：existing E 依赖 existing D => 边 D -> E
  for (const [existingId, deps] of existingDeps) {
    ensureNode(EXISTING_PREFIX + existingId);
    for (const dep of deps) {
      addEdge(EXISTING_PREFIX + dep, EXISTING_PREFIX + existingId);
    }
  }

  // 计划问题图
  for (const question of plan.questions) {
    const plannedNode = PLANNED_PREFIX + question.key;
    ensureNode(plannedNode);
    for (const dep of question.dependencies) {
      if (dep.kind === 'existing') {
        addEdge(EXISTING_PREFIX + dep.questionId, plannedNode);
      } else {
        addEdge(PLANNED_PREFIX + dep.questionKey, plannedNode);
      }
    }
  }

  // Kahn 拓扑排序
  const queue: string[] = [];
  for (const node of nodes) {
    if ((inDegree.get(node) ?? 0) === 0) {
      queue.push(node);
    }
  }

  const plannedOrder: string[] = [];
  let processed = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    processed++;
    if (node.startsWith(PLANNED_PREFIX)) {
      plannedOrder.push(node.slice(PLANNED_PREFIX.length));
    }
    for (const neighbor of adjacency.get(node)!) {
      const next = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, next);
      if (next === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (processed < nodes.size) {
    return {
      ok: false,
      code: 'GRILL_PLAN_CYCLE_DETECTED',
      message: '问题依赖图存在循环',
    };
  }

  return { ok: true, plannedOrder };
}
