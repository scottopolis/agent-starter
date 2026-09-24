import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DefaultChatTransport } from 'ai';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';

import McpApp from './chat/McpApp';
import { ChatWidget } from './lib';
import './lib/styles.css';
import './app.css';

const transport = new DefaultChatTransport({ api: '/api/chat' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChatWidget
      transport={transport}
      renderTool={(part, { renderDefault }) => part.toolMetadata?.app
        ? <McpApp part={part} fallback={renderDefault()} />
        : renderDefault()}
    />
  </StrictMode>,
);
