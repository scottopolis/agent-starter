import { render, screen } from '@testing-library/react';

import { ChatSurface } from '../src/lib/ChatSurface';
import './reset.css';
import '../src/lib/styles.css';

describe('library styles', () => {
  it('styles controls only inside the widget root', () => {
    const { container } = render(
      <>
        <button className="send-button">Unrelated page control</button>
        <main className="agent-chat"><button className="send-button">Widget control</button></main>
      </>,
    );
    const [outside, inside] = container.querySelectorAll('button');
    expect(getComputedStyle(outside).width).not.toBe('38px');
    expect(getComputedStyle(inside).width).toBe('38px');
    expect(getComputedStyle(outside).fontFamily).not.toContain('DM Sans Variable');
  });

  it('lets embedded surfaces fill a bounded container without using viewport height', () => {
    const { container } = render(
      <div style={{ width: 420, height: 620 }}>
        <ChatSurface
          embedded
          messages={[]}
          status="ready"
          actions={{ sendMessage() {}, stop() {}, regenerate() {}, addToolApprovalResponse() {} }}
          style={{ '--agent-chat-accent': '#123456' }}
        />
      </div>,
    );
    const widget = container.querySelector('.agent-chat')!;
    expect(getComputedStyle(widget).height).toBe('var(--agent-chat-height, 100%)');
    expect(getComputedStyle(widget).height).not.toContain('svh');
    expect(getComputedStyle(widget).minHeight).toBe('0');
    expect(getComputedStyle(widget.querySelector('.chat-card')!).height).toBe('100%');
    expect(getComputedStyle(widget).getPropertyValue('--agent-chat-accent')).toBe('#123456');
  });

  it('preserves Markdown structure and literal newlines under a CSS reset', () => {
    const actions = { sendMessage() {}, stop() {}, regenerate() {}, addToolApprovalResponse() {} };
    render(
      <>
        <ChatSurface
          messages={[
            { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'First line\nSecond line' }] },
            { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: '# Heading\n\n- Bullet\n\n1. Numbered' }] },
          ]}
          status="ready"
          actions={actions}
        />
        <ChatSurface messages={[]} status="ready" actions={actions} welcome={'Welcome line\nSecond line'} />
      </>,
    );
    const heading = screen.getByRole('heading', { name: 'Heading' });
    expect(getComputedStyle(heading).fontSize).toBe('2em');
    expect(getComputedStyle(heading).fontWeight).toBe('700');
    const lists = screen.getAllByRole('list');
    expect(getComputedStyle(lists[0]).listStyleType).toBe('disc');
    expect(getComputedStyle(lists[1]).listStyleType).toBe('decimal');
    expect(getComputedStyle(screen.getByText(/First line/)).whiteSpace).toBe('pre-wrap');
    expect(getComputedStyle(screen.getByText(/Welcome line/)).whiteSpace).toBe('pre-wrap');
  });
});
