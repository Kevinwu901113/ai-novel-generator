/**
 * 仓库统一 canonical JSON 序列化（RW-1-R5）。
 *
 * 直接复用 domain 的 `canonicalJson`（Creation Contract 域已有的强语义）：
 * NFC 规范化、code-point 排序（含 astral）、NFC 后 key 冲突拒绝、
 * undefined / BigInt / Symbol / function / 非有限数拒绝。
 * 不维护第二套弱序列化器。
 */
export { canonicalJson } from '@ai-novel/domain';
