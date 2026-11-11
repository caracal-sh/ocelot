import { describe, expect, it } from 'vitest';
import { splitTop } from '../render/motionCss';
import { addStop, convertFill, fillFromSpec, fillToSpec, fillsToStyles, layerCss, mixColors, moveStop, newGradient, parseFills, removeStop, resolveStops, FillError, type Fill } from './fills';

const parse = (background: string) => parseFills({ background });
const css = (fills: Fill[]) => fillsToStyles(fills);

describe('splitTop', () => {
  it('splits only at top-level commas', () => {
    expect(splitTop('linear-gradient(red, blue), rgba(0, 0, 0, 0.5)', /,/)).toEqual(['linear-gradient(red, blue)', 'rgba(0, 0, 0, 0.5)']);
    expect(splitTop('url("a,b.png") center / cover', /,/)).toEqual(['url("a,b.png") center / cover']);
  });
});

describe('parseFills (legacy values)', () => {
  it('keeps a single color as it was', () => {
    expect(parse('#d9d9d9')).toEqual([{ type: 'solid', color: '#d9d9d9' }]);
    expect(css(parse('#d9d9d9')!)).toEqual({ background: '#d9d9d9', 'background-color': null, 'background-image': null, 'background-size': null, 'background-position': null, 'background-repeat': null });
    expect(parseFills({ 'background-color': 'rgba(0, 0, 0, 0.1)' })).toEqual([{ type: 'solid', color: 'rgba(0, 0, 0, 0.1)' }]);
    expect(parse('var(--brand)')).toEqual([{ type: 'solid', color: 'var(--brand)' }]);
    expect(parseFills({})).toEqual([]);
  });

  it('parses angles, `to` sides and stops without positions', () => {
    expect(parse('linear-gradient(135deg, #ff6a00 0%, #ee0979 100%)')).toEqual([
      { type: 'linear', angle: 135, to: null, stops: [{ color: '#ff6a00', position: 0 }, { color: '#ee0979', position: 100 }] },
    ]);
    expect(parse('linear-gradient(to right, red, rgba(0, 0, 255, 0.5))')).toEqual([
      { type: 'linear', angle: null, to: 'right', stops: [{ color: 'red' }, { color: 'rgba(0, 0, 255, 0.5)' }] },
    ]);
    expect(parse('linear-gradient(#fff, #000)')).toEqual([{ type: 'linear', angle: null, to: null, stops: [{ color: '#fff' }, { color: '#000' }] }]);
    expect(parse('linear-gradient(0.25turn, #fff, #000)')).toMatchObject([{ angle: 90 }]);
  });

  it('parses radial gradients with shape, size and position', () => {
    expect(parse('radial-gradient(circle at 30% 40%, #fff 0%, #000 100%)')).toEqual([
      { type: 'radial', shape: 'circle', size: null, at: '30% 40%', stops: [{ color: '#fff', position: 0 }, { color: '#000', position: 100 }] },
    ]);
    expect(parse('radial-gradient(#fff, #000)')).toEqual([{ type: 'radial', shape: null, size: null, at: null, stops: [{ color: '#fff' }, { color: '#000' }] }]);
    expect(parse('radial-gradient(ellipse farthest-corner at center, #fff, #000)')).toMatchObject([{ shape: 'ellipse', size: 'farthest-corner', at: 'center' }]);
  });

  it('keeps gradients it does not model verbatim', () => {
    expect(parse('conic-gradient(red, blue)')).toEqual([{ type: 'css', value: 'conic-gradient(red, blue)' }]);
    expect(parse('repeating-linear-gradient(45deg, red, blue 10%)')).toEqual([{ type: 'css', value: 'repeating-linear-gradient(45deg, red, blue 10%)' }]);
    expect(parse('linear-gradient(in oklab, red, blue)')).toEqual([{ type: 'css', value: 'linear-gradient(in oklab, red, blue)' }]);
    expect(parse('linear-gradient(red 0 20px, blue)')).toEqual([{ type: 'css', value: 'linear-gradient(red 0 20px, blue)' }]);
  });

  it('stacks layers from the shorthand: gradient over color', () => {
    expect(parse('linear-gradient(180deg, rgba(0,0,0,0) 0%, #000 100%), #336699')).toEqual([
      { type: 'linear', angle: 180, to: null, stops: [{ color: 'rgba(0,0,0,0)', position: 0 }, { color: '#000', position: 100 }] },
      { type: 'solid', color: '#336699' },
    ]);
  });

  it('reads the image longhands (what the image tools write)', () => {
    expect(parseFills({ 'background-image': 'url(asset://abc)', 'background-size': 'cover', 'background-position': 'center', 'background-repeat': 'no-repeat', 'background-color': '#fff' })).toEqual([
      { type: 'image', url: 'url(asset://abc)', size: 'cover', position: 'center', repeat: 'no-repeat' },
      { type: 'solid', color: '#fff' },
    ]);
  });

  it('reads url layers of the shorthand and returns null for what it cannot take apart', () => {
    expect(parse('url(asset://abc) center / cover no-repeat')).toEqual([{ type: 'image', url: 'url(asset://abc)', size: 'cover', position: 'center', repeat: 'no-repeat' }]);
    expect(parse('url(asset://abc) fixed')).toBeNull();
    expect(parse('red, blue')).toBeNull();
    expect(parse('#fff url(x)')).toBeNull();
  });
});

describe('fillsToStyles', () => {
  const none = { 'background-color': null, 'background-image': null, 'background-size': null, 'background-position': null, 'background-repeat': null };
  it('round-trips legacy gradients byte for byte', () => {
    for (const v of ['linear-gradient(135deg, #ff6a00 0%, #ee0979 100%)', 'linear-gradient(to right, red, blue)', 'linear-gradient(#fff, #000)', 'radial-gradient(circle at 30% 40%, #fff 0%, #000 100%)', 'radial-gradient(#fff, #000)', 'conic-gradient(red, blue)', 'linear-gradient(180deg, rgba(0,0,0,0) 0%, #000 100%), #336699']) {
      expect(css(parse(v)!)).toEqual({ background: v, ...none });
    }
  });

  it('is stable: parse(serialize(x)) equals x', () => {
    const fills: Fill[] = [newGradient('linear', '#336699'), newGradient('radial'), { type: 'solid', color: '#fff' }];
    const styles = css(fills);
    expect(parseFills(styles)).toEqual(fills);
    expect(css(parseFills(styles)!)).toEqual(styles);
  });

  it('puts a solid above other fills in a layer of its own (CSS allows a color on the bottom layer only)', () => {
    const styles = css([{ type: 'solid', color: 'rgba(0, 0, 0, 0.5)' }, { type: 'solid', color: '#fff' }]);
    expect(styles.background).toBe('linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5)), #fff');
    expect(parse(styles.background!)).toEqual([{ type: 'solid', color: 'rgba(0, 0, 0, 0.5)' }, { type: 'solid', color: '#fff' }]);
  });

  it('writes images as longhands so the image tools keep working, gradients ride along', () => {
    const styles = css([
      { type: 'linear', angle: 180, to: null, stops: [{ color: 'rgba(0, 0, 0, 0)', position: 0 }, { color: '#000', position: 100 }] },
      { type: 'image', url: 'url(asset://abc)', size: 'cover', position: 'center' },
      { type: 'solid', color: '#222' },
    ]);
    expect(styles).toEqual({
      background: null,
      'background-image': 'linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, #000 100%), url(asset://abc)',
      'background-color': '#222',
      'background-size': 'cover',
      'background-position': 'center',
      'background-repeat': null,
    });
    expect(parseFills(styles)).toMatchObject([{ type: 'linear' }, { type: 'image', url: 'url(asset://abc)', size: 'cover', position: 'center' }, { type: 'solid', color: '#222' }]);
  });

  it('writes per-layer lists when images disagree', () => {
    const styles = css([{ type: 'image', url: 'url(asset://a)', size: 'cover' }, { type: 'image', url: 'url(asset://b)', size: '40px' }]);
    expect(styles['background-size']).toBe('cover, 40px');
    expect(parseFills(styles)).toMatchObject([{ size: 'cover' }, { size: '40px' }]);
  });

  it('clears everything for an empty stack', () => {
    expect(css([])).toEqual({ background: null, ...none });
  });
});

describe('stop editing', () => {
  const stops = [{ color: '#000000', position: 0 }, { color: '#ffffff', position: 100 }];

  it('spreads unspecified positions like CSS', () => {
    expect(resolveStops([{ color: 'a' }, { color: 'b' }, { color: 'c' }, { color: 'd', position: 90 }]).map((s) => s.position)).toEqual([0, 30, 60, 90]);
    expect(resolveStops([{ color: 'a' }, { color: 'b', position: 20 }, { color: 'c', position: 10 }]).map((s) => s.position)).toEqual([0, 20, 20]);
  });

  it('adds a stop with the color the gradient has there, and keeps stops sorted', () => {
    const r = addStop(stops, 50);
    expect(r.index).toBe(1);
    expect(r.stops).toEqual([{ color: '#000000', position: 0 }, { color: '#808080', position: 50 }, { color: '#ffffff', position: 100 }]);
  });

  it('removes stops but keeps two', () => {
    expect(removeStop(addStop(stops, 50).stops, 1)).toEqual(stops);
    expect(removeStop(stops, 0)).toEqual(stops);
  });

  it('moves a stop past its neighbor and reports the new index', () => {
    const three = addStop(stops, 50).stops;
    const r = moveStop(three, 1, 100);
    expect(r.stops.map((s) => s.position)).toEqual([0, 100, 100]);
    expect(r.stops[2]!.color).toBe('#808080');
    expect(r.index).toBe(2);
  });

  it('mixes colors with alpha', () => {
    expect(mixColors('rgba(0, 0, 0, 0)', '#000000', 0.5)).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('converts between types keeping the stops', () => {
    const lin = { ...newGradient('linear', '#336699') } as Extract<Fill, { type: 'linear' }>;
    const rad = convertFill(lin, 'radial');
    expect(rad.type).toBe('radial');
    expect(rad.type === 'radial' && rad.stops).toEqual(lin.stops);
    expect(convertFill(lin, 'solid')).toEqual({ type: 'solid', color: '#336699' });
    expect(convertFill({ type: 'solid', color: '#abc' }, 'linear')).toMatchObject({ type: 'linear', stops: [{ color: '#abc' }, { color: 'rgba(170, 187, 204, 0)' }] });
  });
});

describe('agent specs produce the same CSS as the UI', () => {
  it('maps set_fill specs to fills and back', () => {
    const fills = [
      { type: 'linear', angle: 135, stops: [{ color: '#ff6a00', position: 0 }, { color: '#ee0979', position: 100 }] },
      { type: 'radial', at: 'top left', stops: [{ color: '#fff' }, { color: '#000' }] },
      { type: 'image', asset_id: 'abc', size: 'cover' },
      { type: 'solid', color: 'rgba(0,0,0,0.5)' },
    ].map((s, i) => fillFromSpec(s, i));
    expect(css(fills)).toEqual({
      background: null,
      'background-image': 'linear-gradient(135deg, #ff6a00 0%, #ee0979 100%), radial-gradient(circle at top left, #fff, #000), url(asset://abc)',
      'background-color': 'rgba(0,0,0,0.5)',
      'background-size': 'cover',
      'background-position': null,
      'background-repeat': null,
    });
    expect(fills.map(fillToSpec)[0]).toEqual({ type: 'linear', angle: 135, stops: [{ color: '#ff6a00', position: 0 }, { color: '#ee0979', position: 100 }] });
    expect(layerCss(fills[0]!)).toBe('linear-gradient(135deg, #ff6a00 0%, #ee0979 100%)');
  });

  it('says what to fix', () => {
    expect(() => fillFromSpec({ type: 'linear', stops: [{ color: 'red' }] })).toThrow(FillError);
    expect(() => fillFromSpec({ type: 'solid', color: 'linear-gradient(red, blue)' })).toThrow(/gradient fill/);
    expect(() => fillFromSpec({ type: 'image', url: 'https://example.com/a.png' })).toThrow(/asset_id/);
    expect(() => fillFromSpec({ type: 'blob' })).toThrow(/solid.*linear.*radial.*image/);
    expect(() => fillFromSpec({ type: 'linear', stops: [{ color: 'red', position: 120 }, { color: 'blue' }] })).toThrow(/0 to 100/);
  });
});
