/**
 * 仓库统一 canonical JSON 序列化（RW-1-R5, canonical input contract）。
 *
 * 确定性：对象键递归排序、数组保序、原始值按 JSON 语义。用于幂等载荷指纹、
 * input snapshot 序列化 / inputHash、input_snapshot_json 持久化。
 * 不使用 localeCompare（跨 locale / 输入编码稳定）。
 */

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
