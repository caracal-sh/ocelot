// The Design system studio's live preview: NodeSpecs drawn straight from the data (no document, no canvas) on a stage that
// carries the design system's tokens as CSS custom properties. Hover, pressed and keyboard focus are live because the specs'
// `states` become real stylesheet rules (the same generator the canvas uses), so what the studio shows is what an artboard shows.

import { useDeferredValue, useEffect, useId, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { loadComponentSet, type ComponentSet } from '../designsystem/components/set';
import type { DesignSystemRecord, DsStyle, Scheme } from '../designsystem/model';
import { rootStyles as rootTokenStyles } from '../designsystem/tokens';
import { BUNDLED_FONT_FACE_CSS } from '../themes/fonts';
import { buildSpecimen, type SpecimenId } from './dsSpecimens';
import { stateRulesCss } from '../render/motionCss';
import type { NodeSpec, StyleMap } from '../model/types';

const VOID = new Set(['input', 'img', 'hr', 'br']);
const ATTR_NAME = /^[a-zA-Z_:][\w:.-]*$/;
/** React prop names for the HTML attributes whose spelling differs. */
const ATTR_PROP: Record<string, string> = { class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', colspan: 'colSpan', rowspan: 'rowSpan', viewbox: 'viewBox' };
const BOOLEAN_ATTR = new Set(['disabled', 'checked', 'readonly', 'required', 'hidden', 'selected', 'multiple', 'open']);
/** Stage rules a spec cannot override: the document's frame reset (Tailwind's preflight), scoped to the stage. */
export const STAGE_RESET_CSS = `
.ds-stage *, .ds-stage ::before, .ds-stage ::after { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; }
.ds-stage { line-height: 1.5; -webkit-text-size-adjust: 100%; tab-size: 4; -webkit-font-smoothing: antialiased; }
.ds-stage h1, .ds-stage h2, .ds-stage h3, .ds-stage h4, .ds-stage h5, .ds-stage h6 { font-size: inherit; font-weight: inherit; }
.ds-stage a { color: inherit; text-decoration: inherit; }
.ds-stage table { text-indent: 0; border-color: inherit; border-collapse: collapse; }
.ds-stage ol, .ds-stage ul { list-style: none; }
.ds-stage img, .ds-stage svg { display: block; vertical-align: middle; }
.ds-stage button, .ds-stage input, .ds-stage select, .ds-stage textarea { font: inherit; letter-spacing: inherit; color: inherit; border-radius: 0; background-color: transparent; opacity: 1; }
.ds-stage ::placeholder { opacity: 1; color: color-mix(in oklab, currentcolor 50%, transparent); }
.ds-stage button:not(:disabled) { cursor: default; }
`.trim();

/** `font-size` → `fontSize`, `-webkit-x` → `WebkitX`; custom properties (`--x`) pass through untouched. */
export function reactStyle(styles: StyleMap | undefined): CSSProperties {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(styles ?? {})) {
    if (key.startsWith('--')) out[key] = value;
    else out[key.replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = value;
  }
  return out as CSSProperties;
}

function reactAttrs(attrs: Record<string, string> | undefined, tag: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (!ATTR_NAME.test(name) || /^on/i.test(name) || name === 'style') continue;
    const key = name.toLowerCase();
    if (BOOLEAN_ATTR.has(key)) {
      // A spec describes a snapshot; the controls stay uncontrolled so a person can still type and tick them.
      out[key === 'checked' ? 'defaultChecked' : ATTR_PROP[key] ?? key] = value !== 'false';
    } else if (key === 'value' && (tag === 'input' || tag === 'textarea')) out['defaultValue'] = value;
    else out[ATTR_PROP[key] ?? (name.startsWith('data-') || name.startsWith('aria-') ? name : key)] = value;
  }
  return out;
}

interface Ctx {
  /** Unique per stage: state rules address nodes by `data-pv`, so two stages never collide. */
  prefix: string;
  next: number;
  rules: string[];
}

function renderNode(spec: NodeSpec, ctx: Ctx, key: string): ReactElement | null {
  if (spec.type === 'code' || spec.hidden) return null;
  const tag = spec.tag ?? (spec.type === 'text' ? 'p' : spec.type === 'image' ? 'img' : spec.type === 'svg' ? 'svg' : 'div');
  const props: Record<string, unknown> = { key, ...reactAttrs(spec.attrs, tag), style: reactStyle(spec.styles) };
  if (spec.states && Object.keys(spec.states).length) {
    const id = `${ctx.prefix}${ctx.next++}`;
    props['data-pv'] = id;
    const css = stateRulesCss(`[data-pv="${id}"]`, spec.states);
    if (css) ctx.rules.push(css);
  }
  if (spec.name) props['data-name'] = spec.name;
  if (VOID.has(tag)) return <Tag tag={tag} {...props} />;
  if (spec.type === 'svg') return <Tag tag="svg" {...props} dangerouslySetInnerHTML={{ __html: spec.html ?? '' }} />;
  if (spec.type === 'text') {
    if (spec.html) return <Tag tag={tag} {...props} dangerouslySetInnerHTML={{ __html: spec.html }} />;
    return <Tag tag={tag} {...props}>{spec.text ?? ''}</Tag>;
  }
  const kids = (spec.children ?? []).map((c, i) => renderNode(c, ctx, `${key}.${i}`));
  return <Tag tag={tag} {...props}>{spec.text ? [spec.text, ...kids] : kids}</Tag>;
}

/** A dynamic tag without a type-level union of every element name. */
function Tag({ tag, ...rest }: { tag: string } & Record<string, unknown>) {
  const El = tag as unknown as React.ElementType;
  return <El {...rest} />;
}

/** The specs as React elements plus the state rules they need (`<style>` goes next to them). */
export function renderSpecs(specs: readonly NodeSpec[], prefix: string): { nodes: Array<ReactElement | null>; css: string } {
  const ctx: Ctx = { prefix, next: 0, rules: [] };
  const nodes = specs.map((s, i) => renderNode(s, ctx, String(i)));
  return { nodes, css: ctx.rules.join('\n') };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** `fontSize` / `WebkitX` → `font-size` / `-webkit-x`; kebab-case and custom properties (`--x`) pass through. */
const kebab = (key: string): string => (key.startsWith('--') || !/[A-Z]/.test(key) ? key : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

function specElement(spec: NodeSpec): Element | null {
  if (spec.type === 'code' || spec.hidden) return null;
  const tag = spec.tag ?? (spec.type === 'text' ? 'p' : spec.type === 'image' ? 'img' : spec.type === 'svg' ? 'svg' : 'div');
  const el = tag === 'svg' ? document.createElementNS(SVG_NS, 'svg') : document.createElement(tag);
  for (const [name, value] of Object.entries(spec.attrs ?? {})) {
    if (!ATTR_NAME.test(name) || /^on/i.test(name) || name === 'style') continue;
    const key = name.toLowerCase();
    if (BOOLEAN_ATTR.has(key)) {
      if (value !== 'false') el.setAttribute(key, '');
    } else el.setAttribute(key === 'viewbox' ? 'viewBox' : name, value);
  }
  if (spec.name) el.setAttribute('data-name', spec.name);
  const style = (el as HTMLElement).style;
  for (const [key, value] of Object.entries(spec.styles ?? {})) style.setProperty(kebab(key), value);
  if (VOID.has(tag)) return el;
  if (spec.type === 'svg') el.innerHTML = spec.html ?? '';
  else if (spec.type === 'text') {
    if (spec.html) el.innerHTML = spec.html;
    else el.textContent = spec.text ?? '';
  } else {
    if (spec.text) el.append(spec.text);
    for (const child of spec.children ?? []) {
      const node = specElement(child);
      if (node) el.append(node);
    }
  }
  return el;
}

/**
 * The stage of `SpecStage` built straight as DOM, for static previews (thumbnails): same tree, tokens and attributes, but no state
 * rules, no React and no reset `<style>` (the caller puts `STAGE_RESET_CSS` on the page once). Several times cheaper than rendering
 * the same specs through React, which matters when two dozen block previews open at once.
 */
export function buildStageElement({ specs, rootStyles, scheme, layout = 'block', testId, label }: SpecStageProps): HTMLElement {
  const root = document.createElement('div');
  root.className = `ds-stage ds-stage--${layout}`;
  root.setAttribute('data-scheme', scheme);
  root.setAttribute('role', 'group');
  if (testId) root.setAttribute('data-testid', testId);
  if (label) root.setAttribute('aria-label', label);
  const style = root.style;
  style.setProperty('background-color', 'var(--background)');
  style.setProperty('color', 'var(--foreground)');
  style.setProperty('font-family', "var(--font-sans, ui-sans-serif, system-ui, sans-serif)");
  for (const [key, value] of Object.entries(rootStyles)) style.setProperty(kebab(key), value);
  for (const spec of specs) {
    const node = specElement(spec);
    if (node) root.append(node);
  }
  return root;
}

export interface SpecStageProps {
  specs: readonly NodeSpec[];
  /** The tokens (custom properties, `color-scheme`) and bindings written on the stage root: what an artboard root carries. */
  rootStyles: Readonly<Record<string, string>>;
  scheme: 'light' | 'dark';
  /** Layout of the specs inside the stage. */
  layout?: 'column' | 'center' | 'mini' | 'block';
  testId?: string;
  label?: string;
}

/**
 * The stage: tokens on its root, the specs inside. Nothing here styles the specs: the tokens are the whole input, exactly as on
 * an artboard. The scheme is baked in the specs (see plan 3.3), so switching light/dark means new specs, not a class.
 */
export function SpecStage({ specs, rootStyles, scheme, layout = 'column', testId = 'ds-preview-stage', label = 'Design system preview' }: SpecStageProps) {
  const prefix = `p${useId().replace(/[^\w]/g, '')}-`;
  const { nodes, css } = useMemo(() => renderSpecs(specs, prefix), [specs, prefix]);
  const style = useMemo<CSSProperties>(
    () => ({
      // The same four root bindings an artboard gets (background, ink, face); a token map that already binds them wins.
      backgroundColor: 'var(--background)',
      color: 'var(--foreground)',
      fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
      ...reactStyle(rootStyles as StyleMap),
    }),
    [rootStyles],
  );
  return (
    <div className={`ds-stage ds-stage--${layout}`} data-testid={testId} data-scheme={scheme} role="group" aria-label={label} style={style}>
      <style>{STAGE_RESET_CSS}</style>
      {css && <style data-testid="ds-preview-states">{css}</style>}
      {nodes}
    </div>
  );
}

/** The component set of `style` (specs are lazy: one chunk per style), or the reason it could not load. */
export function useComponentSet(style: DsStyle, enabled = true): { set: ComponentSet | null; error: string | null } {
  const [state, setState] = useState<{ style: DsStyle; set: ComponentSet | null; error: string | null }>({ style, set: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadComponentSet(style).then(
      (set) => live && setState({ style, set, error: null }),
      (err: unknown) => live && setState({ style, set: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [style, enabled]);
  // Until the new style's chunk arrives the previous one stays on stage (no flash of an empty preview); never a stale error.
  return state.style === style ? { set: state.set, error: state.error } : { set: state.set, error: null };
}

export interface DsPreviewProps {
  record: DesignSystemRecord;
  scheme: Scheme;
  specimen: SpecimenId;
}

/** The studio's live preview: the draft's tokens on a stage, a specimen of its style's components in the draft's scheme. */
export function DsPreview({ record, scheme, specimen }: DsPreviewProps) {
  // Knob and token edits are urgent, redrawing the stage is not: the controls never wait for it.
  const deferred = useDeferredValue(record);
  const { set, error } = useComponentSet(deferred.style);
  const built = useMemo(() => (set ? buildSpecimen(set, deferred, specimen, scheme) : null), [set, deferred, specimen, scheme]);
  const rootStyles = useMemo(() => rootTokenStyles(deferred, scheme), [deferred, scheme]);
  return (
    <div className="ds-preview" data-testid="ds-preview" data-specimen={specimen} data-style={deferred.style}>
      <style>{BUNDLED_FONT_FACE_CSS}</style>
      <SpecStage specs={built?.specs ?? []} rootStyles={rootStyles} scheme={scheme} label={`${deferred.name} preview, ${scheme}`} />
      {error && (
        <p className="ds-preview__note" role="status" data-testid="ds-preview-error">
          The {deferred.style} specs could not load: {error} Run bun run ds:specs, then reload the editor.
        </p>
      )}
      {built && built.problems.length > 0 && (
        <p className="ds-preview__note" role="status" data-testid="ds-preview-problems" title={built.problems.join('\n')}>
          {built.problems.length} part{built.problems.length === 1 ? ' of this specimen is' : 's of this specimen are'} missing from the {deferred.style} specs. The agent surface has the same limit (get_component).
        </p>
      )}
    </div>
  );
}
