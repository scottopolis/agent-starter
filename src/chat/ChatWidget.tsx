import { ArrowUp, MessageCircle, RotateCcw, Square, X } from 'lucide-react';
import { useChat } from '@ai-sdk/react';
import { FormEvent, KeyboardEvent, lazy, Suspense, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getToolName, isToolUIPart, type ChatStatus, type ChatTransport, type UIMessage } from 'ai';

const McpApp = lazy(() => import('./McpApp'));

export type ChatWidgetProps = Readonly<{
  transport: ChatTransport<UIMessage>;
  title?: string;
  welcome?: string;
  embedded?: boolean;
  embedAncestorOrigin?: string;
  requestedPrompt?: Readonly<{ id: string; text: string }>;
  onRequestClose?: () => void;
}>;

export function ChatWidget({
  transport,
  title = 'Your AI assistant',
  welcome = 'Hi! I’m here to help. Ask me anything about the product.',
  embedded = false,
  embedAncestorOrigin,
  requestedPrompt,
  onRequestClose,
}: ChatWidgetProps) {
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  return (
    <ConnectedChat
      key={conversationId}
      id={conversationId}
      transport={transport}
      title={title}
      welcome={welcome}
      embedded={embedded}
      embedAncestorOrigin={embedAncestorOrigin}
      requestedPrompt={requestedPrompt}
      onReset={() => setConversationId(crypto.randomUUID())}
      onRequestClose={onRequestClose}
    />
  );
}

function ConnectedChat({
  id,
  transport,
  title,
  welcome,
  embedded,
  embedAncestorOrigin,
  requestedPrompt,
  onReset,
  onRequestClose,
}: ChatWidgetProps & Readonly<{ id: string; onReset: () => void }>) {
  const chat = useChat({ id, transport });
  const [draft, setDraft] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const handledPromptRef = useRef<string | undefined>(undefined);
  const submitLockedRef = useRef(false);

  useEffect(() => {
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
  }, [chat.messages]);

  useEffect(() => {
    if (!requestedPrompt || handledPromptRef.current === requestedPrompt.id || isBusy(chat.status)) return;
    handledPromptRef.current = requestedPrompt.id;
    void chat.sendMessage({ text: requestedPrompt.text });
  }, [chat.sendMessage, chat.status, requestedPrompt]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (submitLockedRef.current || isBusy(chat.status) || !draft.trim()) return;
    submitLockedRef.current = true;
    void chat.sendMessage({ text: draft.trim() }).finally(() => { submitLockedRef.current = false; });
    setDraft('');
  }

  async function stopResponse() {
    await chat.stop();
    chat.setMessages((messages) => {
      const last = messages.at(-1);
      return last?.role === 'assistant' && !hasVisibleParts(last) ? messages.slice(0, -1) : messages;
    });
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
            <button type="button" onClick={onReset} aria-label="Start a new chat" title="New chat"><RotateCcw /></button>
            {onRequestClose && <button type="button" onClick={onRequestClose} aria-label="Close chat"><X /></button>}
          </div>
        </header>

        <div className="message-viewport" ref={viewportRef} aria-label="Conversation messages" aria-busy={isBusy(chat.status)}>
          {chat.messages.length === 0 && (
            <div className="welcome">
              <div className="assistant-avatar">AI</div>
              <div className="message-bubble message-bubble--assistant"><p>{welcome}</p></div>
            </div>
          )}
          {chat.messages.map((message) => <Message key={message.id} message={message} embedAncestorOrigin={embedAncestorOrigin} />)}
          {isBusy(chat.status) && !hasVisibleParts(chat.messages.at(-1)) && (
            <div className="typing" role="status" aria-label="Assistant is responding"><i /><i /><i /></div>
          )}
          {chat.error && (
            <div className="error-card" role="alert">
              <div><strong>Something went wrong</strong><p>{chat.error.message}</p></div>
              <button type="button" onClick={() => void chat.regenerate()}>Try again</button>
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
            {isBusy(chat.status) ? (
              <button className="send-button" type="button" onClick={() => void stopResponse()} aria-label="Stop response"><Square /></button>
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

function Message({ message, embedAncestorOrigin }: { message: UIMessage; embedAncestorOrigin?: string }) {
  if (message.role === 'user') {
    const text = message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
    return <div className="message-row message-row--user"><div className="message-bubble message-bubble--user"><p>{text}</p></div></div>;
  }
  return (
    <div className="message-row message-row--assistant">
      <div className="assistant-avatar">AI</div>
      <div className="assistant-stack">
        {message.parts.map((part, index) => {
          if (part.type === 'text' && part.text) {
            return (
              <div className="message-bubble message-bubble--assistant markdown" key={`${part.type}-${index}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                  a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
                }}>{part.text}</ReactMarkdown>
              </div>
            );
          }
          if (isToolUIPart(part)) return <ToolCard key={part.toolCallId} part={part} embedAncestorOrigin={embedAncestorOrigin} />;
          return null;
        })}
      </div>
    </div>
  );
}

function ToolCard({ part, embedAncestorOrigin }: {
  part: Extract<UIMessage['parts'][number], { toolCallId: string }>;
  embedAncestorOrigin?: string;
}) {
  const name = getToolName(part);
  const fallback = <ToolFallback part={part} name={name} />;
  if (part.toolMetadata?.app) {
    return (
      <Suspense fallback={<div className="mcp-app-loading" role="status">Loading interactive app…</div>}>
        <McpApp part={part} embedAncestorOrigin={embedAncestorOrigin} fallback={fallback} />
      </Suspense>
    );
  }
  return fallback;
}

function ToolFallback({ part, name }: {
  part: Extract<UIMessage['parts'][number], { toolCallId: string }>;
  name: string;
}) {
  const output = part.state === 'output-available' ? part.output : undefined;
  const error = part.state === 'output-error' ? part.errorText : undefined;
  return (
    <details className="tool-card">
      <summary><span className={`tool-status tool-status--${toolStatus(part.state)}`} /> {humanize(name)} <small>{toolStatus(part.state)}</small></summary>
      {'input' in part && part.input !== undefined && <pre>{JSON.stringify(part.input, null, 2)}</pre>}
      {output !== undefined && <pre>{JSON.stringify(output, null, 2)}</pre>}
      {error !== undefined && <pre>{error}</pre>}
    </details>
  );
}

function toolStatus(state: string) {
  if (state === 'output-available') return 'complete';
  if (state === 'output-error' || state === 'output-denied') return 'error';
  return 'running';
}

function isBusy(status: ChatStatus) {
  return status === 'submitted' || status === 'streaming';
}

function hasVisibleParts(message?: UIMessage) {
  return message?.parts.some((part) => part.type === 'text' ? Boolean(part.text) : isToolUIPart(part)) ?? false;
}

function humanize(value: string) {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
