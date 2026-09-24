export type ChatRole = 'user' | 'assistant';

export type McpAppMetadata = Readonly<{
  capabilityId: string;
  resourceUri: string;
  mimeType: 'text/html;profile=mcp-app';
}>;

export type ToolDisplay = Readonly<{
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
  input?: unknown;
  output?: unknown;
  app?: McpAppMetadata;
}>;

export type ChatMessage = Readonly<{
  id: string;
  role: ChatRole;
  content: string;
  tools?: readonly ToolDisplay[];
}>;

export type ChatStreamEvent =
  | Readonly<{ type: 'text-delta'; text: string }>
  | Readonly<{ type: 'tool'; tool: ToolDisplay }>;

export type ChatRequest = Readonly<{
  messages: readonly ChatMessage[];
  signal: AbortSignal;
}>;

/**
 * The UI's only network boundary. Own authentication, sessions, and wire formats
 * in an adapter implementing this interface—not in React components.
 */
export interface ChatTransport {
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}
