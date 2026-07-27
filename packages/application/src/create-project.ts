/**
 * CreateProject 用例。
 *
 * 流程（使用创建事务保证崩溃一致性）：
 * 1. 验证输入
 * 2. 生成 ProjectId
 * 3. 创建临时项目目录
 * 4. 初始化 project.sqlite
 * 5. 创建子目录
 * 6. app.sqlite 事务写入 project_creations，phase=prepared
 * 7. rename 临时目录为正式目录
 * 8. app.sqlite 事务：插入正式索引 + 删除 project_creations 记录
 * 9. 返回 Project
 *
 * SIGKILL / 断电恢复由启动时 reconciliation 处理。
 */

import { createProjectName, createInitialIdea, type Project } from '@ai-novel/domain';
import type {
  IdGenerator,
  Clock,
  ProjectIndexRepository,
  ProjectCreationRepository,
  ProjectMetadataStore,
  ProjectFileSystem,
} from './types.js';
import { ValidationError, ProjectCreateFailedError } from './errors.js';

/** CreateProject 用例依赖 */
export interface CreateProjectDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly projectIndexRepo: ProjectIndexRepository;
  readonly projectCreationRepo: ProjectCreationRepository;
  readonly projectMetadataStore: ProjectMetadataStore;
  readonly fileSystem: ProjectFileSystem;
}

/** CreateProject 输入 */
export interface CreateProjectInput {
  readonly name: string;
  readonly initialIdea: string;
}

/** 从 baseDir 和 projectId 构造最终目录名（受控相对名称） */
function makeFinalDirName(projectId: string): string {
  return projectId;
}

/**
 * 创建项目用例。
 *
 * 文件系统和两个数据库无法使用同一个事务，
 * 通过 project_creations 表记录中间状态，保证崩溃后可恢复。
 */
export function createProject(deps: CreateProjectDeps, input: CreateProjectInput): Project {
  const {
    idGenerator,
    clock,
    projectIndexRepo,
    projectCreationRepo,
    projectMetadataStore,
    fileSystem,
  } = deps;

  // 1. 验证输入
  let name: string;
  let initialIdea: string;
  try {
    name = createProjectName(input.name);
    initialIdea = createInitialIdea(input.initialIdea);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : '输入验证失败');
  }

  const projectId = idGenerator.generate();
  const now = clock.now();
  const baseDir = fileSystem.getBaseDir();
  let tempDir: string | null = null;
  let creationRecorded = false;
  let promoted = false;

  try {
    // 2. 创建临时项目目录
    tempDir = fileSystem.createTempDirectory(baseDir, projectId);

    // 3. 初始化 project.sqlite（在临时目录中）
    projectMetadataStore.init(tempDir, {
      id: projectId,
      name,
      initialIdea,
      status: 'idea',
      createdAt: now,
      updatedAt: now,
    });

    // 4. 创建子目录
    fileSystem.ensureSubdirectories(tempDir);

    // 5. 记录创建事务（phase=prepared）
    const finalDirName = makeFinalDirName(projectId);
    projectCreationRepo.create({
      projectId,
      tempDirectoryName: `${projectId}.tmp`,
      finalDirectoryName: finalDirName,
      phase: 'prepared',
      createdAt: now,
      updatedAt: now,
    });
    creationRecorded = true;

    // 6. rename 临时目录为正式目录
    const finalDir = `${baseDir}/projects/${finalDirName}`;
    fileSystem.renameToFinal(tempDir, finalDir);
    tempDir = null; // 已重命名，不需要清理

    // 7. 插入正式索引 + 删除创建事务记录
    projectIndexRepo.create({
      id: projectId,
      name,
      initialIdea,
      status: 'idea',
      projectDirectory: finalDir,
      createdAt: now,
      updatedAt: now,
    });
    projectCreationRepo.delete(projectId);
    promoted = true;

    // 8. 返回 Project
    return {
      id: projectId as ReturnType<typeof createProject>['id'],
      name,
      initialIdea,
      status: 'idea',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: null,
    };
  } catch (err) {
    // 补偿逻辑（普通异常；SIGKILL 由 reconciliation 处理）
    if (promoted) {
      // 已完成，无需补偿
    } else if (creationRecorded && tempDir === null) {
      // rename 成功但索引写入失败：清理最终目录和创建记录
      const finalDir = `${baseDir}/projects/${makeFinalDirName(projectId)}`;
      try {
        fileSystem.removeDirectory(finalDir);
      } catch {
        // 忽略
      }
      try {
        projectCreationRepo.delete(projectId);
      } catch {
        // 忽略
      }
    } else if (tempDir) {
      // rename 前失败：清理临时目录和创建记录
      try {
        fileSystem.removeDirectory(tempDir);
      } catch {
        // 忽略
      }
      if (creationRecorded) {
        try {
          projectCreationRepo.delete(projectId);
        } catch {
          // 忽略
        }
      }
    }

    // 包装错误，不泄露内部路径
    const message = err instanceof Error ? err.message : '创建项目失败';
    throw new ProjectCreateFailedError(message);
  }
}
