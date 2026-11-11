import { describe, expect, it } from 'vitest';
import { OcelotDocument, ORIGIN } from './document';
import { assertKeyframesName, cssValueProblem, normalizeOffset, normalizeStops, normalizeStylePatch, parseStateName, referencedKeyframes } from './motion';
import { decodeDocument, encodeDocument } from './persistence';
import { ModelError } from './types';
import { History } from './history';

function setup() {
  let n = 0;
  const doc = new OcelotDocument({ idGenerator: () => `n${++n}` });
  const ops = doc.ops(ORIGIN.human);
  const ab = ops.createArtboard({ preset: 'mobile' });
  const [btn] = ops.insertNodes(ab, [{ type: 'frame', tag: 'button', styles: { transition: 'transform 200ms ease' } }]);
  return { doc, ops, ab, btn: btn! };
}

describe('state style validation', () => {
  it('accepts plain declarations and normalizes names', () => {
    expect(normalizeStylePatch({ backgroundColor: ' #fff ', transform: 'translateY(-2px)', '--accent': 'red' }, 'x')).toEqual({
      'background-color': '#fff',
      transform: 'translateY(-2px)',
      '--accent': 'red',
    });
  });

  it('turns null and empty values into removals', () => {
    expect(normalizeStylePatch({ opacity: null, color: '  ' }, 'x')).toEqual({ opacity: null, color: null });
  });

  it.each([
    ['a brace', 'red; } body { background: url(x)'],
    ['a closing brace', 'red}'],
    ['a semicolon', 'red; color: blue'],
    ['an at-rule', '@import url(x)'],
    ['a comment', 'red /* x'],
    ['a style end tag', 'red </style><script>'],
    ['!important', 'red !important'],
    ['an unterminated quote', '"abc'],
    ['an unbalanced paren', 'translate(1px'],
    ['an unmatched paren', 'red)'],
  ])('rejects %s', (_what, value) => {
    expect(cssValueProblem(value)).not.toBeNull();
    expect(() => normalizeStylePatch({ color: value }, 'x')).toThrow(ModelError);
  });

  it('allows semicolons inside url() and quotes', () => {
    expect(cssValueProblem('url("data:image/png;base64,AAAA")')).toBeNull();
    expect(cssValueProblem('"a;b"')).toBeNull();
  });

  it('rejects property names that are not CSS properties', () => {
    expect(() => normalizeStylePatch({ 'color: red; background': 'x' }, 'x')).toThrow(/not a CSS property/);
    expect(() => normalizeStylePatch({ '{': 'x' }, 'x')).toThrow(/not a CSS property/);
  });

  it('parses state names, including the designer words', () => {
    expect(parseStateName('pressed')).toBe('active');
    expect(parseStateName('Hover')).toBe('hover');
    expect(parseStateName('focus-visible')).toBe('focus');
    expect(parseStateName('::placeholder')).toBe('placeholder');
    expect(() => parseStateName('visited')).toThrow(/hover, pressed/);
  });
});

describe('keyframes validation', () => {
  it('accepts CSS identifiers and refuses everything else', () => {
    for (const ok of ['fade-up', 'Pulse', '_x', '-slide', 'a1']) expect(() => assertKeyframesName(ok)).not.toThrow();
    for (const bad of ['', '1a', 'a b', 'a{}', 'fade;up', '--x', 'none', 'inherit', 'a'.repeat(65)]) {
      expect(() => assertKeyframesName(bad)).toThrow(ModelError);
    }
  });

  it('canonicalizes offsets', () => {
    expect(normalizeOffset('0%')).toBe('from');
    expect(normalizeOffset(100)).toBe('to');
    expect(normalizeOffset('40')).toBe('40%');
    expect(normalizeOffset('12.5%')).toBe('12.5%');
    expect(() => normalizeOffset('half')).toThrow(/"from", "to"/);
    expect(() => normalizeOffset(120)).toThrow(ModelError);
  });

  it('sorts stops, validates styles and rejects duplicates', () => {
    const stops = normalizeStops(
      [
        { offset: 'to', styles: { opacity: '1' } },
        { offset: '50%', styles: { opacity: '0.5' } },
        { offset: 0, styles: { opacity: '0' } },
      ],
      'k',
    );
    expect(stops.map((s) => s.offset)).toEqual(['from', '50%', 'to']);
    expect(() => normalizeStops([{ offset: 'from', styles: { opacity: '0' } }, { offset: '0%', styles: { opacity: '1' } }], 'k')).toThrow(/share offset/);
    expect(() => normalizeStops([{ offset: 'from', styles: { color: 'red;}' } }], 'k')).toThrow(ModelError);
    expect(() => normalizeStops([], 'k')).toThrow(/at least one stop/);
    expect(() => normalizeStops([{ offset: 'from', styles: {} }], 'k')).toThrow(/no styles/);
  });

  it('finds referenced keyframes in animation and animation-name', () => {
    const known = new Set(['fade-up', 'pulse']);
    expect(referencedKeyframes({ animation: 'fade-up 400ms ease-out both, pulse 1s infinite' }, known)).toEqual(['fade-up', 'pulse']);
    expect(referencedKeyframes({ 'animation-name': 'pulse' }, known)).toEqual(['pulse']);
    expect(referencedKeyframes({ animation: 'other 1s' }, known)).toEqual([]);
  });
});

describe('document ops', () => {
  it('stores state styles per node, patches and removes them', () => {
    const { doc, ops, btn } = setup();
    ops.setStateStyles(btn, 'hover', { transform: 'translateY(-2px)', 'background-color': '#1d4ed8' });
    ops.setStateStyles(btn, 'active', { transform: 'scale(0.97)' });
    expect(doc.require(btn).states).toEqual({
      hover: { transform: 'translateY(-2px)', 'background-color': '#1d4ed8' },
      active: { transform: 'scale(0.97)' },
    });
    ops.setStateStyles(btn, 'hover', { 'background-color': null });
    expect(doc.require(btn).states.hover).toEqual({ transform: 'translateY(-2px)' });
    ops.setStateStyles(btn, 'hover', { opacity: '0.9' }, { replace: true });
    expect(doc.require(btn).states.hover).toEqual({ opacity: '0.9' });
    ops.setStateStyles(btn, 'active', { transform: null });
    expect(doc.require(btn).states).toEqual({ hover: { opacity: '0.9' } });
  });

  it('refuses injection and unknown nodes without writing', () => {
    const { doc, ops, btn } = setup();
    expect(() => ops.setStateStyles(btn, 'hover', { color: 'red}', opacity: '0.5' })).toThrow(ModelError);
    expect(doc.require(btn).states).toEqual({});
    expect(() => ops.setStateStyles('missing', 'hover', { opacity: '1' })).toThrow(/does not exist/);
  });

  it('keeps states when duplicating and in specs', () => {
    const { doc, ops, btn } = setup();
    ops.setStateStyles(btn, 'hover', { opacity: '0.8' });
    const [copy] = ops.duplicateNodes([btn]);
    expect(doc.require(copy!).states).toEqual({ hover: { opacity: '0.8' } });
    expect(doc.toSpec(btn).states).toEqual({ hover: { opacity: '0.8' } });
  });

  it('creates nodes from specs with states and validates them', () => {
    const { doc, ops, ab } = setup();
    const [id] = ops.insertNodes(ab, [{ type: 'frame', states: { hover: { opacity: '0.5' } } }]);
    expect(doc.require(id!).states).toEqual({ hover: { opacity: '0.5' } });
    expect(() => ops.insertNodes(ab, [{ type: 'frame', states: { hover: { opacity: '0.5; }' } } }])).toThrow(ModelError);
  });

  it('sets, replaces, lists and deletes keyframes', () => {
    const { doc, ops, btn } = setup();
    ops.setKeyframes('fade-up', [
      { offset: 'to', styles: { opacity: '1' } },
      { offset: 'from', styles: { opacity: '0' } },
    ]);
    expect(doc.keyframesMap()).toEqual({ 'fade-up': [{ offset: 'from', styles: { opacity: '0' } }, { offset: 'to', styles: { opacity: '1' } }] });
    ops.updateStyles(btn, { animation: 'fade-up 400ms ease-out both' });
    expect(doc.nodesUsingKeyframes('fade-up')).toEqual([btn]);
    ops.setKeyframes('fade-up', [{ offset: 'from', styles: { opacity: '0.2' } }, { offset: 'to', styles: { opacity: '1' } }]);
    expect(doc.keyframesMap()['fade-up']![0]!.styles.opacity).toBe('0.2');
    ops.deleteKeyframes('fade-up');
    expect(doc.keyframesMap()).toEqual({});
    expect(() => ops.deleteKeyframes('fade-up')).toThrow(/No keyframes named/);
    expect(() => ops.setKeyframes('bad name', [{ offset: 'to', styles: { opacity: '1' } }])).toThrow(/valid keyframes name/);
  });

  it('round-trips through save and load, and through undo', () => {
    const { doc, ops, btn } = setup();
    ops.setStateStyles(btn, 'focus', { outline: '2px solid #2563eb' });
    ops.setKeyframes('pulse', [{ offset: 'from', styles: { transform: 'scale(1)' } }, { offset: '50%', styles: { transform: 'scale(1.05)' } }]);
    const file = JSON.parse(JSON.stringify(encodeDocument(doc)));
    expect(file.tree.keyframes.pulse).toHaveLength(2);
    const loaded = decodeDocument(file);
    expect(loaded.require(btn).states).toEqual({ focus: { outline: '2px solid #2563eb' } });
    expect(loaded.keyframesMap()).toEqual(doc.keyframesMap());
  });

  it('agent writes are undone with the agent step', () => {
    const { doc, btn } = setup();
    const history = new History(doc);
    const agent = doc.ops(ORIGIN.agent);
    history.agentStep('motion', () => {
      agent.setStateStyles(btn, 'hover', { opacity: '0.5' });
      agent.setKeyframes('fade', [{ offset: 'to', styles: { opacity: '1' } }]);
    });
    expect(doc.require(btn).states.hover).toBeDefined();
    history.undo();
    expect(doc.require(btn).states).toEqual({});
    expect(doc.keyframesMap()).toEqual({});
  });
});
