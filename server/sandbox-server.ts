import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import type { McpUiCsp, McpUiPermissions } from './mcp.js';

const MAX_QUERY_BYTES = 8_192;

export function createSandboxServer(allowedOrigins = parseAllowedOrigins(process.env.MCP_HOST_ORIGINS)) {
  return createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://sandbox.invalid');
      if (request.method !== 'GET' || requestUrl.pathname !== '/sandbox') return plain(response, 404, 'Not found');
      if ((request.url?.length ?? 0) > MAX_QUERY_BYTES) return plain(response, 414, 'Request URI too long');
      const hostOrigin = exactOrigin(requestUrl.searchParams.get('hostOrigin'));
      const referrerOrigin = originFromReferrer(request.headers.referer);
      if (!hostOrigin || !allowedOrigins.has(hostOrigin) || referrerOrigin !== hostOrigin) return plain(response, 403, 'Forbidden');
      const csp = parseCspParam(requestUrl.searchParams.get('csp'));
      const permissions = parsePermissionsParam(requestUrl.searchParams.get('permissions'));
      const script = sandboxScript(hostOrigin, csp, permissions);
      response.writeHead(200, sandboxHeaders(hostOrigin, csp, permissions));
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>MCP App sandbox</title><style>html,body{margin:0;width:100%;height:100%;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><script>${script}</script></body></html>`);
    } catch {
      plain(response, 400, 'Invalid sandbox request');
    }
  });
}

export function sandboxHeaders(hostOrigin: string, csp?: McpUiCsp, permissions?: McpUiPermissions) {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': buildCsp(hostOrigin, csp),
    'permissions-policy': buildPermissionsPolicy(permissions),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'cross-origin',
  };
}

export function buildCsp(hostOrigin: string, csp?: McpUiCsp) {
  const resources = sanitizeDomains(csp?.resourceDomains, false);
  const connections = sanitizeDomains(csp?.connectDomains, true);
  const frames = sanitizeDomains(csp?.frameDomains, false);
  const bases = sanitizeDomains(csp?.baseUriDomains, false);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources.join(' ')}`.trim(),
    `style-src 'unsafe-inline' ${resources.join(' ')}`.trim(),
    `img-src data: ${resources.join(' ')}`.trim(),
    `font-src ${resources.length ? resources.join(' ') : "'none'"}`,
    `media-src data: ${resources.join(' ')}`.trim(),
    `connect-src ${connections.length ? connections.join(' ') : "'none'"}`,
    `frame-src ${frames.length ? frames.join(' ') : "'none'"}`,
    `base-uri ${bases.length ? bases.join(' ') : "'none'"}`,
    "object-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${hostOrigin}`,
  ].join('; ');
}

function sandboxScript(hostOrigin: string, csp: McpUiCsp | undefined, permissions: McpUiPermissions | undefined) {
  const expected = JSON.stringify({ csp, permissions });
  const allow = buildAllowAttribute(permissions);
  return `(() => {
    'use strict';
    const EXPECTED_HOST_ORIGIN = ${JSON.stringify(hostOrigin)};
    const EXPECTED_POLICY = ${JSON.stringify(expected)};
    const MAX_MESSAGE_BYTES = 1048576;
    let appFrame;
    const announceReady = () => window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, EXPECTED_HOST_ORIGIN);
    const readyInterval = window.setInterval(announceReady, 250);
    const valid = value => value && typeof value === 'object' && !Array.isArray(value) && value.jsonrpc === '2.0' && (typeof value.method === 'string' || Object.prototype.hasOwnProperty.call(value, 'id'));
    const bounded = value => { try { return JSON.stringify(value).length <= MAX_MESSAGE_BYTES; } catch { return false; } };
    const reserved = value => typeof value.method === 'string' && value.method.startsWith('ui/notifications/sandbox-');
    window.addEventListener('message', event => {
      if (event.source === window.parent) {
        if (event.origin !== EXPECTED_HOST_ORIGIN || !valid(event.data) || !bounded(event.data)) return;
        if (event.data.method === 'ui/notifications/sandbox-resource-ready') {
          if (appFrame || JSON.stringify({ csp: event.data.params?.csp, permissions: event.data.params?.permissions }) !== EXPECTED_POLICY) return;
          if (event.data.params?.sandbox !== 'allow-scripts allow-forms' || typeof event.data.params?.html !== 'string') return;
          window.clearInterval(readyInterval);
          appFrame = document.createElement('iframe');
          appFrame.setAttribute('sandbox', 'allow-scripts allow-forms');
          ${allow ? `appFrame.setAttribute('allow', ${JSON.stringify(allow)});` : ''}
          appFrame.srcdoc = event.data.params.html;
          document.body.append(appFrame);
        } else if (!reserved(event.data) && appFrame?.contentWindow) {
          appFrame.contentWindow.postMessage(event.data, '*');
        }
        return;
      }
      if (!appFrame || event.source !== appFrame.contentWindow || event.origin !== 'null' || !valid(event.data) || !bounded(event.data) || reserved(event.data)) return;
      window.parent.postMessage(event.data, EXPECTED_HOST_ORIGIN);
    });
    announceReady();
  })();`;
}

function sanitizeDomains(domains: readonly string[] | undefined, websocket: boolean) {
  if (!domains) return [];
  if (domains.length > 32) throw new Error('Too many CSP domains');
  return domains.map((domain) => {
    if (typeof domain !== 'string' || domain.length > 300 || /[\s;'"\\]/.test(domain)) throw new Error('Unsafe CSP domain');
    const match = domain.match(/^(https|wss):\/\/(\*\.)?([a-z0-9.-]+)(:\d{1,5})?$/i);
    if (!match || (!websocket && match[1]?.toLowerCase() !== 'https')) throw new Error('Invalid CSP origin');
    if (websocket && !['https', 'wss'].includes(match[1]!.toLowerCase())) throw new Error('Invalid connect origin');
    if (!match[3] || match[3].startsWith('.') || match[3].endsWith('.') || match[3].includes('..')) throw new Error('Invalid CSP host');
    return domain.toLowerCase();
  });
}

function parseCspParam(value: string | null): McpUiCsp | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error('Invalid CSP');
  const keys = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const;
  if (Object.keys(parsed).some((key) => !keys.includes(key as typeof keys[number]))) throw new Error('Invalid CSP key');
  for (const key of keys) if (parsed[key] !== undefined) sanitizeDomains(parsed[key] as string[], key === 'connectDomains');
  return parsed as McpUiCsp;
}

function parsePermissionsParam(value: string | null): McpUiPermissions | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error('Invalid permissions');
  const keys = new Set(['camera', 'microphone', 'geolocation', 'clipboardWrite']);
  if (Object.entries(parsed).some(([key, permission]) => !keys.has(key) || !isRecord(permission) || Object.keys(permission).length > 0)) throw new Error('Invalid permission');
  return parsed;
}

function buildAllowAttribute(permissions?: McpUiPermissions) {
  return [
    permissions?.camera && 'camera *',
    permissions?.microphone && 'microphone *',
    permissions?.geolocation && 'geolocation *',
    permissions?.clipboardWrite && 'clipboard-write *',
  ].filter(Boolean).join('; ');
}

function buildPermissionsPolicy(permissions?: McpUiPermissions) {
  return [
    `camera=${permissions?.camera ? '*' : '()'}`,
    `microphone=${permissions?.microphone ? '*' : '()'}`,
    `geolocation=${permissions?.geolocation ? '*' : '()'}`,
    `clipboard-write=${permissions?.clipboardWrite ? '*' : '()'}`,
  ].join(', ');
}

function parseAllowedOrigins(raw?: string) {
  const values = raw?.split(',').map((value) => value.trim()).filter(Boolean) ?? ['http://localhost:5173'];
  return new Set(values.map((value) => {
    const origin = exactOrigin(value);
    if (!origin) throw new Error(`Invalid MCP host origin: ${value}`);
    return origin;
  }));
}

function exactOrigin(value: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.href === `${url.origin}/` ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function originFromReferrer(value?: string) {
  if (!value) return undefined;
  try { return new URL(value).origin; } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plain(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
  response.end(body);
}

const entryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (entryPoint === import.meta.url) {
  const port = Number.parseInt(process.env.MCP_SANDBOX_PORT || '8789', 10);
  createSandboxServer().listen(port, '0.0.0.0', () => console.log(`MCP App sandbox listening on http://0.0.0.0:${port}`));
}
