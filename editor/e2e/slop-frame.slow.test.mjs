// @vitest-environment jsdom
// The design probe in a real browser (the same function the editor runs on the live canvas and the eval runs in its page):
//  - frame and layout rules, each with a fixture that trips it and one that must not;
//  - the layout-dependent tells;
//  - calibration: the human-made references (inspect/fixtures/good.html and the theme showcase page in every catalog theme) raise
//    ZERO Fix findings, and poor.html raises several.
// jsdom is only the environment for write_html's DOMParser; every measurement happens in Chromium.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launch, serve } from './browser.mjs';
import { LANDING_HTML } from './fixtures/themedLanding.mjs';
import { Editor } from '../src/editor/Editor.ts';
import { McpServer } from '../src/mcp/protocol.ts';
import { createBrowserHost } from '../src/host/host.ts';
import { artboardDocumentHtml } from '../src/render/serialize.ts';
import { probeSlop } from '../src/inspect/probe.ts';
import { classify } from '../src/inspect/rules.ts';
import { lintPage } from '../src/inspect/pageChecks.ts';
import { BUNDLED_FONT_FACE_CSS } from '../src/themes/fonts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
let site;
let browser;
beforeAll(async () => {
  site = await serve(join(HERE, '..', 'public'));
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

/** Probes `html` at width x height; the root is the first element with data-ocelot-root (a page that has none gets its body). */
async function inspect(html, width, height, kind = 'canvas', themeId = null) {
  const page = await browser.newPage({ viewport: { width, height } });
  const path = site.addPage(html.includes('data-ocelot-root') ? html : html.replace('<body', '<body data-ocelot-root'));
  await page.goto(site.url + path, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const probed = await page.evaluate(probeSlop, { width, height, kind });
  await page.close();
  return { ...classify(probed.findings, { kind: probed.kind, themeId }), facts: probed.facts, kind: probed.kind };
}
const doc = (body, style = '') => `<!doctype html><body style="margin:0;font-family:Georgia,serif;color:#222;${style}">${body}`;
const ids = (r) => r.findings.map((f) => f.rule_id);
const fixes = (r) => r.findings.filter((f) => f.level === 'fix');

const BODY = 'A handmade lamp that warms as the sun goes down, so your home winds down with you, one quiet evening at a time. Made to order in small batches by two people.';
const P = (text, style = '') => `<p style="margin:0;font-size:18px;line-height:1.4;${style}">${text}</p>`;
const H = (text, style = '') => `<h1 style="margin:0;font-size:72px;line-height:1.05;font-weight:700;${style}">${text}</h1>`;

describe('frame rules', () => {
  const centred = (inner) => doc(`<div style="width:1440px;height:900px;padding:96px 120px;box-sizing:border-box">${inner}</div>`);

  it('off-centre: unequal side margins trip it, a centred layout does not', async () => {
    const lopsided = doc(`<div style="width:1440px;height:900px;box-sizing:border-box;padding:96px 60px 96px 140px"><div style="width:1240px;height:300px;background:#cde"></div>${P('Hello there', 'margin-top:20px')}</div>`);
    const r = await inspect(lopsided, 1440, 900);
    expect(ids(r)).toContain('off-centre');
    expect(r.findings.find((f) => f.rule_id === 'off-centre').measured).toMatch(/left margin 140px, right margin 60px/);
    expect(ids(await inspect(centred(`<div style="height:300px;background:#cde"></div>${P('Hello there', 'margin-top:20px')}`), 1440, 900))).not.toContain('off-centre');
  });

  it('off-centre: a picture that bleeds off one edge on purpose is not a margin', async () => {
    const split = doc(`<div style="display:flex;width:1440px;height:700px"><div style="width:700px;padding:100px 0 0 120px;box-sizing:border-box">${H('Lamps', 'font-size:60px')}${P('Warm light.')}</div><div style="flex:1;background:#e0a070"></div></div>`);
    expect(ids(await inspect(split, 1440, 700))).not.toContain('off-centre');
  });

  it('edge-text: text 10px from a phone edge trips it; 24px does not; 12px is fine on a phone but not on a desktop', async () => {
    const at = (x, w, h) => doc(`<div style="position:relative;width:${w}px;height:${h}px">${P('Keep clear of the edge', `position:absolute;left:${x}px;top:200px`)}${P('Another line of copy here', `position:absolute;left:${w / 2 - 80}px;top:300px`)}</div>`);
    expect(ids(await inspect(at(10, 390, 700), 390, 700))).toContain('edge-text');
    expect(ids(await inspect(at(24, 390, 700), 390, 700))).not.toContain('edge-text');
    expect(ids(await inspect(at(13, 390, 700), 390, 700))).not.toContain('edge-text');
    expect(ids(await inspect(at(13, 1440, 900), 1440, 900))).toContain('edge-text');
  });

  it('caps a broken page at six findings per rule and counts the rest', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => P(`Line ${i} hugging the edge`, `position:absolute;left:4px;top:${40 + i * 40}px`)).join('');
    const r = await inspect(doc(`<div style="position:relative;width:600px;height:600px">${lines}</div>`), 600, 600);
    const edge = r.findings.filter((f) => f.rule_id === 'edge-text');
    expect(edge).toHaveLength(6);
    expect(edge[5].measured).toMatch(/\(\+4 more\)$/);
  });

  it('edge-text: huge display type may bleed on purpose', async () => {
    const monument = doc(`<div style="position:relative;width:1440px;height:900px">${H('TIDE', 'position:absolute;left:4px;top:300px;font-size:300px;line-height:1')}</div>`);
    expect(ids(await inspect(monument, 1440, 900))).not.toContain('edge-text');
  });

  it('overflow: text cut off by a clipping container or running outside the artboard trips it', async () => {
    const cut = doc(`<div style="padding:120px"><div style="width:200px;height:24px;overflow:hidden;white-space:nowrap">${P('A line that is much too long for its box and gets cut', 'white-space:nowrap')}</div></div>`);
    expect(ids(await inspect(cut, 1000, 600))).toContain('overflow');
    const out = doc(`<div style="padding:120px 0 0 120px;width:600px">${P('This text starts inside and runs on past the right edge of the artboard', 'white-space:nowrap')}</div>`);
    expect(ids(await inspect(out, 600, 400))).toContain('overflow');
    const fine = doc(`<div style="padding:120px"><div style="width:400px">${P('A line that wraps inside its box instead of being cut off.')}</div></div>`);
    expect(ids(await inspect(fine, 1000, 600))).not.toContain('overflow');
  });

  it('visually hidden text (sr-only) is not painted, so it is never edge text, overflow or overlap', async () => {
    const srOnly = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border-width:0';
    const dialog = doc(`<div style="position:relative;width:420px;height:200px;margin:120px;overflow:hidden">${P('Edit profile', 'padding:24px')}<button style="position:absolute;top:0;right:0;width:24px;height:24px"><span style="${srOnly}">Close</span></button></div>`);
    expect(ids(await inspect(dialog, 700, 440))).not.toContain('overflow');
    expect(ids(await inspect(dialog, 700, 440))).not.toContain('edge-text');
    const visible = doc(`<div style="position:relative;width:420px;height:200px;margin:120px;overflow:hidden">${P('Edit profile', 'padding:24px')}<button style="position:absolute;top:0;right:-30px;width:60px;height:24px">Close</button></div>`);
    expect(ids(await inspect(visible, 700, 440))).toContain('overflow');
  });

  it('overlap: text on text and colliding in-flow siblings trip it; decoration behind text and avatar stacks do not', async () => {
    const stacked = doc(`<div style="position:relative;height:500px;padding:100px 120px">${P('Roasted where the tide comes in', 'position:absolute;left:120px;top:150px;font-size:32px')}${P('Twelve-kilo batches roasted at first light', 'position:absolute;left:150px;top:160px;font-size:32px')}</div>`);
    expect(ids(await inspect(stacked, 1440, 700))).toContain('overlap');
    const collide = doc(`<div style="padding:120px"><div style="width:400px;height:120px;background:#cde"></div><div style="width:400px;height:120px;margin-top:-60px;background:#edc"></div></div>`);
    expect(ids(await inspect(collide, 1440, 700))).toContain('overlap');
    const behind = doc(`<div style="position:relative;padding:150px 120px"><div style="position:absolute;left:100px;top:100px;width:500px;height:200px;background:#cde"></div>${P('Text over a decorative shape', 'position:relative;font-size:32px')}</div>`);
    expect(ids(await inspect(behind, 1440, 600))).not.toContain('overlap');
    const avatars = doc(`<div style="display:flex;padding:150px 120px">${[0, 1, 2].map((i) => `<div style="width:40px;height:40px;border-radius:50%;background:#${['c88', '8c8', '88c'][i]};margin-left:${i ? -12 : 0}px"></div>`).join('')}</div>`);
    expect(ids(await inspect(avatars, 1440, 600))).not.toContain('overlap');
  });

  it('blank-gap: 240px of nothing between two blocks trips it; trailing space and an image band do not', async () => {
    const block = (extra = '') => `<div style="margin:0 120px;height:200px;background:#cde;${extra}"></div>`;
    const gap = doc(`<div style="padding-top:60px">${block()}<div style="height:300px"></div>${block()}</div>`);
    const r = await inspect(gap, 1440, 900);
    expect(ids(r)).toContain('blank-gap');
    expect(r.findings.find((f) => f.rule_id === 'blank-gap').measured).toMatch(/^300px with nothing painted/);
    const small = doc(`<div style="padding-top:60px">${block()}<div style="height:120px"></div>${block()}</div>`);
    expect(ids(await inspect(small, 1440, 900))).not.toContain('blank-gap');
    const trailing = doc(`<div style="padding:60px 0 0">${block()}</div>`);
    expect(ids(await inspect(trailing, 1440, 1600))).not.toContain('blank-gap');
    const band = doc(`<div style="padding-top:60px">${block()}<div style="height:300px;margin:0 120px;background-image:linear-gradient(#e8d8c0,#c0a080)"></div>${block()}</div>`);
    expect(ids(await inspect(band, 1440, 900))).not.toContain('blank-gap');
  });

  it('blank-gap: a flat full-page wrapper is the ground, not content that fills the hole', async () => {
    const wrapped = doc(`<div style="background:#f6f3ee;min-height:900px;padding-top:60px"><div style="margin:0 120px;height:100px;background:#cde"></div><div style="height:300px"></div><div style="margin:0 120px;height:100px;background:#cde"></div></div>`);
    expect(ids(await inspect(wrapped, 1440, 900))).toContain('blank-gap');
  });

  it('blank-gap does not apply to slides', async () => {
    const slide = doc(`<div style="padding-top:60px"><div style="margin:0 120px;height:100px;background:#cde"></div><div style="height:500px"></div><div style="margin:0 120px;height:100px;background:#cde"></div></div>`);
    expect(ids(await inspect(slide, 1920, 1080, 'deck'))).not.toContain('blank-gap');
  });

  it('hero-void: a big empty block in the opening screen trips it; a filled one does not', async () => {
    const huddled = doc(`<div style="width:1440px;height:900px;padding:140px 0 0 120px;box-sizing:border-box;width:640px">${H('Lamps')}${P('Warm light.')}</div>`);
    expect(ids(await inspect(huddled, 1440, 900))).toContain('hero-void');
    const filled = doc(`<div style="display:flex;width:1440px;height:900px"><div style="width:640px;padding:0 0 0 120px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center">${H('Lamps')}${P('Warm light.')}</div><div style="flex:1;margin:120px 120px 80px 0;background-image:linear-gradient(#e0a070,#7a3a1c)"></div></div>`);
    expect(ids(await inspect(filled, 1440, 900))).not.toContain('hero-void');
  });
});

describe('layout-dependent tells', () => {
  const tile = '<div style="width:44px;height:44px;border-radius:12px;background:#e6ecfe;display:flex;align-items:center;justify-content:center"><svg width="20" height="20"><circle cx="10" cy="10" r="8" fill="#2457f5"/></svg></div>';
  const card = (i, withTile = true) => `<div style="width:300px;height:220px;padding:28px;box-sizing:border-box;border-radius:16px;background:#f6f6f4;box-shadow:0 2px 8px rgba(0,0,0,.08)">${withTile ? tile : ''}<h3 style="margin:16px 0 8px;font-size:22px">Feature ${i}</h3>${P('Copy that explains it.')}</div>`;
  const row = (...cards) => doc(`<div style="display:flex;gap:30px;padding:120px 120px">${cards.join('')}</div>`);

  it('icon-tile-row: three equal cards with icon squares trip it; plain cards, unequal cards and app screens do not', async () => {
    expect(ids(await inspect(row(card(1), card(2), card(3)), 1440, 700))).toContain('icon-tile-row');
    expect(ids(await inspect(row(card(1, false), card(2, false), card(3, false)), 1440, 700))).not.toContain('icon-tile-row');
    const unequal = row(card(1), card(2).replace('width:300px', 'width:360px'), card(3));
    expect(ids(await inspect(unequal, 1440, 700))).not.toContain('icon-tile-row');
    expect(ids(await inspect(row(card(1), card(2), card(3)), 1440, 700, 'app'))).not.toContain('icon-tile-row');
  });

  it('eyebrow: a small tracked caps line right above a heading trips it; the same line in a nav or table does not', async () => {
    const label = (extra = '') => `<span style="display:block;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;${extra}">New: Lumen Dusk</span>`;
    const page = (inner) => doc(`<div style="padding:200px 120px;width:900px">${inner}${H('Light that follows your evening')}${P(BODY, 'margin-top:20px')}${P(BODY)}</div>`);
    expect(ids(await inspect(page(label('margin-bottom:12px')), 1440, 700))).toContain('eyebrow');
    expect(ids(await inspect(page(`<nav>${label('margin-bottom:12px')}</nav>`), 1440, 700))).not.toContain('eyebrow');
    expect(ids(await inspect(page(label('margin-bottom:200px')), 1440, 700))).not.toContain('eyebrow');
  });

  it('pill-badge, index-numbers, side-border and glow fire on their devices only', async () => {
    const pill = doc(`<div style="padding:200px 120px">${`<span style="display:inline-block;padding:6px 14px;border-radius:999px;background:#e6ecfe;font-size:13px;margin-bottom:16px">New</span>`}${H('Light that follows your evening')}${P(BODY, 'margin-top:20px')}${P(BODY)}</div>`);
    expect(ids(await inspect(pill, 1440, 700))).toContain('pill-badge');
    const nums = doc(`<div style="padding:120px">${['01 Plan', '02 Build', '03 Ship'].map((t) => P(t, 'font-size:14px')).join('')}</div>`);
    expect(ids(await inspect(nums, 1440, 600))).toContain('index-numbers');
    const callout = doc(`<div style="padding:120px"><div style="padding:20px;border-left:4px solid #2457f5;background:#f0f4ff">${P('Heads up')}</div></div>`);
    expect(ids(await inspect(callout, 1440, 500))).toContain('side-border');
    const glow = doc(`<div style="padding:120px"><div style="width:200px;height:80px;border-radius:12px;background:#7c3aed;box-shadow:0 0 40px rgba(124,58,237,0.6)"></div></div>`);
    expect(ids(await inspect(glow, 1440, 500))).toContain('glow-shadow');
    const plain = doc(`<div style="padding:120px"><div style="width:200px;height:80px;padding:20px;box-sizing:border-box;border-radius:12px;background:#eee;border:1px solid #ccc;box-shadow:0 4px 12px rgba(0,0,0,0.12)">${P('Plain')}</div></div>`);
    expect(ids(await inspect(plain, 1440, 500)).filter((i) => ['pill-badge', 'index-numbers', 'side-border', 'glow-shadow', 'eyebrow'].includes(i))).toEqual([]);
  });

  it('a theme that owns a device gets it skipped, not raised', async () => {
    const callout = doc(`<div style="padding:120px"><div style="padding:20px;border-left:4px solid #000;background:#fff700">${P('Heads up')}</div></div>`);
    const themed = await inspect(callout, 1440, 500, 'canvas', 'neo-brutalist');
    expect(ids(themed)).not.toContain('side-border');
    expect(themed.skipped.map((s) => s.rule_id)).toContain('side-border');
    expect(ids(await inspect(callout, 1440, 500))).toContain('side-border');
  });
});

describe('faux-style with the bundled fonts (real @font-face rules)', () => {
  const page = (family, style) => `<!doctype html><style>${BUNDLED_FONT_FACE_CSS}</style><body style="margin:0;color:#222"><p style="margin:24px;font:${style} 28px ${family}">${BODY}</p>`;
  const faux = async (family, style) => (await inspect(page(family, style), 1440, 400)).findings.find((f) => f.rule_id === 'faux-style');

  it('flags what the browser would fake: bold on the regular-only Geist Serif, italic on Geist Mono', async () => {
    expect((await faux("'Geist Serif', serif", '700')).measured).toBe('Geist Serif has no 700 face, so the browser fakes it: use 400 (or pick a family with that weight)');
    expect((await faux("'Instrument Serif', serif", '600')).level).toBe('fix');
    expect((await faux("'Geist Mono', monospace", 'italic 400')).measured).toMatch(/^Geist Mono has no italic face/);
  });

  it('is quiet when the family ships it or the browser only picks a shipped face', async () => {
    for (const [family, style] of [["'Geist Serif', serif", '400'], ["'Geist Serif', serif", '500'], ['Geist, sans-serif', 'italic 800'], ["'Space Mono', monospace", '600'], ["'Instrument Serif', serif", 'italic 400'], ["'Geist Mono', monospace", '700'], ['Georgia, serif', '700']]) {
      expect(await faux(family, style), `${family} ${style}`).toBeUndefined();
    }
  });
});

describe('calm rules (held-out Checks): text-wall, dense-screen, shouting-display, no-picture, tight-margin', () => {
  const CALM = ['text-wall', 'dense-screen', 'shouting-display', 'no-picture', 'tight-margin'];
  const calm = (r) => ids(r).filter((i) => CALM.includes(i));
  const words = (n, tag = 'w') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
  const PIC = '<div style="width:640px;height:520px;background-image:linear-gradient(160deg,#f4c9a0,#7a3a1c)"></div>';
  /** A desktop page `height` tall: sections of `perSection` words at 18px, margins of `margin`px, an optional picture beside the first one. */
  const page = ({ height, sections, perSection, margin = 144, picture = true, headline = 72 }) =>
    doc(`<div style="width:1440px;height:${height}px;padding:60px ${margin}px;box-sizing:border-box;display:flex;flex-direction:column;gap:80px"><div style="display:flex;gap:60px;align-items:center"><div style="width:560px">${H('Light that follows your evening', `font-size:${headline}px`)}</div>${picture ? PIC : ''}</div>${Array.from({ length: sections }, (_, i) => P(words(perSection, `s${i}x`), 'max-width:640px')).join('')}</div>`);

  it('text-wall: more than 70 words per 1000px on a page of 1500px or more trips it; a sparse tall page, and a one-screen page, do not', async () => {
    const wall = await inspect(page({ height: 2400, sections: 6, perSection: 50 }), 1440, 2400);
    expect(ids(wall)).toContain('text-wall');
    expect(wall.findings.find((f) => f.rule_id === 'text-wall').level).toBe('check');
    expect(ids(await inspect(page({ height: 2400, sections: 3, perSection: 40 }), 1440, 2400))).not.toContain('text-wall');
    expect(ids(await inspect(page({ height: 900, sections: 1, perSection: 90 }), 1440, 900))).not.toContain('text-wall');
  });

  it('dense-screen: more than 100 words on the first screen trips it, 60 do not', async () => {
    expect(ids(await inspect(page({ height: 900, sections: 3, perSection: 40, picture: false }), 1440, 900))).toContain('dense-screen');
    expect(ids(await inspect(page({ height: 900, sections: 1, perSection: 40, picture: false }), 1440, 900))).not.toContain('dense-screen');
  });

  it('shouting-display: a headline above 7.5% of the width trips it; 72px and 100px do not', async () => {
    const loud = await inspect(page({ height: 900, sections: 1, perSection: 20, headline: 120 }), 1440, 900);
    expect(ids(loud)).toContain('shouting-display');
    expect(loud.findings.find((f) => f.rule_id === 'shouting-display').measured).toBe('a 120px headline is 8.3% of the width');
    for (const size of [72, 100]) expect(ids(await inspect(page({ height: 900, sections: 1, perSection: 20, headline: size }), 1440, 900)), `${size}px`).not.toContain('shouting-display');
  });

  it('no-picture: text on flat fills trips it; a gradient block, an image or a vector over a fifth of the first screen does not', async () => {
    expect(ids(await inspect(page({ height: 900, sections: 1, perSection: 20, picture: false }), 1440, 900))).toContain('no-picture');
    expect(ids(await inspect(page({ height: 900, sections: 1, perSection: 20 }), 1440, 900))).not.toContain('no-picture');
    const svg = doc(`<div style="padding:60px 144px">${H('Lamps')}${P(words(30))}<svg width="900" height="400" viewBox="0 0 900 400"><rect width="900" height="400" fill="#c97b3a"/></svg></div>`);
    expect(ids(await inspect(svg, 1440, 900))).not.toContain('no-picture');
    const ground = doc(`<div style="width:1440px;height:900px;padding:60px 144px;box-sizing:border-box;background-image:linear-gradient(#f6f3ee,#e8e0d0)">${H('Lamps')}${P(words(30))}</div>`);
    expect(ids(await inspect(ground, 1440, 900)), 'a gradient page ground is not a picture').toContain('no-picture');
  });

  it('tight-margin: text 40px from the sides trips it; 144px (10%) does not', async () => {
    const tight = await inspect(page({ height: 900, sections: 8, perSection: 12, margin: 40 }), 1440, 900);
    expect(ids(tight)).toContain('tight-margin');
    expect(tight.findings.find((f) => f.rule_id === 'tight-margin').measured).toMatch(/^text starts 40px from the left edge/);
    expect(ids(await inspect(page({ height: 900, sections: 8, perSection: 12, margin: 144 }), 1440, 900))).not.toContain('tight-margin');
  });

  it('apps, decks and phone-sized pages are left alone', async () => {
    const dense = (extra) => doc(`<div style="padding:30px;width:1440px">${extra}${P(words(300))}${H('Dashboard', 'font-size:140px')}</div>`);
    expect(calm(await inspect(dense('<table><tr><td>a</td></tr></table>'), 1440, 2400)), 'a table makes it an app screen').toEqual([]);
    expect(calm(await inspect(dense(''), 1920, 1080, 'deck'))).toEqual([]);
    expect(calm(await inspect(doc(`<div style="padding:12px;width:390px">${P(words(200))}</div>`), 390, 2000))).toEqual([]);
  });
});

describe('page facts and the page-level Checks (action-labels, radius-scale, state-coverage)', () => {
  const PAGE_RULES = ['action-labels', 'radius-scale', 'state-coverage'];
  const texts = (r) => r.facts.actions.map((a) => a.text);
  const radii = (r) => r.facts.radii.map((x) => `${x.kind[0]}${x.nested ? 'n' : ''}${x.px}`).sort();
  const base = (inner) => doc(`<div style="padding:60px 120px;width:1200px">${inner}</div>`);
  const rounded = (px, size = 'width:200px;height:120px', extra = '') => `<div style="${size};border-radius:${px}px;background:#eef;${extra}"></div>`;

  it('reads action labels off buttons, standalone links, button roles, submit inputs and button-like layers, not inline links or hidden ones', async () => {
    const r = await inspect(
      base(`<button>Save changes</button><a href="#" style="display:inline-block">Sign in</a><div role="button">Cancel</div><input type="submit" value="Send message">
        <div style="cursor:pointer">Add project</div><span style="display:inline-block;padding:8px 16px;background:#222;color:#fff">Get started</span>
        <p>Read the <a href="#">terms of service</a> before you continue.</p><button style="display:none">Hidden</button><div>Plain text</div><h2>Settings</h2>
        <button>★</button>`),
      1440, 700,
    );
    expect(texts(r).sort()).toEqual(['Add project', 'Cancel', 'Get started', 'Save changes', 'Send message', 'Sign in']);
  });

  it('reads controls and surfaces by radius; pills, circles, square corners and small chips are not steps', async () => {
    const r = await inspect(
      base(`<button style="height:40px;padding:0 16px;border-radius:6px;background:#222;color:#fff">Save</button>
        <input style="height:40px;border-radius:8px;border:1px solid #ccc"><button style="height:40px;border-radius:999px;background:#222;color:#fff">Pill</button>
        <button style="height:40px;border-radius:0;background:#222;color:#fff">Square</button><div style="width:40px;height:40px;border-radius:50%;background:#ccc"></div>
        <input type="checkbox" style="width:24px;height:24px;border-radius:4px;border:1px solid #333">${rounded(16)}<span style="display:inline-block;height:20px;padding:0 6px;border-radius:4px;background:#eee;font-size:12px">tag</span>`),
      1440, 700,
    );
    expect(radii(r)).toEqual(['c6', 'c8', 's16']);
  });

  it('marks a surface inside a larger-radius surface as nested (a screen in a phone frame), and a percentage radius as its share of the short side', async () => {
    const r = await inspect(base(`<div style="width:300px;height:500px;border-radius:44px;background:#111;padding:10px;box-sizing:border-box"><div style="height:480px;border-radius:36px;background:#fff"></div></div>${rounded(0, 'width:200px;height:120px', 'border-radius:10%')}`), 1440, 800);
    expect(radii(r)).toEqual(['s12', 's44', 'sn36']);
  });

  it('reads a data list: a table or grid of five or more rows, or five side-by-side rows; not a stack of cards, nor four rows', async () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => `<tr><td>Order ${i}</td><td>Ada</td><td>$${i}0</td></tr>`).join('');
    expect((await inspect(base(`<table><thead><tr><th>Order</th><th>Name</th><th>Total</th></tr></thead><tbody>${rows(6)}</tbody></table>`), 1440, 700)).facts.dataList).toMatchObject({ rows: 6 });
    expect((await inspect(base(`<table><tbody>${rows(4)}</tbody></table>`), 1440, 700)).facts.dataList).toBeNull();
    const flexRows = (n) => `<div>${Array.from({ length: n }, (_, i) => `<div style="display:flex;gap:20px;height:40px;align-items:center"><span>Ada ${i}</span><span>Admin</span><span>Active</span></div>`).join('')}</div>`;
    expect((await inspect(base(flexRows(7)), 1440, 700)).facts.dataList).toMatchObject({ rows: 7 });
    const cards = `<div>${Array.from({ length: 6 }, (_, i) => `<div style="height:120px"><h3>Plan ${i}</h3><p>Copy</p><button>Choose</button></div>`).join('')}</div>`;
    expect((await inspect(base(cards), 1440, 700)).facts.dataList).toBeNull();
  });

  it('end to end over four artboards: inconsistent labels, a radius sprawl and a screen with a lone empty state', async () => {
    const settings = await inspect(base(`<button style="border-radius:4px;height:40px;background:#222;color:#fff">Save</button><input style="height:40px;border-radius:6px">`), 1440, 600);
    const billing = await inspect(base(`<button style="border-radius:8px;height:40px;background:#222;color:#fff">Save changes</button><input style="height:40px;border-radius:10px">${rounded(12)}`), 1440, 600);
    const team = await inspect(base(`<button style="border-radius:14px;height:40px;background:#222;color:#fff">Update</button>`), 1440, 600);
    const boards = [['Settings', settings], ['Billing', billing], ['Team', team], ['Team / Empty', team]].map(([name, r]) => ({ id: name, name, kind: r.kind, facts: r.facts }));
    const found = lintPage(boards);
    expect(found.map((f) => f.rule).sort()).toEqual(['action-labels', 'radius-scale', 'state-coverage']);
    expect(found.find((f) => f.rule === 'action-labels').measured).toBe("“Update” on Team and Team / Empty; “Save” on Settings; “Save changes” on Billing: 3 labels for one action");
    expect(found.find((f) => f.rule === 'radius-scale').measured).toBe('5 different corner radii on controls (4px, 6px, 8px, 10px, 14px), 6 with cards and panels');
    expect(found.find((f) => f.rule === 'state-coverage').measured).toBe('“Team” has Empty but no Loading or Error artboard');
  });

  it('a consistent set of product screens raises none of them', async () => {
    const screen = base(`<button style="border-radius:8px;height:40px;background:#222;color:#fff">Save changes</button><input style="height:40px;border-radius:8px">${rounded(12)}`);
    const [a, b] = [await inspect(screen, 1440, 600), await inspect(screen, 1440, 600)];
    expect(lintPage([{ id: 'a', name: 'Settings', kind: a.kind, facts: a.facts }, { id: 'b', name: 'Billing', kind: b.kind, facts: b.facts }]).map((f) => f.rule).filter((x) => PAGE_RULES.includes(x))).toEqual([]);
  });
});

describe('calibration on human-made references', () => {
  it('good.html raises zero Fix findings and none of the calm Checks', async () => {
    const html = await readFile(join(HERE, '..', 'src', 'inspect', 'fixtures', 'good.html'), 'utf8');
    const r = await inspect(html, 1440, 900);
    expect(fixes(r)).toEqual([]);
    expect(r.findings.filter((f) => f.level === 'check').length).toBeLessThanOrEqual(3);
    expect(ids(r).filter((i) => ['text-wall', 'dense-screen', 'shouting-display', 'no-picture', 'tight-margin'].includes(i))).toEqual([]);
    expect(lintPage([{ id: 'good', name: 'Landing', kind: r.kind, facts: r.facts }]), 'none of the page rules').toEqual([]);
  });

  it('poor.html raises several Fix findings (and no Check finding is needed to see it is poor)', async () => {
    const html = await readFile(join(HERE, '..', 'src', 'inspect', 'fixtures', 'poor.html'), 'utf8');
    const r = await inspect(html, 1440, 900);
    expect(new Set(fixes(r).map((f) => f.rule_id))).toEqual(new Set(['edge-text', 'off-centre']));
    expect(fixes(r).length).toBeGreaterThanOrEqual(3);
  });

  it('the theme showcase page raises zero Fix findings in every catalog theme (artboard sized to its content)', async () => {
    const editor = new Editor();
    const server = new McpServer({ editor, locks: editor.locks, host: createBrowserHost({}) });
    let n = 0;
    const call = async (name, args) => JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }))))?.result;
    const ab = editor.doc.artboardIds()[0];
    await call('update_artboard', { artboard_id: ab, width: 1280, height: 860 });
    await call('apply_theme', { theme_id: 'ocelot-default' });
    expect((await call('write_html', { node_id: ab, mode: 'replace', html: LANDING_HTML })).isError).toBeFalsy();
    const themes = JSON.parse((await call('list_themes', {})).content[0].text).themes;
    expect(themes.length).toBeGreaterThanOrEqual(13);
    for (const t of themes) {
      await call('apply_theme', { theme_id: t.id });
      // The showcase markup is authored for 860px; in themes with taller type it is taller. Measure it at the height it needs.
      let height = 860;
      const html = () => artboardDocumentHtml(editor.doc, ab, { timeMs: 'end' });
      const page = await browser.newPage({ viewport: { width: 1280, height } });
      const path = site.addPage(html());
      await page.goto(site.url + path, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      height = Math.max(860, await page.evaluate(() => document.querySelector('[data-ocelot-root]').scrollHeight + 40));
      await page.close();
      const r = await inspect(html(), 1280, height, 'canvas', t.id);
      expect(fixes(r).map((f) => `${t.id}: ${f.rule_id} ${f.measured}`), t.id).toEqual([]);
      expect(lintPage([{ id: 'showcase', name: 'Landing', kind: r.kind, facts: r.facts }]).map((f) => `${t.id}: ${f.rule} ${f.measured}`), t.id).toEqual([]);
      // The showcase is a token demo (103 words on the first screen, no picture, 72px margins): it may raise these three calm Checks, never the other two.
      expect(ids(r).filter((i) => ['text-wall', 'shouting-display'].includes(i)), t.id).toEqual([]);
    }
  }, 120_000);
});
