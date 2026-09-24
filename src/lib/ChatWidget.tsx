import { useChat } from '@ai-sdk/react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatTransport,
  type UIMessage,
} from 'ai';

import { ChatSurface, type ChatSurfaceProps } from './ChatSurface';

export type ChatWidgetProps = Omit<ChatSurfaceProps, 'messages' | 'status' | 'actions' | 'error' | 'onReset'> & Readonly<{
  transport: ChatTransport<UIMessage>;
  /** Initial conversation ID. Changing this prop does not switch an existing chat. */
  id?: string;
  requestedPrompt?: Readonly<{ id: string; text: string }>;
  onReset?: () => void;
}>;

export function ChatWidget({ transport, id, requestedPrompt, onReset, ...surfaceProps }: ChatWidgetProps) {
  const [conversationId, setConversationId] = useState(() => id ?? crypto.randomUUID());
  const handledPromptRef = useRef<string | undefined>(undefined);

  function reset() {
    setConversationId(crypto.randomUUID());
    onReset?.();
  }

  return (
    <ConnectedChat
      key={conversationId}
      {...surfaceProps}
      id={conversationId}
      transport={transport}
      requestedPrompt={requestedPrompt}
      handledPromptRef={handledPromptRef}
      onReset={reset}
    />
  );
}

function ConnectedChat({
  id,
  transport,
  requestedPrompt,
  handledPromptRef,
  ...surfaceProps
}: Omit<ChatWidgetProps, 'id'> & Readonly<{ id: string; handledPromptRef: RefObject<string | undefined> }>) {
  const chat = useChat({ id, transport, sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses });

  useEffect(() => {
    if (!requestedPrompt || handledPromptRef.current === requestedPrompt.id || isBusy(chat.status)) return;
    handledPromptRef.current = requestedPrompt.id;
    try {
      void Promise.resolve(chat.sendMessage({ text: requestedPrompt.text })).catch(() => undefined);
    } catch {
      // useChat exposes submission failures through chat.error.
    }
  }, [chat.sendMessage, chat.status, requestedPrompt]);

  return (
    <ChatSurface
      {...surfaceProps}
      messages={chat.messages}
      status={chat.status}
      error={chat.error}
      actions={chat}
    />
  );
}

function isBusy(status: string) {
  return status === 'submitted' || status === 'streaming';
}
