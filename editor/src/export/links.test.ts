// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { artboardSlugs, slugify } from './links';
import { exportHtml } from './html';
import { exportReact } from './react';
import { exportNode, exportScreensHtml, screensFiles } from './assets';

/** Home (nav `<a>` → Pricing, card → Signup, logo → website), Pricing (back link), Signup. */
function flow() {
  const editor = new Editor();
  const { human, doc } = editor;
  const home = doc.artboardIds()[0]!;
  human.rename(home, 'Home');
  const pricing = human.createArtboard({ name: 'Pricing — Desktop' });
  const signup = human.createArtboard({ name: 'Sign up' });
  const [nav, card, logo] = human.insertNodes(home, [
    { type: 'text', tag: 'a', text: 'Pricing', name: 'Nav / Pricing', attrs: { href: 'https://stale.example' } },
    { type: 'frame', name: 'CTA card', children: [{ type: 'text', text: 'Start' }] },
    { type: 'frame', name: 'Logo' },
  ]);
  const [back] = human.insertNodes(pricing, [{ type: 'text', tag: 'a', text: 'Home', name: 'Nav / Home' }]);
  human.setLink(nav!, { artboard: pricing });
  human.setLink(card!, { artboard: signup });
  human.setLink(logo!, { url: 'https://example.com/?a=1&b=2' });
  human.setLink(back!, { artboard: home });
  return { editor, doc, home, pricing, signup, nav: nav!, card: card!, logo: logo!, back: back! };
}

describe('slugs', () => {
  it('slugify turns names into file and route names', () => {
    expect(slugify('Pricing — Desktop')).toBe('pricing-desktop');
    expect(slugify('Onboarding / Welcome')).toBe('onboarding-welcome');
    expect(slugify('Café Ünïcode')).toBe('cafe-unicode');
    expect(slugify('— / —')).toBe('screen');
  });

  it('are unique across the document, in document order', () => {
    const { editor, home, pricing } = flow();
    const dup = editor.human.createArtboard({ name: 'Pricing - Desktop' });
    const slugs = artboardSlugs(editor.doc);
    expect(slugs.get(home)).toBe('home');
    expect(slugs.get(pricing)).toBe('pricing-desktop');
    expect(slugs.get(dup)).toBe('pricing-desktop-2');
  });
});

describe('HTML export', () => {
  it('a single artboard drops links to other screens to "#" and keeps external URLs', () => {
    const { doc, home } = flow();
    const html = exportHtml(doc, home);
    expect(html).toContain('<a href="#"');
    expect(html).not.toContain('stale.example'); // a link beats a stored href on an <a>
    expect(html).not.toMatch(/pricing-desktop\.html/);
    expect(html).toContain('data-href="https://example.com/?a=1&amp;b=2"'); // a hotspot to the outside
    expect(html).not.toContain('data-href="#"'); // nowhere to go: no hotspot
    expect(html).toContain('<script>');
    expect(html).toContain('data-href');
  });

  it('several screens exported together link to each other as <slug>.html', () => {
    const { doc, home, pricing, signup } = flow();
    const out = exportScreensHtml(doc, [home, pricing, signup], new Editor().assets);
    expect(out.pages.map((p) => p.fileName)).toEqual(['home.html', 'pricing-desktop.html', 'sign-up.html']);
    const homeHtml = out.pages[0]!.code;
    expect(homeHtml).toMatch(/<a href="pricing-desktop\.html"/);
    expect(homeHtml).toMatch(/data-href="sign-up\.html"/);
    expect(homeHtml).toMatch(/role="link" tabindex="0" style="[^"]*cursor: pointer/);
    expect(homeHtml).toContain('data-href="https://example.com/?a=1&amp;b=2"');
    expect(out.pages[1]!.code).toMatch(/<a href="home\.html"/);
    expect(screensFiles(out).map((f) => f.path)).toEqual(['home.html', 'pricing-desktop.html', 'sign-up.html']);
  });

  it('a link to a screen that is not exported (or was deleted) drops to "#"', () => {
    const { doc, editor, home, pricing, signup } = flow();
    const out = exportScreensHtml(doc, [home, pricing], new Editor().assets);
    expect(out.pages[0]!.code).not.toContain('sign-up.html');
    expect(out.pages[0]!.code).toContain('<a href="pricing-desktop.html"');
    editor.human.deleteNodes([signup]);
    expect(exportScreensHtml(editor.doc, [home, pricing], new Editor().assets).pages[0]!.code).not.toContain('sign-up');
  });

  it('a page without links has no script', () => {
    const editor = new Editor();
    expect(exportHtml(editor.doc, editor.doc.artboardIds()[0]!)).not.toContain('<script>');
  });

  it('hotspots keep their own cursor and role', () => {
    const { editor, card, doc, home, pricing, signup } = flow();
    editor.human.updateStyles(card, { cursor: 'help' });
    editor.human.setAttrs(card, { role: 'button' });
    const html = exportScreensHtml(doc, [home, pricing, signup], new Editor().assets).pages[0]!.code;
    expect(html).toContain('cursor: help');
    expect(html).not.toContain('cursor: pointer; cursor');
    expect(html).toMatch(/role="button"[^>]*data-href="sign-up\.html"/);
    expect(html.match(/role="(link|button)"/g)).toHaveLength(2 + 0);
  });
});

describe('React export', () => {
  it('maps screen links to route paths, keeps external URLs, and says the router is up to the app', () => {
    const { doc, home } = flow();
    const { code } = exportReact(doc, home);
    expect(code).toMatch(/^\/\/ Layers that link to other screens use route paths \(e\.g\. \/pricing, one per artboard name\)\. Wiring a router to them is up to your app\.\n/);
    expect(code).toContain('<a href="/pricing-desktop">Pricing</a>');
    expect(code).not.toContain('stale.example');
    expect(code).toContain('role="link" tabIndex={0} onClick={() => window.location.assign("/sign-up")}');
    expect(code).toContain('cursor-pointer');
    expect(code).toContain('onClick={() => window.open("https://example.com/?a=1&b=2", "_blank", "noopener,noreferrer")}');
  });

  it('a design with only external links needs no router note; no links, no note', () => {
    const editor = new Editor();
    const home = editor.doc.artboardIds()[0]!;
    const [a] = editor.human.insertNodes(home, [{ type: 'text', tag: 'a', text: 'Docs' }]);
    expect(exportReact(editor.doc, home).code).not.toContain('router');
    editor.human.setLink(a!, { url: 'https://example.com' });
    const { code } = exportReact(editor.doc, home);
    expect(code).toContain('href="https://example.com"');
    expect(code).not.toContain('router');
  });

  it('routes are the same whatever is exported, and a deleted target drops to "#"', () => {
    const { editor, home, pricing } = flow();
    editor.human.deleteNodes([pricing]);
    expect(exportReact(editor.doc, home).code).toContain('href="#"');
  });
});

describe('exportNode', () => {
  it('HTML of one node drops screen links; React uses routes', () => {
    const { editor, home } = flow();
    expect(exportNode(editor.doc, home, 'html', editor.assets).code).toContain('<a href="#"');
    expect(exportNode(editor.doc, home, 'react', editor.assets).code).toContain('href="/pricing-desktop"');
  });
});
