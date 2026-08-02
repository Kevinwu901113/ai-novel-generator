/**
 * macOS Keychain SecretStore 实现（兼容 re-export）。
 *
 * 实现已抽取到共享 package `@ai-novel/secret-store`，本文件保持兼容 re-export，
 * 使 Worker 现有 import 路径不变、行为（service/account 语义、错误文本、超时）不变。
 * 唯一实现位于 `@ai-novel/secret-store`，此处不保留第二份副本。
 */

export { createMacOSKeychainSecretStore } from '@ai-novel/secret-store';
