import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

import { ChatWidget } from '../src/chat/ChatWidget';

describe('ChatWidget', () => {
  it('submits a prompt supplied by an embed parent', async () => {
    const transport = sequence(() => textChunks('Parent prompt received'));
    render(<ChatWidget transport={transport} requestedPrompt={{ id: 'prompt-1', text: 'Help from the host' }} />);
    expect(await screen.findByText('Help from the host')).toBeInTheDocument();
    expect(await screen.findByText('Parent prompt received')).toBeInTheDocument();
  });

  it('streams Markdown and keeps raw HTML inert', async () => {
    const transport = sequence(() => textChunks('**Safe** [link](https://example.com) <script>alert(1)</script>'));
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Hello{enter}');
    expect(await screen.findByText('Safe')).toHaveTextContent('Safe');
    expect(screen.getByRole('link', { name: 'link' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>/)).toBeInTheDocument();
  });

  it('aborts a response from the stop control', async () => {
    let aborted = false;
    const transport = pendingTransport((signal) => { aborted = signal.aborted; });
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Wait{enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop response' }));
    await waitFor(() => expect(aborted).toBe(true));
    expect(await screen.findByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('removes an empty stopped response before sending the next message', async () => {
    const requests: string[][] = [];
    let calls = 0;
    const transport = sequence(({ messages, abortSignal }) => {
      requests.push(messages.map(messageText));
      calls += 1;
      if (calls === 1) return pendingStream(signalOrDefault(abortSignal));
      return chunkStream(textChunks('Second response'));
    });
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'First{enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop response' }));
    await screen.findByRole('button', { name: 'Send message' });
    await userEvent.type(screen.getByLabelText('Message'), 'Second{enter}');
    expect(await screen.findByText('Second response')).toBeInTheDocument();
    expect(requests).toEqual([['First'], ['First', 'Second']]);
  });

  it('keeps a draft when Enter is pressed while streaming', async () => {
    render(<ChatWidget transport={pendingTransport()} />);
    const composer = screen.getByLabelText('Message');
    await userEvent.type(composer, 'Active{enter}');
    await screen.findByRole('button', { name: 'Stop response' });
    await userEvent.type(composer, 'Keep this{enter}');
    expect(composer).toHaveValue('Keep this');
  });

  it('accepts only one synchronous form submission', async () => {
    let calls = 0;
    const transport = pendingTransport(() => { calls += 1; });
    const { container } = render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Only once');
    const form = container.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toBe(1));
  });

  it('preserves a standard tool-only assistant message', async () => {
    const transport = sequence(() => [
      { type: 'start', messageId: 'assistant-1' },
      { type: 'tool-input-available', toolCallId: 'tool-1', toolName: 'account_lookup', input: {}, dynamic: true },
      { type: 'tool-output-available', toolCallId: 'tool-1', output: { found: true }, dynamic: true },
      { type: 'finish', finishReason: 'stop' },
    ]);
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Find it{enter}');
    expect(await screen.findByText('Account Lookup')).toBeInTheDocument();
  });

  it('ignores an old stream settling after reset while a new stream is active', async () => {
    const oldStream = deferred<UIMessageChunk[]>();
    const newStream = deferred<UIMessageChunk[]>();
    let calls = 0;
    const transport = sequence(({ abortSignal }) => delayedStream(calls++ === 0 ? oldStream.promise : newStream.promise, signalOrDefault(abortSignal)));
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Old{enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Start a new chat' }));
    await userEvent.type(screen.getByLabelText('Message'), 'New{enter}');
    await act(async () => oldStream.resolve(textChunks('Stale response')));
    expect(screen.queryByText('Stale response')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeInTheDocument();
    await act(async () => newStream.resolve(textChunks('Fresh response')));
    expect(await screen.findByText('Fresh response')).toBeInTheDocument();
  });

  it('shows an error and retries the same conversation', async () => {
    let attempts = 0;
    const transport = sequence(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('Temporary failure');
      return textChunks('Recovered');
    });
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Retry me{enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary failure');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Recovered')).toBeInTheDocument();
    expect(attempts).toBe(2);
    expect(screen.getAllByText('Retry me')).toHaveLength(1);
  });
});

type SendOptions = Parameters<ChatTransport<UIMessage>['sendMessages']>[0];

function sequence(factory: (options: SendOptions) => UIMessageChunk[] | ReadableStream<UIMessageChunk>): ChatTransport<UIMessage> {
  return {
    async sendMessages(options) {
      const value = factory(options);
      return value instanceof ReadableStream ? value : chunkStream(value);
    },
    async reconnectToStream() { return null; },
  };
}

function pendingTransport(onAbort?: (signal: AbortSignal) => void) {
  return sequence(({ abortSignal }) => {
    const signal = signalOrDefault(abortSignal);
    onAbort?.(signal);
    signal.addEventListener('abort', () => onAbort?.(signal), { once: true });
    return pendingStream(signal);
  });
}

function signalOrDefault(signal?: AbortSignal) {
  return signal ?? new AbortController().signal;
}

function pendingStream(signal: AbortSignal) {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: 'start', messageId: crypto.randomUUID() });
      signal.addEventListener('abort', () => controller.close(), { once: true });
    },
  });
}

function delayedStream(promise: Promise<UIMessageChunk[]>, signal: AbortSignal) {
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const chunks = await promise;
      if (signal.aborted) return;
      chunks.forEach(chunk => controller.enqueue(chunk));
      controller.close();
    },
  });
}

function textChunks(text: string): UIMessageChunk[] {
  return [
    { type: 'start', messageId: crypto.randomUUID() },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: 'stop' },
  ];
}

function chunkStream(chunks: UIMessageChunk[]) {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(chunk));
      controller.close();
    },
  });
}

function messageText(message: UIMessage) {
  return message.parts.filter(part => part.type === 'text').map(part => part.text).join('');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
