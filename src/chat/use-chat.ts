import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatMessage, ChatTransport, ToolDisplay } from './types';

export function useChat(transport: ChatTransport, initialMessages: readonly ChatMessage[] = []) {
  const [messages, setMessages] = useState<ChatMessage[]>([...initialMessages]);
  const [status, setStatus] = useState<'idle' | 'streaming'>('idle');
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async (history: ChatMessage[]) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('streaming');
    setError(undefined);
    const assistantId = crypto.randomUUID();
    setMessages([...history, { id: assistantId, role: 'assistant', content: '', tools: [] }]);
    try {
      for await (const event of transport.stream({ messages: history, signal: controller.signal })) {
        setMessages((current) => current.map((message) => {
          if (message.id !== assistantId) return message;
          if (event.type === 'text-delta') return { ...message, content: message.content + event.text };
          return { ...message, tools: upsertTool(message.tools ?? [], event.tool) };
        }));
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'The response could not be completed');
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
      setStatus('idle');
    }
  }, [transport]);

  const send = useCallback((text: string) => {
    if (status === 'streaming' || !text.trim()) return;
    const next = [...messagesRef.current, {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: text.trim(),
    }];
    setMessages(next);
    void run(next);
  }, [run, status]);

  const retry = useCallback(() => {
    if (status === 'streaming') return;
    let lastUserIndex = messagesRef.current.length - 1;
    while (lastUserIndex >= 0 && messagesRef.current[lastUserIndex]?.role !== 'user') lastUserIndex -= 1;
    if (lastUserIndex < 0) return;
    const history = messagesRef.current.slice(0, lastUserIndex + 1);
    setMessages(history);
    void run(history);
  }, [run, status]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
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
