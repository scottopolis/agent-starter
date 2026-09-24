import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChatWidget } from '../src/chat/ChatWidget';
import type { ChatStreamEvent, ChatTransport } from '../src/chat/types';

describe('ChatWidget', () => {
  it('submits a prompt supplied by an embed parent', async () => {
    const transport = sequence([{ type: 'text-delta', text: 'Parent prompt received' }]);
    render(<ChatWidget transport={transport} requestedPrompt={{ id: 'prompt-1', text: 'Help from the host' }} />);
    expect(await screen.findByText('Help from the host')).toBeInTheDocument();
    expect(await screen.findByText('Parent prompt received')).toBeInTheDocument();
  });

  it('streams Markdown and keeps raw HTML inert', async () => {
    const transport = sequence([
      { type: 'text-delta', text: '**Safe** [link](https://example.com) <script>alert(1)</script>' },
    ]);
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Hello{enter}');
    expect(await screen.findByText('Safe')).toHaveTextContent('Safe');
    expect(screen.getByRole('link', { name: 'link' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>/)).toBeInTheDocument();
  });

  it('aborts a response from the stop control', async () => {
    let aborted = false;
    const transport: ChatTransport = {
      async *stream({ signal }) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        }, { once: true }));
      },
    };
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Wait{enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop response' }));
    await waitFor(() => expect(aborted).toBe(true));
    expect(await screen.findByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('removes an empty stopped response before sending the next message', async () => {
    const requests: string[][] = [];
    let calls = 0;
    const transport: ChatTransport = {
      async *stream({ messages, signal }) {
        requests.push(messages.map((message) => message.content));
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          return;
        }
        yield { type: 'text-delta', text: 'Second response' };
      },
    };
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'First{enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop response' }));
    await screen.findByRole('button', { name: 'Send message' });
    await userEvent.type(screen.getByLabelText('Message'), 'Second{enter}');
    expect(await screen.findByText('Second response')).toBeInTheDocument();
    expect(requests).toEqual([['First'], ['First', 'Second']]);
  });

  it('keeps a draft when Enter is pressed while streaming', async () => {
    const transport: ChatTransport = {
      async *stream({ signal }) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    };
    render(<ChatWidget transport={transport} />);
    const composer = screen.getByLabelText('Message');
    await userEvent.type(composer, 'Active{enter}');
    await screen.findByRole('button', { name: 'Stop response' });
    await userEvent.type(composer, 'Keep this{enter}');
    expect(composer).toHaveValue('Keep this');
  });

  it('accepts only one synchronous form submission', async () => {
    let calls = 0;
    const transport: ChatTransport = {
      async *stream({ signal }) {
        calls += 1;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    };
    const { container } = render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Only once');
    const form = container.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(calls).toBe(1);
  });

  it('preserves a tool-only assistant message', async () => {
    const transport = sequence([{
      type: 'tool',
      tool: { id: 'tool-1', name: 'account_lookup', status: 'complete', output: { found: true } },
    }]);
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Find it{enter}');
    expect(await screen.findByText('Account Lookup')).toBeInTheDocument();
  });

  it('ignores an old stream settling after reset while a new stream is active', async () => {
    const oldStream = deferred();
    const newStream = deferred();
    let calls = 0;
    const transport: ChatTransport = {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          await oldStream.promise;
          yield { type: 'text-delta', text: 'Stale response' };
          return;
        }
        await newStream.promise;
        yield { type: 'text-delta', text: 'Fresh response' };
      },
    };
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Old{enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Start a new chat' }));
    await userEvent.type(screen.getByLabelText('Message'), 'New{enter}');
    await act(() => {
      oldStream.resolve();
      return oldStream.promise;
    });
    expect(screen.queryByText('Stale response')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeInTheDocument();
    await act(() => {
      newStream.resolve();
      return newStream.promise;
    });
    expect(await screen.findByText('Fresh response')).toBeInTheDocument();
  });

  it('shows an error and retries the same conversation', async () => {
    let attempts = 0;
    const transport: ChatTransport = {
      async *stream() {
        attempts += 1;
        if (attempts === 1) throw new Error('Temporary failure');
        yield { type: 'text-delta', text: 'Recovered' };
      },
    };
    render(<ChatWidget transport={transport} />);
    await userEvent.type(screen.getByLabelText('Message'), 'Retry me{enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary failure');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Recovered')).toBeInTheDocument();
    expect(attempts).toBe(2);
    expect(screen.getAllByText('Retry me')).toHaveLength(1);
  });
});

function sequence(events: ChatStreamEvent[]): ChatTransport {
  return {
    async *stream() {
      for (const event of events) yield event;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
