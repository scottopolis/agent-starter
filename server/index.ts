import { createOpenAI } from '@ai-sdk/openai';
import { config } from 'dotenv';
import {
  ToolLoopAgent,
  createAgentUIStreamResponse,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  jsonSchema,
  tool,
  type JSONValue,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
} from 'ai';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import { McpRegistry, parseMcpConfig, type DiscoveredTool } from './mcp.js';

const maxBodyBytes = 256_000;
const defaultInstructions = 'You are a concise, friendly product assistant. Use Markdown when it improves readability. Use the available MCP tools when relevant.';

export type ChatServerOptions = Readonly<{
  model?: LanguageModel;
  modelName?: string;
  maxSteps?: number;
  instructions?: string;
  mcp?: McpRegistry;
}>;

type ChatRequest = Readonly<{
  id: string;
  messages: UIMessage[];
  trigger: 'submit-message' | 'regenerate-message';
  messageId?: string;
}>;

export function createChatServer({
  model,
  modelName = model ? 'custom' : 'mock',
  maxSteps = 5,
  instructions = defaultInstructions,
  mcp = new McpRegistry([]),
}: ChatServerOptions = {}) {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) {
    throw new Error('maxSteps must be an integer between 1 and 100');
  }
  const conversations = new Map<string, UIMessage[]>();

  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/health') {
      json(response, 200, { ok: true, mode: model ? 'provider' : 'mock', model: modelName, mcp: mcp.enabled });
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

      const chatRequest = parseChatRequest(await readJson(request));
      const messages = authoritativeMessages(chatRequest, conversations.get(chatRequest.id));
      conversations.set(chatRequest.id, messages);
      const discovered = mcp.enabled ? await mcp.discover() : [];
      const webResponse = model
        ? await providerResponse({ model, instructions, maxSteps, messages, discovered, mcp, signal: disconnect.signal, persist: save })
        : mockResponse({ messages, discovered, mcp, signal: disconnect.signal, persist: save });
      await sendWebResponse(response, webResponse);

      function save(next: UIMessage[]) {
        conversations.set(chatRequest.id, next.slice(-100));
      }
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

async function providerResponse({
  model,
  instructions,
  maxSteps,
  messages,
  discovered,
  mcp,
  signal,
  persist,
}: {
  model: LanguageModel;
  instructions: string;
  maxSteps: number;
  messages: UIMessage[];
  discovered: DiscoveredTool[];
  mcp: McpRegistry;
  signal: AbortSignal;
  persist: (messages: UIMessage[]) => void;
}) {
  const tools = createTools(discovered, mcp);
  const agent = new ToolLoopAgent({ model, instructions, tools, stopWhen: isStepCount(maxSteps) });
  return createAgentUIStreamResponse({
    agent,
    uiMessages: messages,
    abortSignal: signal,
    onEnd: ({ messages: next }) => persist(next),
    onError: safeError,
  });
}

function createTools(discovered: DiscoveredTool[], mcp: McpRegistry): ToolSet {
  return Object.fromEntries(discovered.map((item) => [item.modelName, tool({
    description: item.description,
    inputSchema: jsonSchema(item.inputSchema),
    metadata: {
      clientName: item.serverId,
      toolName: item.remoteName,
      ...(item.app ? { app: { ...item.app, visibility: ['model', 'app'] } } : {}),
    },
    execute: (input, { abortSignal }) => mcp.callModelTool(item, input, abortSignal),
    toModelOutput: ({ output }) => toModelToolOutput(output as CallToolResult),
  })]));
}

function mockResponse({
  messages,
  discovered,
  mcp,
  signal,
  persist,
}: {
  messages: UIMessage[];
  discovered: DiscoveredTool[];
  mcp: McpRegistry;
  signal: AbortSignal;
  persist: (messages: UIMessage[]) => void;
}) {
  const stream = createUIMessageStream({
    originalMessages: messages,
    onEnd: ({ messages: next }) => persist(next),
    onError: safeError,
    execute: async ({ writer }) => {
      const prompt = textFromMessage(messages.at(-1));
      const demo = discovered.find((item) => item.app);
      if (demo && /\b(mcp|app|counter|interactive|demo)\b/i.test(prompt)) {
        const toolCallId = `mock-${Date.now()}`;
        const input = { label: 'MCP Apps demo', value: 3 };
        const toolMetadata = {
          clientName: demo.serverId,
          toolName: demo.remoteName,
          app: { ...demo.app!, visibility: ['model', 'app'] },
        };
        writer.write({ type: 'tool-input-available', toolCallId, toolName: demo.modelName, input, dynamic: true, toolMetadata });
        try {
          const output = await mcp.callModelTool(demo, input, signal);
          writer.write({ type: 'tool-output-available', toolCallId, output, dynamic: true, toolMetadata });
          await writeText(writer, 'Here is the interactive MCP App from the configured local server.', signal);
        } catch (error) {
          writer.write({ type: 'tool-output-error', toolCallId, errorText: safeError(error), dynamic: true, toolMetadata });
        }
        return;
      }
      await writeText(writer, mockAnswer(prompt), signal);
    },
  });
  return createUIMessageStreamResponse({ stream });
}

async function writeText(writer: Parameters<Parameters<typeof createUIMessageStream>[0]['execute']>[0]['writer'], text: string, signal: AbortSignal) {
  const id = crypto.randomUUID();
  writer.write({ type: 'text-start', id });
  for (const chunk of text.match(/[\s\S]{1,10}/g) ?? [text]) {
    if (signal.aborted) return;
    writer.write({ type: 'text-delta', id, delta: chunk });
    await new Promise((resolve) => setTimeout(resolve, 32));
  }
  writer.write({ type: 'text-end', id });
}

function authoritativeMessages(request: ChatRequest, stored: UIMessage[] = []): UIMessage[] {
  if (request.trigger === 'regenerate-message') {
    const assistantIndex = request.messageId
      ? stored.findIndex((message) => message.id === request.messageId && message.role === 'assistant')
      : lastAssistantIndex(stored);
    return assistantIndex < 0 ? stored : stored.slice(0, assistantIndex);
  }
  const incoming = request.messages.at(-1);
  if (!incoming || incoming.role !== 'user' || stored.some((message) => message.id === incoming.id)) {
    throw new RequestError(400, 'Invalid user message');
  }
  return [...stored, incoming].slice(-100);
}

function parseChatRequest(value: unknown): ChatRequest {
  if (!isRecord(value) || Object.keys(value).some((key) => !['id', 'messages', 'trigger', 'messageId'].includes(key))) {
    throw new RequestError(400, 'Invalid request');
  }
  if (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 200
    || (value.trigger !== 'submit-message' && value.trigger !== 'regenerate-message')
    || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 100
    || (value.messageId !== undefined && typeof value.messageId !== 'string')) {
    throw new RequestError(400, 'Invalid chat request');
  }
  const messages = value.messages.map(parseIncomingMessage);
  return { id: value.id, messages, trigger: value.trigger, messageId: value.messageId };
}

function parseIncomingMessage(value: unknown): UIMessage {
  if (!isRecord(value) || Object.keys(value).some((key) => !['id', 'role', 'parts', 'metadata'].includes(key))
    || typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 200
    || (value.role !== 'user' && value.role !== 'assistant') || !Array.isArray(value.parts)) {
    throw new RequestError(400, 'Invalid message');
  }
  if (value.role === 'user') {
    let length = 0;
    for (const part of value.parts) {
      if (!isRecord(part) || Object.keys(part).some((key) => !['type', 'text', 'providerMetadata', 'state'].includes(key))
        || part.type !== 'text' || typeof part.text !== 'string' || !part.text.trim()) {
        throw new RequestError(400, 'Invalid user message');
      }
      length += part.text.length;
    }
    if (length > 16_000) throw new RequestError(400, 'Invalid user message');
    return {
      id: value.id,
      role: 'user',
      parts: value.parts.map((part) => ({ type: 'text' as const, text: part.text as string })),
    };
  }
  // Assistant messages are parsed only to locate the final user message. They are
  // never used as authoritative model history; the server keeps its own copy.
  return { id: value.id, role: 'assistant', parts: [] };
}

export function toModelToolOutput(result: CallToolResult) {
  const value = JSON.parse(JSON.stringify({
    content: result.content,
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
  })) as JSONValue;
  return { type: 'json' as const, value };
}

function textFromMessage(message?: UIMessage) {
  return message?.parts.filter((part) => part.type === 'text').map((part) => part.text).join('') ?? '';
}

function mockAnswer(prompt: string) {
  if (/price|plan|cost/i.test(prompt)) {
    return `Here’s a quick overview:\n\n| Plan | Best for |\n| --- | --- |\n| **Starter** | Small teams trying the workflow |\n| **Scale** | Growing teams that need more control |\n\nThis is **mock mode**, so customize these details in \`server/index.ts\`.`;
  }
  return `Thanks for asking! I’m running in **mock mode**, so the starter works without credentials.\n\nYou can:\n- edit this response in \`server/index.ts\`\n- add an \`OPENAI_API_KEY\` for live responses\n- configure an MCP server for tools and interactive apps\n- use any AI SDK-compatible chat connection in your own frontend\n\nYou asked: “${prompt || 'How can you help?'}”`;
}

async function sendWebResponse(response: ServerResponse, webResponse: Response) {
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
  if (!webResponse.body) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done || response.destroyed) break;
    response.write(Buffer.from(value));
  }
  response.end();
}

function lastAssistantIndex(messages: UIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return index;
  }
  return -1;
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

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) {
    throw new RequestError(400, 'Invalid request');
  }
  return value;
}

function json(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...extraHeaders });
  response.end(JSON.stringify(body));
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be completed';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const entryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (entryPoint === import.meta.url) {
  config({ quiet: true });
  const port = Number.parseInt(process.env.API_PORT || '8787', 10);
  const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const model = process.env.OPENAI_API_KEY
    ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(modelName)
    : undefined;
  const registry = new McpRegistry(parseMcpConfig());
  const server = createChatServer({
    model,
    modelName,
    maxSteps: parseMaxSteps(process.env.MAX_STEPS),
    mcp: registry,
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`Chat API listening on http://0.0.0.0:${port} (${model ? modelName : 'mock'} mode, MCP ${registry.enabled ? 'enabled' : 'disabled'})`);
  });
  const shutdown = () => server.close(() => void registry.close());
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function parseMaxSteps(value?: string) {
  if (value === undefined) return 5;
  if (!/^\d+$/.test(value)) throw new Error('MAX_STEPS must be an integer between 1 and 100');
  return Number(value);
}
