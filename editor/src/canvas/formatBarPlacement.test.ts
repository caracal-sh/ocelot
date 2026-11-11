import { describe, expect, it } from 'vitest';
import { placeFormatBar } from './formatBarPlacement';

const canvas = { left: 320, top: 40, width: 920, height: 860 };
const bar = { width: 232, height: 32 };

describe('placeFormatBar', () => {
  it('sits 8px above the layer, centered on it', () => {
    const layer = { left: 500, top: 300, width: 200, height: 60 };
    expect(placeFormatBar(layer, bar, canvas)).toEqual({ left: 500 + 100 - 116, top: 300 - 8 - 32, below: false });
  });

  it('flips to 8px below the layer when there is no room above in the visible canvas', () => {
    const layer = { left: 500, top: 60, width: 200, height: 60 }; // 60 - 8 - 32 = 20 < canvas.top (40)
    expect(placeFormatBar(layer, bar, canvas)).toEqual({ left: 484, top: 60 + 60 + 8, below: true });
  });

  it('stays above when it just fits', () => {
    const layer = { left: 500, top: 80, width: 200, height: 60 }; // 80 - 40 = 40 = canvas.top
    expect(placeFormatBar(layer, bar, canvas).below).toBe(false);
  });

  it('clamps horizontally to the canvas, 8px from either edge', () => {
    expect(placeFormatBar({ left: 322, top: 300, width: 20, height: 20 }, bar, canvas).left).toBe(328);
    expect(placeFormatBar({ left: 1230, top: 300, width: 20, height: 20 }, bar, canvas).left).toBe(320 + 920 - 232 - 8);
  });

  it('never overlaps the layer, whichever side it picks', () => {
    for (const top of [-500, 0, 45, 300, 880]) {
      const layer = { left: 600, top, width: 160, height: 90 };
      const p = placeFormatBar(layer, bar, canvas);
      const overlaps = p.top < layer.top + layer.height && p.top + bar.height > layer.top;
      expect(overlaps).toBe(false);
    }
  });
});
