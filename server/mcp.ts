import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';

export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export type McpServerConfig = Readonly<{
  id: string;
  url: string;
  headers?: Readonly<Record<string, string>>;
}>;

export type McpAppMetadata = Readonly<{
  capabilityId: string;
  resourceUri: string;
  mimeType: typeof MCP_APP_MIME_TYPE;
}>;

export type DiscoveredTool = Readonly<{
  modelName: string;
  serverId: string;
  remoteName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  app?: McpAppMetadata;
}>;

export type AppResource = Readonly<{
  html: string;
  csp?: McpUiCsp;
  permissions?: McpUiPermissions;
  appTools: readonly string[];
}>;

export type McpUiCsp = Readonly<{
  connectDomains?: readonly string[];
  resourceDomains?: readonly string[];
  frameDomains?: readonly string[];
  baseUriDomains?: readonly string[];
}>;

export type McpUiPermissions = Readonly<{
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
}>;

type ConnectedServer = {
  config: McpServerConfig;
  client: Client;
  tools: Tool[];
};

type AppGrant = {
  server: ConnectedServer;
  resourceUri: string;
  sourceTool: string;
  appTools: Set<string>;
};

export class McpRegistry {
  readonly #configs: readonly McpServerConfig[];
  readonly #connections = new Map<string, Promise<ConnectedServer>>();
  readonly #grants = new Map<string, AppGrant>();

  constructor(configs: readonly McpServerConfig[]) {
    this.#configs = configs;
  }

  get enabled() {
    return this.#configs.length > 0;
  }

  async discover(): Promise<DiscoveredTool[]> {
    const servers = await Promise.all(this.#configs.map((config) => this.#connect(config)));
    return servers.flatMap((server) => {
      return server.tools.flatMap((tool) => {
        if (!visibility(tool).includes('model')) return [];
        const resourceUri = resourceUriFor(tool);
        const appTools = new Set(server.tools
          .filter((candidate) => visibility(candidate).includes('app') && resourceUriFor(candidate) === resourceUri)
          .map((candidate) => candidate.name));
        const app = resourceUri ? this.#grant(server, tool.name, resourceUri, appTools) : undefined;
        return [{
          modelName: `${safeName(server.config.id)}__${safeName(tool.name)}`,
          serverId: server.config.id,
          remoteName: tool.name,
          description: tool.description,
          inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' },
          app,
        }];
      });
    });
  }

  async callModelTool(tool: DiscoveredTool, input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const server = await this.#server(tool.serverId);
    const current = server.tools.find((candidate) => candidate.name === tool.remoteName);
    if (!current || !visibility(current).includes('model')) throw new Error('MCP tool is no longer available');
    const result = await server.client.callTool({ name: current.name, arguments: objectArguments(input) }, { signal });
    if (result.isError) throw new Error(textResult(result) || `MCP tool ${current.name} failed`);
    return result;
  }

  async readAppResource(capabilityId: string): Promise<AppResource> {
    const grant = this.#requireGrant(capabilityId);
    this.#reauthorizeGrant(grant);
    const result = await grant.server.client.readResource({ uri: grant.resourceUri });
    if (result.contents.length !== 1) throw new Error('MCP App resource must contain exactly one item');
    const content = result.contents[0];
    if (content.uri !== grant.resourceUri || content.mimeType !== MCP_APP_MIME_TYPE) throw new Error('MCP App resource did not match its declaration');
    const html = 'text' in content ? content.text : 'blob' in content ? decodeBase64(content.blob) : undefined;
    if (typeof html !== 'string' || byteLength(html) > 1_048_576) throw new Error('MCP App resource is invalid or too large');
    const ui = parseResourceUi(content._meta);
    return { html, csp: ui.csp, permissions: ui.permissions, appTools: [...grant.appTools] };
  }

  async callAppTool(capabilityId: string, name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const grant = this.#requireGrant(capabilityId);
    this.#reauthorizeGrant(grant);
    if (!grant.appTools.has(name)) throw new Error('This app is not allowed to call that tool');
    const current = grant.server.tools.find((tool) => tool.name === name);
    if (!current || !visibility(current).includes('app') || resourceUriFor(current) !== grant.resourceUri) throw new Error('This app tool is no longer available');
    return grant.server.client.callTool({ name, arguments: objectArguments(args) }, { signal });
  }

  async close() {
    for (const connection of this.#connections.values()) await (await connection).client.close().catch(() => undefined);
    this.#connections.clear();
    this.#grants.clear();
  }

  #grant(server: ConnectedServer, sourceTool: string, resourceUri: string, appTools: Set<string>): McpAppMetadata {
    const existing = [...this.#grants].find(([, grant]) => grant.server === server && grant.sourceTool === sourceTool && grant.resourceUri === resourceUri);
    const capabilityId = existing?.[0] ?? randomUUID();
    if (!existing) this.#grants.set(capabilityId, { server, sourceTool, resourceUri, appTools });
    return { capabilityId, resourceUri, mimeType: MCP_APP_MIME_TYPE };
  }

  #requireGrant(capabilityId: string) {
    const grant = this.#grants.get(capabilityId);
    if (!grant) throw new Error('Unknown MCP App capability');
    return grant;
  }

  #reauthorizeGrant(grant: AppGrant) {
    const source = grant.server.tools.find((tool) => tool.name === grant.sourceTool);
    if (!source || resourceUriFor(source) !== grant.resourceUri || !visibility(source).includes('model')) {
      throw new Error('MCP App capability is no longer valid');
    }
  }

  async #server(id: string) {
    const config = this.#configs.find((candidate) => candidate.id === id);
    if (!config) throw new Error('Unknown MCP server');
    return this.#connect(config);
  }

  #connect(config: McpServerConfig): Promise<ConnectedServer> {
    const existing = this.#connections.get(config.id);
    if (existing) return existing;
    const pending = (async () => {
      const client = new Client({ name: 'agent-widget-starter', version: '0.2.0' }, {
        capabilities: {
          extensions: {
            'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APP_MIME_TYPE] },
          },
        },
      });
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers },
      });
      await client.connect(transport);
      const { tools } = await client.listTools();
      return { config, client, tools };
    })();
    this.#connections.set(config.id, pending);
    pending.catch(() => this.#connections.delete(config.id));
    return pending;
  }
}

export function parseMcpConfig(raw = process.env.MCP_SERVERS): McpServerConfig[] {
  if (!raw?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('MCP_SERVERS must be valid JSON');
  }
  if (!Array.isArray(value)) throw new Error('MCP_SERVERS must be a JSON array');
  const ids = new Set<string>();
  return value.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(item.id) || typeof item.url !== 'string') {
      throw new Error('Each MCP server needs a safe id and an HTTP(S) url');
    }
    const url = new URL(item.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('MCP server URLs must use HTTP(S)');
    if (ids.has(item.id)) throw new Error(`Duplicate MCP server id: ${item.id}`);
    ids.add(item.id);
    let headers: Record<string, string> | undefined;
    if (item.headers !== undefined) {
      if (!isRecord(item.headers) || Object.values(item.headers).some((header) => typeof header !== 'string')) throw new Error('MCP server headers must be strings');
      headers = item.headers as Record<string, string>;
    }
    return { id: item.id, url: url.href, headers };
  });
}

function resourceUriFor(tool: Tool): string | undefined {
  const meta = isRecord(tool._meta) ? tool._meta : undefined;
  const ui = meta && isRecord(meta.ui) ? meta.ui : undefined;
  const uri = ui?.resourceUri;
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : undefined;
}

function visibility(tool: Tool): ('model' | 'app')[] {
  const meta = isRecord(tool._meta) ? tool._meta : undefined;
  const ui = meta && isRecord(meta.ui) ? meta.ui : undefined;
  if (ui?.visibility === undefined) return ['model', 'app'];
  if (!Array.isArray(ui.visibility)) return [];
  return ui.visibility.filter((item): item is 'model' | 'app' => item === 'model' || item === 'app');
}

function parseResourceUi(meta: unknown): { csp?: McpUiCsp; permissions?: McpUiPermissions } {
  if (!isRecord(meta) || !isRecord(meta.ui)) return {};
  const ui = meta.ui;
  const allowedUi = new Set(['csp', 'permissions', 'domain', 'prefersBorder']);
  if (Object.keys(ui).some((key) => !allowedUi.has(key))) throw new Error('MCP App resource metadata contains unsupported fields');
  return { csp: parseCsp(ui.csp), permissions: parsePermissions(ui.permissions) };
}

function parseCsp(value: unknown): McpUiCsp | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('MCP App CSP is invalid');
  const keys = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const;
  if (Object.keys(value).some((key) => !keys.includes(key as typeof keys[number]))) throw new Error('MCP App CSP contains unsupported directives');
  const parsed: Record<string, readonly string[]> = {};
  for (const key of keys) {
    const domains = value[key];
    if (domains === undefined) continue;
    if (!Array.isArray(domains) || domains.length > 32 || domains.some((domain) => typeof domain !== 'string')) throw new Error('MCP App CSP domains are invalid');
    parsed[key] = domains;
  }
  return parsed;
}

function parsePermissions(value: unknown): McpUiPermissions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('MCP App permissions are invalid');
  const keys = new Set(['camera', 'microphone', 'geolocation', 'clipboardWrite']);
  if (Object.entries(value).some(([key, permission]) => !keys.has(key) || !isRecord(permission) || Object.keys(permission).length > 0)) {
    throw new Error('MCP App permissions are invalid');
  }
  return value;
}

function objectArguments(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('MCP tool arguments must be an object');
  return value;
}

function textResult(result: CallToolResult) {
  return result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function decodeBase64(value: string) {
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw new Error('MCP App resource blob is invalid');
  return buffer.toString('utf8');
}

function byteLength(value: string) {
  return Buffer.byteLength(value, 'utf8');
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
