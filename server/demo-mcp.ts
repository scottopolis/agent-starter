import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const resourceUri = 'ui://agent-widget-demo/counter.html';

export function createDemoMcpServer() {
  const server = new McpServer({ name: 'Agent Widget MCP Apps Demo', version: '1.0.0' });

  registerAppTool(server, 'show-counter', {
    title: 'Show counter',
    description: 'Shows an interactive counter. Use this for MCP Apps demo requests.',
    inputSchema: z.object({ label: z.string().default('Demo counter'), value: z.number().int().default(0) }),
    _meta: { ui: { resourceUri, visibility: ['model', 'app'] } },
  }, async ({ label, value }) => ({
    content: [{ type: 'text', text: `${label}: ${value}` }],
    structuredContent: { label, value },
  }));

  registerAppTool(server, 'increment-counter', {
    title: 'Increment counter',
    description: 'Increments the demo counter from the interactive app.',
    inputSchema: z.object({ label: z.string(), value: z.number().int() }),
    _meta: { ui: { resourceUri, visibility: ['app'] } },
  }, async ({ label, value }) => ({
    content: [{ type: 'text', text: `${label}: ${value + 1}` }],
    structuredContent: { label, value: value + 1 },
  }));

  registerAppTool(server, 'fail-action', {
    title: 'Fail action',
    description: 'Demonstrates an MCP tool error for host error handling.',
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri, visibility: ['model', 'app'] } },
  }, async () => ({
    content: [{ type: 'text', text: 'Intentional demo failure' }],
    isError: true,
  }));

  registerAppResource(server, 'Counter app', resourceUri, {
    description: 'Interactive counter used by the starter local MCP demo.',
    mimeType: RESOURCE_MIME_TYPE,
  }, async () => ({
    contents: [{
      uri: resourceUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: demoAppHtml(),
      _meta: { ui: { prefersBorder: true } },
    }],
  }));
  return server;
}

export function startDemoMcp(port = Number.parseInt(process.env.DEMO_MCP_PORT || '8790', 10)) {
  const app = createMcpExpressApp({ host: '0.0.0.0' });
  app.all('/mcp', async (request: Request, response: Response) => {
    const server = createDemoMcpServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.once('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  return app.listen(port, '0.0.0.0', () => console.log(`Demo MCP server listening on http://0.0.0.0:${port}/mcp`));
}

function demoAppHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{font-family:ui-sans-serif,system-ui,sans-serif;color:#173b33;background:#f5faf7}
  *{box-sizing:border-box}body{margin:0;padding:16px}.card{padding:18px;border:1px solid #cfe3db;border-radius:16px;background:#fff;box-shadow:0 8px 24px #173b3312}
  .eyebrow{margin:0 0 7px;color:#59736b;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}h2{margin:0;font-size:17px}.value{margin:14px 0;font-size:38px;font-weight:750;line-height:1}
  button{padding:9px 13px;border:0;border-radius:10px;color:#fff;background:#173b33;font:600 13px inherit;cursor:pointer}button:disabled{opacity:.55}.status{margin:9px 0 0;color:#65766f;font-size:11px}
</style></head><body><main class="card"><p class="eyebrow">Live MCP App</p><h2 id="label">Loading counter…</h2><div class="value" id="value">—</div><button id="increment" disabled>Increment via MCP</button><p class="status" id="status">Connecting securely…</p></main>
<script>
(() => {
  let id = 1, state = { label: 'Demo counter', value: 0 }, initialized = false;
  const pending = new Map();
  const send = message => parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const request = (method, params) => new Promise((resolve, reject) => { const requestId = id++; pending.set(requestId, { resolve, reject }); send({ id: requestId, method, params }); });
  const render = () => { document.querySelector('#label').textContent = state.label; document.querySelector('#value').textContent = String(state.value); document.querySelector('#increment').disabled = !initialized; requestAnimationFrame(() => send({ method: 'ui/notifications/size-changed', params: { width: document.body.scrollWidth, height: document.body.scrollHeight } })); };
  const applyResult = result => { if (result?.structuredContent) state = result.structuredContent; document.querySelector('#status').textContent = result?.isError ? 'Tool returned an error' : 'Result delivered by the MCP server'; render(); };
  window.addEventListener('message', event => {
    if (event.source !== parent || !event.data || event.data.jsonrpc !== '2.0') return;
    const message = event.data;
    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) { const callback = pending.get(message.id); if (!callback) return; pending.delete(message.id); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result); return; }
    if (message.method === 'ui/notifications/tool-input') { state = message.params.arguments; render(); }
    if (message.method === 'ui/notifications/tool-result') applyResult(message.params);
    if (message.method === 'ui/resource-teardown') send({ id: message.id, result: {} });
  });
  document.querySelector('#increment').addEventListener('click', async () => {
    const button = document.querySelector('#increment'); button.disabled = true; document.querySelector('#status').textContent = 'Calling app-only MCP tool…';
    try { applyResult(await request('tools/call', { name: 'increment-counter', arguments: state })); } catch { document.querySelector('#status').textContent = 'Tool call failed'; button.disabled = false; }
  });
  request('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Starter counter', version: '1.0.0' }, appCapabilities: {} }).then(() => { initialized = true; send({ method: 'ui/notifications/initialized', params: {} }); render(); });
})();
</script></body></html>`;
}

const entryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (entryPoint === import.meta.url) startDemoMcp();
