/**
 * Search key 槽位（B5 / D-B5-6，Tavily / D7）。
 *
 * 与 provider 槽位（provider-secret-ref.ts）并列的独立命名空间；
 * API Key 永不入库、不进项目备份、不经 IPC 返回。
 *
 * 派生规则固定为：
 *   service = `com.ai-novel-generator.search.tavily`
 *   account = `api-key`
 */

export interface SearchSecretRef {
  readonly service: string;
  readonly account: string;
}

export const TAVILY_SEARCH_SECRET_REF: SearchSecretRef = {
  service: 'com.ai-novel-generator.search.tavily',
  account: 'api-key',
};
