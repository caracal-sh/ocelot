// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hasInlineMarkup, inlineText, markState, normalizeMarkup, offsetsOf, rangeFor, safeHref, sanitizeInlineHtml, setLink, setStyleProp, toggleMark, type TextRange } from './richText';

function root(html: string): HTMLElement {
  const el = document.createElement('p');
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

/** Offsets of `needle` in the element's text. */
function at(el: HTMLElement, needle: string): TextRange {
  const start = (el.textContent ?? '').indexOf(needle);
  expect(start).toBeGreaterThanOrEqual(0);
  return { start, end: start + needle.length };
}

describe('toggleMark', () => {
  it('bolds a partial selection inside plain text', () => {
    const el = root('Hello brave new world');
    expect(toggleMark(el, at(el, 'brave'), 'bold')).toEqual({ on: true });
    expect(el.innerHTML).toBe('Hello <b>brave</b> new world');
  });

  it('turns an already bold selection off and merges the pieces back', () => {
    const el = root('Hello <b>brave</b> new world');
    expect(toggleMark(el, at(el, 'brave'), 'bold')).toEqual({ on: false });
    expect(el.innerHTML).toBe('Hello brave new world');
  });

  it('un-bolds the middle of a bold run by splitting it', () => {
    const el = root('<b>one two three</b>');
    toggleMark(el, at(el, 'two'), 'bold');
    expect(el.innerHTML).toBe('<b>one </b>two<b> three</b>');
  });

  it('over a mixed selection turns the mark on everywhere, then off', () => {
    const el = root('aa <b>bb</b> cc');
    expect(toggleMark(el, { start: 0, end: 8 }, 'bold')).toEqual({ on: true });
    expect(el.innerHTML).toBe('<b>aa bb cc</b>');
    expect(toggleMark(el, { start: 0, end: 8 }, 'bold')).toEqual({ on: false });
    expect(el.innerHTML).toBe('aa bb cc');
  });

  it('nests different marks and keeps them independent', () => {
    const el = root('make this loud');
    toggleMark(el, at(el, 'this loud'), 'bold');
    toggleMark(el, at(el, 'loud'), 'italic');
    toggleMark(el, at(el, 'this'), 'underline');
    expect(el.innerHTML).toBe('make <b><u>this</u> <i>loud</i></b>');
    // removing bold from the inner word leaves its italic
    toggleMark(el, at(el, 'loud'), 'bold');
    expect(el.innerHTML).toBe('make <b><u>this</u> </b><i>loud</i>');
  });

  it('treats a collapsed selection as the whole text', () => {
    const el = root('all of it');
    toggleMark(el, { start: 3, end: 3 }, 'italic');
    expect(el.innerHTML).toBe('<i>all of it</i>');
  });

  it('respects the layer being bold already (base style) and switches it off explicitly', () => {
    const el = root('heavy words');
    expect(toggleMark(el, at(el, 'words'), 'bold', { bold: true, italic: false })).toEqual({ on: false });
    expect(el.innerHTML).toBe('heavy <span style="font-weight: 400">words</span>');
    expect(toggleMark(el, at(el, 'words'), 'bold', { bold: true, italic: false })).toEqual({ on: true });
    expect(el.innerHTML).toBe('heavy words');
  });

  it('understands marks written as inline styles (agent markup)', () => {
    const el = root('x <span style="font-weight: 700">bold</span> y');
    expect(markState(el, at(el, 'bold')).bold).toBe(true);
    toggleMark(el, at(el, 'bold'), 'bold');
    expect(el.innerHTML).toBe('x bold y');
  });

  it('keeps the strike and underline words of a shared text-decoration separate', () => {
    const el = root('<span style="text-decoration: underline line-through">both</span>');
    toggleMark(el, { start: 0, end: 4 }, 'strike');
    expect(el.innerHTML).toBe('<span style="text-decoration: underline">both</span>');
  });

  it('returns null without text', () => {
    const el = root('');
    expect(toggleMark(el, { start: 0, end: 0 }, 'bold')).toBeNull();
  });
});

describe('inline styles and links', () => {
  it('sets a color on part of the text, writing it as typed', () => {
    const el = root('Pay <b>20% less</b> today');
    setStyleProp(el, at(el, '20%'), 'color', '#ff6a00');
    expect(el.innerHTML).toBe('Pay <b><span style="color: #ff6a00">20%</span> less</b> today');
  });

  it('replaces an existing color instead of nesting a second one', () => {
    const el = root('a <span style="color: red">bcd</span> e');
    setStyleProp(el, at(el, 'cd'), 'color', 'oklch(0.7 0.15 250)');
    expect(el.innerHTML).toBe('a <span style="color: red">b</span><span style="color: oklch(0.7 0.15 250)">cd</span> e');
  });

  it('removes a property with null and unwraps empty spans', () => {
    const el = root('a <span style="font-size: 24px">big</span> b');
    setStyleProp(el, at(el, 'big'), 'font-size', null);
    expect(el.innerHTML).toBe('a big b');
  });

  it('keeps other properties of a span while changing one', () => {
    const el = root('<span style="color: red; font-size: 20px">x</span>');
    setStyleProp(el, { start: 0, end: 1 }, 'color', 'blue');
    expect(el.innerHTML).toBe('<span style="font-size: 20px"><span style="color: blue">x</span></span>');
  });

  it('links a selection and removes the link again', () => {
    const el = root('read the docs now');
    setLink(el, at(el, 'the docs'), 'https://example.com');
    expect(el.innerHTML).toBe('read <a href="https://example.com" style="text-decoration: underline">the docs</a> now');
    expect(markState(el, at(el, 'docs')).link).toBe('https://example.com');
    setLink(el, at(el, 'docs'), null);
    expect(el.innerHTML).toBe('read <a href="https://example.com" style="text-decoration: underline">the </a>docs now');
  });

  it('only allows safe link targets', () => {
    expect(safeHref('example.com/x')).toBe('https://example.com/x');
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });
});

describe('markState and offsets', () => {
  it('reports what the whole selection agrees on', () => {
    const el = root('<b>a</b><i>b</i> <span style="color: red">c</span>');
    expect(markState(el, at(el, 'a'))).toMatchObject({ bold: true, italic: false });
    expect(markState(el, at(el, 'ab'))).toMatchObject({ bold: false, italic: false });
    expect(markState(el, at(el, 'c')).color).toBe('red');
    expect(markState(el, { start: 0, end: 5 }).color).toBeNull();
  });

  it('round-trips offsets through DOM ranges', () => {
    const el = root('ab <b>cd</b> ef');
    const range = rangeFor(el, { start: 1, end: 6 });
    expect(range.toString()).toBe('b cd ');
    expect(offsetsOf(el, range)).toEqual({ start: 1, end: 6 });
  });
});

describe('sanitizeInlineHtml', () => {
  it('keeps inline marks, links and allowed styles', () => {
    const html = 'a <b>b</b> <a href="https://x.dev" target="_blank">c</a> <span style="color: #f00; font-size: 20px">d</span>';
    expect(sanitizeInlineHtml(html)).toBe(html);
  });

  it('drops scripts, handlers, unsafe links and disallowed styles; unwraps blocks and unknown tags', () => {
    expect(sanitizeInlineHtml('<script>x()</script>hi <b onclick="x()">there</b>')).toBe('hi <b>there</b>');
    expect(sanitizeInlineHtml('<a href="javascript:x()">l</a>')).toBe('<a>l</a>');
    expect(sanitizeInlineHtml('<span style="color: red; position: fixed; background: url(x)">s</span>')).toBe('<span style="color: red">s</span>');
    expect(sanitizeInlineHtml('<div>one</div><div>two</div>')).toBe('one<br>two');
    expect(sanitizeInlineHtml('<font color="red">f</font><strike>s</strike>')).toBe('f<s>s</s>');
  });

  it('drops a trailing placeholder <br> but keeps real line breaks', () => {
    expect(sanitizeInlineHtml('line<br>')).toBe('line');
    expect(sanitizeInlineHtml('a<br>b')).toBe('a<br>b');
  });

  it('tells markup from plain text', () => {
    expect(hasInlineMarkup('plain & simple')).toBe(false);
    expect(hasInlineMarkup('a <b>b</b>')).toBe(true);
    expect(inlineText('a<br>b &amp; c')).toBe('a\nb & c');
  });
});

describe('normalizeMarkup', () => {
  it('merges equal neighbors and drops empty wrappers', () => {
    const el = root('<b>a</b><b>b</b><i></i><span>c</span>');
    normalizeMarkup(el);
    expect(el.innerHTML).toBe('<b>ab</b>c');
  });
});
