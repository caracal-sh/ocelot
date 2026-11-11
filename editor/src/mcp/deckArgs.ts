// Argument shapes shared by the deck tools (deckTools.ts) and the page tools (pageTools.ts).

import { parseTransition, readFormat } from '../model/deck';
import { TRANSITION_KINDS, type Transition } from '../model/types';
import { ToolError, type Args } from './toolkit';

export const TRANSITION_SCHEMA = {
  type: ['object', 'null'],
  properties: {
    kind: { type: 'string', enum: [...TRANSITION_KINDS], description: 'none (hard cut) | fade | push-left | push-up | zoom | dissolve.' },
    ms: { type: 'number', description: 'Length in ms (0-5000). Default 400. Typical 300-600; ignored for none.' },
  },
  required: ['kind'],
  additionalProperties: false,
  description: '{ kind, ms }, or null to clear it.',
};

/** A transition argument: `{ kind, ms }`, a bare kind name, or null (clear). Undefined when absent. */
export function transitionArg(args: Args, key = 'transition'): Transition | null | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string') return parseTransition({ kind: v }, key);
  return parseTransition(v, key);
}

export function formatArg(args: Args, key = 'format'): { width: number; height: number } | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const f = readFormat(v);
  if (!f) throw new ToolError(`${key} must be { width, height } in pixels, each 16-16000, e.g. { "width": 1920, "height": 1080 }.`);
  return f;
}
