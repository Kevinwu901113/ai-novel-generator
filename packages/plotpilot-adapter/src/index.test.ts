import { describe, expect, it, vi } from 'vitest';
import { PlotPilotAdapter } from './index.js';

function sseResponse(frames: ReadonlyArray<Record<string, unknown>>): Response {
  const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('PlotPilotAdapter', () => {
  it('normalizes health responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'healthy',
          version: '1.0.2',
          build_id: 'test-build',
          uptime_seconds: 12.5,
          daemon_process: { running: true, pid: 1234 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const adapter = new PlotPilotAdapter({ fetchImpl });
    await expect(adapter.health()).resolves.toEqual({
      status: 'healthy',
      version: '1.0.2',
      buildId: 'test-build',
      uptimeSeconds: 12.5,
      daemonRunning: true,
      daemonPid: 1234,
    });
  });

  it('forwards chapter generation SSE events in order', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        { type: 'phase', phase: 'planning' },
        { type: 'chunk', text: '第一段' },
        { type: 'done', content: '第一段' },
      ]),
    );
    const events: string[] = [];
    const adapter = new PlotPilotAdapter({ fetchImpl });

    await adapter.generateChapter(
      { novelId: 'novel-1', chapterNumber: 1, outline: '开篇' },
      { onEvent: (event) => events.push(event.type) },
    );

    expect(events).toEqual(['phase', 'chunk', 'done']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8005/api/v1/novels/novel-1/generate-chapter-stream',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('maps unavailable sidecars to a safe adapter error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection refused'));
    const adapter = new PlotPilotAdapter({ fetchImpl });

    await expect(adapter.health()).rejects.toMatchObject({
      code: 'PLOTPILOT_UNAVAILABLE',
      message: '无法连接 PlotPilot sidecar',
    });
  });
});
