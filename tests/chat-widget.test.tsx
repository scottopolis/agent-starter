import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { createRef } from 'react';

import { Chat, ChatSurface, ChatWidget } from '../src/lib';

describe('Chat compound components', () => {
  it('supports reordered layout, custom composer controls, native input props, refs, and submission', async () => {
    const sendMessage = vi.fn();
    const customAction = vi.fn();
    const inputRef = createRef<HTMLTextAreaElement>();
    const transcriptRef = createRef<HTMLDivElement>();
    render(
      <Chat.Root messages={[]} status="ready" actions={surfaceActions({ sendMessage })} title="Composed support chat">
        <footer className="composer-wrap">
          <Chat.Composer>
            <button type="button" onClick={customAction}>Attach context</button>
            <Chat.Input ref={inputRef} name="question" placeholder="How can we help?" />
            <Chat.Send>Send</Chat.Send>
          </Chat.Composer>
          <p>Custom disclaimer</p>
        </footer>
        <header>Custom header after the composer</header>
        <Chat.Transcript ref={transcriptRef}>
          <Chat.Empty>Custom welcome</Chat.Empty>
          <Chat.Messages />
        </Chat.Transcript>
      </Chat.Root>,
    );

    expect(screen.getByRole('region', { name: 'Composed support chat' })).toBeInTheDocument();
    expect(transcriptRef.current).toBe(screen.getByRole('log', { name: 'Conversation messages' }));
    expect(transcriptRef.current).toHaveAttribute('aria-live', 'polite');
    expect(inputRef.current).toHaveAttribute('name', 'question');
    expect(inputRef.current).toHaveAttribute('data-agent-chat-composer');
    inputRef.current?.focus();
    expect(document.activeElement).toBe(inputRef.current);

    await userEvent.click(screen.getByRole('button', { name: 'Attach context' }));
    await userEvent.type(screen.getByPlaceholderText('How can we help?'), '  Composed question  {enter}');
    expect(customAction).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({ text: 'Composed question' });
  });

  it('keeps stop cleanup and follow-scroll behavior in a composed layout', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const setMessages = vi.fn();
    const actions = surfaceActions({ stop, setMessages });
    const { rerender } = render(
      <ComposedChat messages={[]} status="streaming" actions={actions} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Stop response' }));
    expect(stop).toHaveBeenCalledOnce();
    await waitFor(() => expect(setMessages).toHaveBeenCalledOnce());
    const removeEmptyAssistant = setMessages.mock.calls[0][0];
    expect(removeEmptyAssistant([
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Question' }] },
      { id: 'assistant-1', role: 'assistant', parts: [] },
    ])).toHaveLength(1);

    const viewport = screen.getByRole('log', { name: 'Conversation messages' });
    const scrollTo = vi.spyOn(viewport, 'scrollTo');
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 0 },
    });
    fireEvent.scroll(viewport);
    rerender(
      <ComposedChat
        messages={[{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Older' }] }]}
        status="ready"
        actions={actions}
      />,
    );
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('follows appended transcript children only while the reader remains near the end', () => {
    const actions = surfaceActions();
    const messages = [assistantMessage('answer-1', 'Existing answer')];
    const { rerender } = render(
      <FollowContentChat messages={messages} actions={actions} showFooter={false} showStatus={false} />,
    );
    const viewport = screen.getByRole('log', { name: 'Conversation messages' });
    const scrollTo = vi.spyOn(viewport, 'scrollTo');

    rerender(<FollowContentChat messages={messages} actions={actions} showFooter showStatus={false} />);
    expect(screen.getByText('Suggested follow-up')).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalledOnce();

    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, value: 0 },
    });
    fireEvent.scroll(viewport);
    rerender(<FollowContentChat messages={messages} actions={actions} showFooter showStatus />);
    expect(screen.getByRole('status')).toHaveTextContent('Recovery details');
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it('honors a custom accessible transcript label', () => {
    render(
      <Chat.Root messages={[]} status="ready" actions={surfaceActions()}>
        <Chat.Transcript aria-label="Support history"><Chat.Messages /></Chat.Transcript>
      </Chat.Root>,
    );
    expect(screen.getByRole('log', { name: 'Support history' })).toBeInTheDocument();
    expect(screen.queryByRole('log', { name: 'Conversation messages' })).not.toBeInTheDocument();
  });

  it('keeps custom tool rendering authoritative in a composed transcript', () => {
    const responseFooter = vi.fn(() => <Chat.ResponseFooter>Should stay hidden</Chat.ResponseFooter>);
    render(
      <Chat.Root messages={[toolMessage()]} status="ready" actions={surfaceActions()}>
        <Chat.Transcript>
          <Chat.Messages renderTool={() => undefined}>{responseFooter}</Chat.Messages>
        </Chat.Transcript>
      </Chat.Root>,
    );
    expect(screen.queryByText('Account Lookup')).not.toBeInTheDocument();
    expect(screen.queryByText(/found/)).not.toBeInTheDocument();
    expect(screen.queryByText('Should stay hidden')).not.toBeInTheDocument();
    expect(document.querySelector('.message-row--assistant')).toBeNull();
    expect(responseFooter).not.toHaveBeenCalled();
  });

  it('associates actions and suggestions with each visible assistant response', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const messages: UIMessage[] = [
      assistantMessage('answer-1', 'First answer'),
      { id: 'user-2', role: 'user', parts: [{ type: 'text', text: 'Follow-up' }] },
      assistantMessage('answer-2', 'Second answer'),
      assistantMessage('answer-without-suggestions', 'No suggestions here'),
    ];
    const suggestions: Record<string, Array<{ label: string; prompt: string }>> = {
      'answer-1': [{ label: 'Compare plans', prompt: 'Compare the plans in a table' }],
      'answer-2': [{ label: 'Show an example', prompt: 'Show me a complete example' }],
    };
    render(
      <Chat.Root messages={messages} status="ready" actions={surfaceActions({ sendMessage })}>
        <Chat.Transcript>
          <Chat.Messages>
            {(message) => suggestions[message.id] ? (
              <Chat.ResponseFooter data-for-message={message.id}>
                <div className="response-actions" aria-label={`Actions for ${message.id}`}>
                  <button type="button">Copy</button>
                </div>
                <Chat.Suggestions>
                  {suggestions[message.id].map((suggestion) => (
                    <Chat.Suggestion key={suggestion.prompt} prompt={suggestion.prompt}>
                      {suggestion.label}
                    </Chat.Suggestion>
                  ))}
                </Chat.Suggestions>
              </Chat.ResponseFooter>
            ) : null}
          </Chat.Messages>
        </Chat.Transcript>
      </Chat.Root>,
    );

    const footers = document.querySelectorAll('.response-footer');
    expect(footers).toHaveLength(2);
    expect(footers[0]).toHaveAttribute('data-for-message', 'answer-1');
    expect(footers[1]).toHaveAttribute('data-for-message', 'answer-2');
    expect(footers[0].querySelector('.response-actions')?.compareDocumentPosition(
      footers[0].querySelector('.suggestions')!,
    )).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await userEvent.click(screen.getByRole('button', { name: 'Compare plans' }));
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({ text: 'Compare the plans in a table' });
  });

  it('prevents suggestion sends while busy and safely releases a failed send for retry', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const actions = surfaceActions({ sendMessage });
    const { rerender } = render(<SuggestedChat status="submitted" actions={actions} />);
    const suggestion = screen.getByRole('button', { name: 'Try next step' });
    expect(suggestion).toBeDisabled();
    await userEvent.click(suggestion);
    expect(sendMessage).not.toHaveBeenCalled();

    rerender(<SuggestedChat status="ready" actions={actions} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try next step' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try next step' })).toBeEnabled());
    expect(sendMessage).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Try next step' }));
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, { text: 'Continue with the next step' });
  });

  it('reactively locks every prompt control while one send is pending without showing stop', async () => {
    const pending = deferred<unknown>();
    const sendMessage = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(undefined);
    const messages = [
      assistantMessage('answer-1', 'First answer'),
      assistantMessage('answer-2', 'Second answer'),
    ];
    render(
      <Chat.Root messages={messages} status="ready" actions={surfaceActions({ sendMessage })}>
        <Chat.Transcript>
          <Chat.Messages>
            {(message) => (
              <Chat.ResponseFooter>
                <Chat.Suggestions>
                  <Chat.Suggestion prompt={`Ask about ${message.id}`}>{`Suggestion ${message.id}`}</Chat.Suggestion>
                </Chat.Suggestions>
              </Chat.ResponseFooter>
            )}
          </Chat.Messages>
        </Chat.Transcript>
        <Chat.Composer><Chat.Input /><Chat.Send /></Chat.Composer>
      </Chat.Root>,
    );
    const composer = screen.getByLabelText('Message');
    await userEvent.type(composer, 'Composer attempt');
    const suggestions = screen.getAllByRole('button', { name: /Suggestion answer-/ });

    await userEvent.click(suggestions[0]);
    await waitFor(() => suggestions.forEach((suggestion) => expect(suggestion).toBeDisabled()));
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Stop response' })).not.toBeInTheDocument();

    await userEvent.click(suggestions[1]);
    fireEvent.submit(composer.closest('form')!);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(composer).toHaveValue('Composer attempt');

    await act(async () => pending.reject(new Error('offline')));
    await waitFor(() => suggestions.forEach((suggestion) => expect(suggestion).toBeEnabled()));
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await userEvent.click(suggestions[1]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, { text: 'Ask about answer-2' });
  });
});

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

  it('targets each mounted composer through its own ref and stable data attribute', () => {
    const surfaceComposerRef = createRef<HTMLTextAreaElement>();
    const widgetComposerRef = createRef<HTMLTextAreaElement>();
    render(
      <>
        <ChatSurface messages={[]} status="ready" actions={surfaceActions()} composerRef={surfaceComposerRef} />
        <ChatWidget transport={sequence(() => textChunks('unused'))} composerRef={widgetComposerRef} />
      </>,
    );
    const composers = document.querySelectorAll<HTMLTextAreaElement>('[data-agent-chat-composer]');
    expect(composers).toHaveLength(2);
    expect(surfaceComposerRef.current).toBe(composers[0]);
    expect(widgetComposerRef.current).toBe(composers[1]);
    surfaceComposerRef.current?.focus();
    expect(document.activeElement).toBe(surfaceComposerRef.current);
    expect(document.activeElement).not.toBe(widgetComposerRef.current);
  });

  it('does not add a nested main landmark when mounted in an application main', () => {
    render(
      <main aria-label="Application content">
        <ChatSurface messages={[]} status="ready" actions={surfaceActions()} title="Support chat" />
      </main>,
    );
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Support chat' })).toBeInTheDocument();
  });

  it('exposes the conversation transcript as a polite additions-only live log', () => {
    render(<ChatSurface messages={[]} status="ready" actions={surfaceActions()} />);
    const transcript = screen.getByRole('log', { name: 'Conversation messages' });
    expect(transcript).toHaveAttribute('aria-live', 'polite');
    expect(transcript).toHaveAttribute('aria-relevant', 'additions');
    expect(transcript).toHaveAttribute('aria-busy', 'false');
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

function ComposedChat({ messages, status, actions }: {
  messages: UIMessage[];
  status: Parameters<typeof Chat.Root>[0]['status'];
  actions: Parameters<typeof Chat.Root>[0]['actions'];
}) {
  return (
    <Chat.Root messages={messages} status={status} actions={actions}>
      <Chat.Transcript><Chat.Messages /></Chat.Transcript>
      <Chat.Composer><Chat.Input /><Chat.Send /></Chat.Composer>
    </Chat.Root>
  );
}

function SuggestedChat({ status, actions }: {
  status: Parameters<typeof Chat.Root>[0]['status'];
  actions: Parameters<typeof Chat.Root>[0]['actions'];
}) {
  return (
    <Chat.Root messages={[assistantMessage('answer', 'A useful answer')]} status={status} actions={actions}>
      <Chat.Transcript>
        <Chat.Messages>
          {() => (
            <Chat.ResponseFooter>
              <Chat.Suggestions>
                <Chat.Suggestion prompt="Continue with the next step">Try next step</Chat.Suggestion>
              </Chat.Suggestions>
            </Chat.ResponseFooter>
          )}
        </Chat.Messages>
      </Chat.Transcript>
    </Chat.Root>
  );
}

function FollowContentChat({ messages, actions, showFooter, showStatus }: {
  messages: UIMessage[];
  actions: Parameters<typeof Chat.Root>[0]['actions'];
  showFooter: boolean;
  showStatus: boolean;
}) {
  return (
    <Chat.Root messages={messages} status="ready" actions={actions}>
      <Chat.Transcript>
        <Chat.Messages>
          {showFooter ? () => <Chat.ResponseFooter>Suggested follow-up</Chat.ResponseFooter> : undefined}
        </Chat.Messages>
        {showStatus && <div role="status">Recovery details</div>}
      </Chat.Transcript>
    </Chat.Root>
  );
}

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
