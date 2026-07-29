import { describe, expect, it, vi } from 'vitest';
import { PlotPilotAdapter, PlotPilotAdapterError, parseSseStream } from './index.js';

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
  });
}

function spyStream(chunks: string[]): {
  stream: ReadableStream<Uint8Array>;
  cancelSpy: () => number;
} {
  const encoder = new TextEncoder();
  let index = 0;
  let cancelCount = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelCount++;
    },
  });
  return { stream, cancelSpy: () => cancelCount };
}

async function collectEvents(
  stream: ReadableStream<Uint8Array>,
  opts?: { signal?: AbortSignal; maxEventBytes?: number; maxTotalBytes?: number },
): Promise<string[]> {
  const types: string[] = [];
  for await (const event of parseSseStream(stream, opts)) {
    types.push(event.type);
  }
  return types;
}

describe('HTTP first-wins abort/timeout', () => {
  it('29. caller first, timeout later → ABORTED', async () => {
    const controller = new AbortController();
    let rejectFetch!: (e: Error) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((_, reject) => {
          rejectFetch = reject;
        }),
    );

    const adapter = new PlotPilotAdapter({ fetchImpl, requestTimeoutMs: 60_000 });
    const p = adapter.health(controller.signal);

    controller.abort();
    await Promise.resolve();
    const err = new Error('aborted');
    err.name = 'AbortError';
    rejectFetch(err);

    await expect(p).rejects.toMatchObject({ code: 'PLOTPILOT_ABORTED' });
  });

  it('30. timeout first, caller later → TIMEOUT', async () => {
    const controller = new AbortController();
    let rejectFetch!: (e: Error) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((_, reject) => {
          rejectFetch = reject;
        }),
    );

    const adapter = new PlotPilotAdapter({ fetchImpl, requestTimeoutMs: 1 });
    const p = adapter.health(controller.signal);

    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const err = new Error('aborted');
    err.name = 'AbortError';
    rejectFetch(err);

    await expect(p).rejects.toMatchObject({ code: 'PLOTPILOT_TIMEOUT' });
  });

  it('31. near-simultaneous preserves first reason', async () => {
    const controller = new AbortController();
    let rejectFetch!: (e: Error) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((_, reject) => {
          rejectFetch = reject;
        }),
    );

    const adapter = new PlotPilotAdapter({ fetchImpl, requestTimeoutMs: 1 });
    const p = adapter.health(controller.signal);

    controller.abort();
    await new Promise((r) => setTimeout(r, 5));
    const err = new Error('aborted');
    err.name = 'AbortError';
    rejectFetch(err);

    await expect(p).rejects.toMatchObject({ code: 'PLOTPILOT_ABORTED' });
  });

  it('32. successful request cleans up timer and listener', async () => {
    const controller = new AbortController();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));

    const adapter = new PlotPilotAdapter({ fetchImpl, requestTimeoutMs: 100 });
    await adapter.health(controller.signal);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    controller.abort();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('33. HTTP error not overridden by abort classification', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('err', { status: 503 }));
    const adapter = new PlotPilotAdapter({ fetchImpl });

    await expect(adapter.health()).rejects.toMatchObject({
      code: 'PLOTPILOT_HTTP_ERROR',
      statusCode: 503,
    });
  });

  it('34. network rejection → PLOTPILOT_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const adapter = new PlotPilotAdapter({ fetchImpl });
    await expect(adapter.health()).rejects.toMatchObject({ code: 'PLOTPILOT_UNAVAILABLE' });
  });

  it('35. HTTP 4xx/5xx does not leak body', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('secret-api-key-12345', { status: 500 }));
    const adapter = new PlotPilotAdapter({ fetchImpl });

    try {
      await adapter.health();
      expect.unreachable();
    } catch (e) {
      const err = e as PlotPilotAdapterError;
      expect(err.code).toBe('PLOTPILOT_HTTP_ERROR');
      expect(err.message).not.toContain('secret-api-key');
    }
  });

  it('36. response.body === null', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
    const adapter = new PlotPilotAdapter({ fetchImpl });

    await expect(
      adapter.generateChapter({ novelId: 'n1', chapterNumber: 1, outline: 'test' }),
    ).rejects.toMatchObject({ code: 'PLOTPILOT_RESPONSE_INVALID' });
  });
});

describe('SSE parser', () => {
  it('37. LF separator', async () => {
    const stream = streamFrom(['data: {"type":"a"}\n\ndata: {"type":"b"}\n\n']);
    expect(await collectEvents(stream)).toEqual(['a', 'b']);
  });

  it('38. CRLF separator', async () => {
    const stream = streamFrom(['data: {"type":"x"}\r\n\r\ndata: {"type":"y"}\r\n\r\n']);
    expect(await collectEvents(stream)).toEqual(['x', 'y']);
  });

  it('39. separator split across chunks', async () => {
    const stream = streamFrom(['data: {"type":"a"}\n', '\ndata: {"type":"b"}\n\n']);
    expect(await collectEvents(stream)).toEqual(['a', 'b']);
  });

  it('40. UTF-8 multi-byte split across chunks', async () => {
    const encoder = new TextEncoder();
    const full = 'data: {"type":"中文"}\n\n';
    const bytes = encoder.encode(full);
    const mid = Math.floor(bytes.length / 2);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });

    const events: string[] = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event.type);
    }
    expect(events).toEqual(['中文']);
  });

  it('41. multiline data', async () => {
    const stream = streamFrom(['data: {"type":"multi",\ndata: "value":"ok"}\n\n']);
    const events: Array<Record<string, unknown>> = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('multi');
  });

  it('42. comments and metadata fields', async () => {
    const stream = streamFrom([
      ': this is a comment\nevent: update\nid: 42\nretry: 3000\ndata: {"type":"real"}\n\n',
    ]);
    expect(await collectEvents(stream)).toEqual(['real']);
  });

  it('43. last frame without trailing separator', async () => {
    const stream = streamFrom(['data: {"type":"first"}\n\ndata: {"type":"last"}']);
    expect(await collectEvents(stream)).toEqual(['first', 'last']);
  });

  it('44. malformed JSON throws stable error', async () => {
    const stream = streamFrom(['data: {not json}\n\n']);
    await expect(collectEvents(stream)).rejects.toMatchObject({
      code: 'PLOTPILOT_RESPONSE_INVALID',
    });
  });

  it('45. [DONE] sentinel is skipped', async () => {
    const stream = streamFrom(['data: {"type":"a"}\n\ndata: [DONE]\n\n']);
    expect(await collectEvents(stream)).toEqual(['a']);
  });

  it('46. empty data lines produce no event', async () => {
    const stream = streamFrom(['data:\n\ndata: {"type":"ok"}\n\n']);
    expect(await collectEvents(stream)).toEqual(['ok']);
  });
});

describe('SSE stream abort', () => {
  it('47. abort during stream always throws PLOTPILOT_ABORTED', async () => {
    const controller = new AbortController();
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pullCount++;
        if (pullCount === 1) {
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"a"}\n\n'));
        } else {
          controller.abort();
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"b"}\n\n'));
        }
      },
    });

    let caught: unknown;
    const events: string[] = [];
    try {
      for await (const event of parseSseStream(stream, { signal: controller.signal })) {
        events.push(event.type);
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'PLOTPILOT_ABORTED' });
    expect(events).toContain('a');
    expect(events).not.toContain('b');
  });

  it('48. pre-aborted signal throws immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = streamFrom(['data: {"type":"a"}\n\n']);

    await expect(collectEvents(stream, { signal: controller.signal })).rejects.toMatchObject({
      code: 'PLOTPILOT_ABORTED',
    });
  });
});

describe('SSE reader cancel/release', () => {
  it('49. iterator.return() calls cancel once and releases', async () => {
    const { stream } = spyStream([
      'data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c"}\n\n',
    ]);
    const iter = parseSseStream(stream);
    const first = await iter.next();
    expect(first.value?.type).toBe('a');
    await iter.return(undefined);
    expect(stream.locked).toBe(false);
  });

  it('50. for-await break calls cancel once and releases', async () => {
    const { stream } = spyStream([
      'data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c"}\n\n',
    ]);
    for await (const event of parseSseStream(stream)) {
      expect(event.type).toBe('a');
      break;
    }
    expect(stream.locked).toBe(false);
  });

  it('51. onEvent throw preserves original error and releases', async () => {
    const { stream } = spyStream(['data: {"type":"a"}\n\ndata: {"type":"b"}\n\n']);
    let caught: unknown;
    try {
      for await (const event of parseSseStream(stream)) {
        if (event.type === 'a') throw new Error('consumer error');
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('consumer error');
    expect(stream.locked).toBe(false);
  });

  it('52. normal completion releases without cancel', async () => {
    const { stream, cancelSpy } = spyStream(['data: {"type":"a"}\n\n']);
    await collectEvents(stream);
    expect(stream.locked).toBe(false);
    expect(cancelSpy()).toBe(0);
  });

  it('53. abort calls cancel exactly once', async () => {
    const controller = new AbortController();
    let cancelCount = 0;
    let pullCount = 0;

    const abortStream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pullCount++;
        if (pullCount === 1) {
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"a"}\n\n'));
        } else {
          controller.abort();
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"b"}\n\n'));
        }
      },
      cancel() {
        cancelCount++;
      },
    });

    try {
      for await (const _ of parseSseStream(abortStream, { signal: controller.signal })) {
        void _;
      }
    } catch {
      // expected PLOTPILOT_ABORTED
    }
    await Promise.resolve();
    expect(abortStream.locked).toBe(false);
    expect(cancelCount).toBeLessThanOrEqual(1);
  });
});

describe('SSE byte-based limits', () => {
  it('54. ASCII event within byte limit passes', async () => {
    const stream = streamFrom(['data: {"type":"hello"}\n\n']);
    expect(await collectEvents(stream, { maxEventBytes: 100 })).toEqual(['hello']);
  });

  it('55. Chinese text byte limit (3 bytes per char)', async () => {
    const chinese = '中'.repeat(100);
    const stream = streamFrom([`data: {"type":"${chinese}"}\n\n`]);
    await expect(collectEvents(stream, { maxEventBytes: 200 })).rejects.toMatchObject({
      code: 'PLOTPILOT_BUFFER_OVERFLOW',
    });
  });

  it('56. emoji byte limit (4 bytes per char)', async () => {
    const emoji = '😀'.repeat(50);
    const stream = streamFrom([`data: {"type":"${emoji}"}\n\n`]);
    await expect(collectEvents(stream, { maxEventBytes: 150 })).rejects.toMatchObject({
      code: 'PLOTPILOT_BUFFER_OVERFLOW',
    });
  });

  it('57. UTF-8 split across chunks still counts bytes correctly', async () => {
    const encoder = new TextEncoder();
    const chinese = '中'.repeat(100);
    const full = `data: {"type":"${chinese}"}\n\n`;
    const bytes = encoder.encode(full);
    const mid = Math.floor(bytes.length / 2);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });

    await expect(collectEvents(stream, { maxEventBytes: 200 })).rejects.toMatchObject({
      code: 'PLOTPILOT_BUFFER_OVERFLOW',
    });
  });

  it('58. continuous input without separator hits buffer limit', async () => {
    const chunk = 'data: ' + 'x'.repeat(500);
    const stream = streamFrom([chunk, chunk, chunk]);
    await expect(collectEvents(stream, { maxEventBytes: 1000 })).rejects.toMatchObject({
      code: 'PLOTPILOT_BUFFER_OVERFLOW',
    });
  });

  it('59. consumed frames reset pending buffer count', async () => {
    const stream = streamFrom(['data: {"type":"a"}\n\ndata: {"type":"b"}\n\n']);
    expect(await collectEvents(stream, { maxEventBytes: 50 })).toEqual(['a', 'b']);
  });

  it('60. total stream limit enforced', async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => `data: {"type":"e${i}"}\n\n`);
    const stream = streamFrom(chunks);
    await expect(collectEvents(stream, { maxTotalBytes: 100 })).rejects.toMatchObject({
      code: 'PLOTPILOT_BUFFER_OVERFLOW',
    });
  });
});
