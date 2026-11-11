// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ORIGIN } from '../model/document';
import { activeExportRuns } from '../export/fileExport';
import { setupMcp } from './testSetup';

/** A host whose export runs hang until the matching cancel call arrives (like a long render). */
function hangingHost(t: ReturnType<typeof setupMcp>) {
  const real = t.host.call;
  const started: Array<{ method: string; runId: string }> = [];
  const cancels: string[] = [];
  const release = new Map<string, () => void>();
  t.host.call = (async (method: string, params: unknown, o: unknown) => {
    const p = params as { runId?: string };
    if (method === 'host.exportRun' || method === 'host.exportVideoRun') {
      started.push({ method, runId: p.runId! });
      // `new Promise`: the project's TypeScript lib predates Promise.withResolvers.
      await new Promise<void>((resolve) => release.set(p.runId!, resolve));
      return method === 'host.exportRun'
        ? { files: [], cancelled: true }
        : { files: [], frameHashes: [], previews: [], elapsedMs: 0, renderFps: 0, workers: 0, cancelled: true };
    }
    if (method === 'host.exportCancel' || method === 'host.exportVideoCancel') {
      cancels.push(`${method}:${p.runId}`);
      release.get(p.runId!)?.();
      return {};
    }
    return (real as (...a: unknown[]) => unknown)(method, params, o);
  }) as typeof t.host.call;
  return { started, cancels };
}

describe('cancel_export', () => {
  it('with nothing running it answers cancelled: [] and unknown run ids are errors', async () => {
    const t = setupMcp();
    const r = await t.callJson('cancel_export', {});
    expect(r.cancelled).toEqual([]);
    const bad = await t.call('cancel_export', { run_id: 'export-nope' });
    expect(bad.isError).toBe(true);
    expect(t.textOf(bad)).toMatch(/nothing is running|already finished/);
  });

  it('cancels a running image export through cancelExport; the export call returns cancelled', async () => {
    const t = setupMcp();
    const host = hangingHost(t);
    const running = t.call('export_pdf', { scope: 'all' });
    await vi.waitFor(() => expect(host.started).toHaveLength(1));
    expect(activeExportRuns()).toHaveLength(1);
    const r = await t.callJson('cancel_export', {});
    expect(r.cancelled).toEqual([{ run_id: host.started[0]!.runId, kind: 'file', what: expect.stringMatching(/PDF export/) }]);
    expect(host.cancels).toEqual([`host.exportCancel:${host.started[0]!.runId}`]);
    expect(t.editor.ui.toasts.at(-1)?.message).toMatch(/cancelled/);
    await running;
    expect(activeExportRuns()).toHaveLength(0);
  });

  it('cancels a video render through cancelVideoExport, by run_id, and reports one cancel only once', async () => {
    const t = setupMcp();
    const ops = t.editor.doc.ops(ORIGIN.human);
    const page = ops.createPage({ name: 'Reel' });
    ops.setPageKind(page, 'video', { width: 1280, height: 720 });
    const scene = ops.createArtboard({ pageId: page, name: 'S1' });
    ops.setSlide(scene, { durationMs: 1000 });
    const host = hangingHost(t);
    const running = t.call('export_video', { page_id: page });
    await vi.waitFor(() => expect(host.started).toHaveLength(1));
    const [run] = activeExportRuns();
    expect(run).toMatchObject({ kind: 'video' });
    const r = await t.callJson('cancel_export', { run_id: run!.runId });
    expect(r.cancelled).toMatchObject([{ run_id: run!.runId, kind: 'video' }]);
    expect(host.cancels).toEqual([`host.exportVideoCancel:${run!.runId}`]);
    const again = await t.callJson('cancel_export', {});
    expect(again.cancelled.length + (again.already_cancelling?.length ?? 0)).toBeLessThanOrEqual(1);
    const done = await running;
    expect(done.isError).toBe(true);
    expect(t.textOf(done)).toMatch(/cancelled/);
    expect(activeExportRuns()).toHaveLength(0);
  });
});
