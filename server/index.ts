import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from 'ai';
import { config } from 'dotenv';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import { McpRegistry, parseMcpConfig, type DiscoveredTool } from './mcp.js';

config({ quiet: true });

const maxBodyBytes = 256_000;
const registry = new McpRegistry(parseMcpConfig());

export function createChatServer(mcp = registry) {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/health') {
      json(response, 200, {
        ok: true,
        mode: process.env.OPENAI_API_KEY ? 'openai' : 'mock',
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        mcp: mcp.enabled,
      });
      return;
    }

    const disconnect = new AbortController();
    const abort = () => disconnect.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      if (request.method === 'POST' && request.url === '/api/mcp/apps/resource') {
        const body = exactObject(await readJson(request), ['capabilityId']);
        if (typeof body.capabilityId !== 'string') throw new RequestError(400, 'Invalid capability');
        json(response, 200, await mcp.readAppResource(body.capabilityId), { 'cache-control': 'no-store' });
        return;
      }
      if (request.method === 'POST' && request.url === '/api/mcp/apps/tool') {
        const body = exactObject(await readJson(request), ['capabilityId', 'name', 'arguments']);
        if (typeof body.capabilityId !== 'string' || typeof body.name !== 'string') throw new RequestError(400, 'Invalid app tool request');
        const result = await mcp.callAppTool(body.capabilityId, body.name, body.arguments, disconnect.signal);
        json(response, 200, result, { 'cache-control': 'no-store' });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/api/chat') {
        json(response, 404, { error: 'Not found' });
        return;
      }

      const body = await readJson(request);
      const messages = parseMessages(body);
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-content-type-options': 'nosniff',
      });
      const discovered = mcp.enabled ? await mcp.discover() : [];
      if (process.env.OPENAI_API_KEY) await streamOpenAI(messages, discovered, mcp, response, disconnect.signal);
      else await streamMock(messages, discovered, mcp, response, disconnect.signal);
    } catch (error) {
      if (disconnect.signal.aborted || response.destroyed) return;
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const message = error instanceof RequestError ? error.message : 'The request could not be completed';
      json(response, error instanceof RequestError ? error.status : 400, { error: message }, { 'cache-control': 'no-store' });
    } finally {
      request.removeListener('aborted', abort);
      response.removeListener('close', abort);
    }
  });
}

async function streamOpenAI(
  messages: ModelMessage[],
  discovered: DiscoveredTool[],
  mcp: McpRegistry,
  response: ServerResponse,
  abortSignal: AbortSignal,
) {
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const byName = new Map(discovered.map((item) => [item.modelName, item]));
  const tools: ToolSet = Object.fromEntries(discovered.map((item) => [item.modelName, tool({
    description: item.description,
    inputSchema: jsonSchema(item.inputSchema),
    execute: (input, { abortSignal: toolSignal }) => mcp.callModelTool(item, input, toolSignal),
  })]));
  const result = streamText({
    model: openai(process.env.OPENAI_MODEL || 'gpt-4o-mini'),
    system: 'You are a concise, friendly product assistant. Use Markdown when it improves readability. Use the available MCP tools when relevant.',
    messages,
    tools,
    stopWhen: stepCountIs(5),
    abortSignal,
  });
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') writeEvent(response, { type: 'text-delta', text: part.text });
    else if (part.type === 'tool-call') {
      const definition = byName.get(part.toolName);
      writeEvent(response, { type: 'tool', tool: toolDisplay(part.toolCallId, part.toolName, 'running', part.input, undefined, definition) });
    } else if (part.type === 'tool-result') {
      const definition = byName.get(part.toolName);
      writeEvent(response, { type: 'tool', tool: toolDisplay(part.toolCallId, part.toolName, 'complete', part.input, part.output, definition) });
    } else if (part.type === 'tool-error') {
      const definition = byName.get(part.toolName);
      writeEvent(response, { type: 'tool', tool: toolDisplay(part.toolCallId, part.toolName, 'error', part.input, { message: safeError(part.error) }, definition) });
    }
  }
  response.end();
}

async function streamMock(
  messages: ModelMessage[],
  discovered: DiscoveredTool[],
  mcp: McpRegistry,
  response: ServerResponse,
  signal: AbortSignal,
) {
  const last = messages.at(-1)?.content;
  const prompt = typeof last === 'string' ? last : '';
  const demo = discovered.find((item) => item.app);
  if (demo && /\b(mcp|app|counter|interactive|demo)\b/i.test(prompt)) {
    const id = `mock-${Date.now()}`;
    const input = { label: 'MCP Apps demo', value: 3 };
    writeEvent(response, { type: 'tool', tool: toolDisplay(id, demo.modelName, 'running', input, undefined, demo) });
    try {
      const output = await mcp.callModelTool(demo, input, signal);
      writeEvent(response, { type: 'tool', tool: toolDisplay(id, demo.modelName, 'complete', input, output, demo) });
      writeEvent(response, { type: 'text-delta', text: 'Here is the interactive MCP App from the configured local server.' });
    } catch (error) {
      writeEvent(response, { type: 'tool', tool: toolDisplay(id, demo.modelName, 'error', input, { message: safeError(error) }, demo) });
    }
    response.end();
    return;
  }
  const answer = mockAnswer(prompt);
  for (const chunk of answer.match(/[\s\S]{1,10}/g) ?? [answer]) {
    if (response.destroyed) return;
    writeEvent(response, { type: 'text-delta', text: chunk });
    await new Promise((resolve) => setTimeout(resolve, 32));
  }
  response.end();
}

function toolDisplay(
  id: string,
  name: string,
  status: 'running' | 'complete' | 'error',
  input: unknown,
  output: unknown,
  definition?: DiscoveredTool,
) {
  return { id, name, status, input, output, app: definition?.app };
}

function mockAnswer(prompt: string) {
  if (/price|plan|cost/i.test(prompt)) {
    return `Here’s a quick overview:\n\n| Plan | Best for |\n| --- | --- |\n| **Starter** | Small teams trying the workflow |\n| **Scale** | Growing teams that need more control |\n\nThis is **mock mode**, so customize these details in \`server/index.ts\`.`;
  }
  return `Thanks for asking! I’m running in **mock mode**, so the starter works without credentials.\n\nYou can:\n- edit this response in \`server/index.ts\`\n- add an \`OPENAI_API_KEY\` for live responses\n- configure an MCP server for tools and interactive apps\n- replace the HTTP transport with your own backend adapter\n\nYou asked: “${prompt || 'How can you help?'}”`;
}

function writeEvent(response: ServerResponse, event: unknown) {
  response.write(`${JSON.stringify(event)}\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new RequestError(413, 'Request body is too large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestError(400, 'Request body must be valid JSON');
  }
}

function parseMessages(value: unknown): ModelMessage[] {
  const object = exactObject(value, ['messages']);
  const { messages } = object;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100) throw new RequestError(400, 'Invalid messages');
  return messages.map((message) => {
    const item = exactObject(message, ['role', 'content']);
    const { role, content } = item;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim() || content.length > 16_000) {
      throw new RequestError(400, 'Invalid message');
    }
    return { role, content };
  });
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RequestError(400, 'Invalid request');
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) throw new RequestError(400, 'Invalid request');
  return value as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...extraHeaders });
  response.end(JSON.stringify(body));
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : 'MCP tool failed';
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const entryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (entryPoint === import.meta.url) {
  const port = Number.parseInt(process.env.API_PORT || '8787', 10);
  const server = createChatServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`Chat API listening on http://0.0.0.0:${port} (${process.env.OPENAI_API_KEY ? 'OpenAI' : 'mock'} mode, MCP ${registry.enabled ? 'enabled' : 'disabled'})`);
  });
  const shutdown = () => {
    server.close(() => void registry.close());
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
