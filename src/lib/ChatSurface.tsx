import { MessageCircle, RotateCcw, X } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import type { ChatStatus, UIMessage } from 'ai';

import { Chat, DefaultToolRenderer } from './Chat';
import type {
  ChatSurfaceActions,
  ChatSurfaceStyle,
  ToolPart,
  ToolRenderContext,
} from './Chat';

export type {
  ChatSurfaceActions,
  ChatSurfaceStyle,
  ToolApprovalResponse,
  ToolPart,
  ToolRenderContext,
} from './Chat';

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
  composerRef?: Ref<HTMLTextAreaElement>;
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
  composerRef,
  composerPlaceholder = 'Ask a question…',
  disclaimer = 'AI can make mistakes. Check important information.',
  onReset,
  onRequestClose,
  renderTool,
  renderError,
}: ChatSurfaceProps) {
  return (
    <Chat.Root
      messages={messages}
      status={status}
      actions={actions}
      title={title}
      embedded={embedded}
      className={className}
      style={style}
    >
      {header === undefined ? (
        <DefaultHeader title={title} onReset={onReset} onRequestClose={onRequestClose} />
      ) : header}

      <Chat.Transcript>
        {welcome !== null && <Chat.Empty>{welcome}</Chat.Empty>}
        <Chat.Messages renderTool={renderTool} showProgress={statusContent === undefined} />
        {statusContent === undefined ? null : statusContent}
        {error && (renderError
          ? renderError(error, () => runAction(actions.regenerate))
          : <DefaultError error={error} retry={() => runAction(actions.regenerate)} />)}
      </Chat.Transcript>

      <footer className="composer-wrap">
        {beforeComposer && <div className="before-composer">{beforeComposer}</div>}
        <Chat.Composer>
          <Chat.Input ref={composerRef} placeholder={composerPlaceholder} />
          <Chat.Send />
        </Chat.Composer>
        {disclaimer !== null && <p>{disclaimer}</p>}
      </footer>
    </Chat.Root>
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

function DefaultError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div className="error-card" role="alert">
      <div><strong>Something went wrong</strong><p>{error.message}</p></div>
      <button type="button" onClick={retry}>Try again</button>
    </div>
  );
}

function runAction(action: () => Promise<unknown> | unknown) {
  try {
    void Promise.resolve(action()).catch(() => undefined);
  } catch {
    // The state owner presents action errors through its controlled error state.
  }
}

export { DefaultToolRenderer };
