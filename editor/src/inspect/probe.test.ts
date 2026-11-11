// @vitest-environment jsdom
// Style-driven rules of the design probe (jsdom has no layout, so geometry rules stay quiet here; they are proven in a real
// browser by e2e/slop-frame.slow.test.mjs). Also the classification step: kinds, theme exemptions, held-out rules, ordering.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeSlop, type ProbeKind } from './probe';
import { classify, RULES, RULE_IDS, type InspectFinding } from './rules';
import { slopNote } from '../mcp/slop';

const hosts: HTMLElement[] = [];
afterEach(() => hosts.splice(0).forEach((h) => h.remove()));

function render(html: string, rootStyle = ''): HTMLElement {
  const host = document.createElement('div');
  hosts.push(host);
  host.innerHTML = `<div data-ocelot-root style="${rootStyle}">${html}</div>`;
  document.body.append(host);
  return host.firstElementChild as HTMLElement;
}
const probe = (root: HTMLElement, kind: ProbeKind | 'canvas' = 'canvas') => probeSlop({ root, width: 1440, height: 900, kind });
const rules = (root: HTMLElement, kind: ProbeKind | 'canvas' = 'canvas') => probe(root, kind).findings.map((f) => f.rule);

const BODY = 'A handmade lamp that warms as the sun goes down, so your home winds down with you, one evening at a time.';

describe('emoji-icon', () => {
  it('flags pictograph glyphs used as icons', () => {
    expect(rules(render('<p>🚀 Fast</p><p>✨ Smart</p>'))).toContain('emoji-icon');
    expect(rules(render('<p>★★★★★</p>'))).toContain('emoji-icon');
  });
  it('leaves ordinary typography alone', () => {
    expect(rules(render('<p>© 2026 Lumen — Order now → $189 • 5 stars</p>'))).not.toContain('emoji-icon');
  });
});

describe('purple-gradient', () => {
  it('flags a violet-to-blue gradient fill', () => {
    const r = render('<div style="background-image:linear-gradient(135deg,rgb(139,92,246),rgb(59,130,246))">x</div>');
    expect(probe(r).findings.find((f) => f.rule === 'purple-gradient')?.measured).toMatch(/purple-to-blue\/pink/);
  });
  it('is quiet for warm gradients and flat violet', () => {
    expect(rules(render('<div style="background-image:linear-gradient(160deg,rgb(244,201,160),rgb(122,58,28))">x</div>'))).not.toContain('purple-gradient');
    expect(rules(render('<div style="background-color:rgb(139,92,246)">x</div>'))).not.toContain('purple-gradient');
  });
});

describe('gradient-text', () => {
  it('flags text clipped to a gradient', () => {
    const r = render('<h1 style="background-image:linear-gradient(90deg,rgb(255,0,0),rgb(0,0,255));-webkit-background-clip:text;background-clip:text;color:transparent">Hello</h1>');
    expect(rules(r)).toContain('gradient-text');
  });
  it('ignores a gradient behind text that is not clipped to it', () => {
    expect(rules(render('<h1 style="background-image:linear-gradient(90deg,rgb(255,0,0),rgb(0,0,255))">Hello</h1>'))).not.toContain('gradient-text');
  });
});

describe('default-face', () => {
  const face = (family: string, extra = '') => render(`<h1 style="font-family:${family};font-size:28px;${extra}">Lamps</h1><p style="font-family:${family};font-size:16px">${BODY}</p>`);
  it('flags one browser or system fallback for everything', () => {
    expect(probe(face('Arial,sans-serif')).findings.find((f) => f.rule === 'default-face')?.measured).toMatch(/^arial on 100%/);
    for (const family of ['Roboto,sans-serif', "'Times New Roman',serif", 'Helvetica,Arial,sans-serif', 'system-ui,sans-serif', 'sans-serif']) {
      expect(rules(face(family)), family).toContain('default-face');
    }
  });
  it('does not flag Geist, Inter or any other named face: a face the author named is a choice', () => {
    for (const family of ['Geist,sans-serif', "'Geist Serif',serif", "'Geist Mono',monospace", 'Inter,sans-serif', 'Fraunces,serif', 'Georgia,serif']) {
      expect(rules(face(family)), family).not.toContain('default-face');
    }
  });
  it('is quiet with two faces, a theme face, an app screen, a phone or earned craft', () => {
    expect(rules(render(`<h1 style="font-family:Georgia,serif;font-size:28px">Lamps</h1><p style="font-family:Arial,sans-serif">${BODY}</p>`))).not.toContain('default-face');
    const themed = render(`<h1 style="font-family:Arial;font-size:28px">Lamps</h1><p style="font-family:Arial">${BODY}</p>`, '--theme-font-sans:Arial, system-ui');
    expect(rules(themed)).not.toContain('default-face');
    expect(rules(face('Arial,sans-serif'), 'app')).not.toContain('default-face');
    expect(rules(face('Arial,sans-serif', 'font-size:96px;font-weight:800;letter-spacing:-0.04em'))).not.toContain('default-face');
    const phone = probeSlop({ root: face('system-ui,sans-serif'), width: 390, height: 844, kind: 'canvas' });
    expect(phone.findings.map((f) => f.rule)).not.toContain('default-face');
  });
});

describe('faux-style', () => {
  // jsdom has no FontFaceSet: stand in for the @font-face rules the frame document declares for the bundled fonts.
  const FACES = [
    { family: '"Geist Serif"', weight: '400', style: 'normal' },
    { family: '"Geist"', weight: '100 900', style: 'normal' },
    { family: '"Geist"', weight: '100 900', style: 'italic' },
    { family: '"Space Mono"', weight: '400', style: 'normal' },
    { family: '"Space Mono"', weight: '700', style: 'normal' },
    { family: '"Instrument Serif"', weight: '400', style: 'normal' },
    { family: '"Instrument Serif"', weight: '400', style: 'italic' },
  ];
  beforeEach(() => Object.defineProperty(document, 'fonts', { value: FACES, configurable: true }));
  afterEach(() => Reflect.deleteProperty(document, 'fonts'));
  const text = (family: string, extra: string) => render(`<p style="font-family:${family};font-size:20px;${extra}">${BODY}</p>`);
  const measured = (root: HTMLElement) => probe(root).findings.find((f) => f.rule === 'faux-style')?.measured;

  it('flags bold on a regular-only family, naming the weight it has', () => {
    expect(measured(text("'Geist Serif',serif", 'font-weight:700'))).toBe('Geist Serif has no 700 face, so the browser fakes it: use 400 (or pick a family with that weight)');
    expect(measured(text("'Instrument Serif',serif", 'font-weight:600'))).toMatch(/^Instrument Serif has no 600 face/);
  });
  it('flags italic on a family without an italic face', () => {
    expect(measured(text("'Geist Serif',serif", 'font-style:italic'))).toMatch(/^Geist Serif has no italic face/);
    expect(measured(text("'Space Mono',monospace", 'font-style:oblique'))).toMatch(/^Space Mono has no italic face/);
  });
  it('is quiet when the family ships the weight or style (or the browser picks a shipped one)', () => {
    for (const [family, extra] of [
      ["'Geist Serif',serif", 'font-weight:400'],
      ["'Geist Serif',serif", 'font-weight:500'],
      ['Geist,sans-serif', 'font-weight:900;font-style:italic'],
      ["'Space Mono',monospace", 'font-weight:700'],
      ["'Space Mono',monospace", 'font-weight:600'],
      ["'Space Mono',monospace", 'font-weight:800'],
      ["'Instrument Serif',serif", 'font-style:italic'],
      ["'Geist Serif',serif", 'font-weight:700;font-synthesis:none'],
    ] as const) expect(measured(text(family, extra)), `${family} ${extra}`).toBeUndefined();
  });
  it('ignores families the document does not declare (installed fonts, generics) and documents with no font set', () => {
    expect(measured(text('Georgia,serif', 'font-weight:700'))).toBeUndefined();
    Reflect.deleteProperty(document, 'fonts');
    expect(measured(text("'Geist Serif',serif", 'font-weight:700'))).toBeUndefined();
  });
  it('reports each distinct problem once', () => {
    const root = render(`<p style="font-family:'Geist Serif';font-weight:700">${BODY}</p><p style="font-family:'Geist Serif';font-weight:700">${BODY}</p><h2 style="font-family:'Geist Serif';font-weight:800">Lamps</h2>`);
    expect(probe(root).findings.filter((f) => f.rule === 'faux-style')).toHaveLength(2);
  });
});

describe('probe basics', () => {
  it('measures nothing without a root and reports no layout in jsdom', () => {
    expect(probeSlop({ width: 100, height: 100, kind: 'page', root: undefined })).toMatchObject({ laidOut: false, findings: [] });
    expect(probe(render('<p>hello</p>')).laidOut).toBe(false);
  });
  it('infers an app screen from a table, a grid or a sidebar', () => {
    expect(probe(render('<table><tr><td>a</td></tr></table>')).kind).toBe('app');
    expect(probe(render('<aside>nav</aside>')).kind).toBe('app');
    expect(probe(render('<p>hello</p>')).kind).toBe('page');
    expect(probe(render('<aside>nav</aside>'), 'deck').kind).toBe('deck');
  });
});

describe('classification', () => {
  const raw = (rule: string, name = 'X') => ({ rule, nodeId: `n_${rule}`, name, measured: 'm', threshold: 't' });

  it('turns every rule id into a catalogue entry and puts fixes before checks', () => {
    for (const id of RULE_IDS) expect(RULES[id]!.say.length).toBeGreaterThan(20);
    const { findings } = classify([raw('gradient-text'), raw('edge-text'), raw('emoji-icon'), raw('blank-gap')], { kind: 'page' });
    expect(findings.map((f) => f.level)).toEqual(['fix', 'fix', 'check', 'check']);
    expect(findings[0]!.rule_id).toBe('edge-text');
    expect(findings[0]).toMatchObject({ node_id: 'n_edge-text', message: expect.stringMatching(/clears every edge/) });
  });

  it('drops rules that do not apply to the kind (convention is fine in apps; slides have no page gaps)', () => {
    expect(classify([raw('icon-tile-row'), raw('default-face')], { kind: 'app' }).findings).toEqual([]);
    expect(classify([raw('blank-gap')], { kind: 'deck' }).findings).toEqual([]);
  });

  it('skips what the applied theme uses on purpose and lists it as skipped', () => {
    const themed = classify([raw('purple-gradient'), raw('emoji-icon')], { kind: 'page', themeId: 'aurora' });
    expect(themed.findings.map((f) => f.rule_id)).toEqual(['emoji-icon']);
    expect(themed.skipped).toEqual([{ rule_id: 'purple-gradient', reason: 'theme "aurora" uses this device on purpose' }]);
    expect(classify([raw('purple-gradient')], { kind: 'page', themeId: 'swiss-grid' }).findings).toHaveLength(1);
    expect(classify([raw('purple-gradient')], { kind: 'page' }).findings).toHaveLength(1);
  });

  it('hides held-out rules from what the agent sees', () => {
    expect(classify([raw('emoji-icon'), raw('edge-text')], { kind: 'page', hidden: ['emoji-icon'] }).findings.map((f) => f.rule_id)).toEqual(['edge-text']);
  });
});

describe('the get_screenshot block', () => {
  const finding = (i: number, level: InspectFinding['level']): InspectFinding => ({ rule_id: level === 'fix' ? 'edge-text' : 'emoji-icon', level, node_id: `n_${i}`, name: `Layer ${i}`, measured: `m${i}`, threshold: 't', message: `Do something ${i}.` });

  it('lists at most five findings and counts the rest', () => {
    const list = [finding(1, 'fix'), finding(2, 'fix'), ...[3, 4, 5, 6, 7, 8].map((i) => finding(i, 'check'))];
    const note = slopNote(list);
    expect(note).toMatch(/^Design findings: 2 Fix, 6 Check\./);
    expect([...note.matchAll(/(?:Fix|Check) \[/g)]).toHaveLength(5);
    expect(note).toMatch(/…and 3 more \(inspect_design lists all\)\./);
    expect(note).toContain('"Layer 1"');
    expect(note).not.toContain('"Layer 8"');
  });

  it('is empty when nothing is found, and never repeats contrast or an already reported overflow', () => {
    expect(slopNote([])).toBe('');
    const contrast: InspectFinding = { ...finding(1, 'fix'), rule_id: 'contrast' };
    const overflow: InspectFinding = { ...finding(2, 'fix'), rule_id: 'overflow' };
    expect(slopNote([contrast])).toBe('');
    expect(slopNote([overflow], { overflowNoted: true })).toBe('');
    expect(slopNote([overflow])).toMatch(/Fix \[overflow\]/);
  });
});
