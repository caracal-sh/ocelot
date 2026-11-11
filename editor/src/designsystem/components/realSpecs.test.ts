// @vitest-environment jsdom
// The runtime against the bundled snapshot specs of every style (skipped for a style whose specs are not built yet).

import { describe, expect, it } from 'vitest';
import { htmlToSpecs } from '../../mcp/htmlToSpec';
import { ORIGIN, OcelotDocument } from '../../model/document';
import type { NodeSpec } from '../../model/types';
import { createDesignSystemRecord } from '../knobs';
import { DS_STYLES, type DsStyle } from '../model';
import { buildDesignSystemPage } from '../page';
import { composePart } from '../snapshot/compose';
import { getComponent, prebuiltComponents } from './catalog';
import { createDsHtmlHook } from './expand';
import { generate } from './generate';
import { loadComponentSet, type ComponentSet } from './set';
import type { PartTemplate } from './specs';

const loaded: Array<[DsStyle, ComponentSet | null]> = await Promise.all(
  DS_STYLES.map(async (style): Promise<[DsStyle, ComponentSet | null]> => {
    const set = await loadComponentSet(style);
    return [style, Object.keys(set.specs.parts).length ? set : null];
  }),
);

/**
 * A hex colour in a declaration; transparent ring defaults (`#0000`, `#0000001a` shadows, `#000` in color-mix) are shadcn's own and not tokens,
 * and neither is the slider thumb's `bg-white` (`#fff`): white is not a theme colour.
 */
const LITERAL_HEX = /#(?!0{3,6}[0-9a-f]{0,2}\b|f{3}\b)[0-9a-f]{3,8}\b/i;

const combos = (t: PartTemplate): Array<Record<string, string>> => {
  let out: Array<Record<string, string>> = [{}];
  for (const [name, def] of Object.entries(t.props)) out = out.flatMap((o) => def.values.map((v) => ({ ...o, [name]: v })));
  return out;
};

const flat = (n: NodeSpec): NodeSpec[] => [n, ...(n.children ?? []).flatMap(flat)];

describe.each(loaded)('real specs: %s', (style, set) => {
  const record = createDesignSystemRecord({ style, pointer: false }).record;

  it.skipIf(set === null)('generate equals the snapshot composition for every prop combination and flag, light and dark', () => {
    let cells = 0;
    for (const t of Object.values(set!.specs.parts)) {
      const flagSets: string[][] = [[], ...Object.keys(t.flags).filter((f) => !f.startsWith('icon')).map((f) => [f])];
      for (const props of combos(t)) {
        for (const flags of flagSets) {
          for (const scheme of ['light', 'dark'] as const) {
            const spec = generate(set!, record, { component: t.part, props: { ...props, ...Object.fromEntries(flags.map((f) => [f, true])) } }, { scheme });
            const direct = composePart(t, scheme, props, flags).root;
            expect(spec.styles, `${t.part} ${JSON.stringify(props)} ${flags} ${scheme}`).toEqual(direct.styles);
            expect(spec.states ?? {}).toEqual(direct.states ?? {});
            cells++;
          }
        }
      }
    }
    expect(cells).toBeGreaterThan(100);
  });

  it.skipIf(set === null)('input and textarea carry their ::placeholder colour as a placeholder state (the canvas reset would otherwise win)', () => {
    for (const component of ['input', 'textarea']) {
      for (const scheme of ['light', 'dark'] as const) {
        const spec = generate(set!, record, { component, attrs: { placeholder: 'x' } }, { scheme });
        expect(spec.states?.placeholder, `${component} ${scheme}`).toEqual({ color: 'var(--muted-foreground)' });
      }
    }
  });

  it.skipIf(set === null)('every prebuilt component describes itself and its example expands', () => {
    for (const name of prebuiltComponents()) {
      const d = getComponent(name, set!);
      expect(d.partDetails.length, name).toBeGreaterThan(0);
      expect(d.example, name).toMatch(/<ds-/);
      const { specs, warnings } = htmlToSpecs(d.example, undefined, createDsHtmlHook(set!, record, 'light'));
      expect(warnings, name).toEqual([]);
      expect(specs.length, name).toBeGreaterThan(0);
      expect(JSON.stringify(specs), name).not.toMatch(LITERAL_HEX);
    }
  });

  it.skipIf(set === null)('builds the Design system page with no skipped specimens, only tokens, in light', () => {
    const doc = new OcelotDocument();
    const ops = doc.ops(ORIGIN.human);
    ops.setDesignSystem(record);
    const report = buildDesignSystemPage(doc, ops, { record, set: set! });
    expect(report.warnings).toEqual([]);
    expect(report.artboards.map((a) => a.specimen)).toEqual(expect.arrayContaining(['colour-roles', 'typography', 'radius-elevation-spacing', 'iconography', 'buttons', 'form-controls', 'cards-alerts', 'navigation', 'overlays', 'overlays-modals', 'overlays-popups', 'menus', 'data', 'dark-mode', 'disclosure', 'loading-and-people', 'lists-and-empty', 'wayfinding', 'scroll-ratio-toast', 'fields', 'choices', 'actions-extra', 'combobox-command']));
    for (const a of report.artboards) {
      for (const id of doc.subtreeIds(a.id)) {
        const n = doc.require(id);
        if (n.attrs['data-ds']) expect(JSON.stringify(n.styles), n.name).not.toMatch(LITERAL_HEX);
      }
    }
    expect(flat(doc.toSpec(doc.childIds(report.artboards[4]!.id)[0]!)).length).toBeGreaterThan(50);
  });
});
