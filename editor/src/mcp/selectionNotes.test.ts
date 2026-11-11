// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { setupMcp } from './testSetup';

describe('get_selection and notes pinned to layers', () => {
  it('lists the pending notes with exact ids, also when nothing is selected', async () => {
    const { editor, call, textOf } = setupMcp();
    const ab = editor.doc.artboardIds()[0]!;
    const [hero] = editor.human.insertNodes(ab, [{ type: 'frame', name: 'Hero' }]) as [string];
    expect(textOf(await call('get_selection'))).not.toMatch(/Ask the agent about this/);
    editor.references.add(editor.doc, [hero], 'make the headline bolder');
    const text = textOf(await call('get_selection'));
    expect(text).toMatch(/Nothing is selected/);
    expect(text).toContain(`"Hero" (frame, id ${hero})`);
    expect(text).toContain('Note: "make the headline bolder"');
    editor.references.clear();
    expect(textOf(await call('get_selection'))).not.toContain('Note:');
  });
});
