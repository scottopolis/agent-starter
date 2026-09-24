import { ExactPostMessageTransport, parseResource } from '../src/chat/McpApp';

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
});
