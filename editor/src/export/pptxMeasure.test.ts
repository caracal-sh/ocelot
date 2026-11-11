// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { nodeToHtml } from '../render/serialize';
import type { PptxTextBoxSpec } from './pptx';
import { hiddenTextCss, measureTextBoxes, parseCssColor } from './pptxMeasure';

// jsdom has no layout. Text rectangles come from a `data-rect="left,top,width,height"` attribute on the element that holds
// the text node (several rectangles, one per line, as `data-rects="l,t,w,h;l,t,w,h"`). Real layout is covered by
// e2e/deck-export.mjs in Chromium.
const realGetClientRects = Range.prototype.getClientRects;
const realElementRects = Element.prototype.getClientRects;
beforeEach(() => {
  Element.prototype.getClientRects = function () {
    return Object.assign([{ left: 0, top: 0, width: 1, height: 1 } as DOMRect], { item: () => null }) as unknown as DOMRectList;
  };
  Range.prototype.getClientRects = function (this: Range) {
    const el = (this.startContainer.nodeType === 3 ? this.startContainer.parentElement : (this.startContainer as Element))!;
    const holder = el.closest('[data-rects],[data-rect]');
    const spec = holder?.getAttribute('data-rects') ?? holder?.getAttribute('data-rect') ?? '';
    const rects = spec.split(';').filter(Boolean).map((s) => {
      const [l, t, w, h] = s.split(',').map(Number) as [number, number, number, number];
      return { left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t } as DOMRect;
    });
    return Object.assign(rects, { item: (i: number) => rects[i] ?? null }) as unknown as DOMRectList;
  };
});
afterEach(() => {
  Range.prototype.getClientRects = realGetClientRects;
  Element.prototype.getClientRects = realElementRects;
  document.body.innerHTML = '';
});

interface Spec {
  name: string;
  html: string;
  style?: string;
}

/** An artboard with one text layer per spec; returns the rendered root, the document and the ids by name. */
function render(specs: Spec[]) {
  const editor = new Editor();
  const ab = editor.doc.artboardIds(editor.doc.firstPageId())[0]!;
  const ids: Record<string, string> = {};
  for (const s of specs) {
    const [id] = editor.human.insertNodes(ab, [{ type: 'text', name: s.name, html: s.html, tag: 'div' }]);
    ids[s.name] = id!;
    if (s.style) editor.human.updateStyles(id!, Object.fromEntries(s.style.split(';').filter(Boolean).map((p) => p.split(':').map((x) => x.trim()) as [string, string])));
  }
  document.body.innerHTML = nodeToHtml(editor.doc, ab);
  const root = document.body.firstElementChild as HTMLElement;
  return { editor, ab, root, ids, measure: () => measureTextBoxes(editor.doc, ab, root) };
}

describe('colours', () => {
  it('reads computed rgb, rgba and color(srgb) values', () => {
    expect(parseCssColor('rgb(26, 58, 42)')).toEqual({ r: 26, g: 58, b: 42, a: 1 });
    expect(parseCssColor('rgba(255, 0, 0, 0.5)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(parseCssColor('rgb(255 0 0 / 25%)')).toEqual({ r: 255, g: 0, b: 0, a: 0.25 });
    expect(parseCssColor('color(srgb 1 0.5 0 / 0.5)')).toEqual({ r: 255, g: 128, b: 0, a: 0.5 });
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor('oklch(0.5 0.2 30)')).toBeNull(); // no canvas in jsdom: reported, not guessed
  });
});

describe('hidden text CSS', () => {
  it('makes exactly the listed layers and what is inside them transparent, escaping ids', () => {
    expect(hiddenTextCss([])).toBe('');
    const css = hiddenTextCss(['a', 'b"c']);
    expect(css).toContain('[data-node-id="a"],[data-node-id="a"] *');
    expect(css).toContain('[data-node-id="b\\"c"]');
    expect(css).toContain('color:transparent!important');
    expect(css).toContain('-webkit-text-fill-color:transparent!important');
    expect(css).toContain('text-shadow:none!important');
  });
});

describe('measureTextBoxes', () => {
  it('turns a one-line layer into a box at the measured text position with its font, colour and size', () => {
    const t = render([{ name: 'Title', html: '<span data-rect="160,120,720,100" style="font-family:Georgia,serif;font-size:96px;color:rgb(26,58,42);font-weight:700">Hello deck</span>', style: 'line-height:120px;text-align:left' }]);
    const m = t.measure();
    expect(m.hidden).toEqual([t.ids['Title']]);
    expect(m.boxes).toHaveLength(1);
    const box = m.boxes[0]!;
    expect(box.runs).toEqual([{ text: 'Hello deck', fontFace: 'Georgia', fontPx: 96, color: '1A3A2A', bold: true }]);
    expect(box.x).toBeLessThanOrEqual(160);
    expect(box.x + box.w).toBeGreaterThanOrEqual(880); // never tighter than the text
    expect(box.wrap).toBe(false);
    expect(box.align).toBe('left');
    expect(box.lineHeightPx).toBe(120);
    expect(box.y).toBeCloseTo(120 - (120 - 100) / 2, 5); // the first LINE box starts above the glyph box by half the leading
  });

  it('splits styled runs, applies text-transform, honours <br>, and wraps multi-line text', () => {
    const t = render([
      {
        name: 'Body',
        html: '<div data-rects="100,200,800,50;100,260,400,50" style="font-size:40px;color:rgb(0,0,0);text-transform:uppercase">plain <span style="font-weight:700;color:rgb(255,0,0)">strong</span> end<br>second line</div>',
        style: 'line-height:60px',
      },
    ]);
    const m = t.measure();
    const box = m.boxes[0]!;
    expect(box.wrap).toBe(true);
    expect(box.h).toBe(120); // two lines × 60px
    expect(box.runs.map((r) => [r.text, r.bold ?? false, r.color, r.breakLine ?? false])).toEqual([
      ['PLAIN ', false, '000000', false],
      ['STRONG', true, 'FF0000', false],
      [' END', false, '000000', true],
      ['SECOND LINE', false, '000000', false],
    ]);
  });

  it('keeps effective opacity as transparency and leaves invisible text out', () => {
    const t = render([
      { name: 'Faded', html: '<span data-rect="0,0,100,40" style="font-size:30px;color:rgb(0,0,0)">Faded</span>', style: 'opacity:0.4' },
      { name: 'Gone', html: '<span data-rect="0,50,100,40" style="font-size:30px;color:rgba(0,0,0,0)">Gone</span>' },
    ]);
    const m = t.measure();
    expect(m.boxes.map((b) => b.runs[0]!.text)).toEqual(['Faded']);
    expect(m.boxes[0]!.runs[0]!.transparency).toBe(60);
  });

  it('leaves text in rotated or scaled layers in the picture and says so', () => {
    const t = render([
      { name: 'Tilted', html: '<span data-rect="0,0,100,40" style="font-size:30px;color:rgb(0,0,0)">Tilted</span>', style: 'transform:rotate(8deg)' },
      { name: 'Straight', html: '<span data-rect="0,60,100,40" style="font-size:30px;color:rgb(0,0,0)">Straight</span>' },
    ]);
    const m = t.measure();
    expect(m.boxes.map((b) => b.nodeId)).toEqual([t.ids['Straight']]);
    expect(m.hidden).toEqual([t.ids['Straight']]);
    expect(m.warnings.join(' ')).toMatch(/Text left in the picture.*"Tilted" sits in a rotated or scaled layer/);
  });

  it('names fonts PowerPoint may not have, once, and warns about wrapping with them', () => {
    const t = render([
      { name: 'A', html: '<div data-rects="0,0,500,40;0,50,300,40" style="font-family:Inter,sans-serif;font-size:30px;color:rgb(0,0,0)">Two lines of text</div>' },
      { name: 'B', html: '<span data-rect="0,200,100,40" style="font-family:Inter,sans-serif;font-size:30px;color:rgb(0,0,0)">More</span>' },
    ]);
    const m = t.measure();
    expect(m.warnings.filter((w) => w.startsWith('Fonts named, not embedded'))).toEqual([expect.stringContaining('Inter')]);
    expect(m.warnings.some((w) => /1 text block wraps over several lines/.test(w))).toBe(true);
  });

  it('anchors the slack of a centred or right-aligned box where its text is anchored', () => {
    const t = render([
      { name: 'Centre', html: '<span data-rect="400,0,400,50" style="font-size:40px;color:rgb(0,0,0)">Centred</span>', style: 'text-align:center' },
      { name: 'Right', html: '<span data-rect="400,100,400,50" style="font-size:40px;color:rgb(0,0,0)">Right</span>', style: 'text-align:right' },
    ]);
    const [centre, right] = t.measure().boxes as [PptxTextBoxSpec, PptxTextBoxSpec];
    expect(centre.x + centre.w / 2).toBeCloseTo(600, 5);
    expect(right.x + right.w).toBeCloseTo(800, 5);
  });

  it('skips empty and hidden text layers', () => {
    const t = render([
      { name: 'Empty', html: '   ' },
      { name: 'Shown', html: '<span data-rect="0,0,100,40" style="font-size:30px;color:rgb(0,0,0)">Shown</span>' },
    ]);
    expect(t.measure().boxes.map((b) => b.nodeId)).toEqual([t.ids['Shown']]);
  });
});
