import { ArrowUp, Square } from 'lucide-react';
import {
  createContext,
  forwardRef,
  type CSSProperties,
  type ChangeEvent,
  type FormHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  type ButtonHTMLAttributes,
  useContext,
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

type ChatContextValue = Readonly<{
  messages: UIMessage[];
  status: ChatStatus;
  actions: ChatSurfaceActions;
  busy: boolean;
  pendingSend: boolean;
  sendPrompt: (prompt: string) => Promise<boolean>;
}>;

const ChatContext = createContext<ChatContextValue | null>(null);

export type ChatRootProps = Readonly<{
  messages: UIMessage[];
  status: ChatStatus;
  actions: ChatSurfaceActions;
  title?: string;
  embedded?: boolean;
  style?: ChatSurfaceStyle;
  children: ReactNode;
}> & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'style' | 'title'>;

function Root({
  messages,
  status,
  actions,
  title = 'Your AI assistant',
  embedded = false,
  className,
  style,
  children,
  ...rootProps
}: ChatRootProps) {
  const busy = isBusy(status);
  const [pendingSend, setPendingSend] = useState(false);
  const sendLockedRef = useRef(false);
  const rootClassName = [
    'agent-chat',
    embedded && 'agent-chat--embedded',
    className,
  ].filter(Boolean).join(' ');

  async function sendPrompt(prompt: string) {
    const text = prompt.trim();
    if (sendLockedRef.current || busy || !text) return false;
    sendLockedRef.current = true;
    setPendingSend(true);
    try {
      await actions.sendMessage({ text });
      return true;
    } catch {
      return false;
    } finally {
      sendLockedRef.current = false;
      setPendingSend(false);
    }
  }

  return (
    <ChatContext.Provider value={{ messages, status, actions, busy, pendingSend, sendPrompt }}>
      <div {...rootProps} className={rootClassName} style={style}>
        <section className="chat-card" aria-label={title}>{children}</section>
      </div>
    </ChatContext.Provider>
  );
}

export type ChatTranscriptProps = HTMLAttributes<HTMLDivElement>;

const Transcript = forwardRef<HTMLDivElement, ChatTranscriptProps>(function Transcript({
  className,
  children,
  onScroll,
  'aria-label': ariaLabel = 'Conversation messages',
  ...props
}, forwardedRef) {
  const { messages, status, busy } = useChatContext('Chat.Transcript');
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followMessagesRef = useRef(true);

  useEffect(() => {
    if (followMessagesRef.current) {
      viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
    }
  }, [children, messages, status]);

  return (
    <div
      {...props}
      className={['message-viewport', className].filter(Boolean).join(' ')}
      ref={(node) => {
        viewportRef.current = node;
        setRef(forwardedRef, node);
      }}
      onScroll={(event) => {
        const viewport = event.currentTarget;
        followMessagesRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
        onScroll?.(event);
      }}
      role="log"
      aria-label={ariaLabel}
      aria-live="polite"
      aria-relevant="additions"
      aria-busy={busy}
    >
      {children}
    </div>
  );
});

export type ChatEmptyProps = Readonly<{ children: ReactNode }>;

function Empty({ children }: ChatEmptyProps) {
  const { messages } = useChatContext('Chat.Empty');
  if (messages.length > 0) return null;
  return (
    <div className="welcome">
      <div className="assistant-avatar">AI</div>
      <div className="message-bubble message-bubble--assistant"><p>{children}</p></div>
    </div>
  );
}

export type ChatMessagesProps = Readonly<{
  renderTool?: (part: ToolPart, context: ToolRenderContext) => ReactNode;
  showProgress?: boolean;
  children?: (message: UIMessage) => ReactNode;
}>;

function Messages({ renderTool, showProgress = true, children }: ChatMessagesProps) {
  const { messages, actions, busy } = useChatContext('Chat.Messages');
  const lastMessage = messages.at(-1);
  return (
    <>
      {messages.map((message) => (
        <Message
          key={message.id}
          message={message}
          renderTool={renderTool}
          respondToApproval={(response) => runAction(() => actions.addToolApprovalResponse(response))}
          responseFooter={children}
        />
      ))}
      {showProgress && busy && (lastMessage?.role !== 'assistant' || !hasVisibleParts(lastMessage)) && (
        <div className="typing" role="status" aria-label="Assistant is responding"><i /><i /><i /></div>
      )}
    </>
  );
}

type ComposerContextValue = Readonly<{
  draft: string;
  setDraft: (draft: string) => void;
  inputId: string;
  stopResponse: () => void;
}>;

const ComposerContext = createContext<ComposerContextValue | null>(null);

export type ChatComposerProps = Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> & Readonly<{
  onSubmit?: FormHTMLAttributes<HTMLFormElement>['onSubmit'];
}>;

function Composer({ className, children, onSubmit, ...props }: ChatComposerProps) {
  const { actions, busy, pendingSend, sendPrompt } = useChatContext('Chat.Composer');
  const [draft, setDraft] = useState('');
  const submitLockedRef = useRef(false);
  const inputId = useId();

  function submit(event: Parameters<NonNullable<FormHTMLAttributes<HTMLFormElement>['onSubmit']>>[0]) {
    onSubmit?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (submitLockedRef.current || busy || pendingSend || !draft.trim()) return;
    const submittedDraft = draft.trim();
    submitLockedRef.current = true;
    setDraft('');
    void sendPrompt(submittedDraft)
      .then((sent) => {
        if (!sent) setDraft((currentDraft) => currentDraft || submittedDraft);
      })
      .finally(() => { submitLockedRef.current = false; });
  }

  function stopResponse() {
    void (async () => {
      try {
        await actions.stop();
      } catch {
        return;
      }
      actions.setMessages?.((currentMessages) => {
        const last = currentMessages.at(-1);
        return last?.role === 'assistant' && !hasVisibleParts(last) ? currentMessages.slice(0, -1) : currentMessages;
      });
    })();
  }

  return (
    <ComposerContext.Provider value={{ draft, setDraft, inputId, stopResponse }}>
      <form {...props} className={['composer', className].filter(Boolean).join(' ')} onSubmit={submit}>
        {children}
      </form>
    </ComposerContext.Provider>
  );
}

export type ChatInputProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue'>;

const Input = forwardRef<HTMLTextAreaElement, ChatInputProps>(function Input({
  id,
  rows = 1,
  onChange,
  onKeyDown,
  ...props
}, ref) {
  const { draft, setDraft, inputId } = useComposerContext('Chat.Input');
  const resolvedId = id ?? inputId;

  function change(event: ChangeEvent<HTMLTextAreaElement>) {
    onChange?.(event);
    if (!event.defaultPrevented) setDraft(event.target.value);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <>
      <label className="sr-only" htmlFor={resolvedId}>Message</label>
      <textarea
        {...props}
        id={resolvedId}
        ref={ref}
        data-agent-chat-composer=""
        rows={rows}
        value={draft}
        onChange={change}
        onKeyDown={keyDown}
      />
    </>
  );
});

export type ChatSendProps = ButtonHTMLAttributes<HTMLButtonElement>;

function Send({ children, className, disabled, onClick, ...props }: ChatSendProps) {
  const { busy, pendingSend } = useChatContext('Chat.Send');
  const { draft, stopResponse } = useComposerContext('Chat.Send');
  return busy ? (
    <button
      {...props}
      className={['send-button', className].filter(Boolean).join(' ')}
      type="button"
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) stopResponse();
      }}
      aria-label={props['aria-label'] ?? 'Stop response'}
    >{children ?? <Square />}</button>
  ) : (
    <button
      {...props}
      className={['send-button', className].filter(Boolean).join(' ')}
      type="submit"
      disabled={disabled || pendingSend || !draft.trim()}
      onClick={onClick}
      aria-label={props['aria-label'] ?? 'Send message'}
    >{children ?? <ArrowUp />}</button>
  );
}

export type ChatResponseFooterProps = HTMLAttributes<HTMLDivElement>;

function ResponseFooter({ children, className, ...props }: ChatResponseFooterProps) {
  if (children === null || children === undefined) return null;
  return <div {...props} className={['response-footer', className].filter(Boolean).join(' ')}>{children}</div>;
}

export type ChatSuggestionsProps = HTMLAttributes<HTMLDivElement>;

function Suggestions({ children, className, ...props }: ChatSuggestionsProps) {
  if (children === null || children === undefined) return null;
  return (
    <div
      {...props}
      className={['suggestions', className].filter(Boolean).join(' ')}
      role="group"
      aria-label={props['aria-label'] ?? 'Suggested prompts'}
    >
      {children}
    </div>
  );
}

export type ChatSuggestionProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & Readonly<{
  prompt: string;
}>;

function Suggestion({ prompt, children, className, disabled, onClick, ...props }: ChatSuggestionProps) {
  const { busy, pendingSend, sendPrompt } = useChatContext('Chat.Suggestion');
  return (
    <button
      {...props}
      className={['suggestion', className].filter(Boolean).join(' ')}
      type="button"
      disabled={disabled || busy || pendingSend}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        void sendPrompt(prompt);
      }}
    >
      {children ?? prompt}
    </button>
  );
}

export const Chat = {
  Root,
  Transcript,
  Empty,
  Messages,
  ResponseFooter,
  Suggestions,
  Suggestion,
  Composer,
  Input,
  Send,
} as const;

function Message({ message, renderTool, respondToApproval, responseFooter }: {
  message: UIMessage;
  renderTool?: ChatMessagesProps['renderTool'];
  respondToApproval: (response: ToolApprovalResponse) => void;
  responseFooter?: ChatMessagesProps['children'];
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
  const footer = responseFooter?.(message);
  return (
    <>
      <div className={['message-row message-row--assistant', footer != null && 'message-row--with-footer'].filter(Boolean).join(' ')}>
        <div className="assistant-avatar">AI</div>
        <div className="assistant-stack">{content}</div>
      </div>
      {footer}
    </>
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

function useChatContext(component: string) {
  const context = useContext(ChatContext);
  if (!context) throw new Error(`${component} must be used inside Chat.Root`);
  return context;
}

function useComposerContext(component: string) {
  const context = useContext(ComposerContext);
  if (!context) throw new Error(`${component} must be used inside Chat.Composer`);
  return context;
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
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
