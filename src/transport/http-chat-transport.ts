import type { ChatStreamEvent, ChatTransport } from '../chat/types';

export type HttpChatTransportOptions = Readonly<{
  endpoint?: string;
  getHeaders?: () => HeadersInit | Promise<HeadersInit>;
}>;

export class HttpChatTransport implements ChatTransport {
  readonly #endpoint: string;
  readonly #getHeaders?: HttpChatTransportOptions['getHeaders'];

  constructor({ endpoint = '/api/chat', getHeaders }: HttpChatTransportOptions = {}) {
    this.#endpoint = endpoint;
    this.#getHeaders = getHeaders;
  }

  async *stream({ messages, signal }: Parameters<ChatTransport['stream']>[0]) {
    const headers = new Headers(await this.#getHeaders?.());
    headers.set('content-type', 'application/json');
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      signal,
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({
        messages: messages
          .filter(({ content }) => content.trim().length > 0)
          .map(({ role, content }) => ({ role, content })),
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
      throw new Error(typeof body?.error === 'string' ? body.error : `Chat request failed (${response.status})`);
    }
    if (!response.body) throw new Error('Chat response did not include a stream');

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += value ?? '';
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          yield parseEvent(line);
        }
        if (done) break;
      }
      if (buffer.trim()) yield parseEvent(buffer);
    } finally {
      reader.releaseLock();
    }
  }
}

function parseEvent(line: string): ChatStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('The server returned an invalid stream event');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The server returned an invalid stream event');
  }
  const event = value as Record<string, unknown>;
  if (event.type === 'text-delta' && typeof event.text === 'string') {
    return { type: 'text-delta', text: event.text };
  }
  if (event.type === 'tool' && isToolDisplay(event.tool)) {
    return { type: 'tool', tool: event.tool };
  }
  throw new Error('The server returned an unknown stream event');
}

function isToolDisplay(value: unknown): value is Extract<ChatStreamEvent, { type: 'tool' }>['tool'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const tool = value as Record<string, unknown>;
  return typeof tool.id === 'string'
    && typeof tool.name === 'string'
    && (tool.status === 'running' || tool.status === 'complete' || tool.status === 'error')
    && (tool.app === undefined || isMcpAppMetadata(tool.app));
}

function isMcpAppMetadata(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const app = value as Record<string, unknown>;
  return Object.keys(app).length === 3
    && typeof app.capabilityId === 'string'
    && typeof app.resourceUri === 'string'
    && app.resourceUri.startsWith('ui://')
    && app.mimeType === 'text/html;profile=mcp-app';
}
