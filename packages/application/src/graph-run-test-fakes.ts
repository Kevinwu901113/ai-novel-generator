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
  GenerationArtifactRecord,
  GenerationArtifactStorePort,
  NodeExecutionRecord,
  NodeExecutionRepositoryPort,
  NodeExecutionStatus,
} from './node-execution-types.js';

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
  const artifacts = new Map<string, GenerationArtifactRecord>();

  const nodeExecutionRepo: NodeExecutionRepositoryPort = {
    create(input: CreateNodeExecutionInput): boolean {
      const dup = [...executions.values()].some(
        (e) =>
          e.graphRunId === input.graphRunId &&
          e.nodeId === input.nodeId &&
          e.attempt === input.attempt,
      );
      if (dup) return false;
      executions.set(input.id, {
        ...input,
        taskId: null,
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
    getByRunNode(graphRunId: string, nodeId: string): NodeExecutionRecord | null {
      const matches = [...executions.values()]
        .filter((e) => e.graphRunId === graphRunId && e.nodeId === nodeId)
        .sort((a, b) => b.attempt - a.attempt);
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
      taskId: string | null,
    ): boolean {
      const e = executions.get(id);
      if (!e || !expected.includes(e.status)) return false;
      executions.set(id, { ...e, status: 'running', taskId, updatedAt: NOW });
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
    retry(id: string, expected: ReadonlyArray<NodeExecutionStatus>, updatedAt: string): boolean {
      const e = executions.get(id);
      if (!e || !expected.includes(e.status)) return false;
      executions.set(id, {
        ...e,
        status: 'pending',
        attempt: e.attempt + 1,
        taskId: null,
        errorCode: null,
        updatedAt,
      });
      return true;
    },
    markSuperseded(id: string, expected: ReadonlyArray<NodeExecutionStatus>): boolean {
      const e = executions.get(id);
      if (!e || !expected.includes(e.status)) return false;
      executions.set(id, { ...e, status: 'superseded', updatedAt: NOW });
      return true;
    },
  };

  const generationArtifactStore: GenerationArtifactStorePort = {
    save(record: GenerationArtifactRecord): void {
      artifacts.set(record.id, record);
    },
    getById(id: string): GenerationArtifactRecord | null {
      return artifacts.get(id) ?? null;
    },
    getLatestByRunNode(graphRunId: string, nodeId: string): GenerationArtifactRecord | null {
      const matches = [...artifacts.values()]
        .filter((a) => a.graphRunId === graphRunId && a.nodeId === nodeId)
        .sort((a, b) => b.version - a.version);
      return matches[0] ?? null;
    },
  };

  const tx: GraphRunTransactionPort = {
    runInTransaction<T>(
      operation: (repos: {
        graphRunRepo: GraphRunRepositoryPort;
        commandLog: GraphRunCommandLogPort;
        intakeAnswer: IdeaIntakeAnswerPort;
        nodeExecutionRepo: NodeExecutionRepositoryPort;
        generationArtifactStore: GenerationArtifactStorePort;
      }) => T,
    ): T {
      return operation({
        graphRunRepo,
        commandLog,
        intakeAnswer,
        nodeExecutionRepo,
        generationArtifactStore,
      });
    },
  };

  return {
    graphRunRepo,
    commandLog,
    intakeAnswer,
    nodeExecutionRepo,
    generationArtifactStore,
    tx,
    runs,
    commands,
    answers,
    executions,
    artifacts,
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
