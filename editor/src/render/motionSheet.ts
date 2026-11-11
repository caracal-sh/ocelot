// The live `<style data-ocelot-motion>` of one artboard iframe. The reconciler feeds it each
// node's states and animation references as they change; the sheet keeps per-node rule text
// and rebuilds its stylesheet text only when something changed (never per frame).

import type { OcelotDocument } from '../model/document';
import type { StateStyles, StyleMap } from '../model/types';
import { keyframesCss, nodeIdSelector, reducedMotionCss, stateRulesCss } from './motionCss';

interface NodeMotion {
  rules: string;
  /** Tokens of `animation` / `animation-name`; intersected with the defined keyframes on flush. */
  tokens: string[];
}

export class MotionSheet {
  readonly #style: HTMLStyleElement;
  readonly #doc: OcelotDocument;
  readonly #nodes = new Map<string, NodeMotion>();
  #dirty = true;
  #text = '';
  /** Final pass over the sheet text (resolves `asset://` references in state rules). */
  transform: (css: string) => string = (css) => css;

  constructor(doc: OcelotDocument, dom: Document) {
    this.#doc = doc;
    this.#style = dom.createElement('style');
    this.#style.setAttribute('data-ocelot-motion', '');
    dom.head.appendChild(this.#style);
  }

  get element(): HTMLStyleElement {
    return this.#style;
  }

  /** Cheap key; changes exactly when this node's generated rules or keyframe references can change. */
  static keyOf(styles: StyleMap, states: StateStyles): string {
    const hasStates = Object.keys(states).length > 0;
    if (!hasStates && !styles['animation'] && !styles['animation-name']) return '';
    return JSON.stringify([states, styles['animation'], styles['animation-name']]);
  }

  setNode(id: string, styles: StyleMap, states: StateStyles): void {
    const tokens: string[] = [];
    for (const v of [styles['animation'], styles['animation-name'], ...Object.values(states).flatMap((s) => (s ? [s['animation'], s['animation-name']] : []))]) {
      if (v) tokens.push(...v.split(/[\s,]+/).filter(Boolean));
    }
    this.#nodes.set(id, { rules: stateRulesCss(nodeIdSelector(id), states), tokens });
    this.#dirty = true;
  }

  removeNode(id: string): void {
    if (this.#nodes.delete(id)) this.#dirty = true;
  }

  /** Called when the document's keyframes changed. */
  invalidate(): void {
    this.#dirty = true;
  }

  /** Writes the stylesheet text if anything changed since the last flush. */
  flush(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    const known = this.#doc.keyframes;
    const used = new Set<string>();
    const parts: string[] = [];
    let animated = false;
    for (const n of this.#nodes.values()) {
      for (const t of n.tokens) if (known.has(t)) used.add(t);
      if (n.rules) {
        parts.push(n.rules);
        animated = true;
      }
    }
    const frames = [...used].sort().map((name) => keyframesCss(name, known.get(name)!));
    if (frames.length) animated = true;
    const text = this.transform([...frames, ...parts, ...(animated ? [reducedMotionCss([...used].sort().map((name) => ({ name, stops: known.get(name)! })))] : [])].join('\n'));
    if (text !== this.#text) {
      this.#text = text;
      this.#style.textContent = text;
    }
  }

  dispose(): void {
    this.#style.remove();
    this.#nodes.clear();
  }
}
