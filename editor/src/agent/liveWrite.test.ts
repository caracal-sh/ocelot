// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { LiveWrites, type LiveWriteEventName, type LiveWriteEvents } from '../editor/liveWrites';
import { htmlToSpecs } from '../mcp/htmlToSpec';
import { LiveWriteTracker } from './liveWrite';
import { biggest, callFrames, executionEnd, MESSAGE_ID, rechunk, writes, type Write } from './liveWrite.testkit';

type Seen = { [K in LiveWriteEventName]: { type: K; event: LiveWriteEvents[K] } }[LiveWriteEventName];

/** A tracker on a hand-driven clock and frame loop; records every event it publishes. */
function harness() {
  let now = 0;
  let queued: (() => void) | null = null;
  let schedules = 0;
  const bus = new LiveWrites();
  const seen: Seen[] = [];
  for (const type of ['liveWrite:start', 'liveWrite:update', 'liveWrite:end', 'liveWrite:commit', 'liveWrite:abort'] as const) bus.on(type, (event) => seen.push({ type, event } as Seen));
  const sink: string[] = [];
  const tracker = new LiveWriteTracker({
    agent: 'omp',
    bus,
    sink: { target: (id, node) => sink.push(`target ${id} ${node}`), label: (id, label) => sink.push(`label ${id} ${label}`), end: (id) => sink.push(`end ${id}`) },
    now: () => now,
    schedule: (cb) => {
      schedules++;
      queued = cb;
      return () => {
        if (queued === cb) queued = null;
      };
    },
  });
  return {
    bus,
    tracker,
    seen,
    sink,
    get now() {
      return now;
    },
    get schedules() {
      return schedules;
    },
    /** One animation frame: time passes, then whatever was scheduled runs. */
    frame(ms = 16) {
      now += ms;
      const cb = queued;
      queued = null;
      cb?.();
    },
    send(frames: Array<Record<string, unknown>>, frameEvery = 0) {
      frames.forEach((f, i) => {
        tracker.handle(f);
        if (frameEvery && i % frameEvery === 0) this.frame();
      });
    },
    types: () => seen.map((s) => s.type.slice('liveWrite:'.length)),
    of: <K extends LiveWriteEventName>(type: K) => seen.filter((s) => s.type === type).map((s) => s.event as LiveWriteEvents[K]),
  };
}

const small = [...writes].sort((a, b) => a.args.html.length - b.args.html.length)[0]!;
const frames = (w: Write, deltas = w.fixture.deltas) => callFrames({ id: w.fixture.id, deltas, args: w.args });

describe('LiveWriteTracker: one write_html call', () => {
  it('publishes start, throttled updates that grow, end with the final layers, then commit', () => {
    const h = harness();
    const w = biggest(1)[0]!;
    h.send(frames(w), 3);
    h.tracker.handle(executionEnd(w.fixture.id));
    const types = h.types();
    expect(types[0]).toBe('start');
    expect(types.at(-2)).toBe('end');
    expect(types.at(-1)).toBe('commit');
    expect(types.filter((t) => t === 'update').length).toBeGreaterThan(5);
    expect(types.filter((t) => t === 'start' || t === 'end' || t === 'commit' || t === 'abort')).toEqual(['start', 'end', 'commit']);

    const [start] = h.of('liveWrite:start');
    expect(start).toMatchObject({ id: w.fixture.id, agent: 'omp', target: {} });
    const updates = h.of('liveWrite:update');
    updates.forEach((u, i) => {
      expect(u).toMatchObject({ id: w.fixture.id, agent: 'omp' });
      if (i > 0) expect(u.length).toBeGreaterThanOrEqual(updates[i - 1]!.length); // equal when only the target changed
      expect(u.consumed).toBeLessThanOrEqual(u.length);
    });
    expect(updates.at(-1)!.target).toEqual({ nodeId: w.args.node_id, mode: w.args.mode });
    const [end] = h.of('liveWrite:end');
    expect(end!.final).toBe(true);
    expect(end!.target).toEqual({ nodeId: w.args.node_id, mode: w.args.mode });
    expect(end!.specs).toEqual(htmlToSpecs(w.args.html).specs);
    expect(h.tracker.size).toBe(0);
  });

  it('reads the target as soon as node_id / mode are complete, whichever order the model writes them in', () => {
    for (const w of writes) {
      const h = harness();
      const keys = Object.keys(w.args);
      const modeFirst = keys.indexOf('mode') < keys.indexOf('html');
      h.send(frames(w), 1);
      const updates = h.of('liveWrite:update');
      const first = updates.find((u) => u.target.nodeId !== undefined)!;
      expect(first.target.nodeId).toBe(w.args.node_id);
      // `mode` before `html` is known by the time any layers show up; after it, only with the last bytes.
      const withLayers = updates.find((u) => u.specs.length > 0)!;
      expect(withLayers.target.mode === w.args.mode).toBe(modeFirst);
      expect(h.of('liveWrite:end')[0]!.target.mode).toBe(w.args.mode);
    }
  }, 60_000);

  it('survives any way of splitting the stream into frames: the end event is always exactly the commit parse', () => {
    const subset = [small, ...biggest(4)];
    for (const w of subset) {
      const expected = htmlToSpecs(w.args.html).specs;
      for (let seed = 1; seed <= 9; seed++) {
        const h = harness();
        const deltas = rechunk(w.json, seed * 104729, [2, 5, 11, 60, 250][seed % 5]!);
        // Frames fall at random places, sometimes none for a long stretch.
        const frameAfter = new Set(deltas.map((_, i) => i).filter((i) => (i * 2654435761 + seed) % 7 === 0));
        const fr = frames(w, deltas);
        fr.forEach((f, i) => {
          h.tracker.handle(f);
          if (frameAfter.has(i)) h.frame();
        });
        h.frame(500);
        const [end] = h.of('liveWrite:end');
        expect(end, `${w.fixture.id} seed ${seed}`).toBeDefined();
        expect(end!.specs).toEqual(expected);
        expect(end!.target).toEqual({ nodeId: w.args.node_id, mode: w.args.mode });
        // No update arrives after the end, and the updates never go backwards.
        const types = h.types();
        expect(types.lastIndexOf('update')).toBeLessThan(types.indexOf('end'));
        const lens = h.of('liveWrite:update').map((u) => u.length);
        expect([...lens].sort((a, b) => a - b)).toEqual(lens);
      }
    }
  }, 120_000);

  it('uses the complete arguments of toolcall_end over what it streamed', () => {
    const h = harness();
    const w = small;
    const corrected = { ...w.args, html: '<p>replaced</p>' };
    h.send(callFrames({ id: 'c1', deltas: w.fixture.deltas, args: corrected }));
    expect(h.of('liveWrite:end')[0]!.specs).toEqual(htmlToSpecs('<p>replaced</p>').specs);
  });

  it('keeps the bus snapshot of calls in flight for a canvas that mounts late', () => {
    const h = harness();
    const w = small;
    const fr = frames(w);
    h.send(fr.slice(0, 40), 5);
    expect(h.bus.active.map((a) => [a.id, a.phase, a.agent])).toEqual([[w.fixture.id, 'streaming', 'omp']]);
    expect(h.bus.get(w.fixture.id)!.preview?.specs.length).toBeGreaterThan(0);
    h.send(fr.slice(40));
    expect(h.bus.get(w.fixture.id)!.phase).toBe('ended');
    h.tracker.handle(executionEnd(w.fixture.id));
    expect(h.bus.active).toEqual([]);
  });
});

describe('LiveWriteTracker: what ends a call without a commit', () => {
  const partial = (h: ReturnType<typeof harness>, w = small, n = 30) => h.send(frames(w).slice(0, n), 4);

  it('aborts a streaming call when the turn ends (agent_end), once', () => {
    const h = harness();
    partial(h);
    h.tracker.handle({ type: 'agent_end', messages: [] });
    h.tracker.handle({ type: 'agent_end', messages: [] });
    expect(h.of('liveWrite:abort')).toEqual([expect.objectContaining({ id: small.fixture.id, reason: 'turn' })]);
    expect(h.tracker.size).toBe(0);
    h.frame(); // a frame that was waiting does nothing
    expect(h.of('liveWrite:update').length).toBeGreaterThan(0);
  });

  it('aborts on abortAll (stop, process exit, new chat), and nothing more is published for that call', () => {
    const h = harness();
    const fr = frames(small);
    h.send(fr.slice(0, 30), 4);
    h.tracker.abortAll('closed');
    const before = h.seen.length;
    h.send(fr.slice(30), 1); // late frames of a call nobody tracks any more
    expect(h.seen.length).toBe(before);
    expect(h.of('liveWrite:abort')[0]!.reason).toBe('closed');
  });

  it('aborts a call that ended but whose execution failed', () => {
    const h = harness();
    h.send(frames(small));
    h.tracker.handle(executionEnd(small.fixture.id, true));
    expect(h.types().slice(-2)).toEqual(['end', 'abort']);
    expect(h.of('liveWrite:abort')[0]!.reason).toBe('failed');
    expect(h.of('liveWrite:commit')).toEqual([]);
  });

  it('aborts when the message restarts, or ends while the call is still streaming; a call that ended survives message_end', () => {
    const restart = harness();
    partial(restart);
    restart.tracker.handle({ type: 'message_update', messageId: MESSAGE_ID, message: { role: 'assistant' }, assistantMessageEvent: { type: 'start', message: {} } });
    expect(restart.of('liveWrite:abort')[0]!.reason).toBe('restart');

    const cut = harness();
    partial(cut);
    cut.tracker.handle({ type: 'message_end', messageId: MESSAGE_ID, message: { role: 'assistant' } });
    expect(cut.of('liveWrite:abort')[0]!.reason).toBe('restart');

    const done = harness();
    done.send(frames(small));
    done.tracker.handle({ type: 'message_end', messageId: MESSAGE_ID, message: { role: 'assistant' } });
    expect(done.of('liveWrite:abort')).toEqual([]);
    done.tracker.handle(executionEnd(small.fixture.id));
    expect(done.of('liveWrite:commit')).toHaveLength(1);
  });

  it('a call restarted in the same slot aborts the first and starts afresh', () => {
    const h = harness();
    partial(h);
    h.send(callFrames({ id: 'second', deltas: small.fixture.deltas, args: small.args }));
    expect(h.types().filter((t) => t === 'abort')).toHaveLength(1);
    expect(h.of('liveWrite:end').map((e) => e.id)).toEqual(['second']);
  });
});

const start = (id: string, name: string, index = 0) => ({ type: 'message_update', messageId: 'm1', message: { role: 'assistant' }, assistantMessageEvent: { type: 'toolcall_start', contentIndex: index, block: { type: 'toolCall', id, name, arguments: {} } } });
const delta = (d: string, index = 0) => ({ type: 'message_update', messageId: 'm1', message: { role: 'assistant' }, assistantMessageEvent: { type: 'toolcall_delta', contentIndex: index, delta: d } });

describe('LiveWriteTracker: telling the writing indicator where a call is headed', () => {
  it('names the container of a write_html as soon as its node_id string is complete, once', () => {
    const h = harness();
    h.tracker.handle(start('c1', 'mcp__ocelot_write_html'));
    h.tracker.handle(delta('{"node_'));
    h.tracker.handle(delta('id": "n_abc'));
    expect(h.sink).toEqual([]); // the string is not closed yet
    h.tracker.handle(delta('12", "html": "<sec'));
    h.tracker.handle(delta('tion>…</section>", "mode": "append"}'));
    expect(h.sink).toEqual(['target c1 n_abc12']);
  });

  it('reads the first id of node_ids, in a batch too, and unescapes it', () => {
    const h = harness();
    h.tracker.handle(start('c1', 'mcp__ocelot_update_styles'));
    h.tracker.handle(delta('{"updates":[{"node_ids":["n\\u0031x","n2"],"styles":{}}]}'));
    h.tracker.handle(start('c2', 'mcp__ocelot_set_text', 1));
    h.tracker.handle(delta('{"updates":[{"node_id":"nT","text":"data-name=\\"x\\""}]}', 1));
    expect(h.sink).toEqual(['target c1 n1x', 'target c2 nT']);
    expect(h.seen).toEqual([]); // only write_html has a preview
  });

  it('keeps parallel calls apart by content index, and ignores tools that are not writes', () => {
    const h = harness();
    h.tracker.handle(start('a', 'mcp__ocelot_write_html', 0));
    h.tracker.handle(start('b', 'mcp__ocelot_set_text', 1));
    h.tracker.handle(start('c', 'mcp__ocelot_get_screenshot', 2));
    h.tracker.handle(delta('{"node_id":"nB"', 1));
    h.tracker.handle(delta('{"node_id":"nA"', 0));
    h.tracker.handle(delta('{"node_id":"nC"}', 2));
    h.tracker.handle({ type: 'message_update', messageId: 'm9', message: { role: 'assistant' }, assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 3, delta: '{"node_id":"n1"}' } });
    expect(h.sink).toEqual(['target b nB', 'target a nA']);
  });

  it('ends a call when it has run or failed, and when the turn ends', () => {
    const h = harness();
    h.tracker.handle(start('a', 'mcp__ocelot_write_html'));
    h.tracker.handle({ type: 'tool_execution_end', toolCallId: 'a' });
    h.tracker.handle({ type: 'tool_execution_end', toolCallId: 'a' });
    h.tracker.handle(start('b', 'mcp__ocelot_update_styles', 1));
    h.tracker.handle({ type: 'tool_execution_end', toolCallId: 'b', isError: true });
    h.tracker.handle(start('c', 'mcp__ocelot_set_text', 2));
    h.tracker.handle({ type: 'agent_end' });
    expect(h.sink).toEqual(['end a', 'end b', 'end c']);
  });

  it('names the layer being written from the first data-name once its quotes close, for write_html only', () => {
    const h = harness();
    h.tracker.handle(start('a', 'mcp__ocelot_write_html'));
    h.tracker.handle(delta('{"node_id":"n1","html":"<nav data-na'));
    h.frame();
    h.tracker.handle(delta('me=\\"Na'));
    h.frame();
    expect(h.sink).toEqual(['target a n1']); // not closed yet
    h.tracker.handle(delta('v\\" style=\\"display:flex\\">'));
    h.frame();
    h.tracker.handle(delta('<a data-name=\\"Logo\\">'));
    h.frame();
    expect(h.sink).toEqual(['target a n1', 'label a Nav']); // only the first
    h.tracker.handle(start('b', 'mcp__ocelot_set_text', 1));
    h.tracker.handle(delta('{"node_id":"n2","text":"data-name=\\"x\\""}', 1));
    h.frame();
    expect(h.sink).toEqual(['target a n1', 'label a Nav', 'target b n2']);
  });
});

describe('LiveWriteTracker: what it ignores', () => {
  it('other tools, other roles, and frames that are not message updates', () => {
    const h = harness();
    h.send(callFrames({ id: 'x', name: 'mcp__ocelot_update_styles', deltas: ['{"node_id":"n_1","styles":{"color":"#000"}}'], args: { node_id: 'n_1' } }));
    h.send(callFrames({ id: 'y', name: 'mcp__ocelot_write_html', deltas: ['{"html":"<p>x</p>"}'] }).map((f) => ({ ...f, message: { role: 'user' } })));
    h.tracker.handle({ type: 'response', id: 'q-1', success: true });
    h.tracker.handle({ type: 'tool_execution_end', toolCallId: 'unknown' });
    h.tracker.handle({ type: 'message_update', assistantMessageEvent: 'nonsense' });
    h.frame();
    expect(h.seen).toEqual([]);
  });

  it('accepts the Claude Code spelling of the tool name and the bare name', () => {
    for (const name of ['mcp__ocelot_write_html', 'mcp__ocelot__write_html']) {
      const h = harness();
      h.send(callFrames({ id: 'z', name, deltas: ['{"node_id":"a","mode":"append","html":"<p>hi</p>"}'] }));
      expect(h.of('liveWrite:end')[0]!.target).toEqual({ nodeId: 'a', mode: 'append' });
    }
  });
});

describe('LiveWriteTracker: the parse budget per frame', () => {
  it('a postponed parse keeps its call dirty and arrives on a later frame, without a frame loop while idle', () => {
    const h = harness();
    const w = biggest(1)[0]!;
    const fr = frames(w);
    h.send(fr.slice(0, 200)); // plenty of text, no frame yet
    h.frame(0);
    expect(h.of('liveWrite:update')).toHaveLength(1);
    h.send(fr.slice(200, 260));
    h.frame(0); // no time has passed: the budget says wait
    expect(h.of('liveWrite:update')).toHaveLength(1);
    expect(h.schedules).toBeGreaterThan(1); // it asked for another frame instead of dropping the text
    h.frame(1000);
    expect(h.of('liveWrite:update')).toHaveLength(2);
    const asked = h.schedules;
    h.frame(1000);
    h.frame(1000);
    expect(h.schedules).toBe(asked); // nothing left to show: no more frames requested
  });
});

describe('LiveWriteTracker: cost of streaming a 20 kB write in 50-byte deltas', () => {
  /** The largest real writes inside one root: the worst case for an incremental parse (nothing ever closes early). */
  function bigPayload(minChars: number): { json: string; html: string } {
    const parts: string[] = [];
    let total = 0;
    for (const w of biggest(writes.length)) {
      if (total + w.args.html.length > minChars * 1.15) continue;
      parts.push(w.args.html);
      total += w.args.html.length;
      if (total >= minChars) break;
    }
    const html = `<div data-name="Page" style="display:flex;flex-direction:column">${parts.join('\n')}</div>`;
    return { html, json: JSON.stringify({ node_id: 'n_artboard', html, mode: 'replace' }) };
  }

  it('averages under 2 ms per animation frame', () => {
    const { json, html } = bigPayload(20_000);
    expect(html.length).toBeGreaterThanOrEqual(20_000);
    const deltas: string[] = [];
    for (let i = 0; i < json.length; i += 50) deltas.push(json.slice(i, i + 50));
    const h = harness();
    const fr = callFrames({ id: 'perf', deltas, args: { node_id: 'n_artboard', html, mode: 'replace' } });
    // One 50-byte delta per 16 ms frame (about 3 kB/s, faster than the models write): every frame pays for its delta and its flush.
    let spent = 0;
    let worst = 0;
    let frameCount = 0;
    for (const f of fr) {
      const t0 = performance.now();
      h.tracker.handle(f);
      h.frame();
      const dt = performance.now() - t0;
      spent += dt;
      if (f !== fr.at(-1)) worst = Math.max(worst, dt);
      frameCount++;
    }
    const updates = h.of('liveWrite:update').length;
    const avg = spent / frameCount;
    console.info(`live write perf: ${html.length} chars, ${deltas.length} deltas, ${updates} parses, avg ${avg.toFixed(3)} ms/frame, worst frame ${worst.toFixed(1)} ms (the final exact parse in the last frame excluded)`);
    expect(h.of('liveWrite:end')[0]!.specs).toEqual(htmlToSpecs(html).specs);
    expect(updates).toBeGreaterThan(10); // it did show the write growing
    // 2 ms is the budget on a person's Mac; shared CI runners measured 2.1-2.2 ms for the same code (GitHub's ubuntu-latest,
    // two release runs on 2026-11-11), so CI keeps headroom and still catches a regression of the parse (several times slower).
    expect(avg).toBeLessThan(process.env['CI'] ? 3 : 2);
  });
});
