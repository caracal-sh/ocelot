import { describe, expect, it } from 'vitest';
import { SLIDE_TRANSITION_CSS, playableTransition, swapSlide, transitionBetween } from './transitions';
import { TRANSITION_KINDS } from '../model/types';

const env = { reducedMotion: false, viewTransitions: true };

describe('playableTransition', () => {
  it('a cut stays a cut, whatever the environment', () => {
    for (const e of [env, { reducedMotion: true, viewTransitions: true }, { reducedMotion: false, viewTransitions: false }]) {
      expect(playableTransition(undefined, e).mode).toBe('cut');
      expect(playableTransition({ kind: 'none', ms: 0 }, e).mode).toBe('cut');
      expect(playableTransition({ kind: 'fade', ms: 0 }, e).mode).toBe('cut');
    }
  });

  it('plays the kind as a View Transition where the web view has them', () => {
    expect(playableTransition({ kind: 'push-left', ms: 500 }, env)).toEqual({ mode: 'view-transition', kind: 'push-left', ms: 500 });
  });

  it('falls back to an opacity crossfade without View Transitions, for every kind', () => {
    for (const kind of TRANSITION_KINDS.filter((k) => k !== 'none')) {
      expect(playableTransition({ kind, ms: 300 }, { reducedMotion: false, viewTransitions: false })).toEqual({ mode: 'crossfade', kind: 'fade', ms: 300 });
    }
  });

  it('reduced motion drops movement and scale: only fade or dissolve remain', () => {
    const reduced = { reducedMotion: true, viewTransitions: true };
    expect(playableTransition({ kind: 'push-up', ms: 400 }, reduced)).toMatchObject({ mode: 'view-transition', kind: 'fade' });
    expect(playableTransition({ kind: 'zoom', ms: 400 }, reduced)).toMatchObject({ kind: 'fade' });
    expect(playableTransition({ kind: 'dissolve', ms: 400 }, reduced)).toMatchObject({ kind: 'dissolve' });
    expect(playableTransition({ kind: 'push-up', ms: 400 }, { reducedMotion: true, viewTransitions: false })).toMatchObject({ mode: 'crossfade' });
  });
});

describe('transitionBetween', () => {
  const into = (i: number) => ({ kind: 'push-left' as const, ms: 100 * (i + 1) });
  it('forward plays the incoming slide\'s transition; back plays the one being left, reversed', () => {
    expect(transitionBetween(1, 2, into)).toEqual({ transition: { kind: 'push-left', ms: 300 }, dir: 'forward' });
    expect(transitionBetween(3, 1, into)).toEqual({ transition: { kind: 'push-left', ms: 400 }, dir: 'back' });
    expect(transitionBetween(2, 2, into).transition).toBeUndefined();
  });
});

describe('recipes', () => {
  it('define an animation for every kind and direction, on the old and the new image', () => {
    for (const kind of ['fade', 'dissolve', 'push-left', 'push-up', 'zoom']) {
      expect(SLIDE_TRANSITION_CSS).toContain(`data-ocelot-slide="${kind}"`);
    }
    expect((SLIDE_TRANSITION_CSS.match(/data-ocelot-dir="back"/g) ?? []).length).toBe(6);
    expect(SLIDE_TRANSITION_CSS).toMatch(/::view-transition-group\(ocelot-slide\)\{animation:none;overflow:clip\}/);
  });
});

/** A document with just enough of the View Transitions API: the callback runs, `finished` resolves after `done()`. */
function fakeDoc(opts: { supported: boolean; skip?: boolean }) {
  const root = { dataset: {} as Record<string, string | undefined>, style: { props: new Map<string, string>(), setProperty(k: string, v: string) { this.props.set(k, v); }, removeProperty(k: string) { this.props.delete(k); } } };
  const seen: Array<Record<string, string | undefined>> = [];
  const doc = {
    documentElement: root,
    getElementById: () => ({}),
    ...(opts.supported
      ? {
          startViewTransition(cb: () => Promise<void>) {
            seen.push({ ...root.dataset });
            const updated = cb();
            return { finished: opts.skip ? updated.then(() => Promise.reject(new Error('skipped'))) : updated };
          },
        }
      : {}),
  };
  return { doc: doc as unknown as Document, root, seen };
}

describe('swapSlide', () => {
  const play = { mode: 'view-transition' as const, kind: 'zoom' as const, ms: 250 };

  it('runs the update inside the View Transition with the recipe attributes, then clears them', async () => {
    const { doc, root, seen } = fakeDoc({ supported: true });
    let ran = 0;
    await swapSlide(doc, play, 'back', async () => {
      ran++;
      expect(root.dataset['ocelotSlide']).toBe('zoom');
    });
    expect(ran).toBe(1);
    expect(seen[0]).toMatchObject({ ocelotSlide: 'zoom', ocelotDir: 'back' });
    expect(root.dataset['ocelotSlide']).toBeUndefined();
    expect(root.style.props.size).toBe(0);
  });

  it('a skipped transition still ran the update once and cleans up', async () => {
    const { doc, root } = fakeDoc({ supported: true, skip: true });
    let ran = 0;
    await swapSlide(doc, play, 'forward', () => void ran++);
    expect(ran).toBe(1);
    expect(root.dataset['ocelotDir']).toBeUndefined();
  });

  it('without View Transitions, or for a cut or crossfade, just runs the update', async () => {
    const { doc } = fakeDoc({ supported: false });
    let ran = 0;
    await swapSlide(doc, play, 'forward', () => void ran++);
    await swapSlide(fakeDoc({ supported: true }).doc, { mode: 'cut', kind: 'none', ms: 0 }, 'forward', () => void ran++);
    await swapSlide(fakeDoc({ supported: true }).doc, { mode: 'crossfade', kind: 'fade', ms: 100 }, 'forward', () => void ran++);
    expect(ran).toBe(3);
  });

  it('a failing update surfaces', async () => {
    const { doc } = fakeDoc({ supported: true });
    await expect(swapSlide(doc, play, 'forward', async () => { throw new Error('load failed'); })).rejects.toThrow('load failed');
  });
});
