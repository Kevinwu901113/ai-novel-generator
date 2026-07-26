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
