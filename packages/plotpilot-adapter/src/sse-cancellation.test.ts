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

describe('HTTP and cancellation', () => {
  it('16. caller abort → PLOTPILOT_ABORTED', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      controller.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const adapter = new PlotPilotAdapter({ fetchImpl });
    await expect(adapter.health(controller.signal)).rejects.toMatchObject({
      code: 'PLOTPILOT_ABORTED',
    });
  });

  it('17. internal deadline → PLOTPILOT_TIMEOUT', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const adapter = new PlotPilotAdapter({ fetchImpl, requestTimeoutMs: 1 });
    await expect(adapter.health()).rejects.toMatchObject({
      code: 'PLOTPILOT_TIMEOUT',
    });
  });

  it('18. network rejection → PLOTPILOT_UNAVAILABLE', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const adapter = new PlotPilotAdapter({ fetchImpl });
    await expect(adapter.health()).rejects.toMatchObject({
      code: 'PLOTPILOT_UNAVAILABLE',
    });
  });

  it('19. HTTP 4xx/5xx does not leak body', async () => {
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
      expect(err.statusCode).toBe(500);
      expect(err.message).not.toContain('secret-api-key');
    }
  });

  it('20. response.body === null', async () => {
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
  it('21. LF separator', async () => {
    const stream = streamFrom(['data: {"type":"a"}\n\ndata: {"type":"b"}\n\n']);
    expect(await collectEvents(stream)).toEqual(['a', 'b']);
  });

  it('22. CRLF separator', async () => {
    const stream = streamFrom(['data: {"type":"x"}\r\n\r\ndata: {"type":"y"}\r\n\r\n']);
    expect(await collectEvents(stream)).toEqual(['x', 'y']);
  });

  it('23. separator split across chunks', async () => {
    const stream = streamFrom(['data: {"type":"a"}\n', '\ndata: {"type":"b"}\n\n']);
    expect(await collectEvents(stream)).toEqual(['a', 'b']);
  });

  it('24. UTF-8 multi-byte split across chunks', async () => {
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

  it('25. multiline data', async () => {
    const stream = streamFrom(['data: {"type":"multi",\ndata: "value":"ok"}\n\n']);
    const events: Array<Record<string, unknown>> = [];
    for await (const event of parseSseStream(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('multi');
  });

  it('26. comments and metadata fields', async () => {
    const stream = streamFrom([
      ': this is a comment\nevent: update\nid: 42\nretry: 3000\ndata: {"type":"real"}\n\n',
    ]);
    expect(await collectEvents(stream)).toEqual(['real']);
  });

  it('27. last frame without trailing separator', async () => {
    const stream = streamFrom(['data: {"type":"first"}\n\ndata: {"type":"last"}']);
    expect(await collectEvents(stream)).toEqual(['first', 'last']);
  });

  it('28. malformed JSON throws stable error', async () => {
    const stream = streamFrom(['data: {not json}\n\n']);
    await expect(collectEvents(stream)).rejects.toMatchObject({
      code: 'PLOTPILOT_RESPONSE_INVALID',
    });
  });

  it('29. buffer limit enforced', async () => {
    const big = 'x'.repeat(2000);
    const stream = streamFrom([`data: {"type":"${big}"}\n\n`]);
    await expect(collectEvents(stream, { maxEventBytes: 1024 })).rejects.toMatchObject({
      code: 'PLOTPILOT_BUFFER_OVERFLOW',
    });
  });

  it('30. iterator early return releases reader', async () => {
    const stream = streamFrom([
      'data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c"}\n\n',
    ]);
    const iter = parseSseStream(stream);
    const first = await iter.next();
    expect(first.value?.type).toBe('a');
    await iter.return(undefined);
    expect(stream.locked).toBe(false);
  });

  it('31. abort during stream', async () => {
    const controller = new AbortController();
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pullCount++;
        if (pullCount === 1) {
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"a"}\n\n'));
        } else if (pullCount === 2) {
          controller.abort();
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"b"}\n\n'));
        } else {
          ctrl.close();
        }
      },
    });

    const events: string[] = [];
    try {
      for await (const event of parseSseStream(stream, { signal: controller.signal })) {
        events.push(event.type);
      }
    } catch {
      // abort may throw or end gracefully
    }
    expect(events).toContain('a');
  });

  it('32. reader cancel/release on consumer break', async () => {
    const stream = streamFrom([
      'data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c"}\n\n',
    ]);
    for await (const event of parseSseStream(stream)) {
      expect(event.type).toBe('a');
      break;
    }
    expect(stream.locked).toBe(false);
  });

  it('[DONE] sentinel is skipped', async () => {
    const stream = streamFrom(['data: {"type":"a"}\n\ndata: [DONE]\n\n']);
    expect(await collectEvents(stream)).toEqual(['a']);
  });

  it('empty data lines produce no event', async () => {
    const stream = streamFrom(['data:\n\ndata: {"type":"ok"}\n\n']);
    expect(await collectEvents(stream)).toEqual(['ok']);
  });
});
