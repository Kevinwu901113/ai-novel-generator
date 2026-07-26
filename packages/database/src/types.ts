/**
 * 数据库层接口定义。
 *
 * 领域层和应用层通过这些接口与数据库交互，
 * 不直接依赖 node:sqlite 或具体实现。
 */

// ── 迁移 ──────────────────────────────────────────────────────────

/** 单个迁移 */
export interface Migration {
  readonly version: number;
  readonly sql: string;
}

/** 迁移运行器 */
export interface Migrator {
  /** 运行迁移，返回新应用的迁移数量 */
  migrate(currentVersion: number, migrations: ReadonlyArray<Migration>): number;
  /** 获取当前数据库版本 */
  getCurrentVersion(): number;
}

// ── 项目索引（app.sqlite）────────────────────────────────────────

/** 项目索引行 —— 存储在 app.sqlite 中 */
export interface ProjectIndexRow {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly projectDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOpenedAt: string | null;
}

/** 创建项目索引数据 */
export interface CreateProjectIndexData {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly projectDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目索引仓库 */
export interface ProjectIndexRepository {
  create(data: CreateProjectIndexData): void;
  list(): ReadonlyArray<ProjectIndexRow>;
  getById(id: string): ProjectIndexRow | null;
  updateLastOpened(id: string, timestamp: string): void;
  delete(id: string): void;
}

// ── 项目元数据（project.sqlite）──────────────────────────────────

/** 项目元数据行 —— 存储在 project.sqlite 中 */
export interface ProjectMetadataRow {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建项目元数据数据 */
export interface CreateProjectMetadataData {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目元数据仓库 */
export interface ProjectMetadataRepository {
  create(data: CreateProjectMetadataData): void;
  get(): ProjectMetadataRow | null;
  update(data: Partial<Omit<ProjectMetadataRow, 'id'>>): void;
}

// ── 创建事务（app.sqlite）────────────────────────────────────────

/** 创建事务阶段 */
export type CreationPhase = 'preparing' | 'prepared' | 'promoted';

/** 创建事务记录 */
export interface ProjectCreationRow {
  readonly projectId: string;
  readonly tempDirectoryName: string;
  readonly finalDirectoryName: string;
  readonly phase: CreationPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建创建事务数据 */
export interface CreateProjectCreationData {
  readonly projectId: string;
  readonly tempDirectoryName: string;
  readonly finalDirectoryName: string;
  readonly phase: CreationPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建事务仓库 */
export interface ProjectCreationRepository {
  create(data: CreateProjectCreationData): void;
  getByProjectId(projectId: string): ProjectCreationRow | null;
  list(): ReadonlyArray<ProjectCreationRow>;
  updatePhase(projectId: string, phase: CreationPhase, updatedAt: string): void;
  delete(projectId: string): void;
}

// ── 数据库管理 ────────────────────────────────────────────────────

/** AppDatabase 管理接口 */
export interface AppDatabaseManager {
  /** 获取项目索引仓库 */
  getProjectIndexRepository(): ProjectIndexRepository;
  /** 获取创建事务仓库 */
  getProjectCreationRepository(): ProjectCreationRepository;
  /** 关闭数据库连接 */
  close(): void;
}

/** ProjectDatabase 管理接口 */
export interface ProjectDatabaseManager {
  /** 获取项目元数据仓库 */
  getProjectMetadataRepository(): ProjectMetadataRepository;
  /** 关闭数据库连接 */
  close(): void;
}
