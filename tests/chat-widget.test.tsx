import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

import { ChatSurface, ChatWidget } from '../src/lib';

describe('ChatWidget', () => {
  it('submits a prompt supplied by an embed parent', async () => {
    const transport = sequence(() => textChunks('Parent prompt received'));
    render(<ChatWidget transport={transport} requestedPrompt={{ id: 'prompt-1', text: 'Help from the host' }} />);
    expect(await screen.findByText('Help from the host')).toBeInTheDocument();
    expect(await screen.findByText('Parent prompt received')).toBeInTheDocument();
  });

  it('does not replay a consumed host prompt after reset but sends a new prompt id', async () => {
    let calls = 0;
    const transport = sequence(() => {
      calls += 1;
      return textChunks(`Response ${calls}`);
    });
    const { rerender } = render(
      <ChatWidget transport={transport} requestedPrompt={{ id: 'prompt-1', text: 'First host prompt' }} />,
    );
    expect(await screen.findByText('Response 1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start a new chat' }));
    await waitFor(() => expect(screen.queryByText('First host prompt')).not.toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);

    rerender(<ChatWidget transport={transport} requestedPrompt={{ id: 'prompt-2', text: 'Second host prompt' }} />);
    expect(await screen.findByText('Response 2')).toBeInTheDocument();
    expect(calls).toBe(2);
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

  it('treats a null custom tool render as suppression without leaking the fallback', () => {
    render(
      <ChatSurface
        messages={[toolMessage()]}
        status="ready"
        actions={surfaceActions()}
        renderTool={() => null}
      />,
    );
    expect(screen.queryByText('Account Lookup')).not.toBeInTheDocument();
    expect(screen.queryByText(/found/)).not.toBeInTheDocument();
    expect(document.querySelector('.message-row--assistant')).toBeNull();
  });

  it('renders host status and controls around the composer and keeps user text literal', () => {
    render(
      <ChatSurface
        messages={[{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '<b>literal</b>' }] }]}
        status="ready"
        actions={surfaceActions()}
        statusContent={<div>Restoring conversation…</div>}
        beforeComposer={<button type="button">Run browser action</button>}
      />,
    );
    expect(screen.getByText('<b>literal</b>')).toBeInTheDocument();
    expect(document.querySelector('.message-bubble--user b')).toBeNull();
    expect(screen.getByText('Restoring conversation…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run browser action' })).toBeInTheDocument();
  });

  it('does not submit Enter while an IME composition is active', () => {
    const sendMessage = vi.fn();
    render(<ChatSurface messages={[]} status="ready" actions={surfaceActions({ sendMessage })} />);
    const composer = screen.getByLabelText('Message');
    fireEvent.change(composer, { target: { value: '変換中' } });
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(composer).toHaveValue('変換中');
  });

  it('uses an independent labelled composer id for each mounted surface', () => {
    render(
      <>
        <ChatSurface messages={[]} status="ready" actions={surfaceActions()} />
        <ChatSurface messages={[]} status="ready" actions={surfaceActions()} />
      </>,
    );
    const composers = screen.getAllByLabelText('Message');
    const labels = screen.getAllByText('Message');
    expect(composers).toHaveLength(2);
    expect(composers[0].id).not.toBe(composers[1].id);
    expect(labels[0]).toHaveAttribute('for', composers[0].id);
    expect(labels[1]).toHaveAttribute('for', composers[1].id);
  });

  it('shows progress after a submitted user message unless host status content replaces it', () => {
    const message: UIMessage = { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Waiting' }] };
    const { rerender } = render(<ChatSurface messages={[message]} status="submitted" actions={surfaceActions()} />);
    expect(screen.getByRole('status', { name: 'Assistant is responding' })).toBeInTheDocument();
    rerender(<ChatSurface messages={[message]} status="submitted" actions={surfaceActions()} statusContent={null} />);
    expect(screen.queryByRole('status', { name: 'Assistant is responding' })).not.toBeInTheDocument();
    rerender(<ChatSurface messages={[message]} status="submitted" actions={surfaceActions()} statusContent={<div role="status">Recovering</div>} />);
    expect(screen.getByRole('status')).toHaveTextContent('Recovering');
  });

  it('restores a rejected draft, releases the submit lock, and permits a successful retry', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    render(<ChatSurface messages={[]} status="ready" actions={surfaceActions({ sendMessage })} />);
    const composer = screen.getByLabelText('Message');
    await userEvent.type(composer, 'Retry this{enter}');
    await waitFor(() => expect(composer).toHaveValue('Retry this'));
    await userEvent.type(composer, '{enter}');
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenNthCalledWith(2, { text: 'Retry this' });
    expect(composer).toHaveValue('');
  });

  it('does not force follow-scroll after the reader scrolls away from the end', () => {
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    const { rerender } = render(<ChatSurface messages={[]} status="ready" actions={surfaceActions()} />);
    const viewport = screen.getByLabelText('Conversation messages');
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 0 },
    });
    fireEvent.scroll(viewport);
    const callsBeforeUpdate = scrollTo.mock.calls.length;
    rerender(<ChatSurface messages={[{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Older' }] }]} status="ready" actions={surfaceActions()} />);
    expect(scrollTo).toHaveBeenCalledTimes(callsBeforeUpdate);
    scrollTo.mockRestore();
  });

  it('shows a tool approval request and sends the decision before continuing', async () => {
    const requests: UIMessage[][] = [];
    let calls = 0;
    const transport = sequence(({ messages }) => {
      requests.push(messages);
      calls += 1;
      if (calls === 1) return [
        { type: 'start', messageId: 'assistant-approval' },
        {
          type: 'tool-input-available', toolCallId: 'refund-1', toolName: 'issue_demo_refund',
          input: { amount: 25, recipient: 'Alex' }, dynamic: true,
        },
        {
          type: 'tool-approval-request', toolCallId: 'refund-1', approvalId: 'approval-1',
          reason: 'Issuing a refund requires approval.',
        },
        { type: 'finish', finishReason: 'tool-calls' },
      ];
      return [
        { type: 'start', messageId: 'assistant-approval' },
        { type: 'tool-output-available', toolCallId: 'refund-1', output: { status: 'simulated' } },
        { type: 'text-start', id: 'text-approval' },
        { type: 'text-delta', id: 'text-approval', delta: 'Refund completed' },
        { type: 'text-end', id: 'text-approval' },
        { type: 'finish', finishReason: 'stop' },
      ];
    });
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Refund Alex $25{enter}');
    expect(await screen.findByRole('region', { name: 'Issue Demo Refund approval' })).toHaveTextContent('Issuing a refund requires approval.');
    expect(screen.getByText(/"amount": 25/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls).toBe(2));
    const responsePart = requests[1].at(-1)?.parts.find((part) => isApprovalPart(part));
    expect(responsePart).toMatchObject({
      state: 'approval-responded',
      approval: { id: 'approval-1', approved: true },
    });
    expect(await screen.findByText('Refund completed')).toBeInTheDocument();
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

function isApprovalPart(part: UIMessage['parts'][number]) {
  return 'state' in part && part.state === 'approval-responded';
}

function toolMessage(): UIMessage {
  return {
    id: 'assistant-tool',
    role: 'assistant',
    parts: [{
      type: 'dynamic-tool',
      toolCallId: 'tool-1',
      toolName: 'account_lookup',
      state: 'output-available',
      input: { accountId: 'secret' },
      output: { found: true },
    }],
  };
}

function surfaceActions(overrides: Partial<Parameters<typeof ChatSurface>[0]['actions']> = {}) {
  return {
    sendMessage: vi.fn(),
    stop: vi.fn(),
    regenerate: vi.fn(),
    addToolApprovalResponse: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
