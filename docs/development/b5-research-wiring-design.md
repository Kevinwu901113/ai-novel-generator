# B5 — GE-4 Research 节点接线设计（决策记录）

> 状态：ACTIVE（B5 实现期间的工作设计，随 PR 入库）
> 决策人：Fable（Principal Architect，项目负责人授权）
> 日期：2026-08-10
> 事实依据：main `d7da5d8`（B4 已合并）之侦察地图；批次定义 takeover-plan §B5、D7

## 1. 五节点执行策略

| 节点                | 策略                                                        | 说明                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RESEARCH_DECISION   | **sync executor**                                           | 从 snapshot 的 idea/creationSpec artifact ref 读底层权威存储（session goal + sections），构造 `ResearchInput` → `determineResearchDepth` → outcome `research_decision(none/light/deep)`。无 artifact。recoveryPolicy=replayable。             |
| RESEARCH_PLAN       | **sync executor（marker，无模型调用）**                     | 图契约 noOut：不产 outcome/artifact。**问题计划的模型调用合并进 RESEARCH_RUN 任务**（镜像 B3：ASK_QUESTION 并入 SPEC_EXTRACT 的先例）；图上 `prompt:research-plan-v1` 暂无独立运行时消费者，本 PR 记录该偏离。executor 本体 no-op 返回 `{}`。 |
| RESEARCH_EXECUTE    | **task-backed**（新任务类型 `RESEARCH_RUN`，migration v14） | prepareTask 从 snapshot 提取引导字段（depth、prior bundle ref、creationSpecVersionId、ideaSessionId），prompt 文本不入库（D-B3-4 同则）。执行在 task-engine `executeResearchRun`。recoveryPolicy=settle_if_result。                           |
| RESEARCH_VALIDATE   | **sync executor**                                           | 按 snapshot 的 researchBundle ref 读权威行，确定性校验（见 D-B5-4）→ outcome `research_valid(valid/invalid)`。invalid + 预算可用 → 图回环重新 EXECUTE（researchRetry ≤2）；耗尽 → RESEARCH_ESCALATION。                                       |
| RESEARCH_ESCALATION | **无 executor**（human gate）                               | parkHumanNodes + 既有 applyHumanDecision(kind:'escalation')；outcome 枚举 use_current_research / skip_research / modify_requirements / cancel / continue_later 由 domain 校验。                                                               |

## 2. 关键机制决策

- **D-B5-1 首次激活的 researchBundle=null**：`computeNodeInputSnapshot` 对缺失 artifact 写 `null`
  （node-input.ts:40）。RESEARCH_RUN 任务据此分支：null → 全新调研（模型产问题计划）；
  有 ref → 重试路径，复用上一轮 bundle 的问题计划（不再调模型），重新搜索/抓取。
  inputHash 含 bundle ref 与 activationNo，回环后旧任务结果自然失效。
- **D-B5-2 bundle 版本策略**：沿用 `research_bundles` 现表（migration v9，bundle_json 单列）。
  每次 RESEARCH_RUN 产出**新 bundle 行**（新 id、version=1，行内 `basedOnBundleId` 记链），
  artifact ref = 新行 id。不做行内版本自增（repo.save 是纯 INSERT；版本化以行链表达）。
- **D-B5-3 Tavily provider（D7）**：`packages/research-engine/src/tavily-search.ts` 实现
  `WebSearchPort`（POST api.tavily.com/search，fetchImpl 可注入以便确定性测试与 live gated
  测试共用）。key 经 secret-store 槽位（D-B5-6）由 worker 注入构造函数，不进代码/配置/日志。
- **D-B5-4 校验规则（确定性）**：depth=light/deep 的 bundle 必须：问题数 ≥1；每问题
  sources ≥1；factNotes ≥1 且每条 sourceUrls 非空且 URL 全部通过 `isSafeSourceUrl`；
  conclusion 非空。任一不满足 → invalid。none 深度不经过 EXECUTE/VALIDATE（图 decision→blueprint 直达）。
- **D-B5-5 SafeWebFetch（V1 安全边界补全）**：`packages/research-engine/src/safe-web-fetch.ts`
  实现 `WebFetchPort`，在既有纯函数校验（security.ts）之上补齐运行时边界：
  1. 请求前 `validateResearchTargetUrl`；
  2. **DNS 解析后校验**：`resolveHost`（可注入；生产用 node:dns/promises lookup all）对每个
     解析地址过 `isPrivateResolvedAddress`（security.ts 新增导出）。B5 复查 B-1 修复后的
     覆盖面：IPv6 先全量归一化展开为 8 组 16-bit 再判定（WHATWG URL 会把
     `[::ffff:127.0.0.1]` 归一化为十六进制 `[::ffff:7f00:1]`，点分正则不可靠）——
     IPv4-mapped `::ffff:0:0/96` / IPv4-compatible `::/96` / NAT64 `64:ff9b::/96` /
     6to4 `2002::/16` 均还原内嵌 IPv4 复检；`::`/`::1`、fe80::/10、fc00::/7、ff00::/8
     直接拒绝；zone id（%）或解析失败按不可信处理。裸 IPv4 与内嵌还原共用同一封禁
     函数（10/8、172.16/12、192.168/16、127/8、169.254/16、100.64/10、198.18/15、
     0/8、组播 224/4、保留 240/4）。入口层 `isBlockedHostname` 对 IPv6 字面量同步收口：
     `validateResearchTargetUrl` / `isSafeSourceUrl` 在 URL 校验层即拒绝私网 IPv6 字面量，
     不依赖 safe-web-fetch 兜底；
  3. 重定向手动跟随（redirect:'manual'，≤3 跳），每跳重新走 1+2；
  4. content-type 白名单（text/html、text/plain、application/xhtml+xml、application/json）；
  5. 响应字节上限（默认 512 KiB，流式截断）；
  6. 连接/读取超时（AbortController，默认 10s，端口签名的 timeoutMs 生效）；
  7. 已知残余风险：解析-连接间的 DNS rebinding TOCTOU 窗口（V1 不做 IP 钉连）；记录于此，
     不视为 blocker（roadmap 边界原文为"含 DNS 解析后"，已满足）。
- **D-B5-6 search key 槽位**：`packages/application/src/search-secret-ref.ts`——
  service `com.ai-novel-generator.search.tavily`、account `api-key`（与 provider 前缀并列，
  不改既有派生规则）。worker 新命令 `search.saveApiKey / deleteApiKey / hasApiKey` +
  contracts/preload/main 三层通道（B6 UI 挂接；B5 先通 RPC 供录入与测试）。
  `search.saveApiKey` 成功后触发 `redriveAfterProviderConfig`（D-B4-8 复用——key 补齐重调度）。
- **D-B5-7 配置类错误保持 PENDING**：`executeResearchRun` 在 claim 前检查模型 provider/key
  （仅当需要问题计划时）与 Tavily key；缺失 → 抛配置类错误码（graph-task-runner 白名单扩列），
  任务保持 PENDING 不增 attempt（BLK-2 同语义），key 录入后由 D-B5-6 重驱动。
- **D-B5-8 问题计划人工增删跳过（roadmap §9）暂不做**：图 L3 的 plan→execute 是 fixed 边、
  无中间人工 Gate；L3 优先于 L4 文档（权威层级）。用户对调研的干预路径 = validate 失败重试、
  escalation（modify_requirements 回 SPEC_EXTRACT）与 B6 的 bundle 查看/来源排除。偏离记录在案。

## 3. 改动点清单（按依赖序）

1. migration **v14**：tasks CHECK 重建加 `RESEARCH_RUN`（镜像 v13）；domain `TaskType` /
   `DbTaskType` 联合同步。
2. research-engine：`security.ts` 增 `isPrivateResolvedAddress`；新增 `safe-web-fetch.ts`、
   `tavily-search.ts`；index 导出。
3. application：`search-secret-ref.ts`；research.ts 补 `basedOnBundleId`（bundle_json 内字段，
   类型上加可选）。
4. task-engine：`research-run.ts`（`executeResearchRun`，镜像 spec-extract 的
   claim/前置校验/invocation/envelope/补偿结构；搜索/抓取端口注入）。
5. worker：`research-executors.ts`（三 sync + 一 prepareTask + 注册）；`graph-task-runner`
   增 RESEARCH_RUN 分派与配置类错误白名单；`index.ts` 注册 + search key 命令 + deps 装配。
6. contracts/preload/main：search key 三通道。
7. 测试：safe-web-fetch 边界单测（注入 fake resolver/fetch）；tavily 单测（fake fetchImpl）；
   executeResearchRun 任务测试；research E2E（真实 SQLite + fake 端口：none 直达 /
   light‑deep 全链 / invalid 回环到预算耗尽 → escalation / PENDING 重启恢复）；
   Tavily live 测试以 `TAVILY_LIVE=1` + env key 门控，默认 skip。

## 4. 非目标

- 不做 Research UI（B6）；不改图定义；不做知识图谱/通用 RAG/无限自动搜索（roadmap §9 非目标）；
- 不做 IP 钉连（D-B5-5 已记录残余风险）；不做 bundle 行内版本自增（D-B5-2）。
