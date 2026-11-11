// The input hashing behind `ds:specs` and the fidelity cache (scripts/ds-snapshot/inputs.mjs): what moves a group's hash and what does not.
import { describe, expect, it } from 'vitest';
import { partitionCatalog } from '../scripts/ds-snapshot/inputs.mjs';

const FILES = [
  { file: 'a.mjs', lists: [{ const: 'GROUPS' }, { fn: 'more' }] },
  { file: 'b.mjs', lists: [{ blocks: 'blocky' }] },
];
const sources = (over = {}) => ({
  'a.mjs': `const row = (x) => x;
export const GROUPS = [
  { component: 'one', parts: { one: {} }, tree: row(1) },
  (() => {
    const local = 2;
    return { component: 'two', parts: { two: { local } } };
  })(),
  ...more(),
];
function more() {
  const helper = 3;
  return [{ component: 'three', n: helper }];
}`,
  'b.mjs': `export function blocky() {
  const groups = [];
  { const x = 1; groups.push({ component: 'four', x }); }
  { const y = 2; groups.push({ component: 'five', y }); }
  return groups;
}`,
  ...over,
});
const part = (over) => partitionCatalog(FILES, (f) => sources(over)[f]);

describe('partitionCatalog', () => {
  it('finds a group in an array, an IIFE, a returned array and a block', () => {
    expect([...part().slices.keys()].sort()).toEqual(['five', 'four', 'one', 'three', 'two']);
  });

  it('an edit inside one group moves that group and nothing else', () => {
    const before = part();
    const after = part({ 'a.mjs': sources()['a.mjs'].replace('tree: row(1)', 'tree: row(99)') });
    expect(after.slices.get('one')).not.toBe(before.slices.get('one'));
    for (const other of ['two', 'three', 'four', 'five']) expect(after.slices.get(other)).toBe(before.slices.get(other));
    expect(after.rest).toBe(before.rest);
  });

  it('an edit to a helper outside every group moves the shared rest (every group)', () => {
    const before = part();
    expect(part({ 'a.mjs': sources()['a.mjs'].replace('const row = (x) => x;', 'const row = (x) => [x];') }).rest).not.toBe(before.rest);
    expect(part({ 'b.mjs': sources()['b.mjs'].replace('const groups = [];', 'const groups = []; // note') }).rest).not.toBe(before.rest);
  });

  it('a group local to a block keeps the block helpers with it', () => {
    const before = part();
    const after = part({ 'b.mjs': sources()['b.mjs'].replace('const x = 1;', 'const x = 7;') });
    expect(after.slices.get('four')).not.toBe(before.slices.get('four'));
    expect(after.slices.get('five')).toBe(before.slices.get('five'));
    expect(after.rest).toBe(before.rest);
  });

  it('a component name two entries share falls back to the whole files', () => {
    const dup = part({ 'b.mjs': sources()['b.mjs'].replace("component: 'five'", "component: 'four'") });
    expect(dup.slices.has('four')).toBe(false);
    expect(dup.rest).not.toBe(part().rest);
  });
});
