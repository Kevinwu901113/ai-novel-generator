/**
 * 应用层端口接口。
 *
 * 应用用例通过这些接口与基础设施交互，
 * 不依赖 Electron、React 或 node:sqlite。
 */

// ── ID 生成器 ─────────────────────────────────────────────────────

/** ID 生成器接口 —— 基础设施侧实现（crypto.randomUUID()），测试可注入固定值 */
export interface IdGenerator {
  generate(): string;
}

// ── 时钟 ──────────────────────────────────────────────────────────

/** 时钟接口 —— 基础设施侧实现，测试可注入固定时间 */
export interface Clock {
  /** 返回 UTC ISO 8601 时间字符串 */
  now(): string;
}

// ── 项目索引仓库（app.sqlite）────────────────────────────────────

/** 项目索引行 */
export interface ProjectIndexData {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly projectDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目索引查询结果 */
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

/** 项目索引仓库接口 */
export interface ProjectIndexRepository {
  create(data: ProjectIndexData): void;
  list(): ReadonlyArray<ProjectIndexRow>;
  getById(id: string): ProjectIndexRow | null;
  updateLastOpened(id: string, timestamp: string): void;
  delete(id: string): void;
}

// ── 创建事务仓库（app.sqlite）────────────────────────────────────

/** 创建事务阶段 */
export type CreationPhase = 'preparing' | 'prepared' | 'promoted';

/** 创建事务行 */
export interface ProjectCreationRow {
  readonly projectId: string;
  readonly tempDirectoryName: string;
  readonly finalDirectoryName: string;
  readonly phase: CreationPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建事务仓库接口 */
export interface ProjectCreationRepository {
  create(data: ProjectCreationRow): void;
  getByProjectId(projectId: string): ProjectCreationRow | null;
  list(): ReadonlyArray<ProjectCreationRow>;
  updatePhase(projectId: string, phase: CreationPhase, updatedAt: string): void;
  delete(projectId: string): void;
}

// ── 项目元数据存储（project.sqlite）──────────────────────────────

/** 项目元数据数据 */
export interface ProjectMetadataData {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目元数据查询结果 */
export interface ProjectMetadataRow {
  readonly id: string;
  readonly name: string;
  readonly initialIdea: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目元数据存储接口 */
export interface ProjectMetadataStore {
  /** 初始化项目元数据（创建 project.sqlite 并写入） */
  init(projectDir: string, data: ProjectMetadataData): void;
  /** 读取项目元数据 */
  read(projectDir: string): ProjectMetadataRow | null;
  /** 检查数据库版本兼容性 */
  checkVersion(projectDir: string): void;
}

// ── 项目文件系统 ──────────────────────────────────────────────────

/** 项目文件系统接口 */
export interface ProjectFileSystem {
  /** 获取项目基础目录（projects/ 的父目录） */
  getBaseDir(): string;
  /** 创建项目目录（先创建临时目录，返回临时目录路径） */
  createTempDirectory(baseDir: string, projectId: string): string;
  /** 将临时目录重命名为最终目录 */
  renameToFinal(tempDir: string, finalDir: string): void;
  /** 确保项目子目录存在 */
  ensureSubdirectories(projectDir: string): void;
  /** 检查路径是否存在 */
  exists(path: string): boolean;
  /** 删除目录 */
  removeDirectory(dirPath: string): void;
  /** 清理属于本应用的过期临时目录 */
  cleanupTemp(baseDir: string, maxAgeMs: number): void;
  /** 判断是否为本应用的临时目录 */
  isTempDirectory(name: string): boolean;
}
