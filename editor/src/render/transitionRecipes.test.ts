import { describe, expect, it } from 'vitest';
import { TRANSITION_LAYERS_SOURCE, transitionLayers } from './transitionRecipes';

describe('transition recipes', () => {
  it('start on the outgoing scene and finish on the incoming one', () => {
    const rest = { opacity: 1, transform: 'none', filter: 'none' };
    expect(transitionLayers('fade', 0, 100, 100)).toEqual({ outgoing: rest, incoming: { ...rest, opacity: 0 } });
    expect(transitionLayers('fade', 1, 100, 100).incoming).toEqual(rest);
    expect(transitionLayers('dissolve', 0, 100, 100).incoming).toEqual({ opacity: 0, transform: 'none', filter: 'blur(10px)' });
    expect(transitionLayers('dissolve', 1, 100, 100).incoming).toEqual({ opacity: 1, transform: 'none', filter: 'blur(0px)' });
    expect(transitionLayers('zoom', 0, 100, 100).incoming).toEqual({ opacity: 0, transform: 'scale(0.9)', filter: 'none' });
    expect(transitionLayers('zoom', 1, 100, 100).incoming).toEqual({ opacity: 1, transform: 'scale(1)', filter: 'none' });
    expect(transitionLayers('push-up', 1, 100, 80).incoming.transform).toBe('translate(0px,0px)');
  });

  it('push moves both scenes a full frame', () => {
    expect(transitionLayers('push-left', 0, 1920, 1080)).toEqual({
      outgoing: { opacity: 1, transform: 'translate(0px,0px)', filter: 'none' },
      incoming: { opacity: 1, transform: 'translate(1920px,0px)', filter: 'none' },
    });
    const mid = transitionLayers('push-up', 0.5, 1920, 1080);
    expect(mid.outgoing.transform).toBe('translate(0px,-540px)');
    expect(mid.incoming.transform).toBe('translate(0px,540px)');
  });

  it('eases in and out, and clamps progress', () => {
    const quarter = transitionLayers('push-left', 0.25, 1000, 100).incoming.transform;
    expect(quarter).toBe('translate(937.5px,0px)'); // ease-in-out cubic: 0.0625 of the way
    expect(transitionLayers('fade', -3, 10, 10).incoming.opacity).toBe(0);
    expect(transitionLayers('fade', 7, 10, 10).incoming.opacity).toBe(1);
  });

  it('a hard cut shows the incoming scene at once', () => {
    expect(transitionLayers('none', 0, 10, 10)).toEqual({
      outgoing: { opacity: 0, transform: 'none', filter: 'none' },
      incoming: { opacity: 1, transform: 'none', filter: 'none' },
    });
  });

  it('is plain self-contained JS: the source runs without any module scope', () => {
    expect(TRANSITION_LAYERS_SOURCE).not.toContain('__name');
    const standalone = new Function(`return (${TRANSITION_LAYERS_SOURCE});`)() as typeof transitionLayers;
    expect(standalone('zoom', 0.5, 100, 100)).toEqual(transitionLayers('zoom', 0.5, 100, 100));
  });
});
