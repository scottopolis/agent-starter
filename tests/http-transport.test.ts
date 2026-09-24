import { HttpChatTransport } from '../src/transport/http-chat-transport';

describe('HttpChatTransport', () => {
  it('parses NDJSON split across network chunks', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"text-del'));
        controller.enqueue(encoder.encode('ta","text":"Hi"}\n{"type":"text-delta","text":"!"}\n'));
        controller.close();
      },
    }), { status: 200 }));
    const events = [];
    const transport = new HttpChatTransport({ endpoint: '/custom' });
    for await (const event of transport.stream({
      messages: [{ id: '1', role: 'user', content: 'hello' }],
      signal: new AbortController().signal,
    })) events.push(event);
    expect(events).toEqual([
      { type: 'text-delta', text: 'Hi' },
      { type: 'text-delta', text: '!' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/custom', expect.objectContaining({ method: 'POST' }));
  });

  it('surfaces safe server error messages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'Rate limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }));
    const iterator = new HttpChatTransport().stream({ messages: [], signal: new AbortController().signal });
    await expect(iterator.next()).rejects.toThrow('Rate limited');
  });
});
