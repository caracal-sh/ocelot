// @vitest-environment jsdom
// P4 batch C (display & layout): the `<ds-*>` example of every new component, written with write_html's hook, exports to real imports of its
// components (no fallback markup, no warning), and the accordion's open state travels as the root's defaultValue.
import { describe, expect, it } from 'vitest';
import { Editor } from '../../editor/Editor';
import { exportReact } from '../../export/react';
import { htmlToSpecs } from '../../mcp/htmlToSpec';
import { createDesignSystem } from '../apply';
import { DISPLAY_ENTRIES } from '../components/catalogDisplay';
import { createDsHtmlHook } from '../components/expand';
import { DS_STYLES, type DsStyle } from '../model';
import { loadStyle } from '../snapshot';
import { createUiComponents } from './reactComponents';

async function exportExample(style: DsStyle, html: string) {
  const editor = new Editor();
  const doc = editor.doc;
  const artboard = doc.artboardIds()[0]!;
  createDesignSystem(doc, editor.agent, { name: 'Acme', style });
  const record = doc.designSystem()!;
  const loaded = await loadStyle(style);
  const ui = createUiComponents(record, loaded);
  const { specs } = htmlToSpecs(html, undefined, createDsHtmlHook(ui.set, record, 'light'));
  const [id] = editor.agent.insertNodes(artboard, specs);
  const out = exportReact(doc, id!, { ui });
  return { out, parts: loaded.specs.parts };
}

describe.each(['nova', 'luma'] as const satisfies readonly DsStyle[])('batch C components export with real imports (%s)', (style) => {
  it.each(Object.entries(DISPLAY_ENTRIES))('%s', async (name, entry) => {
    const { out, parts } = await exportExample(style, entry.example);
    expect(out.ui?.fallbacks, name).toEqual([]);
    expect(out.ui?.warnings, name).toEqual([]);
    for (const part of new Set([...entry.example.matchAll(/<ds-([a-z-]+)/g)].map((m) => m[1]!).filter((p) => p !== 'icon'))) {
      expect(out.code, `${name}: ${part}`).toContain(`<${parts[part]!.fn}`);
    }
  });
});

it('every style exports an accordion with its open item as defaultValue', async () => {
  for (const style of DS_STYLES) {
    const { out } = await exportExample(style, DISPLAY_ENTRIES['accordion']!.example);
    expect(out.code, style).toMatch(/<Accordion[^>]*defaultValue=\{\["item-1"\]\}/);
    expect(out.code, style).toContain('<AccordionItem value="item-2">');
    expect(out.code, style).toContain('<AccordionContent>');
  }
});
