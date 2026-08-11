/**
 * GE-4 Research sync executor 单测（真实 SQLite）。
 *
 * 重点是 TD-023 连接纪律回归：RESEARCH_DECISION / RESEARCH_VALIDATE 每次执行都
 * 通过 ctx.getProjectDb 新开一条 project.sqlite 连接（生产 index.ts getProjectDb
 * 不是缓存）——execute 结束（含抛错）必须 close()，否则每次节点执行（含 infra
 * 重试与回环再激活）都泄漏一条连接，直到 worker 进程退出才回收。
 * intake 两个 sync executor 的同款回归见 intake-e2e.integration.test.ts 测试 10。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import {
  createGrillSession,
  ExecutorRegistry,
  type NodeExecutorRunner,
  type NodeOutput,
} from '@ai-novel/application';
import type { ResearchBundle } from '@ai-novel/research-engine';
import {
  RESEARCH_DECISION,
  RESEARCH_VALIDATE,
  canonicalSerializeContractSections,
  canonicalSerializeContractSnapshot,
  validateCreationContractSections,
} from '@ai-novel/domain';
import { sha256Hex } from '@ai-novel/task-engine';
import { registerResearchExecutors } from './research-executors.js';
import { buildGrillSessionDeps } from './grill-handlers.js';

const NOW = '2026-08-12T00:00:00.000Z';

let tempDir: string;
let idCounter = 0;

const clock = { now: () => NOW };
const idGenerator = { generate: () => `id-${++idCounter}` };

interface SeededDb {
  db: ProjectDatabase;
  dbPath: string;
  sessionId: string;
  specVersionId: string;
}

/** 真实 project.sqlite + 元数据 + grill session + creationSpec v1（决策执行器的读取面） */
function seedDb(): SeededDb {
  const dbPath = join(tempDir, `project-${++idCounter}.sqlite`);
  const db = new ProjectDatabase(dbPath);
  db.getProjectMetadataRepository().create({
    id: 'p1',
    name: '测试项目',
    initialIdea: '一个晚清历史背景的侦探故事，注重史实细节',
    status: 'ACTIVE',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const grillDeps = buildGrillSessionDeps(db, { getProjectDb: () => db, idGenerator, clock });
  const session = createGrillSession(grillDeps, {
    projectId: 'p1',
    goal: '一个晚清历史背景的侦探故事，注重史实细节',
  });
  const sections = validateCreationContractSections({
    premise: '晚清租界里的连环失踪案',
    genre: ['mystery'],
    tone: ['dark'],
    targetAudience: 'adults',
    narrativePov: 'FIRST',
    tense: 'PAST',
    protagonist: { characterKey: 'protag', name: '侦探沈砚' },
  });
  const specVersionId = 'spec-v1';
  db.getCreationContractVersionRepository().create({
    id: specVersionId,
    projectId: 'p1',
    version: 1,
    schemaVersion: 1,
    sourceProposalId: null,
    basedOnGrillSessionId: null,
    basedOnGrillSessionVersion: null,
    sectionsJson: canonicalSerializeContractSections(sections),
    lockedFieldPathsJson: '[]',
    contractSnapshotHash: sha256Hex(
      canonicalSerializeContractSnapshot({ sections, lockedFieldPaths: [], schemaVersion: 1 }),
    ),
    provenanceJson: '[]',
    createdAt: NOW,
    createdBy: 'user',
  });
  return { db, dbPath, sessionId: session.id, specVersionId };
}

function makeBundle(overrides: Partial<ResearchBundle> = {}): ResearchBundle {
  return {
    id: 'bundle-1',
    projectId: 'p1',
    version: 1,
    depth: 'deep',
    questions: [
      {
        id: 'q1',
        text: '晚清租界巡捕房制度',
        sources: [
          {
            url: 'https://facts.example/a',
            title: '资料 A',
            fetchedAt: NOW,
            excerpt: '摘录',
          },
        ],
      },
    ],
    factNotes: [{ id: 'f1', text: '事实笔记', sourceUrls: ['https://facts.example/a'] }],
    conclusion: '调研结论',
    createdAt: NOW,
    basedOnBundleId: null,
    ...overrides,
  };
}

/** 追踪 getProjectDb 交出的每条连接是否被 close（泄漏回归：修复前 executor 从不关） */
function buildTrackedRunners(dbPath: string) {
  const opened: Array<{ closed: boolean }> = [];
  const registry = new ExecutorRegistry();
  const runners = new Map<string, NodeExecutorRunner>();
  registerResearchExecutors(registry, runners, {
    getProjectDb: () => {
      const projDb = new ProjectDatabase(dbPath);
      const entry = { closed: false };
      opened.push(entry);
      const originalClose = projDb.close.bind(projDb);
      projDb.close = () => {
        entry.closed = true;
        originalClose();
      };
      return projDb;
    },
    idGenerator,
    clock,
  });
  return { runners, opened };
}

function syncExecute(runners: Map<string, NodeExecutorRunner>, executorId: string) {
  const runner = runners.get(executorId) as unknown as {
    execute: (ctx: unknown) => NodeOutput;
  };
  return (nodeId: string, inputSnapshot: unknown): NodeOutput =>
    runner.execute({
      projectId: 'p1',
      graphRunId: 'run-1',
      nodeId,
      executionId: `exec-${++idCounter}`,
      activationNo: 1,
      attemptNo: 1,
      inputSnapshot,
      inputHash: 'hash-1',
    });
}

describe('research sync executors（TD-023 连接纪律）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-executors-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('RESEARCH_DECISION 成功路径：产出 outcome，连接执行完即关', () => {
    const { db, dbPath, sessionId, specVersionId } = seedDb();
    try {
      const { runners, opened } = buildTrackedRunners(dbPath);
      const execute = syncExecute(runners, 'research-decision-v1');
      const output = execute(RESEARCH_DECISION, {
        artifacts: {
          idea: { artifactId: sessionId },
          creationSpec: { artifactId: specVersionId },
        },
      });
      expect(output.outcome?.condition).toBe('research_decision');
      expect(['none', 'light', 'deep']).toContain(output.outcome?.value);
      expect(opened).toHaveLength(1);
      expect(opened[0].closed).toBe(true);
    } finally {
      db.close();
    }
  });

  it('RESEARCH_DECISION 抛错路径：session 不存在照样关连接', () => {
    const { db, dbPath, specVersionId } = seedDb();
    try {
      const { runners, opened } = buildTrackedRunners(dbPath);
      const execute = syncExecute(runners, 'research-decision-v1');
      expect(() =>
        execute(RESEARCH_DECISION, {
          artifacts: {
            idea: { artifactId: 'no-such-session' },
            creationSpec: { artifactId: specVersionId },
          },
        }),
      ).toThrow('idea session 不存在');
      expect(opened).toHaveLength(1);
      expect(opened[0].closed).toBe(true);
    } finally {
      db.close();
    }
  });

  it('RESEARCH_VALIDATE 成功路径：valid/invalid 都产出且连接执行完即关', () => {
    const { db, dbPath } = seedDb();
    try {
      db.getResearchBundleRepository().save(makeBundle(), NOW);
      // 缺事实笔记 → 确定性校验 invalid（D-B5-4）
      db.getResearchBundleRepository().save(
        makeBundle({ id: 'bundle-2', version: 2, factNotes: [] }),
        NOW,
      );
      const { runners, opened } = buildTrackedRunners(dbPath);
      const execute = syncExecute(runners, 'research-validate-v1');

      const valid = execute(RESEARCH_VALIDATE, {
        artifacts: { researchBundle: { artifactId: 'bundle-1' } },
      });
      expect(valid.outcome).toEqual({ condition: 'research_valid', value: 'valid' });

      const invalid = execute(RESEARCH_VALIDATE, {
        artifacts: { researchBundle: { artifactId: 'bundle-2' } },
      });
      expect(invalid.outcome).toEqual({ condition: 'research_valid', value: 'invalid' });

      // 每次执行各开各关：两次执行 = 两条连接，全部关闭
      expect(opened).toHaveLength(2);
      expect(opened.every((entry) => entry.closed)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('RESEARCH_VALIDATE 抛错路径：bundle 不存在照样关连接', () => {
    const { db, dbPath } = seedDb();
    try {
      const { runners, opened } = buildTrackedRunners(dbPath);
      const execute = syncExecute(runners, 'research-validate-v1');
      expect(() =>
        execute(RESEARCH_VALIDATE, {
          artifacts: { researchBundle: { artifactId: 'no-such-bundle' } },
        }),
      ).toThrow('researchBundle 不存在');
      expect(opened).toHaveLength(1);
      expect(opened[0].closed).toBe(true);
    } finally {
      db.close();
    }
  });
});
