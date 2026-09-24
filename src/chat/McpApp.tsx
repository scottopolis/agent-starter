import {
  experimental_MCPAppRenderer as MCPAppRenderer,
  type MCPAppBridgeHandlers,
  type MCPAppResource,
} from '@ai-sdk/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UIMessage } from 'ai';

const MIN_HEIGHT = 180;
const MAX_HEIGHT = 720;
const INITIAL_HEIGHT = 280;
const INIT_TIMEOUT_MS = 8_000;
const HOST_INFO = { name: 'Agent Widget Starter', version: '0.1.0' };
const HOST_CONTEXT = { platform: 'web', displayMode: 'inline' as const, availableDisplayModes: ['inline' as const] };

type ToolPart = Extract<UIMessage['parts'][number], { toolCallId: string }>;
type ResourceEnvelope = MCPAppResource & Readonly<{ appTools: readonly string[] }>;

export default function McpApp({
  part,
  embedAncestorOrigin,
  fallback,
}: {
  part: ToolPart;
  embedAncestorOrigin?: string;
  fallback: ReactNode;
}) {
  const capabilityId = capabilityFor(part);
  const [resource, setResource] = useState<ResourceEnvelope>();
  const [failed, setFailed] = useState(!capabilityId);
  const [height, setHeight] = useState(INITIAL_HEIGHT);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!capabilityId) return;
    let cancelled = false;
    setResource(undefined);
    setFailed(false);
    setInitialized(false);
    fetchJson('/api/mcp/apps/resource', { capabilityId })
      .then(parseResource)
      .then((next) => { if (!cancelled) setResource(next); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [capabilityId]);

  useEffect(() => {
    if (!resource || initialized) return;
    const timeout = window.setTimeout(() => setFailed(true), INIT_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [initialized, resource]);

  const sandboxUrl = useMemo(() => {
    try { return resource && makeSandboxUrl(resource, embedAncestorOrigin); } catch { return undefined; }
  }, [embedAncestorOrigin, resource]);

  const handlers = useMemo<MCPAppBridgeHandlers>(() => ({
    allowedTools: [...(resource?.appTools ?? [])],
    callTool: async ({ name, arguments: args }) => parseToolResult(await fetchJson('/api/mcp/apps/tool', {
      capabilityId,
      name,
      arguments: args ?? {},
    })),
    openLink: ({ url }) => {
      const parsed = safeLink(url);
      if (!parsed) throw new Error('Only absolute HTTP(S) links are allowed');
      window.open(parsed.href, '_blank', 'noopener,noreferrer');
      return {};
    },
    onInitialized: () => setInitialized(true),
    onSizeChange: ({ height: requestedHeight }) => {
      if (typeof requestedHeight === 'number' && Number.isFinite(requestedHeight)) {
        setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(requestedHeight))));
      }
    },
    onError: () => setFailed(true),
  }), [capabilityId, resource?.appTools]);

  if (failed || resource && !sandboxUrl) return fallback;
  if (!resource || !sandboxUrl) return <div className="mcp-app-loading" role="status">Loading interactive app…</div>;
  // The experimental renderer sends its current tool state from onInitialized
  // and also flushes state queued before initialization. Hide state until that
  // handshake completes so a result that arrives while the app loads is sent
  // exactly once.
  const rendererPart = initialized ? part : withoutToolState(part);
  return (
    <section className="mcp-app-frame" aria-label="Interactive MCP App">
      <MCPAppRenderer
        part={rendererPart}
        resource={resource}
        handlers={handlers}
        hostInfo={HOST_INFO}
        hostContext={HOST_CONTEXT}
        sandbox={{
          url: sandboxUrl,
          title: 'Interactive MCP App',
          style: { height },
          allowedPermissions: ['camera', 'microphone', 'geolocation', 'clipboardWrite'],
        }}
        fallback={fallback}
      />
    </section>
  );
}

function withoutToolState(part: ToolPart): ToolPart {
  return { ...part, state: 'input-streaming', input: undefined } as ToolPart;
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
  if (!isRecord(value) || Object.keys(value).some((key) => !['uri', 'mimeType', 'html', 'meta', 'appTools'].includes(key))) {
    throw new Error('Invalid MCP App resource');
  }
  if (typeof value.uri !== 'string' || !value.uri.startsWith('ui://')
    || value.mimeType !== 'text/html;profile=mcp-app'
    || typeof value.html !== 'string' || new Blob([value.html]).size > 1_048_576) {
    throw new Error('Invalid MCP App resource');
  }
  if (!Array.isArray(value.appTools) || value.appTools.length > 200 || value.appTools.some((name) => typeof name !== 'string')) {
    throw new Error('Invalid app tool list');
  }
  return {
    uri: value.uri,
    mimeType: value.mimeType,
    html: value.html,
    meta: parseMeta(value.meta),
    appTools: value.appTools,
  };
}

function parseMeta(value: unknown): MCPAppResource['meta'] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => !['csp', 'permissions', 'domain', 'prefersBorder'].includes(key))) {
    throw new Error('Invalid MCP App metadata');
  }
  if (value.csp !== undefined) {
    if (!isRecord(value.csp) || Object.keys(value.csp).some((key) => !['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'].includes(key))) {
      throw new Error('Invalid MCP App CSP');
    }
    for (const domains of Object.values(value.csp)) {
      if (!Array.isArray(domains) || domains.length > 32 || domains.some((domain) => typeof domain !== 'string')) throw new Error('Invalid MCP App CSP');
    }
  }
  if (value.permissions !== undefined && (!isRecord(value.permissions)
    || Object.entries(value.permissions).some(([key, permission]) => !['camera', 'microphone', 'geolocation', 'clipboardWrite'].includes(key)
      || !isRecord(permission) || Object.keys(permission).length > 0))) {
    throw new Error('Invalid MCP App permissions');
  }
  return value as MCPAppResource['meta'];
}

function capabilityFor(part: ToolPart) {
  const value: unknown = part.toolMetadata?.app;
  const app = isRecord(value) ? value : undefined;
  return typeof app?.capabilityId === 'string' ? app.capabilityId : undefined;
}

function makeSandboxUrl(resource: MCPAppResource, embedAncestorOrigin?: string) {
  const configured = import.meta.env.VITE_MCP_SANDBOX_URL || 'http://localhost:8789/sandbox';
  const url = new URL(configured, window.location.href);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === window.location.origin) {
    throw new Error('MCP_SANDBOX_URL must use a distinct HTTP(S) origin');
  }
  url.search = '';
  url.searchParams.set('hostOrigin', window.location.origin);
  if (embedAncestorOrigin) url.searchParams.set('embedAncestorOrigin', embedAncestorOrigin);
  if (resource.meta?.csp) url.searchParams.set('csp', JSON.stringify(resource.meta.csp));
  if (resource.meta?.permissions) url.searchParams.set('permissions', JSON.stringify(resource.meta.permissions));
  return url.href;
}

function parseToolResult(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.content)
    || value.content.some((part) => !isRecord(part) || typeof part.type !== 'string')) {
    throw new Error('Invalid MCP tool result');
  }
  return value;
}

function safeLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
