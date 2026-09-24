export const WIDGET_NAMESPACE = 'agent-widget-starter';
export const WIDGET_VERSION = 1;

type MessageType = 'READY' | 'OPEN' | 'CLOSE' | 'REQUEST_CLOSE';

export type ControlMessage = Readonly<{
  namespace: typeof WIDGET_NAMESPACE;
  version: typeof WIDGET_VERSION;
  type: MessageType;
}>;

export type PromptMessage = Readonly<{
  namespace: typeof WIDGET_NAMESPACE;
  version: typeof WIDGET_VERSION;
  type: 'SEND_MESSAGE';
  message: string;
}>;

export function controlMessage(type: MessageType): ControlMessage {
  return { namespace: WIDGET_NAMESPACE, version: WIDGET_VERSION, type };
}

export function promptMessage(message: string): PromptMessage {
  return { namespace: WIDGET_NAMESPACE, version: WIDGET_VERSION, type: 'SEND_MESSAGE', message };
}

export function parseControlMessage(value: unknown): ControlMessage | undefined {
  if (!hasExactKeys(value, ['namespace', 'version', 'type'])) return undefined;
  if (value.namespace !== WIDGET_NAMESPACE || value.version !== WIDGET_VERSION) return undefined;
  if (value.type !== 'READY' && value.type !== 'OPEN' && value.type !== 'CLOSE' && value.type !== 'REQUEST_CLOSE') return undefined;
  return value as ControlMessage;
}

export function parsePromptMessage(value: unknown): PromptMessage | undefined {
  if (!hasExactKeys(value, ['namespace', 'version', 'type', 'message'])) return undefined;
  return value.namespace === WIDGET_NAMESPACE
    && value.version === WIDGET_VERSION
    && value.type === 'SEND_MESSAGE'
    && typeof value.message === 'string'
    && value.message.trim().length > 0
    && value.message.length <= 16_000
    ? value as PromptMessage
    : undefined;
}

export function exactOrigin(value: string | null): string | undefined {
  if (value === null) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.origin === value && url.pathname === '/' && !url.search && !url.hash
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
