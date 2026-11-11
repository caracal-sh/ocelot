import { describe, expect, it } from 'vitest';
import type { OcelotDocument } from '../model/document';
import { addButton, addToolbar, newDoc } from './componentsFixture';
import { buildHandoff, describeHandoff, flowsJson, folderMarkdown, type FolderLayout } from './handoff';

const brief = (doc: OcelotDocument, scope: 'document' | 'selection' = 'document', nodeIds?: string[]) =>
  buildHandoff({ doc, selection: [], currentPageId: doc.firstPageId() }, { scope, ...(nodeIds ? { nodeIds } : {}) });

/** Page holds two Buttons and a Toolbar (which contains a Button); the Library artboard holds the mains. */
function project() {
  const s = newDoc();
  const lib = s.ops.createArtboard({ name: 'Library', width: 400, height: 300 });
  const button = addButton(s.doc, s.ops, lib);
  const { toolbar } = addToolbar(s.ops, lib);
  s.ops.placeInstance('Button', s.ab, { name: 'Save', props: { label: 'Save' } });
  s.ops.placeInstance('Button', s.ab, { name: 'Plain' });
  s.ops.placeInstance('Toolbar', s.ab, { name: 'Actions' });
  const toolbarId = s.doc.componentByRef('Toolbar')!.id;
  return { ...s, lib, button, toolbar, toolbarId };
}

describe('the handoff brief lists the document components', () => {
  it('name, props with types and defaults, instance count, and where a component sits inside another', () => {
    const p = project();
    const h = brief(p.doc);
    expect(h.components.map((c) => [c.name, c.instances, c.nested_in])).toEqual([['Button', 2, ['Toolbar']], ['Toolbar', 1, []]]);
    expect(h.components[0]).toMatchObject({ id: p.button.componentId, main_id: p.button.btn });
    expect(h.components[0]!.props).toEqual([
      { name: 'label', type: 'text', default: 'Button' },
      { name: 'showIcon', type: 'boolean', default: true },
      { name: 'variant', type: 'variant', options: ['primary', 'secondary'], default: 'primary' },
    ]);
    expect(h.components[1]!.props).toEqual([]);
  });

  it('the prompt names them, says to build each once, and the steps carry code/components/', () => {
    const h = brief(project().doc);
    expect(h.prompt).toContain('Components (2):');
    expect(h.prompt).toContain('- Button: 2 instances, used inside Toolbar; props label: string = "Button", showIcon: boolean = true, variant: "primary" | "secondary" = "primary"');
    expect(h.prompt).toContain('- Toolbar: 1 instance; no props');
    expect(h.prompt).toContain('built once');
    expect(h.constraints.some((c) => c.startsWith('Document components'))).toBe(true);
    expect(h.steps.join('\n')).toContain('`code/components/` into src/components/');
    expect(describeHandoff(h)).toContain('2 components');
  });

  it('only the components the handed-off screens use are listed', () => {
    const p = project();
    // the Library screen holds mains only: an instance inside a main is not a use on the screen
    expect(brief(p.doc, 'selection', [p.lib]).components).toEqual([]);
    expect(brief(p.doc, 'selection', [p.ab]).components.map((c) => c.name)).toEqual(['Button', 'Toolbar']);
  });

  it('a component used only inside another is listed with no instances of its own', () => {
    const s = newDoc();
    const lib = s.ops.createArtboard({ name: 'Library', width: 400, height: 300 });
    addButton(s.doc, s.ops, lib);
    addToolbar(s.ops, lib);
    s.ops.placeInstance('Toolbar', s.ab, { name: 'Actions' });
    const h = brief(s.doc, 'selection', [s.ab]);
    expect(h.components.map((c) => [c.name, c.instances, c.nested_in])).toEqual([['Button', 0, ['Toolbar']], ['Toolbar', 1, []]]);
    expect(h.prompt).toContain('- Button: no instance on the screens themselves, used inside Toolbar;');
  });

  it('HANDOFF.md has a Components section with the file the export wrote; flows.json carries them', () => {
    const p = project();
    const h = brief(p.doc);
    const layout: FolderLayout = {
      code: [],
      hasRegistry: false,
      hasPrototype: false,
      hasScreenshots: false,
      components: [{ componentId: p.button.componentId, name: 'Button', file: 'components/Button.tsx' }],
    };
    const md = folderMarkdown(h, layout);
    expect(md).toContain('## Components');
    expect(md).toContain('| Component | Props | Instances | File |');
    expect(md).toContain('`variant: "primary" \\| "secondary" = "primary"`');
    expect(md).toContain('| 2 (inside Toolbar) | `code/components/Button.tsx` |');
    expect(md).toContain('| Toolbar | none | 1 | (not exported) |');
    expect(md).toContain('`code/components/` into `src/components/`');
    const flows = JSON.parse(flowsJson(h, layout));
    expect(flows.components.map((c: { name: string; identifier: string | null; file: string | null }) => [c.name, c.identifier, c.file])).toEqual([
      ['Button', 'Button', 'code/components/Button.tsx'],
      ['Toolbar', null, null],
    ]);
  });

  it('a document without components has none of it', () => {
    const s = newDoc();
    const h = brief(s.doc);
    expect(h.components).toEqual([]);
    expect(h.prompt).not.toContain('Components (');
    expect(h.constraints.some((c) => c.startsWith('Document components'))).toBe(false);
    expect(h.steps.join('\n')).not.toContain('code/components/');
    expect(describeHandoff(h)).not.toContain('component');
    const md = folderMarkdown(h, { code: [], hasRegistry: false, hasPrototype: false, hasScreenshots: false });
    expect(md).not.toContain('## Components');
    expect(JSON.parse(flowsJson(h, { code: [], hasRegistry: false, hasPrototype: false, hasScreenshots: false })).components).toBeUndefined();
  });
});
