import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DefaultChatTransport } from 'ai';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';

import { ChatWidget } from './chat/ChatWidget';
import './styles.css';

const transport = new DefaultChatTransport({ api: '/api/chat' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChatWidget transport={transport} />
  </StrictMode>,
);
