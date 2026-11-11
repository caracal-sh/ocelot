import { describe, expect, it } from 'vitest';
import { describeCall, htmlLayerNames } from './describe';

const NAMES: Record<string, string> = { n_hero: 'Hero', n_cta: 'CTA', n_nav: 'Nav', n_board: 'Ember landing page', n_old: 'Old card' };
const nameOf = (id: string) => NAMES[id];

describe('htmlLayerNames', () => {
  it('names the top-level layers', () => {
    expect(htmlLayerNames('<section data-name="Hero: headline and booking card" style="x"><h1 data-name="Headline">Hi</h1></section>')).toEqual(['Hero: headline and booking card']);
    expect(htmlLayerNames('<nav data-name="Nav"></nav><section data-name="Hero"></section><footer></footer>')).toEqual(['Nav', 'Hero']);
  });

  it('falls back to the children of a lone unnamed root', () => {
    expect(htmlLayerNames('<div style="display:flex"><div data-name="Card 1"><p data-name="Deep">x</p></div><div data-name="Card 2"></div></div>')).toEqual(['Card 1', 'Card 2']);
  });

  it('copes with void tags, self-closing tags and > inside attribute values', () => {
    expect(htmlLayerNames('<img src="a.png"><div data-name="Row" title="a > b"><br><input></div>')).toEqual(['Row']);
    expect(htmlLayerNames('<div data-name=\'Single quoted\'/>')).toEqual(['Single quoted']);
  });

  it('names nothing for unnamed siblings', () => {
    expect(htmlLayerNames('<p>a</p><p>b</p>')).toEqual([]);
  });
});

describe('describeCall', () => {
  it('write_html says what was built, in both tenses', () => {
    const html = '<section data-name="Row 4: pricing tiers"><div>x</div></section>';
    expect(describeCall('write_html', { node_id: 'n_board', html, mode: 'append' })).toEqual({ doing: 'Building Row 4: pricing tiers', done: 'Built Row 4: pricing tiers' });
  });

  it('write_html lists up to three names, then counts the rest', () => {
    const html = ['Nav', 'Hero', 'Cards', 'Footer', 'Legal'].map((n) => `<section data-name="${n}"></section>`).join('');
    expect(describeCall('write_html', { node_id: 'n_board', html, mode: 'replace' })?.done).toBe('Built Nav, Hero, Cards and 2 more');
  });

  it('write_html without names quotes its first text, else names the container, else falls back', () => {
    expect(describeCall('write_html', { node_id: 'n_board', html: '<div><h1>Brew better   coffee, every morning</h1><p>x</p></div>', mode: 'append' })?.done).toBe('Built “Brew better coffee, every morning”');
    expect(describeCall('write_html', { node_id: 'n_hero', html: '<div style="height:20px"></div>', mode: 'append' }, { nameOf })?.done).toBe('Built in Hero');
    expect(describeCall('write_html', null)).toEqual({ doing: 'Building layers', done: 'Built layers' });
    expect(describeCall('write_html', { node_id: 'n_x', html: '' })?.done).toBe('Built layers');
  });

  it('the agent\'s own intent wins, trimmed to one sentence', () => {
    const text = describeCall('write_html', { html: '<p data-name="X"></p>' }, { intent: 'build the pricing row. Then check it' });
    expect(text).toEqual({ doing: 'Build the pricing row', done: 'Build the pricing row' });
    expect(describeCall('update_styles', null, { intent: 'x'.repeat(200) })?.done).toHaveLength(64);
  });

  it('update_styles names the layers it touches (single, plural and batch forms)', () => {
    expect(describeCall('update_styles', { node_id: 'n_hero', styles: {} }, { nameOf })).toEqual({ doing: 'Styling Hero', done: 'Styled Hero' });
    expect(describeCall('update_styles', { node_ids: ['n_hero', 'n_cta'], styles: {} }, { nameOf })?.done).toBe('Styled Hero and CTA');
    expect(describeCall('update_styles', { updates: [{ node_ids: ['n_hero'], styles: {} }, { node_id: 'n_cta', styles: {} }, { node_id: 'n_nav', styles: {} }] }, { nameOf })?.done).toBe('Styled Hero, CTA and Nav');
  });

  it('without layer names it counts, and without targets it falls back', () => {
    expect(describeCall('update_styles', { node_ids: ['gone1', 'gone2', 'gone3'], styles: {} }, { nameOf })?.done).toBe('Styled 3 layers');
    expect(describeCall('update_styles', { node_id: 'gone', styles: {} })?.done).toBe('Styled a layer');
    expect(describeCall('update_styles', null)).toEqual({ doing: 'Adjusting styles', done: 'Adjusted styles' });
    expect(describeCall('delete_nodes', { node_ids: ['n_old'] })?.done).toBe('Deleted a layer');
    expect(describeCall('delete_nodes', { node_ids: ['n_old'] }, { nameOf })?.done).toBe('Deleted Old card');
  });

  it('set_text quotes what it wrote', () => {
    expect(describeCall('set_text', { node_id: 'n_hero', text: 'Brew better coffee' })?.done).toBe('Wrote “Brew better coffee”');
    expect(describeCall('set_text', { updates: [{ node_id: 'a', text: 'One' }, { node_id: 'b', html: 'Save <b>20%</b>' }, { node_id: 'c', text: 'Three' }] })?.doing).toBe('Writing “One” and 2 more');
    expect(describeCall('set_text', { node_id: 'n_hero', html: 'Save <b>20%</b> today' })?.done).toBe('Wrote “Save 20% today”');
    expect(describeCall('set_text', { node_id: 'n_hero' })?.done).toBe('Changed text');
  });

  it('create_shape, move_nodes, rename_nodes and insert_component read the call', () => {
    expect(describeCall('create_shape', { parent_id: 'n_hero', shape: 'ellipse' }, { nameOf })?.done).toBe('Drew an ellipse in Hero');
    expect(describeCall('create_shape', { parent_id: 'n_hero', shape: 'line', name: 'Divider' }, { nameOf })?.done).toBe('Drew “Divider” in Hero');
    expect(describeCall('move_nodes', { node_ids: ['n_cta'], new_parent_id: 'n_hero' }, { nameOf })?.done).toBe('Moved CTA into Hero');
    expect(describeCall('rename_nodes', { updates: [{ node_id: 'n_hero', name: 'Hero' }, { node_id: 'n_cta', name: 'Booking CTA' }] })?.done).toBe('Named Hero and Booking CTA');
    expect(describeCall('insert_component', { parent_id: 'n_hero', component: 'button' }, { nameOf })?.done).toBe('Inserted button in Hero');
    expect(describeCall('insert_component', { parent_id: 'n_hero', components: [{ component: 'button' }, { component: 'badge' }] })?.done).toBe('Inserted button and badge');
  });

  it('leaves every other tool to the fixed labels', () => {
    expect(describeCall('get_screenshot', {})).toBeNull();
    expect(describeCall('begin_edit', { label: 'x' }, { intent: 'y' })).toBeNull();
    expect(describeCall('constructor', {})).toBeNull();
  });
});
