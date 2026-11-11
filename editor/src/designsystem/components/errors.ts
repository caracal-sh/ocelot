export type ComponentErrorCode = 'unknown_component' | 'bad_prop' | 'bad_prop_value' | 'no_slot' | 'bad_child' | 'page_exists' | 'corrupt_specs' | 'no_design_system' | 'locked';

/** A component request that cannot be generated. The message names the nearest valid values and what to do next. */
export class ComponentError extends Error {
  readonly code: ComponentErrorCode;
  constructor(code: ComponentErrorCode, message: string) {
    super(message);
    this.name = 'ComponentError';
    this.code = code;
  }
}

/** Levenshtein distance, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** The candidates closest to `value` (substring matches first), at most `n`. */
export function nearest(value: string, candidates: readonly string[], n = 3): string[] {
  const v = value.toLowerCase();
  return [...candidates]
    .map((c) => ({ c, d: c.toLowerCase().includes(v) || v.includes(c.toLowerCase()) ? 0 : distance(v, c.toLowerCase()) }))
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
    .slice(0, n)
    .map((x) => x.c);
}
