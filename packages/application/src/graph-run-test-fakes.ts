/**
 * Graph Run 测试 fakes（内存实现），用于 application 层用例测试。
 * 不用于 database 集成测试（后者用真实 SQLite + GraphRunTransactionPortImpl）。
 */

import type { AnyIdeaToNovelRunState } from '@ai-novel/domain';
import {
  CHAPTER_GENERATION_GRAPH_ID,
  CHAPTER_GENERATION_GRAPH_V1,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
} from '@ai-novel/domain';
import type { GraphRunDeps } from './graph-run.js';
import type {
  GraphRunCommandLogPort,
  GraphRunCommandRecord,
  GraphRunRepositoryPort,
  GraphRunStateRecord,
  GraphRunTransactionPort,
  IdeaIntakeAnswerPort,
} from './graph-run-types.js';
import type {
  CreateNodeExecutionInput,
  NodeExecutionRecord,
  NodeExecutionRepositoryPort,
  NodeExecutionResultEnvelope,
  NodeExecutionResultStorePort,
  NodeExecutionStatus,
} from './node-execution-types.js';
import type { ResearchBundleRepositoryPort } from './research.js';
import type { StoryBlueprintRepositoryPort } from './blueprint.js';
import type { ResearchBundle } from '@ai-novel/research-engine';
import type { StoryBlueprint } from '@ai-novel/domain';

export interface FakeAnswerRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly text: string;
  readonly createdAt: string;
}

const NOW = '2026-08-04T00:00:00.000Z';

export function createFakeGraphRunRepos() {
  const runs = new Map<string, GraphRunStateRecord>();
  const commands = new Map<string, GraphRunCommandRecord>();
  const answers: FakeAnswerRecord[] = [];
  let forceCasFail = false;

  const graphRunRepo: GraphRunRepositoryPort = {
    create(state: AnyIdeaToNovelRunState, _updatedAt: string): void {
      runs.set(state.workflowRunId, {
        kind: state.graphId === CHAPTER_GENERATION_GRAPH_ID ? 'chapter' : 'project',
        state,
        expectedVersion: 1,
      });
    },
    getById(runId: string): GraphRunStateRecord | null {
      return runs.get(runId) ?? null;
    },
    listByProject(projectId: string): ReadonlyArray<GraphRunStateRecord> {
      return [...runs.values()].filter((r) => r.state.projectId === projectId);
    },
    listNonTerminal(): ReadonlyArray<GraphRunStateRecord> {
      return [...runs.values()].filter((r) => r.state.terminalStatus === null);
    },
    saveWithCas(
      runId: string,
      expectedVersion: number,
      next: AnyIdeaToNovelRunState,
      _updatedAt: string,
    ): boolean {
      if (forceCasFail) return false;
      const rec = runs.get(runId);
      if (!rec || rec.expectedVersion !== expectedVersion) return false;
      runs.set(runId, {
        kind: rec.kind,
        state: next,
        expectedVersion: expectedVersion + 1,
      });
      return true;
    },
  };

  const commandLog: GraphRunCommandLogPort = {
    get(id: string): GraphRunCommandRecord | null {
      return commands.get(id) ?? null;
    },
    insert(record: GraphRunCommandRecord): boolean {
      if (commands.has(record.id)) return false;
      commands.set(record.id, record);
      return true;
    },
  };

  const intakeAnswer: IdeaIntakeAnswerPort = {
    insertAnswer(input: {
      readonly id: string;
      readonly sessionId: string;
      readonly questionId: string;
      readonly text: string;
      readonly createdAt: string;
    }): void {
      answers.push(input);
    },
  };

  const executions = new Map<string, NodeExecutionRecord>();
  const results = new Map<string, NodeExecutionResultEnvelope>();

  const nodeExecutionRepo: NodeExecutionRepositoryPort = {
    create(input: CreateNodeExecutionInput): boolean {
      // 模拟 partial unique：同 run+node 已有 in-flight（pending/running）→ 并发冲突
      const inFlight = [...executions.values()].some(
        (e) =>
          e.graphRunId === input.graphRunId &&
          e.nodeId === input.nodeId &&
          (e.status === 'pending' || e.status === 'running'),
      );
      if (inFlight) return false;
      // 模拟 unique(graph_run_id, node_id, activation_no, attempt_no)
      const dup = [...executions.values()].some(
        (e) =>
          e.graphRunId === input.graphRunId &&
          e.nodeId === input.nodeId &&
          e.activationNo === input.activationNo &&
          e.attemptNo === input.attemptNo,
      );
      if (dup) return false;
      executions.set(input.id, {
        ...input,
        taskId: null,
        claimedBy: null,
        leaseExpiresAt: null,
        status: 'pending',
        artifactReceiptJson: null,
        errorCode: null,
        settledAt: null,
      });
      return true;
    },
    getById(id: string): NodeExecutionRecord | null {
      return executions.get(id) ?? null;
    },
    getByTaskId(taskId: string): NodeExecutionRecord | null {
      return [...executions.values()].find((e) => e.taskId === taskId) ?? null;
    },
    getLatestByRunNode(graphRunId: string, nodeId: string): NodeExecutionRecord | null {
      const matches = [...executions.values()]
        .filter((e) => e.graphRunId === graphRunId && e.nodeId === nodeId)
        .sort((a, b) => b.activationNo - a.activationNo || b.attemptNo - a.attemptNo);
      return matches[0] ?? null;
    },
    getInFlightByRunNode(graphRunId: string, nodeId: string): NodeExecutionRecord | null {
      const matches = [...executions.values()]
        .filter(
          (e) =>
            e.graphRunId === graphRunId &&
            e.nodeId === nodeId &&
            (e.status === 'pending' || e.status === 'running'),
        )
        .sort((a, b) => b.activationNo - a.activationNo || b.attemptNo - a.attemptNo);
      return matches[0] ?? null;
    },
    listActiveByRun(graphRunId: string): ReadonlyArray<NodeExecutionRecord> {
      return [...executions.values()].filter(
        (e) => e.graphRunId === graphRunId && (e.status === 'pending' || e.status === 'running'),
      );
    },
    markRunning(
      id: string,
      expected: ReadonlyArray<NodeExecutionStatus>,
      opts: {
        readonly taskId: string | null;
        readonly claimedBy: string | null;
        readonly leaseExpiresAt: string | null;
      },
    ): boolean {
      const e = executions.get(id);
      if (!e || !expected.includes(e.status)) return false;
      executions.set(id, {
        ...e,
        status: 'running',
        taskId: opts.taskId,
        claimedBy: opts.claimedBy,
        leaseExpiresAt: opts.leaseExpiresAt,
        updatedAt: NOW,
      });
      return true;
    },
    markSettled(
      id: string,
      expected: ReadonlyArray<NodeExecutionStatus>,
      receiptJson: string | null,
      settledAt: string,
    ): boolean {
      const e = executions.get(id);
      if (!e || !expected.includes(e.status)) return false;
      executions.set(id, {
        ...e,
        status: 'settled',
        artifactReceiptJson: receiptJson,
        settledAt,
        updatedAt: NOW,
      });
      return true;
    },
    markFailed(
      id: string,
      expected: ReadonlyArray<NodeExecutionStatus>,
      errorCode: string,
    ): boolean {
      const e = executions.get(id);
      if (!e || !expected.includes(e.status)) return false;
      executions.set(id, { ...e, status: 'failed', errorCode, updatedAt: NOW });
      return true;
    },
    markSuperseded(id: string, expected: ReadonlyArray<NodeExecutionStatus>): boolean {
      const e = executions.get(id);
      if (!e || !expected.includes(e.status)) return false;
      executions.set(id, { ...e, status: 'superseded', updatedAt: NOW });
      return true;
    },
  };

  const nodeExecutionResultStore: NodeExecutionResultStorePort = {
    save(envelope: NodeExecutionResultEnvelope): void {
      results.set(envelope.executionId, envelope);
    },
    saveOrVerifySame(envelope: NodeExecutionResultEnvelope): void {
      const existing = results.get(envelope.executionId);
      if (existing === undefined) {
        results.set(envelope.executionId, envelope);
        return;
      }
      if (JSON.stringify(existing) !== JSON.stringify(envelope)) {
        throw new Error(`execution ${envelope.executionId} 已有不同内容的权威 result，拒绝覆盖`);
      }
    },
    getByExecutionId(executionId: string): NodeExecutionResultEnvelope | null {
      return results.get(executionId) ?? null;
    },
    getByArtifactId(artifactId: string): NodeExecutionResultEnvelope | null {
      return [...results.values()].find((r) => r.artifactId === artifactId) ?? null;
    },
  };

  // 真实 artifact 权威存储 fake（transaction-scoped resolver 校验 researchBundle / storyBlueprint）
  const researchBundles = new Map<string, ResearchBundle>();
  const researchBundleRepo: ResearchBundleRepositoryPort = {
    save(bundle: ResearchBundle): void {
      researchBundles.set(`${bundle.projectId}:${bundle.id}:${bundle.version}`, bundle);
    },
    getById(projectId: string, bundleId: string): ResearchBundle | null {
      const all = [...researchBundles.values()].filter(
        (b) => b.projectId === projectId && b.id === bundleId,
      );
      all.sort((a, b) => b.version - a.version);
      return all[0] ?? null;
    },
    listByProject(projectId: string): ReadonlyArray<ResearchBundle> {
      return [...researchBundles.values()].filter((b) => b.projectId === projectId);
    },
  };

  const storyBlueprints = new Map<string, { blueprint: StoryBlueprint; accepted: boolean }>();
  const storyBlueprintRepo: StoryBlueprintRepositoryPort = {
    save(blueprint: StoryBlueprint, accepted: boolean): void {
      storyBlueprints.set(`${blueprint.projectId}:${blueprint.id}:${blueprint.version}`, {
        blueprint,
        accepted,
      });
    },
    getById(
      projectId: string,
      blueprintId: string,
    ): { readonly blueprint: StoryBlueprint; readonly accepted: boolean } | null {
      const all = [...storyBlueprints.values()].filter(
        (r) => r.blueprint.projectId === projectId && r.blueprint.id === blueprintId,
      );
      all.sort((a, b) => b.blueprint.version - a.blueprint.version);
      return all[0] ?? null;
    },
    listByProject(projectId: string): ReadonlyArray<StoryBlueprint> {
      return [...storyBlueprints.values()]
        .filter((r) => r.blueprint.projectId === projectId)
        .map((r) => r.blueprint);
    },
    markAccepted(projectId: string, blueprintId: string): boolean {
      let found = false;
      for (const [key, r] of storyBlueprints) {
        if (r.blueprint.projectId === projectId && r.blueprint.id === blueprintId) {
          storyBlueprints.set(key, { ...r, accepted: true });
          found = true;
        }
      }
      return found;
    },
  };

  // idea / creationSpec 底层权威存储 fake（B3/D-B3-2）
  const fakeIntakeSessions = new Map<string, { id: string; projectId: string }>();
  const intakeSessionReadRepo: import('./graph-run-types.js').IntakeSessionReadPort = {
    getById: (id) => fakeIntakeSessions.get(id) ?? null,
  };
  const fakeSpecVersions = new Map<string, { id: string; projectId: string; version: number }>();
  const creationSpecVersionReadRepo: import('./graph-run-types.js').CreationSpecVersionReadPort = {
    getById: (projectId, id) => {
      const row = fakeSpecVersions.get(id);
      return row && row.projectId === projectId ? row : null;
    },
  };

  // 任务仓库 fake（Blocker 3：execution、task 创建/绑定同一事务内）
  const fakeTasks = new Map<string, import('./types.js').TaskData>();
  const taskRepo: import('./types.js').TaskRepositoryPort = {
    create: (d) => {
      fakeTasks.set(d.id, {
        ...d,
        dedupeKey: d.dedupeKey ?? null,
        status: 'PENDING',
        attemptCount: 0,
        resultJson: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        staleAt: null,
        cancelledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    },
    getById: (id) => fakeTasks.get(id) ?? null,
    listByProject: () => [],
    listByStatus: () => [],
    claimPending: (id) => {
      const t = fakeTasks.get(id);
      if (!t || t.status !== 'PENDING') return false;
      fakeTasks.set(id, { ...t, status: 'RUNNING', attemptCount: t.attemptCount + 1 });
      return true;
    },
    completeRunning: (id, resultJson) => {
      const t = fakeTasks.get(id);
      if (!t || t.status !== 'RUNNING') return false;
      fakeTasks.set(id, { ...t, status: 'SUCCEEDED', resultJson });
      return true;
    },
    failRunning: (id, errorCode, errorMessage) => {
      const t = fakeTasks.get(id);
      if (!t || t.status !== 'RUNNING') return false;
      fakeTasks.set(id, { ...t, status: 'FAILED', errorCode, errorMessage });
      return true;
    },
    failPending: (id, errorCode, errorMessage) => {
      const t = fakeTasks.get(id);
      if (!t || t.status !== 'PENDING') return false;
      fakeTasks.set(id, { ...t, status: 'FAILED', errorCode, errorMessage });
      return true;
    },
    markStale: () => true,
    resetToPending: () => true,
    listRunning: () => [],
  };

  // execution→artifact provenance fake（Blocker 5）
  const provenance = new Map<
    string,
    import('./node-execution-types.js').ArtifactProvenanceRecord
  >();
  const artifactProvenanceRepo: import('./node-execution-types.js').ArtifactProvenanceRepoPort = {
    upsert: (record) => {
      const key = `${record.artifactKind}:${record.artifactId}`;
      const existing = provenance.get(key);
      if (
        existing !== undefined &&
        (existing.executionId !== record.executionId ||
          existing.version !== record.version ||
          existing.graphRunId !== record.graphRunId ||
          existing.nodeId !== record.nodeId ||
          existing.projectId !== record.projectId)
      ) {
        throw new Error(`artifact ${key} 已由其他 execution/run 产出，拒绝覆盖`);
      }
      provenance.set(key, record);
    },
    getByArtifact: (artifactKind, artifactId) =>
      provenance.get(`${artifactKind}:${artifactId}`) ?? null,
  };

  const tx: GraphRunTransactionPort = {
    runInTransaction<T>(
      operation: (repos: {
        graphRunRepo: GraphRunRepositoryPort;
        commandLog: GraphRunCommandLogPort;
        intakeAnswer: IdeaIntakeAnswerPort;
        nodeExecutionRepo: NodeExecutionRepositoryPort;
        nodeExecutionResultStore: NodeExecutionResultStorePort;
        researchBundleRepo: ResearchBundleRepositoryPort;
        storyBlueprintRepo: StoryBlueprintRepositoryPort;
        intakeSessionReadRepo: import('./graph-run-types.js').IntakeSessionReadPort;
        creationSpecVersionReadRepo: import('./graph-run-types.js').CreationSpecVersionReadPort;
        taskRepo: import('./types.js').TaskRepositoryPort;
        artifactProvenanceRepo: import('./node-execution-types.js').ArtifactProvenanceRepoPort;
      }) => T,
    ): T {
      return operation({
        graphRunRepo,
        commandLog,
        intakeAnswer,
        nodeExecutionRepo,
        nodeExecutionResultStore,
        researchBundleRepo,
        storyBlueprintRepo,
        intakeSessionReadRepo,
        creationSpecVersionReadRepo,
        taskRepo,
        artifactProvenanceRepo,
      });
    },
  };

  return {
    graphRunRepo,
    commandLog,
    intakeAnswer,
    nodeExecutionRepo,
    nodeExecutionResultStore,
    researchBundleRepo,
    storyBlueprintRepo,
    intakeSessionReadRepo,
    creationSpecVersionReadRepo,
    fakeIntakeSessions,
    fakeSpecVersions,
    taskRepo,
    fakeTasks,
    artifactProvenanceRepo,
    provenance,
    tx,
    runs,
    commands,
    answers,
    executions,
    results,
    setForceCasFail(value: boolean): void {
      forceCasFail = value;
    },
  };
}

let counter = 0;

export function createTestDeps() {
  const repos = createFakeGraphRunRepos();
  const deps: GraphRunDeps = {
    idGenerator: {
      generate: () => {
        counter += 1;
        return `id-${counter}`;
      },
    },
    clock: { now: () => '2026-08-04T00:00:00.000Z' },
    hashPayload: (payload: string) => `h:${payload}`,
    tx: repos.tx,
    projectGraph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    chapterGraph: CHAPTER_GENERATION_GRAPH_V1,
  };
  return { deps, ...repos };
}
