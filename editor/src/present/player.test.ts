// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { containBox } from './player';
import { decodePlayerMessage, encodePlayerMessage } from './protocol';

describe('player layout', () => {
  it('letterboxes a 16:9 slide in a 16:9 window and scales it exactly', () => {
    expect(containBox({ width: 1920, height: 1080 }, { width: 3840, height: 2160 })).toEqual({ scale: 2, x: 0, y: 0 });
    expect(containBox({ width: 1920, height: 1080 }, { width: 960, height: 540 })).toEqual({ scale: 0.5, x: 0, y: 0 });
  });

  it('centers on black bars: pillarbox in a wider window, letterbox in a taller one', () => {
    expect(containBox({ width: 1920, height: 1080 }, { width: 2000, height: 540 })).toEqual({ scale: 0.5, x: 520, y: 0 });
    expect(containBox({ width: 1920, height: 1080 }, { width: 960, height: 800 })).toEqual({ scale: 0.5, x: 0, y: 130 });
  });
});

describe('player messages', () => {
  const show = { type: 'show', seq: 3, artboardId: 'a', html: '<p>x</p>', width: 1920, height: 1080, dir: 'forward', blank: 'none', transition: { kind: 'fade', ms: 300 } } as const;

  it('round-trips a show message and the blank and clear messages', () => {
    expect(decodePlayerMessage(encodePlayerMessage(show))).toEqual(show);
    expect(decodePlayerMessage(encodePlayerMessage({ type: 'blank', blank: 'white' }))).toEqual({ type: 'blank', blank: 'white' });
    expect(decodePlayerMessage('{"type":"clear"}')).toEqual({ type: 'clear' });
  });

  it('ignores anything that is not one of ours (a stray postMessage, bad JSON, a half message)', () => {
    expect(decodePlayerMessage('not json')).toBeNull();
    expect(decodePlayerMessage(null)).toBeNull();
    expect(decodePlayerMessage({ ocelotPlayerReady: true })).toBeNull();
    expect(decodePlayerMessage({ type: 'blank', blank: 'red' })).toBeNull();
    expect(decodePlayerMessage({ ...show, width: 'wide' })).toBeNull();
    expect(decodePlayerMessage({ ...show, dir: 'sideways' })).toBeNull();
  });
});

describe('mountPlayer (jsdom)', () => {
  it('shows a slide scaled to the window, swaps to the next, and covers it with the blank screen', async () => {
    const { mountPlayer } = await import('./player');
    const root = document.createElement('div');
    document.body.append(root);
    const player = mountPlayer(root);
    expect(window.__ocelotPlayer).toBeTruthy();
    const base = { type: 'show', seq: 1, width: 1920, height: 1080, dir: 'forward', blank: 'none' } as const;
    await player.dispatch({ ...base, artboardId: 'a', html: '<!doctype html><p id="one">one</p>' });
    expect(player.current()).toBe('a');
    const frames = () => root.querySelectorAll('iframe');
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frames()[0]!.srcdoc).toContain('id="one"');
    expect(frames()[0]!.style.width).toBe('1920px');
    await player.dispatch({ ...base, seq: 2, artboardId: 'b', html: '<!doctype html><p id="two">two</p>', transition: { kind: 'fade', ms: 10 } });
    expect(player.current()).toBe('b');
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.srcdoc).toContain('id="two"');
    const blank = root.querySelector<HTMLElement>('.ocelot-player__blank')!;
    await player.dispatch({ type: 'blank', blank: 'white' });
    expect(blank.style.display).toBe('block');
    expect(blank.style.background).toMatch(/#fff|rgb\(255, 255, 255\)/);
    await player.dispatch({ type: 'blank', blank: 'none' });
    expect(blank.style.display).toBe('none');
    await player.dispatch({ type: 'clear' });
    expect(frames()).toHaveLength(0);
    expect(blank.style.display).toBe('block');
    // The host's entry point takes the JSON string.
    await window.__ocelotPlayer!.dispatch(JSON.stringify({ ...base, artboardId: 'c', html: '<p>c</p>' }));
    expect(player.current()).toBe('c');
    player.destroy();
    expect(window.__ocelotPlayer).toBeUndefined();
  });
});
