// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { JobOutcome } from '../assets/jobs';
import { Editor } from '../editor/Editor';
import { EditorContext } from '../editor/context';
import { ImageJobStep, PendingImages } from './ImageJobs';
import { applyEvent, emptyTranscript, imageJobLabel, toolLabel, type ToolItem } from './transcript';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.el.remove();
  }
});

function mount(editor: Editor, ui: React.ReactNode) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  act(() => root.render(<EditorContext.Provider value={editor}>{ui}</EditorContext.Provider>));
  return el;
}

const item: ToolItem = { kind: 'tool', id: 't1', tool: 'generate_image', input: { prompt: 'a barn' }, status: 'ok', job: 'j1' };

/** A job whose work the test finishes by hand. */
function startJob(editor: Editor) {
  let finish!: (o: JobOutcome) => void;
  let fail!: (e: Error) => void;
  const job = editor.assets.jobs.start({
    owner: 'omp',
    ownerLabel: 'omp',
    operation: 'generate',
    prompt: 'a barn',
    etaS: 30,
    placeholderIds: [],
    run: () =>
      new Promise<JobOutcome>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  });
  return { job, finish: (o: JobOutcome) => finish(o), fail: (e: Error) => fail(e) };
}

describe('image job rows in the sidebar', () => {
  it('the transcript row follows the started job, not the call that returned at once', () => {
    const started = JSON.stringify({ status: 'started', job_id: 'j7', eta_s: 30 });
    const s = [
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'mcp__ocelot_generate_image', args: { prompt: 'a barn' } },
      { type: 'tool_execution_end', toolCallId: 'c1', result: { content: [{ type: 'text', text: started }, { type: 'text', text: 'image_jobs:\n- image job j6 done: asset://x placed in "Hero"' }] } },
    ].reduce(applyEvent, emptyTranscript());
    const row = s.items[0] as ToolItem;
    expect(row).toMatchObject({ status: 'ok', job: 'j7' });
    expect(toolLabel(row)).toBe('Generating image in the background');
    // A blocking call (no "started") keeps the plain label.
    const sync = [
      { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'mcp__ocelot_generate_image', args: { prompt: 'a barn' } },
      { type: 'tool_execution_end', toolCallId: 'c2', result: { content: [{ type: 'text', text: '{"images": []}' }] } },
    ].reduce(applyEvent, emptyTranscript());
    expect((sync.items[0] as ToolItem).job).toBeUndefined();
    expect(toolLabel(sync.items[0] as ToolItem)).toBe('Generated image');
    expect(imageJobLabel('edit_image', 'failed')).toBe('Image edit failed');
  });

  it('shows "Generating image in the background" with elapsed time while running, then the finished label', () => {
    const editor = new Editor();
    const { job, finish } = startJob(editor);
    const el = mount(editor, <ImageJobStep item={item} jobId={job.id} />);
    const step = el.querySelector('[data-testid="agent-step"]')!;
    expect(step.className).toContain('at-step--running');
    expect(step.textContent).toMatch(/Generating image in the background\d+s/);
    act(() => finish({ assetIds: ['a'], nodeIds: [], placedText: 'x', result: {}, preview: null }));
    return job.settled.then(() => {
      expect(el.querySelector('[data-testid="agent-step"]')!.className).toContain('at-step--ok');
      expect(el.textContent).toBe('Generated image');
    });
  });

  it('a failed job turns its row into an error with the reason', async () => {
    const editor = new Editor();
    const { job, fail } = startJob(editor);
    const el = mount(editor, <ImageJobStep item={item} jobId={job.id} />);
    await act(async () => {
      fail(new Error('The generation failed: rate limited.'));
      await job.settled;
    });
    const step = el.querySelector('[data-testid="agent-step"]')!;
    expect(step.className).toContain('at-step--error');
    expect(step.textContent).toContain('Image generation failed');
    expect(step.textContent).toContain('rate limited');
  });

  it('keeps a pending job visible after the turn: "1 image generating", gone when it lands', async () => {
    const editor = new Editor();
    const empty = mount(editor, <PendingImages />);
    expect(empty.textContent).toBe('');
    const { job, finish } = startJob(editor);
    const el = mount(editor, <PendingImages />);
    expect(el.querySelector('[data-testid="agent-images-pending"]')!.textContent).toMatch(/^1 image generating\d+s$/);
    await act(async () => {
      finish({ assetIds: [], nodeIds: [], placedText: '', result: {}, preview: null });
      await job.settled;
    });
    expect(el.textContent).toBe('');
  });
});
