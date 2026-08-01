/**
 * 测试工具（仅测试使用；tsconfig 排除构建）。
 *
 * - FakeFs：内存文件系统，模拟 mkdir/writeFile/exists/readFile/renameDir/removeDir；
 * - fake invoke：按调用顺序返回预设 ModelInvocationOutput。
 */

import type { ModelInvocationInput, ModelInvocationOutput } from '@ai-novel/model-gateway';

export interface FakeFs {
  readonly tree: Map<string, string | null>;
  mkdir(p: string): void;
  writeFile(p: string, content: string): void;
  exists(p: string): boolean;
  readFile(p: string): string;
  renameDir(from: string, to: string): void;
  removeDir(p: string): void;
  list(p: string): string[];
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
}

export function createFakeFs(): FakeFs {
  const tree = new Map<string, string | null>();

  function mkdir(p: string): void {
    if (tree.has(p)) return;
    const parent = dirname(p);
    if (parent !== p) mkdir(parent);
    tree.set(p, null);
  }

  function writeFile(p: string, content: string): void {
    mkdir(dirname(p));
    tree.set(p, content);
  }

  function exists(p: string): boolean {
    return tree.has(p);
  }

  function readFile(p: string): string {
    const v = tree.get(p);
    if (v === undefined || v === null) throw new Error(`ENOENT: ${p}`);
    return v;
  }

  function renameDir(from: string, to: string): void {
    if (tree.get(from) !== null || !tree.has(from)) {
      throw new Error(`EISDIR/ENOENT expected: ${from}`);
    }
    if (tree.has(to)) throw new Error(`EEXIST: ${to}`);
    const keys = [...tree.keys()].filter((k) => k === from || k.startsWith(`${from}/`));
    if (keys.length === 0) throw new Error(`ENOENT: ${from}`);
    mkdir(dirname(to));
    for (const k of keys) {
      const v = tree.get(k)!;
      tree.delete(k);
      tree.set(k === from ? to : `${to}${k.slice(from.length)}`, v);
    }
  }

  function removeDir(p: string): void {
    const keys = [...tree.keys()].filter((k) => k === p || k.startsWith(`${p}/`));
    for (const k of keys) tree.delete(k);
  }

  function list(p: string): string[] {
    const prefix = p === '/' ? '/' : `${p}/`;
    return [...tree.keys()].filter((k) => k.startsWith(prefix));
  }

  return { tree, mkdir, writeFile, exists, readFile, renameDir, removeDir, list };
}

export interface QueuedInvoke {
  (input: ModelInvocationInput): Promise<ModelInvocationOutput>;
  calls: ModelInvocationInput[];
}

export function createQueuedInvoke(outputs: readonly ModelInvocationOutput[]): QueuedInvoke {
  const calls: ModelInvocationInput[] = [];
  let index = 0;
  const fn = async (input: ModelInvocationInput): Promise<ModelInvocationOutput> => {
    calls.push(input);
    const out = outputs[Math.min(index, outputs.length - 1)];
    index += 1;
    return out;
  };
  (fn as QueuedInvoke).calls = calls;
  return fn as QueuedInvoke;
}

export function okOutput(
  text: string,
  extra: Partial<ModelInvocationOutput> = {},
): ModelInvocationOutput {
  return {
    text,
    providerRequestId: 'req-live-1',
    finishReason: 'end_turn',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
    },
    latencyMs: 10,
    errorCode: null,
    errorMessage: null,
    ...extra,
  };
}

export function errorOutput(
  code: string,
  extra: Partial<ModelInvocationOutput> = {},
): ModelInvocationOutput {
  return {
    text: '',
    providerRequestId: null,
    finishReason: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    },
    latencyMs: 5,
    errorCode: code as ModelInvocationOutput['errorCode'],
    errorMessage: 'RAW provider error message (must never leak)',
    ...extra,
  };
}
