// The `ds-raw-values` check of a design-system document: layers an agent (or a person) wrote with a literal color or radius where a
// token exists. It reads the document, not the rendered page, because a computed style always resolves var() to a literal.
//
// Not flagged: custom properties (the tokens themselves), shadows and filters (components carry literal shadow colors), the artboard
// root, instances generated from components (`data-slot`: refresh_design_system_instances governs those), `transparent`, `currentColor`,
// named colors, pill radii (999px and up), 0 and percentages, and any value that already goes through var().

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
