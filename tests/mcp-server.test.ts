// @vitest-environment node

import type { AddressInfo } from 'node:net';

import { startDemoMcp } from '../server/demo-mcp';
import { createChatServer } from '../server/index';
import { McpRegistry } from '../server/mcp';
import { buildCsp, createSandboxServer } from '../server/sandbox-server';

describe('MCP backend', () => {
  it('keeps ordinary mock chat working with MCP disabled', async () => {
    const registry = new McpRegistry([]);
    const server = createChatServer(registry);
    await listen(server);
    try {
      const origin = serverOrigin(server);
      expect(await fetch(`${origin}/api/health`).then((response) => response.json())).toMatchObject({ ok: true, mode: 'mock', mcp: false });
      const response = await fetch(`${origin}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
      });
      const text = (await response.text()).trim().split('\n').map((line) => JSON.parse(line).text ?? '').join('');
      expect(text).toContain('mock mode');
    } finally {
      await close(server);
    }
  });

  it('discovers and executes a real Streamable HTTP fixture, including its app resource', async () => {
    const fixture = startDemoMcp(0);
    await listening(fixture);
    const registry = new McpRegistry([{ id: 'demo', url: `${serverOrigin(fixture)}/mcp` }]);
    try {
      const tools = await registry.discover();
      expect(tools.map((tool) => tool.remoteName)).toEqual(['show-counter', 'fail-action']);
      const source = tools.find((tool) => tool.remoteName === 'show-counter')!;
      expect(source.app?.resourceUri).toBe('ui://agent-widget-demo/counter.html');

      const result = await registry.callModelTool(source, { label: 'Real fixture', value: 4 });
      expect(result.structuredContent).toEqual({ label: 'Real fixture', value: 4 });

      const resource = await registry.readAppResource(source.app!.capabilityId);
      expect(resource.html).toContain('Increment via MCP');
      expect(resource.appTools).toEqual(expect.arrayContaining(['show-counter', 'increment-counter', 'fail-action']));

      const incremented = await registry.callAppTool(source.app!.capabilityId, 'increment-counter', { label: 'Real fixture', value: 4 });
      expect(incremented.structuredContent).toEqual({ label: 'Real fixture', value: 5 });
      const failed = await registry.callAppTool(source.app!.capabilityId, 'fail-action', {});
      expect(failed).toMatchObject({ isError: true });
      const modelFailure = tools.find((tool) => tool.remoteName === 'fail-action')!;
      await expect(registry.callModelTool(modelFailure, {})).rejects.toThrow('Intentional demo failure');
      await expect(registry.callAppTool(source.app!.capabilityId, 'not-discovered', {})).rejects.toThrow('not allowed');
      await expect(registry.readAppResource('browser-chosen-resource')).rejects.toThrow('Unknown MCP App capability');
    } finally {
      await registry.close();
      await close(fixture);
    }
  });
});

describe('MCP sandbox security', () => {
  it('builds restrictive CSP from validated declarations and rejects raw directives', () => {
    const value = buildCsp('https://widget.example', {
      connectDomains: ['https://api.example'],
      resourceDomains: ['https://cdn.example'],
    });
    expect(value).toContain("default-src 'none'");
    expect(value).toContain('connect-src https://api.example');
    expect(value).toContain('script-src \'unsafe-inline\' https://cdn.example');
    expect(value).toContain("frame-src 'none'");
    expect(() => buildCsp('https://widget.example', { resourceDomains: ["https://safe.example; frame-src *"] })).toThrow('Unsafe CSP domain');
  });

  it('requires an allowed exact host origin and matching referrer', async () => {
    const sandbox = createSandboxServer(new Set(['https://widget.example']));
    await listen(sandbox);
    try {
      const base = serverOrigin(sandbox);
      const valid = await fetch(`${base}/sandbox?hostOrigin=${encodeURIComponent('https://widget.example')}`, {
        headers: { referer: 'https://widget.example/chat' },
      });
      expect(valid.status).toBe(200);
      expect(valid.headers.get('content-security-policy')).toContain('frame-ancestors https://widget.example');

      const wrongSource = await fetch(`${base}/sandbox?hostOrigin=${encodeURIComponent('https://widget.example')}`, {
        headers: { referer: 'https://attacker.example/' },
      });
      expect(wrongSource.status).toBe(403);
      const lookalike = await fetch(`${base}/sandbox?hostOrigin=${encodeURIComponent('https://widget.example.evil.test')}`, {
        headers: { referer: 'https://widget.example.evil.test/' },
      });
      expect(lookalike.status).toBe(403);
    } finally {
      await close(sandbox);
    }
  });
});

function serverOrigin(server: { address(): string | AddressInfo | null }) {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function listen(server: { listen(port: number, host: string, callback: () => void): unknown }) {
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function listening(server: { listening: boolean; once(event: 'listening', callback: () => void): unknown }) {
  return server.listening ? Promise.resolve() : new Promise<void>((resolve) => server.once('listening', resolve));
}

function close(server: { close(callback: (error?: Error) => void): unknown }) {
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
