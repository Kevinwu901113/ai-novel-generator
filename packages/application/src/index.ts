/**
 * @ai-novel/application
 *
 * 应用用例和流程接口。
 * 不依赖 Electron UI、React 或 node:sqlite。
 */

// ── 端口接口 ──────────────────────────────────────────────────────

export type {
  IdGenerator,
  Clock,
  ProjectIndexData,
  ProjectIndexRow,
  ProjectIndexRepository,
  ProjectCreationRow,
  ProjectCreationRepository,
  CreationPhase,
  ProjectMetadataData,
  ProjectMetadataRow,
  ProjectMetadataStore,
  ProjectFileSystem,
  SecretStore,
  ProviderProfileData,
  ProviderProfileRepository,
} from './types.js';

// ── 错误 ──────────────────────────────────────────────────────────

export {
  AppError,
  ValidationError,
  ProjectNotFoundError,
  ProjectDirectoryMissingError,
  ProjectDatabaseInvalidError,
  DatabaseVersionUnsupportedError,
  ProjectCreateFailedError,
  WorkerUnavailableError,
  ProviderNotConfiguredError,
  ApiKeyRequiredError,
  ApiKeyStoreFailedError,
  ApiKeyReadFailedError,
  ApiKeyDeleteFailedError,
} from './errors.js';

// ── 用例 ──────────────────────────────────────────────────────────

export { createProject } from './create-project.js';
export type { CreateProjectDeps, CreateProjectInput } from './create-project.js';

export { listProjects } from './list-projects.js';
export type { ListProjectsDeps, ProjectListItem } from './list-projects.js';

export { openProject } from './open-project.js';
export type { OpenProjectDeps, OpenProjectInput } from './open-project.js';

export { getProviderState } from './get-provider-state.js';
export type { GetProviderStateDeps } from './get-provider-state.js';

export { saveProviderApiKey } from './save-provider-api-key.js';
export type { SaveProviderApiKeyDeps, SaveProviderApiKeyInput } from './save-provider-api-key.js';

export { deleteProviderApiKey } from './delete-provider-api-key.js';
export type { DeleteProviderApiKeyDeps } from './delete-provider-api-key.js';

export { testProviderConnection } from './test-provider-connection.js';
export type { TestProviderConnectionDeps } from './test-provider-connection.js';
