import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { parseJSONRPCMessage, type CallToolResult, type JSONRPCMessage, type MessageExtraInfo, type Transport, type TransportSendOptions } from '@modelcontextprotocol/client';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ToolDisplay } from './types';

const MIN_HEIGHT = 180;
const MAX_HEIGHT = 720;
const INITIAL_HEIGHT = 280;
const INIT_TIMEOUT_MS = 8_000;

type ResourceEnvelope = {
  html: string;
  csp?: McpUiCsp;
  permissions?: McpUiPermissions;
  appTools: string[];
};

type McpUiCsp = Partial<Record<'connectDomains' | 'resourceDomains' | 'frameDomains' | 'baseUriDomains', string[]>>;
type McpUiPermissions = Partial<Record<'camera' | 'microphone' | 'geolocation' | 'clipboardWrite', Record<string, never>>>;
type ActiveBridge = { bridge: AppBridge; initialized: boolean; inputKey?: string; resultKey?: string };

export default function McpApp({ tool, embedAncestorOrigin }: { tool: ToolDisplay; embedAncestorOrigin?: string }) {
  const capabilityId = tool.app!.capabilityId;
  const latestToolRef = useRef(tool);
  latestToolRef.current = tool;
  const [resource, setResource] = useState<ResourceEnvelope>();
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const activeRef = useRef<ActiveBridge | undefined>(undefined);
  const sandboxUrl = useMemo(() => {
    try { return resource && makeSandboxUrl(resource, embedAncestorOrigin); } catch { return undefined; }
  }, [embedAncestorOrigin, resource]);

  useEffect(() => {
    let cancelled = false;
    setResource(undefined);
    setFailed(false);
    fetchJson('/api/mcp/apps/resource', { capabilityId })
      .then(parseResource)
      .then((next) => { if (!cancelled) setResource(next); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [capabilityId]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!resource || !sandboxUrl || !frame?.contentWindow) return;
    const sandboxOrigin = new URL(sandboxUrl).origin;
    let disposed = false;
    let initialized = false;
    const transport = new ExactPostMessageTransport(frame.contentWindow, sandboxOrigin);
    const bridge = new AppBridge(
      null,
      { name: 'Agent Widget Starter', version: '0.2.0' },
      { openLinks: {}, serverTools: {}, sandbox: { csp: resource.csp, permissions: resource.permissions } },
      { hostContext: { platform: 'web', displayMode: 'inline', availableDisplayModes: ['inline'], containerDimensions: { maxHeight: MAX_HEIGHT } } },
    );
    activeRef.current = { bridge, initialized: false };
    const timeout = window.setTimeout(() => {
      if (!initialized && !disposed) setFailed(true);
    }, INIT_TIMEOUT_MS);

    bridge.addEventListener('sandboxready', () => {
      void bridge.sendSandboxResourceReady({
        html: resource.html,
        sandbox: 'allow-scripts allow-forms',
        csp: resource.csp,
        permissions: resource.permissions,
      }).catch(() => setFailed(true));
    });
    bridge.addEventListener('initialized', () => {
      initialized = true;
      window.clearTimeout(timeout);
      if (activeRef.current) activeRef.current.initialized = true;
      void syncTool(activeRef.current, latestToolRef.current).catch(() => setFailed(true));
    });
    bridge.addEventListener('sizechange', ({ height: requestedHeight }) => {
      if (typeof requestedHeight === 'number' && Number.isFinite(requestedHeight)) {
        setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(requestedHeight))));
      }
    });
    bridge.onopenlink = async ({ url }) => {
      const parsed = safeLink(url);
      if (!parsed) throw new Error('Only absolute HTTP(S) links are allowed');
      window.open(parsed.href, '_blank', 'noopener,noreferrer');
      return {};
    };
    bridge.oncalltool = async ({ name, arguments: args }) => {
      if (!resource.appTools.includes(name)) throw new Error('This app is not allowed to call that tool');
      const result = await fetchJson('/api/mcp/apps/tool', {
        capabilityId,
        name,
        arguments: args ?? {},
      });
      return parseToolResult(result);
    };
    void bridge.connect(transport).catch(() => setFailed(true));

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      if (activeRef.current?.bridge === bridge) activeRef.current = undefined;
      void Promise.race([
        initialized ? bridge.teardownResource({}) : Promise.resolve({}),
        new Promise((resolve) => window.setTimeout(resolve, 250)),
      ]).finally(() => bridge.close());
    };
  }, [capabilityId, resource, sandboxUrl]);

  useEffect(() => {
    void syncTool(activeRef.current, tool).catch(() => setFailed(true));
  }, [tool]);

  if (failed) return <AppFallback tool={tool} />;
  if (resource && !sandboxUrl) return <AppFallback tool={tool} />;
  if (!resource) return <div className="mcp-app-loading" role="status">Loading interactive app…</div>;
  return (
    <section className="mcp-app-frame" aria-label={`${humanize(tool.name)} interactive app`}>
      <iframe
        ref={frameRef}
        src={sandboxUrl}
        title={`${humanize(tool.name)} interactive app`}
        sandbox="allow-scripts allow-same-origin allow-forms"
        allow={allowAttribute(resource.permissions)}
        referrerPolicy="strict-origin"
        style={{ height }}
      />
    </section>
  );
}

async function syncTool(active: ActiveBridge | undefined, tool: ToolDisplay) {
  if (!active?.initialized) return;
  const input = objectValue(tool.input);
  const inputKey = stableKey(input);
  if (active.inputKey !== inputKey) {
    active.inputKey = inputKey;
    await active.bridge.sendToolInput({ arguments: input });
  }
  if (tool.status === 'running') return;
  const result = tool.status === 'error'
    ? { content: [{ type: 'text' as const, text: errorText(tool.output) }], isError: true }
    : parseToolResult(tool.output);
  const resultKey = stableKey(result);
  if (active.resultKey !== resultKey) {
    active.resultKey = resultKey;
    await active.bridge.sendToolResult(result);
  }
}

function makeSandboxUrl(resource: ResourceEnvelope, embedAncestorOrigin?: string) {
  const configured = import.meta.env.VITE_MCP_SANDBOX_URL || 'http://localhost:8789/sandbox';
  const url = new URL(configured, window.location.href);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === window.location.origin) throw new Error('MCP_SANDBOX_URL must use a distinct HTTP(S) origin');
  url.search = '';
  url.searchParams.set('hostOrigin', window.location.origin);
  if (embedAncestorOrigin) url.searchParams.set('embedAncestorOrigin', embedAncestorOrigin);
  if (resource.csp) url.searchParams.set('csp', JSON.stringify(resource.csp));
  if (resource.permissions) url.searchParams.set('permissions', JSON.stringify(resource.permissions));
  return url.href;
}

async function fetchJson(endpoint: string, body: unknown): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('MCP App request failed');
  return response.json();
}

export function parseResource(value: unknown): ResourceEnvelope {
  if (!isRecord(value) || Object.keys(value).some((key) => !['html', 'csp', 'permissions', 'appTools'].includes(key))) throw new Error('Invalid MCP App resource');
  if (typeof value.html !== 'string' || new Blob([value.html]).size > 1_048_576) throw new Error('Invalid MCP App HTML');
  if (!Array.isArray(value.appTools) || value.appTools.length > 200 || value.appTools.some((name) => typeof name !== 'string')) throw new Error('Invalid app tool list');
  return { html: value.html, appTools: value.appTools, csp: parseCsp(value.csp), permissions: parsePermissions(value.permissions) };
}

function parseCsp(value: unknown): McpUiCsp | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => !['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'].includes(key))) throw new Error('Invalid MCP App CSP');
  for (const domains of Object.values(value)) {
    if (!Array.isArray(domains) || domains.length > 32 || domains.some((domain) => typeof domain !== 'string')) throw new Error('Invalid MCP App CSP');
  }
  return value as McpUiCsp;
}

function parsePermissions(value: unknown): McpUiPermissions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.entries(value).some(([key, permission]) => !['camera', 'microphone', 'geolocation', 'clipboardWrite'].includes(key) || !isRecord(permission) || Object.keys(permission).length > 0)) {
    throw new Error('Invalid MCP App permissions');
  }
  return value as McpUiPermissions;
}

function parseToolResult(value: unknown): CallToolResult {
  if (!isRecord(value) || !Array.isArray(value.content) || value.content.some((part) => !isRecord(part) || typeof part.type !== 'string')) throw new Error('Invalid MCP tool result');
  return value as CallToolResult;
}

function safeLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch { return undefined; }
}

function allowAttribute(permissions?: McpUiPermissions) {
  return [
    permissions?.camera && 'camera *', permissions?.microphone && 'microphone *',
    permissions?.geolocation && 'geolocation *', permissions?.clipboardWrite && 'clipboard-write *',
  ].filter(Boolean).join('; ');
}

function AppFallback({ tool }: { tool: ToolDisplay }) {
  return (
    <div className="mcp-app-fallback" role="alert">
      <strong>This app could not be displayed.</strong>
      {tool.output !== undefined && <pre>{JSON.stringify(tool.output, null, 2)}</pre>}
    </div>
  );
}

export class ExactPostMessageTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  sessionId?: string;
  #started = false;

  constructor(readonly target: Window, readonly targetOrigin: string) {}

  readonly #receive = (event: MessageEvent) => {
    if (event.source !== this.target || event.origin !== this.targetOrigin) return;
    try { this.onmessage?.(parseJSONRPCMessage(event.data)); } catch (error) { this.onerror?.(error as Error); }
  };

  async start() {
    if (this.#started) throw new Error('Transport already started');
    this.#started = true;
    window.addEventListener('message', this.#receive);
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions) {
    if (!this.#started) throw new Error('Transport not started');
    this.target.postMessage(message, this.targetOrigin);
  }

  async close() {
    if (!this.#started) return;
    this.#started = false;
    window.removeEventListener('message', this.#receive);
    this.onclose?.();
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stableKey(value: unknown) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function errorText(value: unknown) {
  return isRecord(value) && typeof value.message === 'string' ? value.message : 'MCP tool failed';
}

function humanize(value: string) {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
