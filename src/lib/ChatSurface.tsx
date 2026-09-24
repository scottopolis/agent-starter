import { ArrowUp, MessageCircle, RotateCcw, Square, X } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  getToolName,
  isToolUIPart,
  type ChatStatus,
  type UIMessage,
} from 'ai';

export type ToolPart = Extract<UIMessage['parts'][number], { toolCallId: string }>;
export type ToolApprovalResponse = { id: string; approved: boolean; reason?: string };

export type ChatSurfaceStyle = CSSProperties & Partial<Record<
  | '--agent-chat-accent'
  | '--agent-chat-accent-hover'
  | '--agent-chat-header-text'
  | '--agent-chat-header-muted'
  | '--agent-chat-avatar-bg'
  | '--agent-chat-paper'
  | '--agent-chat-ink'
  | '--agent-chat-muted'
  | '--agent-chat-line'
  | '--agent-chat-height',
  string | number
>>;

export type ChatSurfaceActions = Readonly<{
  sendMessage: (message: { text: string }) => Promise<unknown> | unknown;
  stop: () => Promise<unknown> | unknown;
  regenerate: () => Promise<unknown> | unknown;
  addToolApprovalResponse: (response: ToolApprovalResponse) => Promise<unknown> | unknown;
  setMessages?: (update: (messages: UIMessage[]) => UIMessage[]) => void;
}>;

export type ToolRenderContext = Readonly<{
  respondToApproval: (response: ToolApprovalResponse) => void;
  renderDefault: () => ReactNode;
}>;

export type ChatSurfaceProps = Readonly<{
  messages: UIMessage[];
  status: ChatStatus;
  actions: ChatSurfaceActions;
  error?: Error;
  title?: string;
  welcome?: ReactNode;
  embedded?: boolean;
  className?: string;
  style?: ChatSurfaceStyle;
  header?: ReactNode;
  statusContent?: ReactNode;
  beforeComposer?: ReactNode;
  composerPlaceholder?: string;
  disclaimer?: ReactNode;
  onReset?: () => void;
  onRequestClose?: () => void;
  renderTool?: (part: ToolPart, context: ToolRenderContext) => ReactNode;
  renderError?: (error: Error, retry: () => void) => ReactNode;
}>;

export function ChatSurface({
  messages,
  status,
  actions,
  error,
  title = 'Your AI assistant',
  welcome = 'Hi! I’m here to help. Ask me anything about the product.',
  embedded = false,
  className,
  style,
  header,
  statusContent,
  beforeComposer,
  composerPlaceholder = 'Ask a question…',
  disclaimer = 'AI can make mistakes. Check important information.',
  onReset,
  onRequestClose,
  renderTool,
  renderError,
}: ChatSurfaceProps) {
  const [draft, setDraft] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const submitLockedRef = useRef(false);
  const followMessagesRef = useRef(true);
  const composerId = useId();
  const busy = isBusy(status);
  const lastMessage = messages.at(-1);

  useEffect(() => {
    if (followMessagesRef.current) {
      viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
    }
  }, [messages, statusContent]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (submitLockedRef.current || busy || !draft.trim()) return;
    const submittedDraft = draft.trim();
    submitLockedRef.current = true;
    setDraft('');
    let result: Promise<unknown> | unknown;
    try {
      result = actions.sendMessage({ text: submittedDraft });
    } catch {
      submitLockedRef.current = false;
      setDraft((currentDraft) => currentDraft || submittedDraft);
      return;
    }
    void Promise.resolve(result)
      .catch(() => { setDraft((currentDraft) => currentDraft || submittedDraft); })
      .finally(() => { submitLockedRef.current = false; });
  }

  async function stopResponse() {
    try {
      await actions.stop();
    } catch {
      return;
    }
    actions.setMessages?.((currentMessages) => {
      const last = currentMessages.at(-1);
      return last?.role === 'assistant' && !hasVisibleParts(last) ? currentMessages.slice(0, -1) : currentMessages;
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function handleViewportScroll() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followMessagesRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
  }

  const rootClassName = [
    'agent-chat',
    embedded && 'agent-chat--embedded',
    className,
  ].filter(Boolean).join(' ');

  return (
    <main className={rootClassName} style={style}>
      <section className="chat-card" aria-label={title}>
        {header === undefined ? (
          <DefaultHeader title={title} onReset={onReset} onRequestClose={onRequestClose} />
        ) : header}

        <div className="message-viewport" ref={viewportRef} onScroll={handleViewportScroll} aria-label="Conversation messages" aria-busy={busy}>
          {messages.length === 0 && welcome !== null && (
            <div className="welcome">
              <div className="assistant-avatar">AI</div>
              <div className="message-bubble message-bubble--assistant"><p>{welcome}</p></div>
            </div>
          )}
          {messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              renderTool={renderTool}
              respondToApproval={(response) => runAction(() => actions.addToolApprovalResponse(response))}
            />
          ))}
          {statusContent === undefined
            ? busy && (lastMessage?.role !== 'assistant' || !hasVisibleParts(lastMessage)) && (
              <div className="typing" role="status" aria-label="Assistant is responding"><i /><i /><i /></div>
            )
            : statusContent}
          {error && (renderError
            ? renderError(error, () => runAction(actions.regenerate))
            : <DefaultError error={error} retry={() => runAction(actions.regenerate)} />)}
        </div>

        <footer className="composer-wrap">
          {beforeComposer && <div className="before-composer">{beforeComposer}</div>}
          <form className="composer" onSubmit={submit}>
            <label className="sr-only" htmlFor={composerId}>Message</label>
            <textarea
              id={composerId}
              rows={1}
              placeholder={composerPlaceholder}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
            />
            {busy ? (
              <button className="send-button" type="button" onClick={() => void stopResponse()} aria-label="Stop response"><Square /></button>
            ) : (
              <button className="send-button" type="submit" disabled={!draft.trim()} aria-label="Send message"><ArrowUp /></button>
            )}
          </form>
          {disclaimer !== null && <p>{disclaimer}</p>}
        </footer>
      </section>
    </main>
  );
}

function DefaultHeader({ title, onReset, onRequestClose }: {
  title: string;
  onReset?: () => void;
  onRequestClose?: () => void;
}) {
  return (
    <header className="chat-header">
      <div className="brand-mark"><MessageCircle aria-hidden="true" /></div>
      <div><h1>{title}</h1><p><span className="status-dot" /> Online</p></div>
      <div className="header-actions">
        {onReset && <button type="button" onClick={onReset} aria-label="Start a new chat" title="New chat"><RotateCcw /></button>}
        {onRequestClose && <button type="button" onClick={onRequestClose} aria-label="Close chat"><X /></button>}
      </div>
    </header>
  );
}

function Message({ message, renderTool, respondToApproval }: {
  message: UIMessage;
  renderTool?: ChatSurfaceProps['renderTool'];
  respondToApproval: (response: ToolApprovalResponse) => void;
}) {
  if (message.role === 'user') {
    const text = message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
    return <div className="message-row message-row--user"><div className="message-bubble message-bubble--user"><p>{text}</p></div></div>;
  }
  const content = message.parts.map((part, index) => {
    if (part.type === 'text' && part.text) {
      return (
        <div className="message-bubble message-bubble--assistant markdown" key={`${part.type}-${index}`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
            a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
          }}>{part.text}</ReactMarkdown>
        </div>
      );
    }
    if (isToolUIPart(part)) {
      const renderDefault = () => <DefaultToolRenderer part={part} respondToApproval={respondToApproval} />;
      const rendered = renderTool ? renderTool(part, { respondToApproval, renderDefault }) : renderDefault();
      return rendered === null || rendered === undefined
        ? null
        : <div className="tool-part" key={part.toolCallId}>{rendered}</div>;
    }
    return null;
  });
  if (content.every((part) => part === null)) return null;
  return (
    <div className="message-row message-row--assistant">
      <div className="assistant-avatar">AI</div>
      <div className="assistant-stack">{content}</div>
    </div>
  );
}

export function DefaultToolRenderer({ part, respondToApproval }: {
  part: ToolPart;
  respondToApproval: (response: ToolApprovalResponse) => void;
}) {
  const name = getToolName(part);
  if (part.state === 'approval-requested' && !part.approval.isAutomatic) {
    return (
      <section className="approval-card" aria-label={`${humanize(name)} approval`}>
        <p className="approval-card__eyebrow">Approval required</p>
        <h2>{humanize(name)}</h2>
        {part.approval.requestReason && <p>{part.approval.requestReason}</p>}
        <pre>{JSON.stringify(part.input, null, 2)}</pre>
        <div className="approval-card__actions">
          <button type="button" className="approval-card__deny" onClick={() => respondToApproval({ id: part.approval.id, approved: false, reason: 'Denied by user' })}>Deny</button>
          <button type="button" className="approval-card__approve" onClick={() => respondToApproval({ id: part.approval.id, approved: true })}>Approve</button>
        </div>
      </section>
    );
  }
  if (part.state === 'approval-responded' && !part.approval.isAutomatic) return null;
  if (part.state === 'output-denied') {
    return <div className="approval-card approval-card--denied" role="status"><strong>Denied</strong><span>{humanize(name)} was not run.</span></div>;
  }
  const output = part.state === 'output-available' ? part.output : undefined;
  const toolError = part.state === 'output-error' ? part.errorText : undefined;
  return (
    <details className="tool-card">
      <summary><span className={`tool-status tool-status--${toolStatus(part.state)}`} /> {humanize(name)} <small>{toolStatus(part.state)}</small></summary>
      {'input' in part && part.input !== undefined && <pre>{JSON.stringify(part.input, null, 2)}</pre>}
      {output !== undefined && <pre>{JSON.stringify(output, null, 2)}</pre>}
      {toolError !== undefined && <pre>{toolError}</pre>}
    </details>
  );
}

function DefaultError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div className="error-card" role="alert">
      <div><strong>Something went wrong</strong><p>{error.message}</p></div>
      <button type="button" onClick={retry}>Try again</button>
    </div>
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
  return message?.parts.some(isVisiblePart) ?? false;
}

function isVisiblePart(part: UIMessage['parts'][number]) {
  if (part.type === 'text') return Boolean(part.text);
  if (!isToolUIPart(part)) return false;
  return part.state !== 'approval-responded' || part.approval.isAutomatic === true;
}

function humanize(value: string) {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function runAction(action: () => Promise<unknown> | unknown) {
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // The state owner presents action errors through its controlled error state.
  }
}
