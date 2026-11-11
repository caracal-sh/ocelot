// @vitest-environment jsdom
// jsdom has no layout, so the geometry of this file's page is stubbed: every element with data-box="x,y,w,h" reports that box
// (relative to the artboard root, which is 1440×900), everything else reports an empty one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeSlop } from './probe';

const hosts: HTMLElement[] = [];

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = this.getAttribute('data-box');
    const root = this.hasAttribute('data-ocelot-root');
    const [x, y, w, h] = root ? [0, 0, 1440, 900] : (box?.split(',').map(Number) ?? [0, 0, 0, 0]);
    return { x: x!, y: y!, left: x!, top: y!, width: w!, height: h!, right: x! + w!, bottom: y! + h!, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  hosts.splice(0).forEach((h) => h.remove());
});

function render(html: string): HTMLElement {
  const host = document.createElement('div');
  hosts.push(host);
  host.innerHTML = `<div data-ocelot-root style="background:#fff">${html}</div>`;
  document.body.append(host);
  return host.firstElementChild as HTMLElement;
}
const rules = (root: HTMLElement) => probeSlop({ root, width: 1440, height: 900, kind: 'canvas' }).findings.map((f) => f.rule);

describe('an artboard with no content yet', () => {
  it('is not a hero-void: there is no page to be missing something', () => {
    expect(rules(render(''))).not.toContain('hero-void');
  });

  it('is not one when it only holds layers that paint nothing (an agent is mid-write)', () => {
    expect(rules(render('<div data-box="0,0,1440,900"></div><div data-box="0,0,300,40"></div>'))).not.toContain('hero-void');
  });

  it('still reports the hole once real content sits in a corner of the first screen', () => {
    const nav = '<nav data-box="0,0,1440,64" style="background:#111"><span data-box="24,20,120,24">Ember</span></nav>';
    expect(rules(render(nav))).toContain('hero-void');
  });
});
