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
    // toasts are drawn by the registry's Toaster from its toast manager, not placed as parts (see the toast tests below)
    if (name === 'toast') return;
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

describe('a toast stack exports as the Toaster with the design\'s toasts added on mount', () => {
  it('writes <Toaster> and one component that adds the toasts oldest first, with the title, description and action of each', async () => {
    const { out } = await exportExample('nova', DISPLAY_ENTRIES['toast']!.example);
    expect(out.ui?.components).toContain('toast');
    expect(out.code).toContain('import { Toaster, useToastManager } from "@/components/ui/toast";');
    expect(out.code).toContain('import { useEffect } from "react";');
    expect(out.code).toMatch(/<Toaster>\s*\{\/\*[^]*?\*\/\}\s*<DesignToasts \/>\s*<\/Toaster>/);
    const adds = [...out.code.matchAll(/toasts\.add\(\{ (.*?) \}\),/g)].map((m) => m[1]!);
    expect(adds).toEqual([
      'title: "File uploaded", description: "report-q4.pdf is ready.", timeout: 0',
      'title: "Invite sent", description: "We emailed Sam a link.", timeout: 0',
      'title: "Event created", description: "Sunday, December 03, 2023", actionProps: { children: "Undo" }, timeout: 0',
    ]);
    expect(out.code).not.toMatch(/<Toast(Viewport|Provider|Content)?\b/);
  });

  it('says that the hovered state is the Toaster\'s own', async () => {
    const { out } = await exportExample('nova', DISPLAY_ENTRIES['toast']!.example.replace('<ds-toast-viewport>', '<ds-toast-viewport expanded>'));
    expect(out.ui?.warnings.join('\n')).toMatch(/opens it when the pointer is over it/);
  });

  it('falls back to the inline layers for a toast outside a viewport', async () => {
    const { out } = await exportExample('nova', '<ds-toast><ds-toast-content><ds-toast-title>Alone</ds-toast-title></ds-toast-content></ds-toast>');
    expect(out.ui?.fallbacks.map((f) => f.reason).join('\n')).toMatch(/inside a toast viewport/);
    expect(out.code).not.toContain('<Toaster');
  });
});
