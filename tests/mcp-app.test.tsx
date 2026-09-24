import { act, render, waitFor } from '@testing-library/react';

const bridgeMock = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  AppBridge: class {
    listeners = new Map<string, (...args: any[]) => void>();
    sendToolInput = vi.fn().mockResolvedValue({});
    sendToolResult = vi.fn().mockResolvedValue({});
    connect = vi.fn().mockResolvedValue({});
    close = vi.fn();
    teardownResource = vi.fn().mockResolvedValue({});
    addEventListener(name: string, listener: (...args: any[]) => void) { this.listeners.set(name, listener); }
    constructor() { bridgeMock.instances.push(this); }
  },
}));

import McpApp, { ExactPostMessageTransport, parseResource } from '../src/chat/McpApp';

describe('MCP App host boundary', () => {
  it('requires both the exact iframe source and sandbox origin', async () => {
    const target = { postMessage: vi.fn() } as unknown as Window;
    const transport = new ExactPostMessageTransport(target, 'https://sandbox.example');
    const received = vi.fn();
    transport.onmessage = received;
    await transport.start();

    const message = { jsonrpc: '2.0', method: 'ping', id: 1 };
    window.dispatchEvent(new MessageEvent('message', { data: message, source: window, origin: 'https://sandbox.example' }));
    window.dispatchEvent(new MessageEvent('message', { data: message, source: target, origin: 'https://attacker.example' }));
    expect(received).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent('message', { data: message, source: target, origin: 'https://sandbox.example' }));
    expect(received).toHaveBeenCalledOnce();
    await transport.close();
  });

  it('rejects undeclared resource fields, CSP directives, and oversized tool lists', () => {
    expect(() => parseResource({ html: '<p>ok</p>', appTools: [], resourceUrl: 'https://attacker.example' })).toThrow('Invalid MCP App resource');
    expect(() => parseResource({ html: '<p>ok</p>', appTools: [], csp: { 'script-src': ['*'] } })).toThrow('Invalid MCP App CSP');
    expect(() => parseResource({ html: '<p>ok</p>', appTools: Array.from({ length: 201 }, (_, index) => `tool-${index}`) })).toThrow('Invalid app tool list');
  });

  it('sends the latest completed tool result once after delayed initialization', async () => {
    bridgeMock.instances.length = 0;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ html: '<p>counter</p>', appTools: [] }),
    }));
    const running = {
      id: 'call-1', name: 'counter', status: 'running' as const, input: { amount: 2 },
      app: { capabilityId: 'cap-1', resourceUri: 'ui://counter/app.html', mimeType: 'text/html;profile=mcp-app' as const },
    };
    const { rerender } = render(<McpApp tool={running} />);
    await waitFor(() => expect(bridgeMock.instances).toHaveLength(1));
    const bridge = bridgeMock.instances[0];

    rerender(<McpApp tool={{ ...running, status: 'complete', output: { content: [{ type: 'text', text: 'final' }] } }} />);
    await act(async () => { bridge.listeners.get('initialized')(); });

    expect(bridge.sendToolInput).toHaveBeenCalledOnce();
    expect(bridge.sendToolInput).toHaveBeenCalledWith({ arguments: { amount: 2 } });
    expect(bridge.sendToolResult).toHaveBeenCalledOnce();
    expect(bridge.sendToolResult).toHaveBeenCalledWith({ content: [{ type: 'text', text: 'final' }] });
    vi.unstubAllGlobals();
  });
});
