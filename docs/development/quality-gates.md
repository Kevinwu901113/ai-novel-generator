# 质量门禁

## 代码质量检查

### 格式检查

```bash
pnpm format:check
```

- 使用 Prettier 检查代码格式
- 不符合格式的代码不能提交

### Lint 检查

```bash
pnpm lint
```

- 使用 ESLint 检查代码质量
- 不允许 `any` 类型
- 不允许未使用的变量

### 类型检查

```bash
pnpm typecheck
```

- 使用 TypeScript 严格模式
- 不允许类型错误
- 所有包都必须通过类型检查

### 测试

```bash
pnpm test
```

- 使用 Vitest 运行测试
- 所有测试必须通过
- 新功能必须有测试覆盖

### 构建

```bash
pnpm build
```

- 所有包都必须能成功构建
- Electron 应用必须能打包

## 完整检查

```bash
pnpm check
```

按顺序执行：

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm build`

任何一步失败都会中止后续步骤。

## 代码审查检查项

### 安全性

- [ ] Electron 安全配置正确
- [ ] Renderer 不直接访问 Node.js
- [ ] API Key 不泄露到前端
- [ ] 用户输入经过验证

### 代码质量

- [ ] 没有 `any` 类型
- [ ] 没有未使用的变量
- [ ] 函数职责单一
- [ ] 命名清晰有意义

### 测试

- [ ] 新功能有测试覆盖
- [ ] 测试用例清晰
- [ ] 边界条件已覆盖

### 文档

- [ ] 复杂逻辑有注释
- [ ] API 有文档
- README 和 AGENTS.md 已更新

## 提交前检查

每次提交前必须执行：

```bash
pnpm check
```

确保：

- 代码格式正确
- 没有 Lint 错误
- 没有类型错误
- 所有测试通过
- 构建成功

## CI/CD 检查

未来 CI/CD 流水线将自动执行：

1. 代码检出
2. 依赖安装
3. `pnpm check`
4. 构建产物
5. 部署（可选）
