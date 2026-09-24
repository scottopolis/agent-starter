import { render, screen, waitFor } from '@testing-library/react';
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
