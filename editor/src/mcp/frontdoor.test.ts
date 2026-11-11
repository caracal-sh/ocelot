// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '../editor/Editor';
import { OcelotDocument } from '../model/document';
import { decodeDocument, encodeDocument } from '../model/persistence';
import { setupMcp } from './testSetup';

describe('project id', () => {
  it('is created with the document and survives save/load', () => {
    const editor = new Editor();
    const id = editor.doc.projectId;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const file = editor.save();
    expect(file.projectId).toBe(id);
    const loaded = new Editor();
    loaded.load(JSON.parse(JSON.stringify(file)));
    expect(loaded.doc.projectId).toBe(id);
  });

  it('gives documents from before project ids one on load, without counting as an edit', () => {
    const doc = new OcelotDocument();
    doc.ops({ actor: 'system' }).createArtboard({ preset: 'desktop' });
    const legacy = JSON.parse(JSON.stringify(encodeDocument(doc)));
    expect(legacy.projectId).toBeUndefined();
    const loaded = decodeDocument(legacy);
    expect(loaded.projectId).toMatch(/^[0-9a-f-]{36}$/);
    const editor = new Editor();
    editor.replaceDocument(loaded);
    expect(editor.revision).toBe(0);
  });

  it('is reported by get_document_info', async () => {
    const { editor, callJson } = setupMcp();
    expect((await callJson('get_document_info')).project_id).toBe(editor.doc.projectId);
  });
});

describe('per-session MCP options', () => {
  it('uses the calling client for lock badges, not the last client that initialized', async () => {
    const { editor, server } = setupMcp();
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'cursor' } } }));
    const board = editor.doc.artboardIds()[0]!;
    const reply = await server.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'begin_edit', arguments: { node_ids: [board], label: 'Hero' } } }),
      { client: 'codex-mcp-client' },
    );
    expect(JSON.parse(reply!).result.isError).toBeFalsy();
    expect(editor.locks.active[0]!.agentName).toBe('Codex');
  });

  it('hides and refuses write tools on read-only connections', async () => {
    const { server } = setupMcp();
    const list = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { readOnly: true }))!);
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('get_screenshot');
    expect(names).not.toContain('update_styles');
    const call = JSON.parse((await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_artboard', arguments: {} } }), { readOnly: true }))!);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toMatch(/read-only/);
  });
});
