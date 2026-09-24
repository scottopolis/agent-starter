import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';

import { ChatWidget } from './chat/ChatWidget';
import { HttpChatTransport } from './transport/http-chat-transport';
import './styles.css';

const transport = new HttpChatTransport();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChatWidget transport={transport} />
  </StrictMode>,
);
