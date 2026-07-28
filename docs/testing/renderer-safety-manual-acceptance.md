# Renderer 安全错误呈现 - 人工验收文档

## 概述

本文档描述 Renderer 安全错误呈现功能的人工验收步骤，包括区域错误边界、安全错误消息和 TaskStats 过期数据处理。

## 验收环境

- 启动开发服务器：`pnpm dev`
- 打开 Electron 桌面应用

---

## 1. 项目创建失败

### 步骤

1. 在中间栏输入项目名称和初始想法
2. 点击"创建项目"按钮
3. 模拟创建失败（例如断开数据服务或使用无效输入）

### 预期行为

- 错误消息显示在全局错误提示区域
- 错误消息不包含：
  - `/Users/` 或 `/home/` 路径
  - `file://` 协议
  - `.sqlite` 数据库文件名
  - `node_modules` 路径
  - JS stack frame（如 `at Object.<anonymous>`）
  - 完整 UUID
  - Bearer token 或 API Key

---

## 2. 打开项目失败

### 步骤

1. 在左栏项目列表中点击一个项目
2. 模拟打开失败（例如项目文件被删除）

### 预期行为

- 错误消息显示在全局错误提示区域
- 错误消息不包含敏感信息（同上）

---

## 3. Provider 保存和测试失败

### 步骤

1. 在右栏"模型服务"区域输入 API Key
2. 点击"保存"按钮
3. 模拟保存失败
4. 点击"测试连接"按钮
5. 模拟测试失败

### 预期行为

- 错误消息显示在 Provider 错误区域
- 错误消息不包含敏感信息
- 已知错误码（如 `PROVIDER_TIMEOUT`）显示中文映射

---

## 4. TaskCenter 加载失败

### 步骤

1. 打开一个项目
2. 在右栏"任务活动"区域查看任务列表
3. 模拟任务列表加载失败

### 预期行为

- 错误消息显示在任务列表区域
- 错误消息不包含敏感信息
- 统计区域显示"统计加载失败"

---

## 5. TaskStats 过期数据

### 步骤

1. 打开一个项目，确保任务统计加载成功
2. 刷新统计，模拟刷新失败

### 预期行为

- 上一次成功的统计数据仍然显示
- 显示"统计可能已过期"提示
- 任务列表不受影响

---

## 6. Grill 区域模拟崩溃

### 步骤

1. 打开一个项目
2. 在 Grill 工作台区域触发渲染异常（例如使用开发工具手动抛出错误）

### 预期行为

- Grill 区域显示错误边界 fallback
- fallback 消息为中文，不显示原始异常
- 提供"重新加载此区域"按钮
- 点击"重新加载此区域"后，Grill 区域重新挂载
- **右栏 TaskCenter 和 Provider 区域保持正常工作**

---

## 7. TaskCenter 区域模拟崩溃

### 步骤

1. 打开一个项目
2. 在 TaskCenter 区域触发渲染异常

### 预期行为

- TaskCenter 区域显示错误边界 fallback
- fallback 消息为中文，不显示原始异常
- 提供"重新加载此区域"按钮
- **Grill 工作台和 Provider 区域保持正常工作**

---

## 8. Provider 区域模拟崩溃

### 步骤

1. 在 Provider 区域触发渲染异常

### 预期行为

- Provider 区域显示错误边界 fallback
- **Grill 工作台和 TaskCenter 区域保持正常工作**

---

## 9. 区域重新加载

### 步骤

1. 使某个区域进入错误状态
2. 点击"重新加载此区域"按钮
3. 修复导致错误的条件
4. 再次点击"重新加载此区域"

### 预期行为

- 点击按钮后，区域重新挂载子组件
- 如果错误条件已修复，区域恢复正常显示
- 如果错误条件仍然存在，区域继续显示错误 fallback

---

## 10. 确认窗口其余区域保持可用

### 步骤

1. 使 Grill 区域进入错误状态
2. 操作 TaskCenter（刷新、筛选、查看详情）
3. 操作 Provider（保存 Key、测试连接）
4. 操作项目列表（切换项目、新建项目）

### 预期行为

- 所有其他区域的功能不受影响
- 窗口不会白屏

---

## 11. 确认 DOM 不含敏感信息

### 步骤

1. 打开开发者工具
2. 在各种错误场景下检查 DOM

### 检查项

- [ ] 不包含 `/Users/` 路径
- [ ] 不包含 `/home/` 路径
- [ ] 不包含 `file://` 协议
- [ ] 不包含 `.sqlite` 文件名
- [ ] 不包含 `node_modules` 路径
- [ ] 不包含 JS stack frame（`at Object`、`at Array` 等）
- [ ] 不包含完整 UUID（8-4-4-4-12 格式）
- [ ] 不包含 `Bearer` token
- [ ] 不包含 `sk-` API Key 前缀
- [ ] 不包含 `api_key` 或 `apikey` 配置
- [ ] 不包含 Keychain service/account 信息

---

## 验收清单

| 场景                           | 通过 | 备注 |
| ------------------------------ | ---- | ---- |
| 项目创建失败不泄露             |      |      |
| 打开项目失败不泄露             |      |      |
| Provider 保存失败不泄露        |      |      |
| Provider 测试失败不泄露        |      |      |
| TaskCenter 加载失败不泄露      |      |      |
| TaskStats 过期数据显示         |      |      |
| Grill 崩溃不影响 TaskCenter    |      |      |
| TaskCenter 崩溃不影响 Provider |      |      |
| 区域重新加载功能               |      |      |
| DOM 不含路径/stack/secret/UUID |      |      |

---

## 自动化测试覆盖

相关测试文件：

- `apps/desktop/src/renderer/safety/safe-error.test.ts` - 安全错误处理测试
- `apps/desktop/src/renderer/safety/RendererErrorBoundary.test.tsx` - 错误边界测试
- `apps/desktop/src/renderer/task-center/task-center.test.tsx` - TaskCenter 测试（含安全测试）
- `apps/desktop/src/renderer/grill/workbench.test.tsx` - Grill 工作台测试（含安全测试）

运行测试：

```bash
pnpm test -- apps/desktop/src/renderer/safety/
pnpm test -- apps/desktop/src/renderer/task-center/
pnpm test -- apps/desktop/src/renderer/grill/
```
