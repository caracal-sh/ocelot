import { describe, expect, it } from 'vitest';
import { composeBorder, parseBorder } from './StyleSections';

describe('border shorthand', () => {
  it('parses width, style and color in any order', () => {
    expect(parseBorder('1px solid #e5e5e5')).toEqual({ width: '1px', style: 'solid', color: '#e5e5e5' });
    expect(parseBorder('dashed 2px rgba(0, 0, 0, 0.2)')).toEqual({ width: '2px', style: 'dashed', color: 'rgba(0, 0, 0, 0.2)' });
    expect(parseBorder('2px solid')).toEqual({ width: '2px', style: 'solid', color: '' });
  });

  it('falls back to the raw field for anything it cannot split', () => {
    expect(parseBorder('1px solid red blue')).toBeNull();
    expect(parseBorder('var(--b) var(--c) 1px solid')).toBeNull();
    expect(parseBorder('')).toBeNull();
  });

  it('composes with defaults', () => {
    expect(composeBorder({ width: '', style: '', color: '#000' })).toBe('1px solid #000');
    expect(composeBorder({ width: '3px', style: 'dotted', color: '' })).toBe('3px dotted');
  });
});
