import { ArrowUp, MessageCircle, RotateCcw, Square, X } from 'lucide-react';
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { ChatMessage, ChatTransport, ToolDisplay } from './types';
import { useChat } from './use-chat';

export type ChatWidgetProps = Readonly<{
  transport: ChatTransport;
  title?: string;
  welcome?: string;
  embedded?: boolean;
  requestedPrompt?: Readonly<{ id: string; text: string }>;
  onRequestClose?: () => void;
}>;

export function ChatWidget({
  transport,
  title = 'Your AI assistant',
  welcome = 'Hi! I’m here to help. Ask me anything about the product.',
  embedded = false,
  requestedPrompt,
  onRequestClose,
}: ChatWidgetProps) {
  const initialMessages = useMemo<ChatMessage[]>(() => [], []);
  const chat = useChat(transport, initialMessages);
  const [draft, setDraft] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const handledPromptRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
  }, [chat.messages]);

  useEffect(() => {
    if (!requestedPrompt || handledPromptRef.current === requestedPrompt.id || chat.status === 'streaming') return;
    handledPromptRef.current = requestedPrompt.id;
    chat.send(requestedPrompt.text);
  }, [chat, requestedPrompt]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (chat.status === 'streaming' || !draft.trim()) return;
    chat.send(draft);
    setDraft('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <main className={embedded ? 'chat-shell chat-shell--embedded' : 'chat-shell'}>
      <section className="chat-card" aria-label={title}>
        <header className="chat-header">
          <div className="brand-mark"><MessageCircle aria-hidden="true" /></div>
          <div><h1>{title}</h1><p><span className="status-dot" /> Online</p></div>
          <div className="header-actions">
            <button type="button" onClick={chat.reset} aria-label="Start a new chat" title="New chat"><RotateCcw /></button>
            {onRequestClose && <button type="button" onClick={onRequestClose} aria-label="Close chat"><X /></button>}
          </div>
        </header>

        <div className="message-viewport" ref={viewportRef} aria-label="Conversation messages" aria-busy={chat.status === 'streaming'}>
          {chat.messages.length === 0 && (
            <div className="welcome">
              <div className="assistant-avatar">AI</div>
              <div className="message-bubble message-bubble--assistant"><p>{welcome}</p></div>
            </div>
          )}
          {chat.messages.map((message) => <Message key={message.id} message={message} />)}
          {chat.status === 'streaming' && chat.messages.at(-1)?.content === '' && (
            <div className="typing" role="status" aria-label="Assistant is responding"><i /><i /><i /></div>
          )}
          {chat.error && (
            <div className="error-card" role="alert">
              <div><strong>Something went wrong</strong><p>{chat.error}</p></div>
              <button type="button" onClick={chat.retry}>Try again</button>
            </div>
          )}
        </div>

        <footer className="composer-wrap">
          <form className="composer" onSubmit={submit}>
            <label className="sr-only" htmlFor="chat-message">Message</label>
            <textarea
              id="chat-message"
              ref={composerRef}
              rows={1}
              placeholder="Ask a question…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
            />
            {chat.status === 'streaming' ? (
              <button className="send-button" type="button" onClick={chat.stop} aria-label="Stop response"><Square /></button>
            ) : (
              <button className="send-button" type="submit" disabled={!draft.trim()} aria-label="Send message"><ArrowUp /></button>
            )}
          </form>
          <p>AI can make mistakes. Check important information.</p>
        </footer>
      </section>
    </main>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return <div className="message-row message-row--user"><div className="message-bubble message-bubble--user"><p>{message.content}</p></div></div>;
  }
  return (
    <div className="message-row message-row--assistant">
      <div className="assistant-avatar">AI</div>
      <div className="assistant-stack">
        {message.content && (
          <div className="message-bubble message-bubble--assistant markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
              a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
            }}>{message.content}</ReactMarkdown>
          </div>
        )}
        {message.tools?.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
      </div>
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolDisplay }) {
  return (
    <details className="tool-card">
      <summary><span className={`tool-status tool-status--${tool.status}`} /> {humanize(tool.name)} <small>{tool.status}</small></summary>
      {tool.input !== undefined && <pre>{JSON.stringify(tool.input, null, 2)}</pre>}
      {tool.output !== undefined && <pre>{JSON.stringify(tool.output, null, 2)}</pre>}
    </details>
  );
}

function humanize(value: string) {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
