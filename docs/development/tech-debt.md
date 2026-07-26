# M1 前技术债务

## TD-001: `--no-prune` in Electron packaging

**状态**: 未解决  
**优先级**: M1 前必须解决  
**创建日期**: 2026-07-26

### 问题描述

`@electron/packager` 的 `--no-prune` 标志导致所有 `devDependencies`（包括 typescript、vite、electron 等）被打包进生产 asar，使产物膨胀至 ~72MB。

### 根因

`@electron/packager` 的 prune 步骤使用 Node.js 模块解析来确定依赖树。在 pnpm strict mode（默认）下，`@electron-internal/extract-zip` 等深层依赖无法通过符号链接链被正确解析，导致 prune 阶段失败：

```
Failed to locate module "@electron-internal/extract-zip" from ".../@electron/packager"
```

### 已尝试的修复

1. `public-hoist-pattern[]=@electron-internal/*` — 未生效，pnpm 需要重新安装才能应用
2. `node-linker=hoisted` — 会破坏 pnpm 的严格模式，不推荐

### 可能的解决方案

1. 升级 `@electron/packager` 到支持 pnpm strict mode 的版本
2. 使用 `electron-builder` 替代 `electron-packager`（electron-builder 原生支持 pnpm）
3. 在 CI 中使用 `node-linker=hoisted` 仅用于打包步骤

### 影响

- 生产 asar 包含不必要的开发依赖（typescript、vite、electron 等）
- 包体积 ~72MB（理想情况下应 < 20MB）
- 安全扫描范围增大

### 验证

移除 `--no-prune` 后运行 `pnpm package`，确认不再出现 `Failed to locate module` 错误。

## M1-A 技术债务

### TD-002: Worker 类型声明不完整

**状态**: 未解决
**优先级**: M1-B 前
**创建日期**: 2026-07-26

#### 问题描述

`apps/worker/src/index.ts` 中 `process.parentPort` 的类型声明是手动添加的 `declare const process`，覆盖了标准 NodeJS.Process 类型。这是因为 Electron Utility Process 的 `parentPort` 不在标准 Node.js 类型定义中。

#### 可能的解决方案

1. 使用 `@types/electron` 中的类型（如果存在）
2. 创建独立的类型声明文件
3. 等待上游类型支持

### TD-003: 数据库测试需要 node:sqlite 运行时

**状态**: 未解决
**优先级**: 持续
**创建日期**: 2026-07-26

#### 问题描述

数据库集成测试需要 Node.js 22+ 的 node:sqlite 模块。如果运行环境不支持 node:sqlite，这些测试会失败。

#### 影响

- CI 环境必须使用 Node.js 22+
- 测试不能在浏览器环境中运行

### TD-004: Electron 42+ 二进制动态下载

**状态**: 未解决
**优先级**: CI 前
**创建日期**: 2026-07-26

#### 问题描述

Electron 42+ 改为在首次运行时动态下载二进制文件，不再在 `postinstall` 时下载。这影响 CI 和打包流程。

#### 可能的解决方案

1. 使用 `ELECTRON_MIRROR` 环境变量指定镜像
2. 在 CI 中预先下载 Electron 二进制
3. 使用 electron-builder 替代 electron-packager
