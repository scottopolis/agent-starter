import { act, render, screen, waitFor } from '@testing-library/react';
import type { DynamicToolUIPart } from 'ai';

import McpApp, { parseResource } from '../src/chat/McpApp';

describe('MCP App host boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects undeclared resource fields, CSP directives, and oversized tool lists', () => {
    const base = { uri: 'ui://counter/app.html', mimeType: 'text/html;profile=mcp-app', html: '<p>ok</p>', appTools: [] };
    expect(() => parseResource({ ...base, resourceUrl: 'https://attacker.example' })).toThrow('Invalid MCP App resource');
    expect(() => parseResource({ ...base, meta: { csp: { 'script-src': ['*'] } } })).toThrow('Invalid MCP App CSP');
    expect(() => parseResource({ ...base, appTools: Array.from({ length: 201 }, (_, index) => `tool-${index}`) })).toThrow('Invalid app tool list');
  });

  it('accepts initialization only from the exact sandbox frame and origin', async () => {
    stubResource();
    const part = runningPart();
    const { unmount } = render(<McpApp part={part} fallback={<div>Fallback</div>} />);
    const iframe = await screen.findByTitle('MCP App') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);

    await act(async () => {
      dispatchFrom(window, 'http://localhost:8789', initialized());
      dispatchFrom(iframe.contentWindow!, 'https://attacker.example', initialized());
    });
    expect(toolNotifications(postMessage)).toEqual([]);

    await act(async () => dispatchFrom(iframe.contentWindow!, 'http://localhost:8789', initialized()));
    await waitFor(() => expect(toolNotifications(postMessage)).toEqual([
      expect.objectContaining({ method: 'ui/notifications/tool-input', params: { arguments: { amount: 2 } } }),
    ]));
    unmount();
  });

  it('sends a final result that arrives before delayed initialization exactly once', async () => {
    stubResource();
    const { rerender, unmount } = render(<McpApp part={runningPart()} fallback={<div>Fallback</div>} />);
    const iframe = await screen.findByTitle('MCP App') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined);
    rerender(<McpApp part={completedPart()} fallback={<div>Fallback</div>} />);
    await act(async () => undefined);
    expect(toolNotifications(postMessage)).toEqual([]);

    await act(async () => dispatchFrom(iframe.contentWindow!, 'http://localhost:8789', initialized()));
    await waitFor(() => expect(toolNotifications(postMessage)).toEqual([
      expect.objectContaining({ method: 'ui/notifications/tool-input', params: { arguments: { amount: 2 } } }),
      expect.objectContaining({ method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: 'final' }] } }),
    ]));
    unmount();
  });
});

function stubResource() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    uri: 'ui://counter/app.html',
    mimeType: 'text/html;profile=mcp-app',
    html: '<p>counter</p>',
    appTools: [],
  }), { status: 200, headers: { 'content-type': 'application/json' } })));
}

function runningPart(): DynamicToolUIPart {
  return {
    type: 'dynamic-tool',
    toolCallId: 'call-1',
    toolName: 'counter',
    state: 'input-available',
    input: { amount: 2 },
    toolMetadata: { app: {
      capabilityId: 'cap-1',
      resourceUri: 'ui://counter/app.html',
      mimeType: 'text/html;profile=mcp-app',
    } },
  };
}

function completedPart(): DynamicToolUIPart {
  const running = runningPart();
  return {
    type: running.type,
    toolCallId: running.toolCallId,
    toolName: running.toolName,
    toolMetadata: running.toolMetadata,
    state: 'output-available',
    input: { amount: 2 },
    output: { content: [{ type: 'text', text: 'final' }] },
  };
}

function initialized() {
  return { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} };
}

function dispatchFrom(source: Window, origin: string, data: unknown) {
  const event = new MessageEvent('message', { data });
  Object.defineProperties(event, {
    source: { value: source },
    origin: { value: origin },
  });
  window.dispatchEvent(event);
}

function toolNotifications(postMessage: { mock: { calls: any[][] } }) {
  return postMessage.mock.calls.map((call) => call[0]).filter((message: any) =>
    message?.method === 'ui/notifications/tool-input' || message?.method === 'ui/notifications/tool-result');
}
