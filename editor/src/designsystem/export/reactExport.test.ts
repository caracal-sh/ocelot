// @vitest-environment jsdom
// The React export of a document that has a design system: tokens come from <Name>.css, not from an inline copy on the root.
import { describe, expect, it } from 'vitest';
import { Editor } from '../../editor/Editor';
import { exportReact } from '../../export/react';
import { createDesignSystem, setArtboardSchemeOps } from '../apply';
import { registryCssVars } from './css';

function setup() {
  const editor = new Editor();
  const doc = editor.doc;
  const artboard = doc.artboardIds()[0]!;
  editor.agent.insertNodes(artboard, [{ type: 'text', tag: 'h1', text: 'Hello', styles: { color: 'var(--foreground)', 'font-family': 'var(--font-heading)' } }]);
  return { editor, doc, artboard };
}

describe('exportReact with a design system', () => {
  it('moves the tokens to the stylesheet and keeps the root free of them', () => {
    const { editor, doc, artboard } = setup();
    createDesignSystem(doc, editor.agent, { name: 'Acme', radius: 'large' });
    const ds = doc.designSystem()!;
    const out = exportReact(doc, artboard);
    expect(out.code).not.toContain('--primary');
    expect(out.code).not.toContain('--radius');
    expect(out.code).toContain('var(--foreground)');
    expect(out.code).not.toContain('"dark ');
    expect(out.code).toContain('Needs ./');
    expect(out.code).toContain('"Acme" design system');
    const css = out.css!.text;
    expect(css).toContain(`--primary: ${registryCssVars(ds).light.primary};`);
    expect(css).toContain('--radius: 0.875rem;');
    expect(css).toContain('.dark {');
    expect(css).toContain('@import "@fontsource-variable/geist";');
    // The theme aliases still map the theme tokens onto the design system's variables.
    expect(css).toContain('--theme-color-ink: var(--foreground);');
    expect(css.indexOf('@import')).toBeLessThan(css.indexOf('@theme inline'));
  });

  it('puts a dark artboard in the dark token set with the dark class', () => {
    const { editor, doc, artboard } = setup();
    createDesignSystem(doc, editor.agent, {});
    setArtboardSchemeOps(doc, editor.agent, artboard, 'dark');
    const out = exportReact(doc, artboard);
    expect(out.code).toMatch(/className="[^"]*\bdark\b/);
    expect(out.code).not.toContain('--background:');
  });

  it('keeps a root override of a token', () => {
    const { editor, doc, artboard } = setup();
    createDesignSystem(doc, editor.agent, {});
    editor.agent.updateStyles(artboard, { '--primary': 'hotpink' });
    expect(exportReact(doc, artboard).code).toContain('--primary:hotpink');
  });

  it('is unchanged for a document without a design system', () => {
    const { doc, artboard } = setup();
    const out = exportReact(doc, artboard);
    expect(out.css).toBeUndefined();
    expect(out.code).not.toContain('design system');
  });
});
