/**
 * Web Research Worker 命令分发测试（GE-4/B6，真实 SQLite + fake provider）。
 *
 * - research.execute：编排 + 持久化 ResearchBundle；
 * - 非法深度 / 缺失字段 → VALIDATION_ERROR；
 * - research.getResearchState：无 run / none 决策 / deep+bundle / invalid+escalation 四态（D-B6-3）；
 * - research.getBundle / listBundles：DTO 映射（D-B6-3）；
 * - research.setSourceExclusion / listSourceExclusions：来源排除（D-B6-2）+ 不安全 URL 拒绝。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectDatabase } from '@ai-novel/database';
import type { ResearchBundle } from '@ai-novel/research-engine';
import {
  artifactRef,
  createProjectId,
  createProjectInitialRunState,
  createWorkflowRunId,
  IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
  RESEARCH_DECISION,
  RESEARCH_ESCALATION,
  RESEARCH_VALIDATE,
} from '@ai-novel/domain';
import type { IdeaToNovelProjectRunState } from '@ai-novel/domain';
import {
  createFakeResearchProvider,
  dispatchResearchCommand,
  type ResearchHandlerContext,
} from './research-handlers.js';

const NOW = '2026-08-04T00:00:00.000Z';

let tempDir: string;
let dbPath: string;

function freshDb(): ProjectDatabase {
  const db = new ProjectDatabase(dbPath);
  if (db.getProjectMetadataRepository().get() === null) {
    db.getProjectMetadataRepository().create({
      id: 'p1',
      name: '项目一',
      initialIdea: '一个故事',
      status: 'contract',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return db;
}

function ctx(): ResearchHandlerContext {
  const provider = createFakeResearchProvider();
  return {
    getProjectDb: () => freshDb(),
    search: provider.search,
    fetch: provider.fetch,
  };
}

/** 只读/排除通道的 ctx：不装配搜索/抓取 provider（B6 交付说明——不复用 fake provider ctx） */
function readCtx(): ResearchHandlerContext {
  return { getProjectDb: () => freshDb() };
}

/** insertProjectRun 的场景覆盖（各字段与 base 深合并，未提及的键保留 base 默认） */
interface RunOverrides {
  readonly nodeStatuses?: Partial<IdeaToNovelProjectRunState['nodeStatuses']>;
  readonly nodeOutcomes?: IdeaToNovelProjectRunState['nodeOutcomes'];
  readonly artifacts?: Partial<IdeaToNovelProjectRunState['artifacts']>;
  readonly attemptBudget?: IdeaToNovelProjectRunState['attemptBudget'];
  readonly pendingHumanDecision?: IdeaToNovelProjectRunState['pendingHumanDecision'];
}

/**
 * 直接插入一个 project run 状态（绕过任务引擎，仅用于投影读测试）。
 * nodeStatuses/nodeOutcomes/artifacts 与 base 深合并（只需给出要覆盖的键）；
 * attemptBudget/pendingHumanDecision 给出即整体替换。
 */
function insertProjectRun(
  db: ProjectDatabase,
  runId: string,
  createdAt: string,
  overrides: RunOverrides,
): void {
  const base = createProjectInitialRunState({
    graph: IDEA_TO_NOVEL_PROJECT_GRAPH_V1,
    projectId: createProjectId('p1'),
    workflowRunId: createWorkflowRunId(runId),
    createdAt,
  });
  const state: IdeaToNovelProjectRunState = {
    ...base,
    nodeStatuses: {
      ...base.nodeStatuses,
      ...overrides.nodeStatuses,
    } as IdeaToNovelProjectRunState['nodeStatuses'],
    nodeOutcomes: { ...base.nodeOutcomes, ...overrides.nodeOutcomes },
    artifacts: {
      ...base.artifacts,
      ...overrides.artifacts,
    } as IdeaToNovelProjectRunState['artifacts'],
    attemptBudget: overrides.attemptBudget ?? base.attemptBudget,
    pendingHumanDecision: overrides.pendingHumanDecision ?? base.pendingHumanDecision,
  };
  db.getGraphRunTransaction().runInTransaction((repos) => {
    repos.graphRunRepo.create(state, createdAt);
  });
}

describe('dispatchResearchCommand', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-handler-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('research.execute 生成并持久化 ResearchBundle', async () => {
    const db = freshDb();
    try {
      const bundle = (await dispatchResearchCommand(
        'research.execute',
        {
          projectId: 'p1',
          idea: '晚清上海滩的谍战故事',
          depth: 'deep',
          questions: ['当时的租界格局'],
        },
        ctx(),
      )) as ResearchBundle;
      expect(bundle.depth).toBe('deep');
      expect(bundle.projectId).toBe('p1');
      expect(bundle.questions.length).toBeGreaterThan(0);

      // 已持久化
      const saved = db.getResearchBundleRepository().getById('p1', bundle.id);
      expect(saved).not.toBeNull();
      expect(saved!.factNotes.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('非法深度 → VALIDATION_ERROR', async () => {
    await expect(
      dispatchResearchCommand(
        'research.execute',
        { projectId: 'p1', idea: 'x', depth: 'ultra', questions: [] },
        ctx(),
      ),
    ).rejects.toThrow();
  });

  it('缺失 idea → VALIDATION_ERROR', async () => {
    await expect(
      dispatchResearchCommand(
        'research.execute',
        { projectId: 'p1', depth: 'light', questions: [] },
        ctx(),
      ),
    ).rejects.toThrow();
  });
});

describe('research.getResearchState（D-B6-3，四态）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-handler-state-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('无 run：全 null / false / 0', async () => {
    freshDb().close();
    const state = await dispatchResearchCommand(
      'research.getResearchState',
      { projectId: 'p1' },
      readCtx(),
    );
    expect(state).toEqual({
      runId: null,
      researchDecision: null,
      researchValid: null,
      bundleRef: null,
      escalationActive: false,
      researchRetryUsed: 0,
    });
  });

  it('none 决策：直达蓝图，无 bundle/校验/升级', async () => {
    const db = freshDb();
    try {
      insertProjectRun(db, 'run-none', NOW, {
        nodeStatuses: { [RESEARCH_DECISION]: 'succeeded' },
        nodeOutcomes: { [RESEARCH_DECISION]: { condition: 'research_decision', value: 'none' } },
      });
    } finally {
      db.close();
    }

    const state = await dispatchResearchCommand(
      'research.getResearchState',
      { projectId: 'p1' },
      readCtx(),
    );
    expect(state).toEqual({
      runId: 'run-none',
      researchDecision: 'none',
      researchValid: null,
      bundleRef: null,
      escalationActive: false,
      researchRetryUsed: 0,
    });
  });

  it('deep + bundle：research_valid=valid，bundleRef 指向 artifact', async () => {
    const db = freshDb();
    try {
      insertProjectRun(db, 'run-deep', NOW, {
        nodeStatuses: {
          [RESEARCH_DECISION]: 'succeeded',
          [RESEARCH_VALIDATE]: 'succeeded',
        },
        nodeOutcomes: {
          [RESEARCH_DECISION]: { condition: 'research_decision', value: 'deep' },
          [RESEARCH_VALIDATE]: { condition: 'research_valid', value: 'valid' },
        },
        artifacts: {
          researchBundle: artifactRef('researchBundle', 'rb-1'),
        },
      });
    } finally {
      db.close();
    }

    const state = await dispatchResearchCommand(
      'research.getResearchState',
      { projectId: 'p1' },
      readCtx(),
    );
    expect(state).toEqual({
      runId: 'run-deep',
      researchDecision: 'deep',
      researchValid: 'valid',
      bundleRef: 'rb-1',
      escalationActive: false,
      researchRetryUsed: 0,
    });
  });

  it('invalid + escalation：research_valid=invalid，人工升级 Gate 打开', async () => {
    const db = freshDb();
    try {
      insertProjectRun(db, 'run-invalid', NOW, {
        nodeStatuses: {
          [RESEARCH_DECISION]: 'succeeded',
          [RESEARCH_VALIDATE]: 'succeeded',
          [RESEARCH_ESCALATION]: 'waiting_for_human',
        },
        nodeOutcomes: {
          [RESEARCH_DECISION]: { condition: 'research_decision', value: 'deep' },
          [RESEARCH_VALIDATE]: { condition: 'research_valid', value: 'invalid' },
        },
        attemptBudget: {
          clarification: 0,
          intakeRevision: 0,
          researchRetry: 2,
          blueprintRewrite: 0,
          specRevision: 0,
        },
        pendingHumanDecision: { nodeId: RESEARCH_ESCALATION, decisionType: 'escalation' },
      });
    } finally {
      db.close();
    }

    const state = await dispatchResearchCommand(
      'research.getResearchState',
      { projectId: 'p1' },
      readCtx(),
    );
    expect(state).toEqual({
      runId: 'run-invalid',
      researchDecision: 'deep',
      researchValid: 'invalid',
      bundleRef: null,
      escalationActive: true,
      researchRetryUsed: 2,
    });
  });

  it('多个 project run：取最新（按 createdAt）', async () => {
    const db = freshDb();
    try {
      insertProjectRun(db, 'run-old', '2026-08-01T00:00:00.000Z', {
        nodeStatuses: { [RESEARCH_DECISION]: 'succeeded' },
        nodeOutcomes: { [RESEARCH_DECISION]: { condition: 'research_decision', value: 'light' } },
      });
      insertProjectRun(db, 'run-new', '2026-08-02T00:00:00.000Z', {
        nodeStatuses: { [RESEARCH_DECISION]: 'succeeded' },
        nodeOutcomes: { [RESEARCH_DECISION]: { condition: 'research_decision', value: 'none' } },
      });
    } finally {
      db.close();
    }

    const state = await dispatchResearchCommand(
      'research.getResearchState',
      { projectId: 'p1' },
      readCtx(),
    );
    expect((state as { runId: string }).runId).toBe('run-new');
    expect((state as { researchDecision: string }).researchDecision).toBe('none');
  });
});

describe('research.getBundle / listBundles（D-B6-3）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-handler-bundle-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function fixtureBundle(id: string, version: number): ResearchBundle {
    return {
      id,
      projectId: 'p1',
      version,
      depth: 'deep',
      questions: [
        {
          id: 'q1',
          text: '问题一',
          sources: [
            { url: 'https://example.com/a', title: '标题', fetchedAt: NOW, excerpt: '摘要' },
          ],
        },
      ],
      factNotes: [{ id: 'f1', text: '事实一', sourceUrls: ['https://example.com/a'] }],
      conclusion: '结论',
      createdAt: NOW,
    };
  }

  it('getBundle：存在则映射为 DTO（basedOnBundleId 缺省归一为 null）', async () => {
    const db = freshDb();
    try {
      db.getResearchBundleRepository().save(fixtureBundle('rb-1', 1), NOW);
    } finally {
      db.close();
    }

    const dto = await dispatchResearchCommand(
      'research.getBundle',
      { projectId: 'p1', bundleId: 'rb-1' },
      readCtx(),
    );
    expect(dto).toMatchObject({
      id: 'rb-1',
      projectId: 'p1',
      version: 1,
      depth: 'deep',
      basedOnBundleId: null,
    });
  });

  it('getBundle：不存在返回 null', async () => {
    freshDb().close();
    const dto = await dispatchResearchCommand(
      'research.getBundle',
      { projectId: 'p1', bundleId: 'never-existed' },
      readCtx(),
    );
    expect(dto).toBeNull();
  });

  it('listBundles：按 created_at 升序返回全部版本', async () => {
    const db = freshDb();
    try {
      db.getResearchBundleRepository().save(fixtureBundle('rb-1', 1), '2026-08-01T00:00:00.000Z');
      db.getResearchBundleRepository().save(fixtureBundle('rb-2', 1), '2026-08-02T00:00:00.000Z');
    } finally {
      db.close();
    }

    const list = (await dispatchResearchCommand(
      'research.listBundles',
      { projectId: 'p1' },
      readCtx(),
    )) as ReadonlyArray<{ id: string }>;
    expect(list.map((b) => b.id)).toEqual(['rb-1', 'rb-2']);
  });
});

describe('research.setSourceExclusion / listSourceExclusions（D-B6-2）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'research-handler-exclusion-'));
    dbPath = join(tempDir, 'project.sqlite');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('setExclusion(true) → listSourceExclusions 可见；setExclusion(false) → 取消', async () => {
    freshDb().close();
    const afterSet = await dispatchResearchCommand(
      'research.setSourceExclusion',
      { projectId: 'p1', url: 'https://example.com/a', excluded: true },
      readCtx(),
    );
    expect(afterSet).toEqual(['https://example.com/a']);

    const list = await dispatchResearchCommand(
      'research.listSourceExclusions',
      { projectId: 'p1' },
      readCtx(),
    );
    expect(list).toEqual(['https://example.com/a']);

    const afterUnset = await dispatchResearchCommand(
      'research.setSourceExclusion',
      { projectId: 'p1', url: 'https://example.com/a', excluded: false },
      readCtx(),
    );
    expect(afterUnset).toEqual([]);
  });

  it('不安全来源 URL（IPv4-mapped IPv6 私网字面量）→ VALIDATION_ERROR', async () => {
    freshDb().close();
    await expect(
      dispatchResearchCommand(
        'research.setSourceExclusion',
        { projectId: 'p1', url: 'http://[::ffff:127.0.0.1]/', excluded: true },
        readCtx(),
      ),
    ).rejects.toThrow();
  });

  it('非法 URL 协议（非 http/https）→ VALIDATION_ERROR', async () => {
    freshDb().close();
    await expect(
      dispatchResearchCommand(
        'research.setSourceExclusion',
        { projectId: 'p1', url: 'ftp://example.com/a', excluded: true },
        readCtx(),
      ),
    ).rejects.toThrow();
  });

  it('缺失 excluded 字段 → VALIDATION_ERROR', async () => {
    freshDb().close();
    await expect(
      dispatchResearchCommand(
        'research.setSourceExclusion',
        { projectId: 'p1', url: 'https://example.com/a' },
        readCtx(),
      ),
    ).rejects.toThrow();
  });
});
