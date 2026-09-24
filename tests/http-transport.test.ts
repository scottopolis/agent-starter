import { DefaultChatTransport, type UIMessage, type UIMessageChunk } from 'ai';

describe('DefaultChatTransport', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends UIMessage parts and parses the standard SSE stream', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response([
      'data: {"type":"start","messageId":"assistant-1"}\n\n',
      'data: {"type":"text-start","id":"text-1"}\n\n',
      'data: {"type":"text-delta","id":"text-1","delta":"Hi"}\n\n',
      'data: {"type":"text-end","id":"text-1"}\n\n',
      'data: {"type":"finish","finishReason":"stop"}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const transport = new DefaultChatTransport<UIMessage>({
      api: '/custom',
      headers: () => new Headers({ authorization: 'Bearer test-token' }),
    });
    const messages: UIMessage[] = [
      { id: 'assistant-tool', role: 'assistant', parts: [{
        type: 'dynamic-tool', toolCallId: 'call-1', toolName: 'lookup', state: 'output-available', input: {}, output: { found: true },
      }] },
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    ];
    const stream = await transport.sendMessages({
      chatId: 'chat-1', messages, trigger: 'submit-message', messageId: undefined, abortSignal: new AbortController().signal,
    });
    expect(await collect(stream)).toEqual(expect.arrayContaining([
      { type: 'text-delta', id: 'text-1', delta: 'Hi' },
    ]));

    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-token');
    expect(JSON.parse(init?.body as string)).toEqual({ id: 'chat-1', messages, trigger: 'submit-message' });
  });
});

async function collect(stream: ReadableStream<UIMessageChunk>) {
  const values: UIMessageChunk[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return values;
    values.push(value);
  }
}
