// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { htmlToSpecs } from './htmlToSpec';

describe('htmlToSpecs', () => {
  it('maps containers, text, images and svg', () => {
    const { specs, warnings } = htmlToSpecs(`
      <section data-name="Hero" style="display:flex; flex-direction: column; gap: 24px">
        <h1 style="font-size:48px">Simple <b>pricing</b></h1>
        <p>Pick a plan</p>
        <img src="https://x.test/a.png" alt="A" style="width:100px">
        <svg viewBox="0 0 10 10" width="10"><circle cx="5" cy="5" r="5" onclick="x()"/></svg>
        <div style="height:1px;background:#eee"></div>
      </section>`);
    expect(warnings).toEqual([]);
    expect(specs).toHaveLength(1);
    const hero = specs[0]!;
    expect(hero).toMatchObject({ type: 'frame', tag: 'section', name: 'Hero', styles: { display: 'flex', 'flex-direction': 'column', gap: '24px' } });
    const [h1, p, img, svg, line] = hero.children!;
    expect(h1).toMatchObject({ type: 'text', tag: 'h1', html: 'Simple <b>pricing</b>', styles: { 'font-size': '48px' } });
    expect(p).toMatchObject({ type: 'text', tag: 'p', text: 'Pick a plan' });
    expect(img).toMatchObject({ type: 'image', tag: 'img', attrs: { src: 'https://x.test/a.png', alt: 'A' } });
    expect(svg).toMatchObject({ type: 'svg', attrs: { viewBox: '0 0 10 10', width: '10' } });
    expect(svg!.html).toContain('<circle');
    expect(svg!.html).not.toContain('onclick');
    expect(line).toMatchObject({ type: 'frame', tag: 'div', children: [] });
  });

  it('turns buttons with icons into frames and loose text into spans', () => {
    const { specs } = htmlToSpecs('<button>Buy <svg width="8" height="8"></svg></button><div>Hello <div>block</div></div>');
    expect(specs[0]).toMatchObject({ type: 'frame', tag: 'button' });
    expect(specs[0]!.children![0]).toMatchObject({ type: 'text', tag: 'span', text: 'Buy' });
    expect(specs[1]!.children!.map((c) => c.type)).toEqual(['text', 'text']);
  });

  it('drops unsafe content and explains why', () => {
    const { specs, warnings } = htmlToSpecs(
      '<style>.a{}</style><div class="p-4" onclick="evil()"><script>x()</script><a href="javascript:alert(1)">x</a></div>',
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]!.attrs).toEqual({ class: 'p-4' });
    expect(warnings.join(' ')).toMatch(/style.*inline/i);
    expect(warnings.join(' ')).toMatch(/onclick/);
    expect(warnings.join(' ')).toMatch(/Tailwind/);
    expect(JSON.stringify(specs)).not.toContain('javascript:');
    expect(JSON.stringify(specs)).not.toContain('script');
  });
});
