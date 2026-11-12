// The checks of a design-system document, read from the document, not the rendered page:
//
// `ds-raw-values`: layers an agent (or a person) wrote with a literal color or radius where a token exists (a computed style always
// resolves var() to a literal, so the page cannot tell). Not flagged: custom properties (the tokens themselves), shadows and filters
// (components carry literal shadow colors), the artboard root, instances generated from components (`data-slot`:
// refresh_design_system_instances governs those), `transparent`, `currentColor`, named colors, pill radii (999px and up), 0 and
// percentages, and any value that already goes through var().
//
// `ds-hand-built`: a layer drawn by hand as a component the system ships with its states and behaviour (a toast that stacks, a dialog
// that traps focus, a command menu driven by the keyboard). Found by the layer's name or ARIA role; a layer that holds an instance is a
// wrapper around the real component and is not flagged, nor are text layers or anything inside a flagged layer.

import type { Editor } from '../editor/Editor';
import type { NodeData } from '../model/types';
import { RULES, type InspectFinding } from '../inspect/rules';

const SKIPPED_PROPS = /^(--|box-shadow$|text-shadow$|filter$|backdrop-filter$|-webkit-)/;
const RADIUS_PROPS = /^(border(-(top|bottom|start|end)-(left|right|start|end))?-radius)$/;
const LITERAL_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const RADIUS_LENGTH = /(-?\d*\.?\d+)(px|rem|em)\b/g;

/** The first literal color of a declaration value that does not go through a token, else null. */
function rawColor(prop: string, value: string): string | null {
  if (value.includes('var(')) return null;
  if (/^(color|background|background-color|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?)$/.test(prop)) {
    return LITERAL_COLOR.exec(value) ? value : null;
  }
  return null;
}

/** The first radius of a declaration value that is a small literal length (not a pill, not 0, not a token), else null. */
function rawRadius(prop: string, value: string): string | null {
  if (!RADIUS_PROPS.test(prop) || value.includes('var(')) return null;
  for (const m of value.matchAll(RADIUS_LENGTH)) {
    const n = Number(m[1]);
    const px = m[2] === 'px' ? n : n * 16;
    if (px > 0 && px < 999) return value;
  }
  return null;
}

/**
 * Names and roles that say "this layer IS component X". The component word must end the name ("Delete modal", "Toasts", "Command menu"),
 * so a part or a label about one ("Toast header", "Dialog copy", "popover / popover-foreground") is not taken for it.
 */
const HAND_BUILT: ReadonlyArray<{ component: string; name: RegExp; roles?: readonly string[] }> = [
  { component: 'command', name: /(\bcommand[ -](menu|palette|bar|k)|⌘ ?k|\bcmd ?\+? ?k)$/i },
  { component: 'toast', name: /\b(toast|snackbar)s?$/i },
  { component: 'alert-dialog or dialog', name: /\b(dialog|modal)s?$/i, roles: ['dialog', 'alertdialog'] },
  { component: 'drawer', name: /\b(drawer|bottom ?sheet)s?$/i },
  { component: 'sheet', name: /\b(side ?)?sheets?$/i },
  { component: 'dropdown-menu', name: /\b((drop-?down|context|popup|overflow|actions?) menu|drop-?down)s?$/i, roles: ['menu'] },
  { component: 'popover', name: /\bpopovers?$/i },
  { component: 'tooltip', name: /\btooltips?$/i, roles: ['tooltip'] },
  { component: 'input-otp', name: /\b(otp|one[- ]time (code|password)|verification code)( input| field)?$/i },
];

/** The component a hand-drawn layer stands in for, or null. A trailing note ("Toast — success", "Dialog (open)", "Modal 2") is ignored. */
function handBuiltAs(node: NodeData): string | null {
  const head = node.name.replace(/\s*[([—–:|].*$/, '').replace(/\s+\d+$/, '');
  const role = node.attrs['role'];
  for (const h of HAND_BUILT) if (h.name.test(head) || (role !== undefined && h.roles?.includes(role))) return h.component;
  return null;
}

/** One finding for the artboard (or null): layers drawn by hand as a component the design system ships, outermost first. */
export function dsHandBuiltFinding(editor: Editor, artboardId: string): InspectFinding | null {
  const { doc } = editor;
  if (!doc.designSystem()) return null;
  const isInstance = (id: string) => {
    const a = doc.get(id)?.attrs;
    return !!a && (a['data-ds'] !== undefined || a['data-slot'] !== undefined);
  };
  const hits: Array<{ node: NodeData; component: string }> = [];
  const visit = (id: string) => {
    const node = doc.get(id);
    if (!node || isInstance(id)) return;
    const component = id !== artboardId && node.type !== 'text' ? handBuiltAs(node) : null;
    if (component && !doc.subtreeIds(id).some(isInstance)) {
      hits.push({ node, component });
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(artboardId);
  if (!hits.length) return null;
  const first = hits.slice(0, 3).map((h) => `"${h.node.name}" (use ${h.component})`).join('; ');
  const more = hits.length > 3 ? ` (+${hits.length - 3} more)` : '';
  return {
    rule_id: 'ds-hand-built',
    level: 'check',
    node_id: hits[0]!.node.id,
    name: hits[0]!.node.name,
    measured: `${hits.length} layer${hits.length === 1 ? '' : 's'} drawn by hand where the design system has the component: ${first}${more}`,
    threshold: 'insert_component or <ds-…>',
    message: RULES['ds-hand-built']!.say,
  };
}

/** One finding for the artboard (or null): how many layers carry a raw value, with the first few named. */
export function dsRawValueFinding(editor: Editor, artboardId: string): InspectFinding | null {
  const { doc } = editor;
  if (!doc.designSystem()) return null;
  const hits: Array<{ node: NodeData; what: string }> = [];
  for (const id of doc.subtreeIds(artboardId)) {
    if (id === artboardId) continue;
    const node = doc.get(id);
    if (!node || node.attrs['data-slot'] !== undefined || node.attrs['data-ds'] !== undefined) continue;
    for (const [prop, value] of Object.entries(node.styles)) {
      if (SKIPPED_PROPS.test(prop)) continue;
      const raw = rawColor(prop, value) ?? rawRadius(prop, value);
      if (raw) {
        hits.push({ node, what: `${prop} ${raw}` });
        break;
      }
    }
  }
  if (!hits.length) return null;
  const first = hits.slice(0, 3).map((h) => `"${h.node.name}" ${h.what}`).join('; ');
  const more = hits.length > 3 ? ` (+${hits.length - 3} more)` : '';
  return {
    rule_id: 'ds-raw-values',
    level: 'check',
    node_id: hits[0]!.node.id,
    name: hits[0]!.node.name,
    measured: `${hits.length} layer${hits.length === 1 ? '' : 's'} with a literal color or radius: ${first}${more}`,
    threshold: 'var(--token)',
    message: RULES['ds-raw-values']!.say,
  };
}
