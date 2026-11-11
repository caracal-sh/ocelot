import { describe, expect, it } from 'vitest';
import { ASK_BUTTON, askKeyAction, componentChipBox, outlineStrips, placeAskButton, placeAskPopover, type Box } from './askPlacement';

const key = (init: Partial<Parameters<typeof askKeyAction>[0]>) => askKeyAction({ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, ...init });

describe('the popover keys', () => {
  it('Enter adds to chat, ⌘Enter (or Ctrl) sends now, Esc closes', () => {
    expect(key({})).toBe('add');
    expect(key({ metaKey: true })).toBe('send');
    expect(key({ ctrlKey: true })).toBe('send');
    expect(key({ key: 'Escape' })).toBe('close');
  });

  it('⇧Enter is a new line, other keys and IME composition do nothing', () => {
    expect(key({ shiftKey: true })).toBeNull();
    expect(key({ key: 'a' })).toBeNull();
    expect(key({ isComposing: true })).toBeNull();
    expect(key({ key: 'Escape', isComposing: true })).toBeNull();
  });
});

describe('placement', () => {
  const area = { left: 0, top: 0, width: 1000, height: 700 };

  it('puts the button just outside the selection top-right corner', () => {
    expect(placeAskButton({ left: 100, top: 200, width: 300, height: 100 }, area)).toEqual({ left: 408, top: 200 });
  });

  it('goes to the other side when there is no room to the right of the corner', () => {
    expect(placeAskButton({ left: 100, top: 200, width: 880, height: 100 }, area)).toEqual({ left: 100 - 8 - ASK_BUTTON, top: 200 });
  });

  it('keeps off a neighbouring layer and 6 px from its text', () => {
    const selection = { left: 100, top: 200, width: 90, height: 40 };
    const neighbour = { left: 203, top: 200, width: 100, height: 40 };
    const text = { left: 220, top: 210, width: 60, height: 16 };
    // Beside the corner is the neighbour (13 px away): the button goes to the top-left instead of covering it.
    expect(placeAskButton(selection, area, { layers: [neighbour], text: [text] })).toEqual({ left: 100 - 8 - ASK_BUTTON, top: 200 });
    // Text alone, even without a layer box around it, rules out a spot closer than 6 px.
    const at = placeAskButton(selection, area, { text: [{ left: 200, top: 205, width: 40, height: 14 }] });
    expect(at.left + ASK_BUTTON + 6 <= 200 || at.left >= 240 + 6 || at.top + ASK_BUTTON + 6 <= 205 || at.top >= 219 + 6).toBe(true);
    expect(at).not.toEqual({ left: 198, top: 200 });
  });

  it('never covers the selection chrome (size label, component label, handles)', () => {
    const selection = { left: 100, top: 200, width: 90, height: 40 };
    const label = { left: 100, top: 178, width: 130, height: 18 }; // component label above the top-left, reaching past the right edge
    const handle = { left: 186, top: 196, width: 8, height: 8 };
    const glyph = { left: 190, top: 200, width: 20, height: 12 }; // a chip drawn right where the corner spot would be
    const at = placeAskButton(selection, area, { chrome: [label, handle, glyph] });
    const box = { left: at.left, top: at.top, width: ASK_BUTTON, height: ASK_BUTTON };
    for (const c of [label, handle, glyph]) {
      const apart = box.left >= c.left + c.width + 4 || c.left >= box.left + box.width + 4 || box.top >= c.top + c.height + 4 || c.top >= box.top + box.height + 4;
      expect(apart).toBe(true);
    }
  });

  // A button within `radius` px of the selection reads as belonging to it.
  const distance = (a: Box, b: Box): number => Math.hypot(Math.max(0, a.left - (b.left + b.width), b.left - (a.left + a.width)), Math.max(0, a.top - (b.top + b.height), b.top - (a.top + a.height)));
  const buttonBox = (at: { left: number; top: number }): Box => ({ left: at.left, top: at.top, width: ASK_BUTTON, height: ASK_BUTTON });
  const overlap = (a: Box, b: Box): boolean => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

  it('stays next to the selection in a crowded row, never at the row end', () => {
    // A Cancel-like button between two others in a padded row: both corners beside it are taken by a neighbour's box and text.
    const selection = { left: 400, top: 300, width: 90, height: 40 };
    const left = { left: 290, top: 300, width: 100, height: 40 };
    const right = { left: 500, top: 300, width: 100, height: 40 };
    const leftText = { left: 310, top: 312, width: 60, height: 16 };
    const rightText = { left: 520, top: 312, width: 60, height: 16 };
    const row = { left: 270, top: 280, width: 350, height: 80 };
    const at = placeAskButton(selection, area, { ancestors: [row], layers: [left, right], text: [leftText, rightText, selection], artboards: [{ left: 0, top: 0, width: 1000, height: 700 }] });
    const box = buttonBox(at);
    expect(distance(box, selection)).toBeLessThanOrEqual(32);
    expect(overlap(box, left) || overlap(box, right)).toBe(false);
  });

  it('overlaps a neighbour box rather than its text when every spot beside the selection is taken', () => {
    const selection = { left: 400, top: 300, width: 90, height: 40 };
    const left = { left: 290, top: 300, width: 100, height: 40 };
    const right = { left: 500, top: 300, width: 100, height: 40 };
    const texts = [
      { left: 300, top: 312, width: 40, height: 16 },
      { left: 540, top: 312, width: 40, height: 16 },
      { left: 300, top: 250, width: 300, height: 16 }, // a line of text above the row
      { left: 300, top: 360, width: 300, height: 16 }, // and below it
    ];
    const at = placeAskButton(selection, area, { layers: [left, right], text: texts });
    const box = buttonBox(at);
    expect(distance(box, selection)).toBeLessThanOrEqual(32);
    for (const t of texts) expect(overlap(box, t)).toBe(false);
  });

  it('sits inside the top-right corner of a large selection that is hemmed in by text', () => {
    const selection = { left: 100, top: 200, width: 400, height: 300 };
    const walls = [
      { left: 100 - 8 - ASK_BUTTON - 4, top: 0, width: 40, height: 700 },
      { left: 500, top: 0, width: 100, height: 700 },
      { left: 0, top: 0, width: 1000, height: 200 },
      { left: 0, top: 500, width: 1000, height: 200 },
    ];
    expect(placeAskButton(selection, area, { text: walls })).toEqual({ left: 500 - 8 - ASK_BUTTON, top: 208 });
  });

  it('keeps off the "Part of Button" chip and the instance outline when a part is selected', () => {
    // The Label part inside a Button instance: the chip sits above the instance, the thin outline runs around it.
    const instance = { left: 200, top: 300, width: 113, height: 70 };
    const selection = { left: 233, top: 312, width: 47, height: 21 };
    const chip = componentChipBox(instance, 'Part of Button');
    const strips = outlineStrips(instance);
    const handles = [0, 0.5, 1].flatMap((fx) =>
      [0, 0.5, 1].flatMap((fy) => (fx === 0.5 && fy === 0.5 ? [] : [{ left: selection.left + selection.width * fx - 4, top: selection.top + selection.height * fy - 4, width: 8, height: 8 }])),
    );
    // Text on both sides of the label takes the corner spots there; above it are the chip and the outline, so the first spot clear of everything is below.
    const text = [selection, { left: 285, top: 306, width: 25, height: 20 }, { left: 204, top: 306, width: 25, height: 20 }];
    const at = placeAskButton(selection, area, { text, chrome: [chip, ...handles], outlines: strips });
    expect(at).toEqual({ left: 256, top: 341 });
    const box = buttonBox(at);
    for (const c of [chip, ...strips, ...handles]) expect(overlap(box, c)).toBe(false);
  });

  it('keeps the button inside the visible area when the corner is out of view', () => {
    const at = placeAskButton({ left: 100, top: -500, width: 5000, height: 4000 }, area);
    expect(at).toEqual({ left: 1000 - 8 - ASK_BUTTON, top: 8 });
  });

  it('opens the popover below the button, above when there is no room, and never past the right edge', () => {
    const size = { width: 288, height: 140 };
    expect(placeAskPopover({ left: 408, top: 200 }, size, area)).toMatchObject({ left: 408, above: false, top: 200 + ASK_BUTTON + 6 });
    expect(placeAskPopover({ left: 408, top: 600 }, size, area)).toMatchObject({ above: true, top: 600 - 6 - 140 });
    expect(placeAskPopover({ left: 960, top: 200 }, size, area).left).toBe(1000 - 8 - 288);
  });

  it('never covers the selection or the button, flipping to the side away from the selection', () => {
    const size = { width: 288, height: 140 };
    const cases: Array<{ selection: Box; button: { left: number; top: number } }> = [
      // The button at the right edge: shifted left, the popover below it would cover the selection's strip; it opens above instead.
      { selection: { left: 700, top: 300, width: 260, height: 40 }, button: { left: 968, top: 300 } },
      // The button left of a wide selection: the popover must not run right across it.
      { selection: { left: 100, top: 200, width: 880, height: 100 }, button: { left: 68, top: 200 } },
      // Above the selection, and below it.
      { selection: { left: 300, top: 300, width: 200, height: 100 }, button: { left: 476, top: 268 } },
      { selection: { left: 300, top: 300, width: 200, height: 100 }, button: { left: 476, top: 408 } },
      // A selection hugging the bottom: no room below it.
      { selection: { left: 300, top: 560, width: 200, height: 100 }, button: { left: 508, top: 560 } },
    ];
    for (const { selection, button } of cases) {
      const pos = placeAskPopover(button, size, area, selection);
      const box = { left: pos.left, top: pos.top, width: size.width, height: size.height };
      expect(overlap(box, selection)).toBe(false);
      expect(overlap(box, { left: button.left, top: button.top, width: ASK_BUTTON, height: ASK_BUTTON })).toBe(false);
      expect(box.left).toBeGreaterThanOrEqual(8);
      expect(box.left + box.width).toBeLessThanOrEqual(1000 - 8);
    }
  });
});
