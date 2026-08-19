/**
 * 故事图谱（D14 / B22）的应用层数据类型与仓库端口。
 *
 * 类型定义在应用层而不是 database 包：抽取引擎在 task-engine，而 task-engine
 * 不依赖 database（模块边界），端口必须落在两者共同依赖的应用层。database 的
 * migration v22 仓库实现结构上满足这些端口（`*RepositoryImpl implements *Port`）。
 *
 * 语义纪律见 `docs/development/b22-story-graph-data-design.md`：
 * - 状态边 append-only，关闭旧边只碰 valid_until_chapter / superseded_by_id（D-B22-1）；
 * - 自动抽取只写 origin='extracted'，user 覆盖层永不被触碰（D-B22-4）；
 * - 自动抽取永不合并既有实体，疑似同实体只进待审队列（D-B22-5）。
 */

// ── 字面量 ────────────────────────────────────────────────────────

/** 图记录来源：自动抽取 / 用户覆盖层 */
export type StoryOrigin = 'extracted' | 'user';

/** 实体种类 */
export type StoryEntityKind = 'character' | 'location' | 'item' | 'setting';

/** 线程（伏笔）状态 */
export type StoryThreadStatus = 'open' | 'closed' | 'abandoned';

/** 抽取账本状态 */
export type StoryExtractionStatus = 'pending' | 'succeeded' | 'failed';

/** 同名异人待审状态 */
export type StoryMergeReviewStatus = 'pending' | 'merged' | 'rejected';

// ── 数据 ──────────────────────────────────────────────────────────

/** 实体 */
export interface StoryEntityData {
  readonly id: string;
  readonly projectId: string;
  readonly kind: StoryEntityKind;
  readonly canonicalName: string;
  readonly profileSummary: string;
  readonly firstChapter: number | null;
  readonly origin: StoryOrigin;
  /** 软合并后指向存续实体（可回退）；自动抽取永不填此列 */
  readonly mergedIntoId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建实体（updated_at 初始化为 createdAt） */
export interface CreateStoryEntityInput {
  readonly id: string;
  readonly projectId: string;
  readonly kind: StoryEntityKind;
  readonly canonicalName: string;
  readonly profileSummary: string;
  readonly firstChapter: number | null;
  readonly origin: StoryOrigin;
  readonly createdAt: string;
}

/** 实体别名 */
export interface StoryEntityAliasData {
  readonly id: string;
  readonly projectId: string;
  readonly entityId: string;
  readonly alias: string;
  readonly origin: StoryOrigin;
  readonly createdAt: string;
}

/** 创建别名 */
export interface CreateStoryEntityAliasInput {
  readonly id: string;
  readonly projectId: string;
  readonly entityId: string;
  readonly alias: string;
  readonly origin: StoryOrigin;
  readonly createdAt: string;
}

/** 状态/关系边（append-only：内容列写入后不再改，只关闭） */
export interface StoryStateData {
  readonly id: string;
  readonly projectId: string;
  readonly subjectEntityId: string;
  readonly predicate: string;
  readonly objectEntityId: string | null;
  readonly objectText: string | null;
  readonly validFromChapter: number;
  /** NULL = 仍有效 */
  readonly validUntilChapter: number | null;
  readonly sourceChapterId: string | null;
  readonly sourceContentHash: string | null;
  readonly evidenceSpan: string | null;
  readonly confidence: number | null;
  readonly origin: StoryOrigin;
  readonly supersededById: string | null;
  readonly createdAt: string;
}

/**
 * 插入状态边。
 *
 * 没有 validUntilChapter / supersededById：新边一律以"仍有效"落库，
 * 关闭旧边是独立的 supersede 调用（D-B22-1）。
 */
export interface CreateStoryStateInput {
  readonly id: string;
  readonly projectId: string;
  readonly subjectEntityId: string;
  readonly predicate: string;
  readonly objectEntityId: string | null;
  readonly objectText: string | null;
  readonly validFromChapter: number;
  readonly sourceChapterId: string | null;
  readonly sourceContentHash: string | null;
  readonly evidenceSpan: string | null;
  readonly confidence: number | null;
  readonly origin: StoryOrigin;
  readonly createdAt: string;
}

/** 线程（伏笔） */
export interface StoryThreadData {
  readonly id: string;
  readonly projectId: string;
  readonly kind: string;
  readonly description: string;
  readonly status: StoryThreadStatus;
  readonly promisedPayoff: string | null;
  readonly openedChapter: number;
  readonly closedChapter: number | null;
  readonly sourceChapterId: string | null;
  readonly sourceContentHash: string | null;
  readonly evidenceSpan: string | null;
  readonly origin: StoryOrigin;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 开启线程（status 恒为 'open'，核销走独立调用） */
export interface CreateStoryThreadInput {
  readonly id: string;
  readonly projectId: string;
  readonly kind: string;
  readonly description: string;
  readonly promisedPayoff: string | null;
  readonly openedChapter: number;
  readonly sourceChapterId: string | null;
  readonly sourceContentHash: string | null;
  readonly evidenceSpan: string | null;
  readonly origin: StoryOrigin;
  readonly createdAt: string;
}

/** 抽取账本 */
export interface StoryExtractionData {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly sourceContentHash: string;
  readonly taskId: string | null;
  readonly status: StoryExtractionStatus;
  readonly extractedAt: string;
}

/** 登记抽取 */
export interface CreateStoryExtractionInput {
  readonly id: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly sourceVersionId: string;
  readonly sourceContentHash: string;
  readonly taskId: string | null;
  readonly status: StoryExtractionStatus;
  readonly extractedAt: string;
}

/** 待审队列 */
export interface StoryMergeReviewData {
  readonly id: string;
  readonly projectId: string;
  readonly entityAId: string;
  readonly entityBId: string;
  readonly suggestedReason: string;
  readonly status: StoryMergeReviewStatus;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

/** 提交待审（status 恒为 'pending'，裁决在 B24） */
export interface CreateStoryMergeReviewInput {
  readonly id: string;
  readonly projectId: string;
  readonly entityAId: string;
  readonly entityBId: string;
  readonly suggestedReason: string;
  readonly createdAt: string;
}

/** 前情登记表条目：实体 + 其全部别名 */
export interface StoryEntityRegistryEntry {
  readonly entity: StoryEntityData;
  readonly aliases: ReadonlyArray<string>;
}

/** 前情登记表：抽取输入里的"该项目已知什么"（D-B22-4，指代消解的锚） */
export interface StoryGraphPriorContext {
  readonly entities: ReadonlyArray<StoryEntityRegistryEntry>;
  readonly openThreads: ReadonlyArray<StoryThreadData>;
}

/** 回填重建时清空 extracted 层的逐表计数 */
export interface StoryGraphClearExtractedResult {
  readonly states: number;
  readonly threads: number;
  readonly aliases: number;
  readonly entities: number;
  readonly extractions: number;
  readonly mergeReviews: number;
}

// ── 仓库端口 ──────────────────────────────────────────────────────

export interface StoryEntityRepositoryPort {
  create(data: CreateStoryEntityInput): void;
  getById(projectId: string, id: string): StoryEntityData | null;
  /** canonical_name 精确命中（已软合并的实体不再作为归并目标） */
  findByCanonicalName(projectId: string, canonicalName: string): StoryEntityData | null;
  /** 别名精确命中 */
  findByAlias(projectId: string, alias: string): StoryEntityData | null;
  /** 归并判据：canonical_name 或别名精确命中（D-B22-5） */
  findByNameOrAlias(projectId: string, name: string): StoryEntityData | null;
  /** 追加档案段落（超阈值丢最旧段落）；实体不存在返回 false */
  appendProfileSummary(projectId: string, id: string, addition: string, now: string): boolean;
  /** 登记别名；同 (别名, 实体) 重复登记幂等返回 false */
  addAlias(data: CreateStoryEntityAliasInput): boolean;
  listAliases(projectId: string, entityId: string): ReadonlyArray<string>;
}

export interface StoryStateRepositoryPort {
  insert(data: CreateStoryStateInput): void;
  getById(projectId: string, id: string): StoryStateData | null;
  /** 主体 + 谓词上当前有效的抽取边（valid_until IS NULL 且 origin='extracted'） */
  listCurrentBySubjectPredicate(
    projectId: string,
    subjectEntityId: string,
    predicate: string,
  ): ReadonlyArray<StoryStateData>;
  listBySourceChapter(projectId: string, sourceChapterId: string): ReadonlyArray<StoryStateData>;
  /** 关闭旧边：只填 valid_until_chapter + superseded_by_id */
  supersede(
    projectId: string,
    id: string,
    validUntilChapter: number,
    supersededById: string,
  ): boolean;
  /** 改章重抽的定向失效（只删本章边 + 链接拼接，D-B22-7），返回删除行数 */
  deleteExtractedBySourceChapter(projectId: string, sourceChapterId: string): number;
}

export interface StoryThreadRepositoryPort {
  open(data: CreateStoryThreadInput): void;
  getById(projectId: string, id: string): StoryThreadData | null;
  findOpenByDescription(projectId: string, description: string): StoryThreadData | null;
  listOpen(projectId: string): ReadonlyArray<StoryThreadData>;
  /** 核销：status → closed + closed_chapter */
  close(projectId: string, id: string, closedChapter: number, now: string): boolean;
  /** 重抽某章前撤回该章做过的核销，返回重开行数 */
  reopenClosedAtChapter(projectId: string, closedChapter: number, now: string): number;
  deleteExtractedBySourceChapter(projectId: string, sourceChapterId: string): number;
}

export interface StoryExtractionRepositoryPort {
  register(data: CreateStoryExtractionInput): void;
  getLatestByChapter(projectId: string, chapterId: string): StoryExtractionData | null;
  deleteByChapter(projectId: string, chapterId: string): number;
}

export interface StoryMergeReviewRepositoryPort {
  /** 撞 pending 部分唯一索引时幂等返回 false */
  insertPending(data: CreateStoryMergeReviewInput): boolean;
  listPending(projectId: string): ReadonlyArray<StoryMergeReviewData>;
}

export interface StoryGraphRepositoryPort {
  /** 前情登记表（D-B22-4） */
  loadPriorContext(projectId: string): StoryGraphPriorContext;
  /** 回填重建第一步：清空全项目 extracted 记录，user 覆盖层保留（D-B22-6） */
  clearExtracted(projectId: string): StoryGraphClearExtractedResult;
}

// ── 检索地基（B23）────────────────────────────────────────────────

/** 可被检索的图行种类（story_embeddings.kind / story_graph_fts.kind） */
export type StoryIndexKind = 'entity' | 'state' | 'thread';

/** 一条图行的"可检索文本"及其指纹（FTS 与嵌入共用同一份文本，避免两处漂移） */
export interface StoryIndexSource {
  readonly kind: StoryIndexKind;
  readonly refId: string;
  readonly text: string;
  /** text 的 sha256；与 story_embeddings.content_hash 比对即知要不要重算 */
  readonly contentHash: string;
}

/** 嵌入行 */
export interface StoryEmbeddingData {
  readonly id: string;
  readonly projectId: string;
  readonly kind: StoryIndexKind;
  readonly refId: string;
  readonly model: string;
  readonly dims: number;
  readonly vector: Float32Array;
  readonly contentHash: string;
  readonly createdAt: string;
}

/** 写入嵌入（按 project+kind+ref_id upsert） */
export interface CreateStoryEmbeddingInput {
  readonly id: string;
  readonly projectId: string;
  readonly kind: StoryIndexKind;
  readonly refId: string;
  readonly model: string;
  readonly vector: ReadonlyArray<number>;
  readonly contentHash: string;
  readonly createdAt: string;
}

/** FTS 命中；rank 是 fts5 的原始打分，**越小越相关** */
export interface StoryFtsMatch {
  readonly kind: StoryIndexKind;
  readonly refId: string;
  readonly rank: number;
}

export interface StoryEmbeddingRepositoryPort {
  upsert(data: CreateStoryEmbeddingInput): void;
  /** 已存的指纹；与新文本的 hash 相同就不必重算（D-B23-4） */
  getContentHash(projectId: string, kind: StoryIndexKind, refId: string): string | null;
  listByKind(projectId: string, kind: StoryIndexKind): ReadonlyArray<StoryEmbeddingData>;
  listAll(projectId: string): ReadonlyArray<StoryEmbeddingData>;
  deleteByRefs(projectId: string, kind: StoryIndexKind, refIds: ReadonlyArray<string>): number;
  deleteAll(projectId: string): number;
}

export interface StoryGraphSearchPort {
  /**
   * FTS5 次级召回。种子文本由实现切成 trigram 安全的 MATCH 表达式
   * （trigram 要求词 ≥ 3 字符，两字人名走别名激活那一路）。
   */
  searchFts(
    projectId: string,
    seedText: string,
    /** 缺省 50：漏传会被绑定成 undefined 直接抛，给个安全默认值 */
    limit?: number,
  ): ReadonlyArray<StoryFtsMatch>;
  /** 取这些行当前的可检索文本与指纹（嵌入写路径用） */
  listIndexSources(
    projectId: string,
    refs: ReadonlyArray<{ readonly kind: StoryIndexKind; readonly refId: string }>,
  ): ReadonlyArray<StoryIndexSource>;
}

/** 抽取管线用到的全部图仓库（一处注入，避免每层重复列举） */
export interface StoryGraphRepositories {
  readonly entityRepo: StoryEntityRepositoryPort;
  readonly stateRepo: StoryStateRepositoryPort;
  readonly threadRepo: StoryThreadRepositoryPort;
  readonly extractionRepo: StoryExtractionRepositoryPort;
  readonly mergeReviewRepo: StoryMergeReviewRepositoryPort;
  readonly graphRepo: StoryGraphRepositoryPort;
  readonly embeddingRepo: StoryEmbeddingRepositoryPort;
  readonly searchRepo: StoryGraphSearchPort;
}
