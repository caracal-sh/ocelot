import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT_STACK, MONO_FONT_STACK } from './frameDocument';

// The canvas reset must use Tailwind's default fonts, or React exports render
// with a different font than the canvas on machines without SF/Segoe.
describe('canvas reset matches Tailwind defaults', () => {
  const require = createRequire(import.meta.url);
  const theme = readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8');
  const read = (name: string) => {
    const m = new RegExp(`--${name}:([^;]+);`).exec(theme);
    return m![1]!.replace(/\s+/g, ' ').trim();
  };
  const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/"/g, "'").trim();

  it('sans stack', () => expect(norm(DEFAULT_FONT_STACK)).toBe(norm(read('font-sans'))));
  it('mono stack', () => expect(norm(MONO_FONT_STACK)).toBe(norm(read('font-mono'))));
});
