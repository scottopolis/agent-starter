import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DefaultChatTransport } from 'ai';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';

import McpApp from './chat/McpApp';
import { controlMessage, exactOrigin, parseControlMessage, parsePromptMessage } from './embed/protocol';
import { ChatWidget } from './lib';
import './lib/styles.css';
import './app.css';

function EmbeddedApp() {
  const config = useMemo(() => readConfig(), []);
  const [prompt, setPrompt] = useState<{ id: string; text: string }>();
  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/chat' }), []);

  useEffect(() => {
    if (!config) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== config.parentOrigin) return;
      const message = parseControlMessage(event.data);
      const requestedPrompt = parsePromptMessage(event.data);
      if (message?.type === 'OPEN' || message?.type === 'CLOSE') {
        window.parent.postMessage(controlMessage('READY'), config.parentOrigin);
      }
      if (message?.type === 'OPEN') document.querySelector<HTMLTextAreaElement>('#chat-message')?.focus();
      else if (requestedPrompt) setPrompt({ id: crypto.randomUUID(), text: requestedPrompt.message });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.parent.postMessage(controlMessage('REQUEST_CLOSE'), config.parentOrigin);
    };
    window.addEventListener('message', receive);
    window.addEventListener('keydown', escape);
    window.parent.postMessage(controlMessage('READY'), config.parentOrigin);
    return () => {
      window.removeEventListener('message', receive);
      window.removeEventListener('keydown', escape);
    };
  }, [config]);

  if (!config) return <p className="embed-error" role="alert">This chat must be opened by an authorized parent page.</p>;
  return (
    <ChatWidget
      embedded
      title={config.title}
      transport={transport}
      requestedPrompt={prompt}
      onRequestClose={() => window.parent.postMessage(controlMessage('REQUEST_CLOSE'), config.parentOrigin)}
      renderTool={(part, { renderDefault }) => part.toolMetadata?.app
        ? <McpApp part={part} embedAncestorOrigin={config.parentOrigin} fallback={renderDefault()} />
        : renderDefault()}
    />
  );
}

function readConfig(): { parentOrigin: string; title: string } | undefined {
  if (window.parent === window) return undefined;
  const params = new URLSearchParams(window.location.search);
  if (params.getAll('parentOrigin').length !== 1 || params.getAll('title').length > 1) return undefined;
  const parentOrigin = exactOrigin(params.get('parentOrigin'));
  if (!parentOrigin) return undefined;
  const title = params.get('title')?.trim();
  return { parentOrigin, title: title && title.length <= 100 ? title : 'Your AI assistant' };
}

createRoot(document.getElementById('root')!).render(<EmbeddedApp />);
