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

export interface FakeAnswerRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly text: string;
  readonly createdAt: string;
}

export function createFakeGraphRunRepos() {
  const runs = new Map<string, GraphRunStateRecord>();
  const commands = new Map<string, GraphRunCommandRecord>();
  const answers: FakeAnswerRecord[] = [];

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

  const tx: GraphRunTransactionPort = {
    runInTransaction<T>(
      operation: (repos: {
        graphRunRepo: GraphRunRepositoryPort;
        commandLog: GraphRunCommandLogPort;
        intakeAnswer: IdeaIntakeAnswerPort;
      }) => T,
    ): T {
      return operation({ graphRunRepo, commandLog, intakeAnswer });
    },
  };

  return { graphRunRepo, commandLog, intakeAnswer, tx, runs, commands, answers };
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
