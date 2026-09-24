import { render } from '@testing-library/react';

import { ChatSurface } from '../src/lib';
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
});
