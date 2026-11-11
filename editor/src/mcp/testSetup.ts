// Shared harness for MCP tests: an editor with a blank document, a stub host
// (fake screenshots and fonts) and helpers to call tools like a client would.

import { Editor } from '../editor/Editor';
import { createBrowserHost, type Host } from '../host/host';
import { fakeImages, fakePng } from '../assets/testing';
import { bytesToBase64 } from '../assets/sniff';
import { McpServer } from './protocol';

/** A valid (tiny) PNG: screenshots of nodes can be imported as reference assets. */
const SHOT_PNG = bytesToBase64(fakePng(8, 8, 1));

export function setupMcp() {
  const editor = new Editor();
  const images = fakeImages();
  const base = createBrowserHost({ assets: images.options });
  /** HTML of every host.renderSnapshot request, in order (to assert what a screenshot would render). */
  const snapshots: string[] = [];
  const host: Host = {
    kind: 'browser',
    call: (async (method: string, params: unknown, opts: unknown) => {
      if (method === 'host.renderSnapshot') {
        const p = params as { html: string; width: number; height: number; scale: number };
        snapshots.push(p.html);
        return { png: SHOT_PNG, width: p.width * p.scale, height: p.height * p.scale, contentWidth: p.width, contentHeight: 1300 };
      }
      if (method === 'host.listFonts') return { families: ['Helvetica Neue', 'Inter', 'Menlo'] };
      return base.call(method as never, params as never, opts as never);
    }) as Host['call'],
  };
  const server = new McpServer({ editor, locks: editor.locks, host });
  let id = 0;
  const rpc = async (method: string, params?: unknown) => {
    const reply = await server.handle(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
    return JSON.parse(reply!);
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return r.result as { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
  };
  const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? '').join('\n');
  /** Calls a tool and parses its JSON text result; fails the test on tool errors. */
  const callJson = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
    return JSON.parse(textOf(r)) as Record<string, any>;
  };
  return { editor, server, host, rpc, call, callJson, textOf, snapshots, images };
}
