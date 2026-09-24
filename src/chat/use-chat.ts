import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatMessage, ChatTransport, ToolDisplay } from './types';

export function useChat(transport: ChatTransport, initialMessages: readonly ChatMessage[] = []) {
  const [messages, setMessages] = useState<ChatMessage[]>([...initialMessages]);
  const [status, setStatus] = useState<'idle' | 'streaming'>('idle');
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async (history: ChatMessage[]) => {
    const controller = new AbortController();
    const generation = ++generationRef.current;
    abortRef.current = controller;
    busyRef.current = true;
    setStatus('streaming');
    setError(undefined);
    const assistantId = crypto.randomUUID();
    setMessages([...history, { id: assistantId, role: 'assistant', content: '', tools: [] }]);
    try {
      for await (const event of transport.stream({ messages: history, signal: controller.signal })) {
        if (abortRef.current !== controller) continue;
        setMessages((current) => current.map((message) => {
          if (generationRef.current !== generation) return message;
          if (message.id !== assistantId) return message;
          if (event.type === 'text-delta') return { ...message, content: message.content + event.text };
          return { ...message, tools: upsertTool(message.tools ?? [], event.tool) };
        }));
      }
    } catch (cause) {
      if (abortRef.current === controller && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'The response could not be completed');
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
        busyRef.current = false;
        setMessages((current) => current.filter(isRenderableMessage));
        setStatus('idle');
      }
    }
  }, [transport]);

  const send = useCallback((text: string) => {
    if (busyRef.current || !text.trim()) return;
    busyRef.current = true;
    const next = [...messagesRef.current.filter(isRenderableMessage), {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: text.trim(),
    }];
    setMessages(next);
    void run(next);
  }, [run]);

  const retry = useCallback(() => {
    if (busyRef.current) return;
    let lastUserIndex = messagesRef.current.length - 1;
    while (lastUserIndex >= 0 && messagesRef.current[lastUserIndex]?.role !== 'user') lastUserIndex -= 1;
    if (lastUserIndex < 0) return;
    busyRef.current = true;
    const history = messagesRef.current.slice(0, lastUserIndex + 1);
    setMessages(history);
    void run(history);
  }, [run]);

  const reset = useCallback(() => {
    const active = abortRef.current;
    abortRef.current = undefined;
    busyRef.current = false;
    generationRef.current += 1;
    active?.abort();
    setMessages([...initialMessages]);
    setError(undefined);
    setStatus('idle');
  }, [initialMessages]);

  return {
    messages,
    status,
    error,
    send,
    retry,
    reset,
    stop: () => abortRef.current?.abort(),
  };
}

function upsertTool(tools: readonly ToolDisplay[], next: ToolDisplay): ToolDisplay[] {
  const index = tools.findIndex((tool) => tool.id === next.id);
  if (index < 0) return [...tools, next];
  return tools.map((tool, toolIndex) => toolIndex === index ? next : tool);
}

function isRenderableMessage(message: ChatMessage): boolean {
  return message.role === 'user' || message.content.trim().length > 0 || (message.tools?.length ?? 0) > 0;
}
