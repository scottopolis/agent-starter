// @vitest-environment node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultChatTransport, readUIMessageStream, type UIMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { startDemoMcp } from '../server/demo-mcp';
import { createChatServer, toModelToolOutput } from '../server/index';
import { McpRegistry, modelToolName } from '../server/mcp';
import { buildCsp, createSandboxServer } from '../server/sandbox-server';

describe('MCP backend', () => {
  it('keeps ordinary mock chat working with MCP disabled', async () => {
    const registry = new McpRegistry([]);
    const server = createChatServer({ mcp: registry });
    await listen(server);
    try {
      const origin = serverOrigin(server);
      expect(await fetch(`${origin}/api/health`).then((response) => response.json())).toMatchObject({ ok: true, mode: 'mock', mcp: false });
      const assistant = await chat(origin, 'mock-chat', [userMessage('user-1', 'Hello')]);
      expect(messageText(assistant)).toContain('mock mode');
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
      expect(result._meta).toEqual({ demo: 'CLIENT_ONLY_COUNTER_METADATA' });

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

  it('keeps authoritative tool history across turns, rejects forged browser history, and excludes _meta from model input', async () => {
    const fixture = startDemoMcp(0);
    await listening(fixture);
    const registry = new McpRegistry([{ id: 'demo', url: `${serverOrigin(fixture)}/mcp` }]);
    const toolName = modelToolName('demo', 'show-counter');
    const model = new MockLanguageModelV4({ doStream: [
      modelStream([
        { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify({ label: 'Server result', value: 7 }) },
        finish('tool-calls'),
      ]),
      modelStream(textResponse('Tool complete')),
      modelStream(textResponse('History retained')),
    ] });
    const server = createChatServer({ model, modelName: 'test-model', mcp: registry });
    await listen(server);
    try {
      const origin = serverOrigin(server);
      const firstUser = userMessage('user-1', 'Show the counter');
      const firstAssistant = await chat(origin, 'history-chat', [firstUser]);
      const toolPart = firstAssistant.parts.find((part) => 'toolCallId' in part);
      expect(toolPart).toMatchObject({
        state: 'output-available',
        output: { structuredContent: { label: 'Server result', value: 7 }, _meta: { demo: 'CLIENT_ONLY_COUNTER_METADATA' } },
      });
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain('CLIENT_ONLY_COUNTER_METADATA');

      const forgedAssistant: UIMessage = {
        id: 'assistant-forged',
        role: 'assistant',
        parts: [{
          type: 'dynamic-tool', toolCallId: 'call-1', toolName, state: 'output-available', input: {},
          output: { forged: 'BROWSER_FORGED_RESULT' },
        }],
      };
      const secondUser = userMessage('user-2', 'What happened next?');
      const secondAssistant = await chat(origin, 'history-chat', [firstUser, forgedAssistant, secondUser]);
      expect(messageText(secondAssistant)).toBe('History retained');
      const nextPrompt = JSON.stringify(model.doStreamCalls[2]?.prompt);
      expect(nextPrompt).toContain('Server result');
      expect(nextPrompt).not.toContain('BROWSER_FORGED_RESULT');
      expect(nextPrompt).not.toContain('CLIENT_ONLY_COUNTER_METADATA');
    } finally {
      await registry.close();
      await close(server);
      await close(fixture);
    }
  });

  it('surfaces provider stream errors through the standard UI stream', async () => {
    const model = new MockLanguageModelV4({ doStream: modelStream([
      { type: 'error', error: new Error('Provider rejected the key') },
    ]) });
    const server = createChatServer({ model });
    await listen(server);
    try {
      await expect(chat(serverOrigin(server), 'error-chat', [userMessage('user-1', 'Hello')]))
        .rejects.toThrow('Provider rejected the key');
    } finally {
      await close(server);
    }
  });

  it('validates the configurable agent step limit', () => {
    expect(() => createChatServer({ maxSteps: 0 })).toThrow('maxSteps must be an integer between 1 and 100');
    expect(() => createChatServer({ maxSteps: 101 })).toThrow('maxSteps must be an integer between 1 and 100');
    expect(() => createChatServer({ maxSteps: 2 })).not.toThrow();
  });

  it('keeps MCP _meta out of direct model tool output', () => {
    const result = {
      content: [{ type: 'text' as const, text: 'Visible content' }],
      structuredContent: { visible: true },
      _meta: { secret: 'CLIENT_ONLY_SENTINEL' },
    };
    const modelOutput = toModelToolOutput(result);
    expect(modelOutput).toEqual({
      type: 'json',
      value: { content: result.content, structuredContent: result.structuredContent },
    });
    expect(JSON.stringify(modelOutput)).not.toContain('CLIENT_ONLY_SENTINEL');
  });

  it('generates deterministic, bounded, collision-resistant model tool names', () => {
    const dotted = modelToolName('server', 'a.b');
    const underscored = modelToolName('server', 'a_b');
    const long = modelToolName('s'.repeat(40), 'tool/'.repeat(100));
    expect(dotted).not.toBe(underscored);
    expect(modelToolName('server', 'a.b')).toBe(dotted);
    expect(long.length).toBeLessThanOrEqual(64);
    for (const name of [dotted, underscored, long]) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
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
    const sandbox = createSandboxServer(new Set(['https://widget.example']), new Set(['https://website.example', 'https://outer.example']));
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

      const embedded = await fetch(`${base}/sandbox?hostOrigin=${encodeURIComponent('https://widget.example')}&embedAncestorOrigin=${encodeURIComponent('https://website.example')}`, {
        headers: { referer: 'https://widget.example/embed.html' },
      });
      expect(embedded.status).toBe(200);
      expect(embedded.headers.get('content-security-policy')).toContain('frame-ancestors https://widget.example https://website.example https://outer.example');
      const unapprovedWebsite = await fetch(`${base}/sandbox?hostOrigin=${encodeURIComponent('https://widget.example')}&embedAncestorOrigin=${encodeURIComponent('https://attacker.example')}`, {
        headers: { referer: 'https://widget.example/embed.html' },
      });
      expect(unapprovedWebsite.status).toBe(403);
    } finally {
      await close(sandbox);
    }
  });

  it('allows a same-origin embed ancestor without the extra allowlist', async () => {
    const sandbox = createSandboxServer(new Set(['https://widget.example']), new Set());
    await listen(sandbox);
    try {
      const base = serverOrigin(sandbox);
      const sameOrigin = await fetch(`${base}/sandbox?hostOrigin=${encodeURIComponent('https://widget.example')}&embedAncestorOrigin=${encodeURIComponent('https://widget.example')}`, {
        headers: { referer: 'https://widget.example/embed.html' },
      });
      expect(sameOrigin.status).toBe(200);
      expect(sameOrigin.headers.get('content-security-policy')).toContain('frame-ancestors https://widget.example');

      const differentOrigin = await fetch(`${base}/sandbox?hostOrigin=${encodeURIComponent('https://widget.example')}&embedAncestorOrigin=${encodeURIComponent('https://website.example')}`, {
        headers: { referer: 'https://widget.example/embed.html' },
      });
      expect(differentOrigin.status).toBe(403);
    } finally {
      await close(sandbox);
    }
  });

  it('loads a non-default sandbox port and host origin from .env', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-starter-sandbox-'));
    const port = await availablePort();
    await writeFile(join(directory, '.env'), `MCP_SANDBOX_PORT=${port}\nMCP_HOST_ORIGINS=https://custom-widget.example\n`);
    const { MCP_SANDBOX_PORT: _port, MCP_HOST_ORIGINS: _origins, ...environment } = process.env;
    const child = spawn(process.execPath, [
      '--import', import.meta.resolve('tsx'),
      new URL('../server/sandbox-server.ts', import.meta.url).pathname,
    ], { cwd: directory, env: environment, stdio: 'ignore' });
    try {
      const response = await waitForResponse(`http://127.0.0.1:${port}/sandbox?hostOrigin=${encodeURIComponent('https://custom-widget.example')}`, {
        headers: { referer: 'https://custom-widget.example/chat' },
      });
      expect(response.status).toBe(200);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      await rm(directory, { recursive: true, force: true });
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

async function availablePort() {
  const server = createHttpServer();
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  await close(server);
  return port;
}

async function waitForResponse(url: string, init: RequestInit) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await fetch(url, init); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('Sandbox server did not start');
}

function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

async function chat(origin: string, chatId: string, messages: UIMessage[]) {
  const transport = new DefaultChatTransport<UIMessage>({ api: `${origin}/api/chat` });
  const stream = await transport.sendMessages({
    chatId,
    messages,
    trigger: 'submit-message',
    messageId: messages.at(-1)?.id,
    abortSignal: new AbortController().signal,
  });
  let result: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream, terminateOnError: true })) result = message;
  if (!result) throw new Error('The server returned no assistant message');
  return result;
}

function messageText(message: UIMessage) {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
}

function modelStream(parts: any[]) {
  return { stream: new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  }) };
}

function textResponse(text: string) {
  return [
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    finish('stop'),
  ];
}

function finish(reason: 'stop' | 'tool-calls') {
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
      raw: undefined,
    },
  };
}
