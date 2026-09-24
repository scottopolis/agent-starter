import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type ModelMessage } from 'ai';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const port = Number.parseInt(process.env.API_PORT || '8787', 10);
const maxBodyBytes = 256_000;

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/api/health') {
    json(response, 200, { ok: true, mode: process.env.OPENAI_API_KEY ? 'openai' : 'mock' });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/api/chat') {
    json(response, 404, { error: 'Not found' });
    return;
  }

  try {
    const body = await readJson(request);
    const messages = parseMessages(body);
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-content-type-options': 'nosniff',
    });
    if (process.env.OPENAI_API_KEY) await streamOpenAI(messages, response);
    else await streamMock(messages, response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const message = error instanceof RequestError ? error.message : 'The chat request could not be completed';
    json(response, error instanceof RequestError ? error.status : 500, { error: message });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Chat API listening on http://0.0.0.0:${port} (${process.env.OPENAI_API_KEY ? 'OpenAI' : 'mock'} mode)`);
});

async function streamOpenAI(messages: ModelMessage[], response: ServerResponse) {
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const result = streamText({
    model: openai(process.env.OPENAI_MODEL || 'gpt-4o-mini'),
    system: 'You are a concise, friendly product assistant. Use Markdown when it improves readability.',
    messages,
  });
  for await (const text of result.textStream) writeEvent(response, { type: 'text-delta', text });
  response.end();
}

async function streamMock(messages: ModelMessage[], response: ServerResponse) {
  const last = messages.at(-1)?.content;
  const prompt = typeof last === 'string' ? last : '';
  const answer = mockAnswer(prompt);
  for (const chunk of answer.match(/[\s\S]{1,10}/g) ?? [answer]) {
    if (response.destroyed) return;
    writeEvent(response, { type: 'text-delta', text: chunk });
    await new Promise((resolve) => setTimeout(resolve, 32));
  }
  response.end();
}

function mockAnswer(prompt: string) {
  if (/price|plan|cost/i.test(prompt)) {
    return `Here’s a quick overview:\n\n| Plan | Best for |\n| --- | --- |\n| **Starter** | Small teams trying the workflow |\n| **Scale** | Growing teams that need more control |\n\nThis is **mock mode**, so customize these details in \`server/index.ts\`.`;
  }
  return `Thanks for asking! I’m running in **mock mode**, so the starter works without credentials.\n\nYou can:\n- edit this response in \`server/index.ts\`\n- add an \`OPENAI_API_KEY\` for live responses\n- replace the HTTP transport with your own backend adapter\n\nYou asked: “${prompt || 'How can you help?'}”`;
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RequestError(400, 'Invalid request');
  const messages = (value as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100) throw new RequestError(400, 'Invalid messages');
  return messages.map((message) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) throw new RequestError(400, 'Invalid message');
    const { role, content } = message as Record<string, unknown>;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim() || content.length > 16_000) {
      throw new RequestError(400, 'Invalid message');
    }
    return { role, content };
  });
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
