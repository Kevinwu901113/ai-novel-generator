# 数据模型

## 核心实体

### Project（项目）

项目是顶层容器，包含所有创作相关数据。

```typescript
interface Project {
  id: ProjectId;
  title: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  metadata: ProjectMetadata;
}
```

### Chapter（章节）

章节是正文的组织单位。

```typescript
interface Chapter {
  id: string;
  projectId: ProjectId;
  title: string;
  order: number;
  status: ChapterStatus;
  content: string; // 版本化
  createdAt: string;
  updatedAt: string;
}
```

### Character（人物）

人物是故事中的角色。

```typescript
interface Character {
  id: string;
  projectId: ProjectId;
  name: string;
  description: string;
  traits: string[];
  relationships: Relationship[];
  createdAt: string;
  updatedAt: string;
}
```

### Task（任务）

任务是 AI 执行的工作单元。

```typescript
interface Task {
  id: string;
  projectId: ProjectId;
  type: TaskType;
  status: TaskStatus;
  input: TaskInput;
  output: TaskOutput | null;
  modelId: string;
  tokenUsage: TokenUsage;
  createdAt: string;
  updatedAt: string;
}
```

## 版本化数据

以下数据需要版本化管理：

- 正文内容（Chapter.content）
- 创作契约
- 章节规划
- 项目状态

### 版本记录

```typescript
interface Version {
  id: string;
  entityType: string;
  entityId: string;
  data: unknown;
  createdAt: string;
  reason: string;
  parentVersionId: string | null;
}
```

## 用户文字保护

用户手动编辑的文字默认受保护：

- AI 不得覆盖用户文字
- 修改用户文字需要明确确认
- 版本历史记录所有修改

## 本地存储结构

```
项目目录/
├── project.json          # 项目配置
├── chapters/             # 章节内容
│   ├── 001-chapter.md
│   └── 002-chapter.md
├── characters/           # 人物资料
│   ├── character-1.json
│   └── character-2.json
├── contracts/            # 创作契约
│   └── contract-v1.md
├── plans/                # 章节规划
│   └── plan-v1.json
├── tasks/                # 任务记录
│   └── tasks.json
└── versions/             # 版本历史
    └── versions.json
```

## API Key 管理

API Key 不进入项目备份：

- 单独存储在用户配置目录
- 加密存储（可选）
- 项目备份时排除 API Key

## M1-A 数据模型

### 数据库分层

- **app.sqlite**：应用级项目索引，存储在 `<userData>/app.sqlite`
- **project.sqlite**：单个项目数据，存储在 `<userData>/projects/<project-id>/project.sqlite`

project.sqlite 是项目的正式数据来源。app.sqlite 仅用于项目列表和快速定位。

### app.sqlite Schema

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  initial_idea TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idea',
  project_directory TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT
) STRICT;
```

### project.sqlite Schema

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE project_metadata (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  initial_idea TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idea',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
```

### 项目目录结构

```
<userData>/
├── app.sqlite
└── projects/
    └── <project-id>/
        ├── project.sqlite
        ├── assets/
        ├── sources/
        ├── snapshots/
        ├── exports/
        └── temp/
```

### SQLite 配置

- `PRAGMA foreign_keys = ON`
- `PRAGMA journal_mode = WAL`
- `PRAGMA busy_timeout = 5000`
- STRICT tables
- 所有时间使用 UTC ISO 8601
