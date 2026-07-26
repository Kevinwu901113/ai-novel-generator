# 测试策略

## 测试层次

### 单元测试

**范围**：单个函数、类、模块

**工具**：Vitest

**原则**：

- 测试纯函数和业务逻辑
- 不测试框架代码
- 不测试第三方库

**示例**：

```typescript
describe('createProjectId', () => {
  it('应该从有效字符串创建 ProjectId', () => {
    const id = createProjectId('project-001');
    expect(id).toBe('project-001');
  });

  it('应该拒绝空字符串', () => {
    expect(() => createProjectId('')).toThrow();
  });
});
```

### 集成测试

**范围**：多个模块协作

**工具**：Vitest

**原则**：

- 测试模块间交互
- 测试 IPC 通信
- 测试数据流

**示例**：

```typescript
describe('健康检查 IPC', () => {
  it('应该返回有效的 HealthCheckResponse', async () => {
    const result = await ipcRenderer.invoke('ipc:health-check');
    expect(isValidHealthCheckResponse(result)).toBe(true);
  });
});
```

### 端到端测试（未来）

**范围**：完整用户流程

**工具**：待定（可能使用 Playwright）

**原则**：

- 测试关键用户路径
- 不测试所有细节
- 优先测试高频场景

## 测试覆盖要求

### M0 阶段

- domain 包基础单元测试
- IPC 健康检查返回结构测试
- Renderer 栏位状态逻辑测试
- 构建配置成功

### 后续阶段

- 新功能必须有测试覆盖
- 关键路径必须有集成测试
- 逐步增加端到端测试

## 测试文件组织

```
src/
├── index.ts
├── index.test.ts      # 对应模块的测试
├── utils.ts
└── utils.test.ts      # 对应模块的测试
```

- 测试文件与源文件同目录
- 测试文件名：`*.test.ts`
- 保持测试与源代码的对应关系

## 测试命名规范

```
describe('模块名', () => {
  describe('函数名', () => {
    it('应该在条件X下执行Y', () => {
      // 测试代码
    });

    it('应该在条件X下抛出错误', () => {
      // 测试代码
    });
  });
});
```

## Mock 策略

### 何时 Mock

- 外部 API 调用
- 文件系统操作
- 数据库操作
- 时间相关逻辑

### 何时不 Mock

- 纯函数
- 类型验证
- 业务逻辑

### Mock 工具

- Vitest 内置 `vi.fn()` 和 `vi.mock()`
- 避免过度 Mock

## 测试运行

### 开发时

```bash
# 运行所有测试
pnpm test

# 监听模式
pnpm test --watch

# 运行特定测试
pnpm test -- path/to/test.test.ts
```

### 提交前

```bash
pnpm check
```

### CI/CD

```bash
pnpm test
```

## 测试数据管理

### 测试数据

- 使用工厂函数创建测试数据
- 避免硬编码测试数据
- 保持测试数据简单

### 数据清理

- 每个测试独立
- 测试后清理状态
- 使用 `beforeEach` 和 `afterEach`
