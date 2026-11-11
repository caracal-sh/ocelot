import { describe, expect, it, vi } from 'vitest';
import { BridgeError, RpcClient, RpcServer } from './rpc';
import type { EditorMethods, HostMethods } from './schema.gen';
import { createBrowserHost, editorEndpoint, installEditorEndpoint } from '../host/host';


function pair() {
  const server = new RpcServer<HostMethods>();
  const client = new RpcClient<HostMethods>((json) => server.dispatch(json));
  return { server, client };
}

describe('rpc', () => {
  it('round-trips a typed call', async () => {
    const { server, client } = pair();
    server.register('host.ping', ({ message }) => ({ message: `pong:${message}`, from: 'test', version: '1', receivedAt: 1 }));
    await expect(client.call('host.ping', { message: 'hi' })).resolves.toEqual({
      message: 'pong:hi',
      from: 'test',
      version: '1',
      receivedAt: 1,
    });
  });

  it('propagates BridgeError code, message and data', async () => {
    const { server, client } = pair();
    server.register('host.ping', () => {
      throw new BridgeError('invalid_params', 'bad message', { field: 'message' });
    });
    const err = await client.call('host.ping', { message: '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err).toMatchObject({ code: 'invalid_params', message: 'bad message', data: { field: 'message' } });
  });

  it('maps plain exceptions to "internal"', async () => {
    const { server, client } = pair();
    server.register('host.ping', () => {
      throw new Error('boom');
    });
    await expect(client.call('host.ping', { message: '' })).rejects.toMatchObject({ code: 'internal', message: 'boom' });
  });

  it('reports unknown methods with the list of known ones', async () => {
    const { server, client } = pair();
    server.register('host.log', () => ({}));
    await expect(client.call('host.ping', { message: '' })).rejects.toMatchObject({
      code: 'unknown_method',
      message: expect.stringContaining('host.log'),
    });
  });

  it('times out when the transport never answers', async () => {
    vi.useFakeTimers();
    try {
      const client = new RpcClient<HostMethods>(() => new Promise<string>(() => {}));
      const p = client.call('host.ping', { message: '' }, { timeoutMs: 50 });
      const assertion = expect(p).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps transport failures to "host_unavailable"', async () => {
    const client = new RpcClient<HostMethods>(() => Promise.reject(new Error('handler gone')));
    await expect(client.call('host.ping', { message: '' })).rejects.toMatchObject({ code: 'host_unavailable' });
  });

  it('rejects responses with a mismatched id', async () => {
    const client = new RpcClient<HostMethods>(async () => JSON.stringify({ v: 1, id: 'other', ok: true, result: {} }));
    await expect(client.call('host.ping', { message: '' })).rejects.toMatchObject({ code: 'internal' });
  });

  it('server answers malformed JSON with an error envelope instead of throwing', async () => {
    const server = new RpcServer<HostMethods>();
    const res = JSON.parse(await server.dispatch('{nope'));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
  });
});

describe('host adapters', () => {
  it('browser host answers ping', async () => {
    const host = createBrowserHost();
    const res = await host.call('host.ping', { message: 'x' });
    expect(res).toMatchObject({ message: 'x', from: 'browser' });
  });

  it('editor endpoint is reachable through the installed global', async () => {
    const off = editorEndpoint.register('editor.ping', ({ message }) => ({ message, from: 'editor', version: 't', receivedAt: 0 }));
    const target: Record<string, unknown> = {};
    installEditorEndpoint(target);
    const g = target['__ocelotEditor'] as { dispatch(json: string): Promise<string> };
    const client = new RpcClient<EditorMethods>((json) => g.dispatch(json));
    await expect(client.call('editor.ping', { message: 'swift' })).resolves.toMatchObject({ message: 'swift', from: 'editor' });
    off();
  });
});
