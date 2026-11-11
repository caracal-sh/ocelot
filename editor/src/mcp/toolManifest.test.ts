// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeResult, listTools } from './protocol';

// The `ocelot` CLI answers initialize/tools/list from a manifest generated from
// these definitions. Stale = `cd editor && bun run gen:manifest`.
describe('CLI tool manifest', () => {
  const file = readFileSync(join(__dirname, '../../../mac/OcelotCLI/Generated/ToolManifest.gen.swift'), 'utf8');
  const manifest = JSON.parse(/#"""\n([\s\S]*?)\n"""#/.exec(file)![1]!);

  it('matches the tool definitions', () => {
    expect(manifest.tools).toEqual(JSON.parse(JSON.stringify(listTools(false))));
    expect(manifest.initialize).toEqual(JSON.parse(JSON.stringify(initializeResult(''))));
  });

  it('hides write tools from read-only connections', () => {
    const names = listTools(true).map((t) => t.name);
    expect(names).toContain('get_document_info');
    expect(names).not.toContain('write_html');
  });
});
