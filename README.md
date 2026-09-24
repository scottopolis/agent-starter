# Agent Widget Starter

A source-first, customizable AI chat widget with an optional MCP Apps host. It includes a React standalone chat, an iframe embed and launcher, a Node/AI SDK backend, server-side MCP tool discovery and execution, and isolated inline MCP App rendering. Everything is editable TypeScript, React, and CSS—there is no hosted account, proprietary runtime, or compiled output in the repository.

MCP is optional. With no provider or MCP configuration, ordinary chat runs in deterministic mock mode.

## Quickstart: ordinary chat

Requirements: Node.js 22 or newer. The pinned AI SDK React and MCP packages require Node 22.

```bash
npm ci
cp .env.example .env # optional
npm run dev
```

Open `http://localhost:5173/` for standalone chat or `http://localhost:5173/example.html` for the sample site and floating embed. `npm run dev` starts the web app, chat API, and the separate-origin sandbox service; no MCP server is required.

### Connect an LLM provider

Set `OPENAI_API_KEY` in `.env`; the executable backend uses `OPENAI_MODEL` (default `gpt-4o-mini`). Provider credentials stay in Node and are never returned to the browser. `MAX_STEPS` configures the agent tool-loop limit from 1–100 (default 5).

In provider mode, ask **“Issue a demo refund of $25 to Alex.”** The model calls the built-in simulated refund tool, the chat pauses for explicit approval, and only an approved request executes. This demonstrates the AI SDK approval protocol without making an external change. The sample signs approval requests and keeps the authoritative tool input server-side; a production application must additionally authenticate the user and authorize the action on the server.

`createChatServer` accepts any AI SDK `LanguageModel`, so applications can inject another provider without changing the server module. Environment and OpenAI wiring live only in the executable entry point:

```ts
const server = createChatServer({ model: myLanguageModel, maxSteps: 8, mcp: registry });
```

## Quickstart: real local MCP App

The repository includes a real Streamable HTTP MCP server with a counter tool, `ui://` HTML resource, and app-only increment tool. It needs no external account or LLM key:

```bash
npm run dev:demo
```

Open the standalone or embedded chat and ask **“Show the MCP counter demo.”** Mock chat deterministically calls the discovered fixture tool. The resulting app is fetched through the backend, rendered in the distinct-origin sandbox, receives its tool input/result, and can call the app-only increment tool through the host. The browser never connects to the MCP endpoint.

`npm run demo:mcp` runs only the fixture at `http://127.0.0.1:8790/mcp` when separate processes are more convenient.

## Connect your own MCP server

Set `MCP_SERVERS` to a JSON array. Each `id` namespaces model-facing tool names; `url` is a Streamable HTTP endpoint; optional headers remain server-side.

```dotenv
MCP_SERVERS=[{"id":"support","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer server-only-token"}}]
```

At request time, the backend connects with the official MCP client, advertises `io.modelcontextprotocol/ui`, discovers tools, hides app-only tools from the model, converts model-visible schemas into AI SDK tools, executes real tool calls, and streams standard AI SDK UI-message parts over SSE. A tool becomes an inline app when `_meta.ui.resourceUri` is a `ui://` URI and `resources/read` returns `text/html;profile=mcp-app`.

This starter supports Streamable HTTP. Add another server-side MCP transport in `server/mcp.ts` if you need stdio; do not connect the browser directly to credentialed MCP services.

## Customize the source

| Concern | Source |
| --- | --- |
| Layout, copy, normal tool cards | `src/chat/ChatWidget.tsx` |
| Inline app policy and AI SDK renderer | `src/chat/McpApp.tsx` |
| Colors, responsive layout, app frame | `src/styles.css` |
| Default React state and UI-message rendering | `src/chat/ChatWidget.tsx` |
| HTTP transport wiring | `src/main.tsx`, `src/embed-main.tsx` |
| LLM/mock orchestration and browser API | `server/index.ts` |
| MCP connection, discovery, grants, calls | `server/mcp.ts` |
| Separate-origin sandbox and CSP | `server/sandbox-server.ts` |
| Local MCP server/app fixture | `server/demo-mcp.ts` |
| Embed launcher and parent protocol | `src/embed/loader.ts`, `src/embed-main.tsx` |

The default app uses `@ai-sdk/react` `useChat`, AI SDK `UIMessage`, and `DefaultChatTransport`. To connect another standard UI-message endpoint, pass a transport to `ChatWidget`; authentication headers belong in that transport:

```ts
const transport = new DefaultChatTransport({
  api: '/api/my-assistant',
  headers: async () => ({ authorization: `Bearer ${await getAccessToken()}` }),
});
```

The rendering code consumes standard UI-message text and tool parts rather than a starter-specific message model. That makes it source-compatible with other AI SDK-shaped state owners, but it is not a promise that different connection hooks are interchangeable. In particular, an application using persisted WebSockets, recovery, approvals, or browser-executed tools should retain its own hook/backend and adapt the source rendering boundary instead of adopting this sample HTTP server.

## Browser/backend contracts

`POST /api/chat` uses the [AI SDK UI message stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) (`text/event-stream`). The browser sends `{ id, messages, trigger, messageId? }`; streamed text and tool calls/results use standard `UIMessageChunk` events.

The sample server owns authoritative conversation history in memory, keyed by chat ID. It accepts only the latest validated user message or an approval decision that matches a pending server-generated request; it does not trust browser-supplied tool inputs or outputs. Server-generated tool calls/results persist across turns. This is safe for a single sample process, not durable storage: conversations and the per-process approval signing key disappear on restart, and production hosts must bind persistent history to authenticated users.

The browser can use only the opaque capability issued for a discovered app tool:

- `POST /api/mcp/apps/resource` with `{ "capabilityId": "..." }` returns `{ html, csp?, permissions?, appTools }`.
- `POST /api/mcp/apps/tool` with `{ "capabilityId": "...", "name": "discovered-app-tool", "arguments": {} }` returns the MCP `CallToolResult`.

The backend ignores browser-selected URLs and reauthorizes the source resource, same MCP connection, and app-visible target tool. Unknown capabilities, resources, and tool names are denied. `isError: true` remains an MCP error result for app calls and is thrown for model execution; it is never presented as model-tool success.

If you replace these endpoints, preserve their constraints and add your own authenticated session binding. The in-memory opaque ID in this sample is capability routing, **not tenant authorization**.

## Sandbox deployment

Web hosts use the MCP Apps double-iframe pattern:

```text
widget origin → trusted sandbox proxy origin → opaque-origin MCP App iframe
```

`server/sandbox-server.ts` must be hosted on a distinct origin (a different port is sufficient locally). Configure both sides:

```dotenv
VITE_MCP_SANDBOX_URL=https://mcp-sandbox.example.com/sandbox
MCP_HOST_ORIGINS=https://chat.example.com
MCP_EMBED_ANCESTOR_ORIGINS=https://www.example.com,https://portal.example.com
```

`VITE_MCP_SANDBOX_URL` is a frontend build setting. `MCP_HOST_ORIGINS` is a comma-separated exact allowlist of widget origins enforced by the sandbox service. `MCP_EMBED_ANCESTOR_ORIGINS` is the non-wildcard allowlist of website origins that may contain the embedded widget **when those origins differ from the widget origin**. A same-origin website needs no extra entry. CSP checks the sandbox's complete frame tree, so explicitly list every different website origin that can be an ancestor. The embed passes its validated parent origin to the sandbox, which rejects unconfigured different origins and emits the configured origins in `frame-ancestors` alongside the widget origin.

Both `dev:sandbox` and `start:sandbox` load these values and `MCP_SANDBOX_PORT` from `.env`. The service also requires a matching widget request referrer, emits restrictive response headers, validates structured CSP origins, and denies undeclared network/frame/base access. It never inserts raw CSP directives. Host and proxy validate exact `postMessage` window sources and origins; the proxy accepts the inner app only from its opaque (`null`) origin.

The pinned experimental `@ai-sdk/react` MCP App renderer handles the Apps bridge lifecycle, and `@ai-sdk/mcp` supplies discovery/resource helpers. The surrounding host still enforces opaque capabilities, app-tool allowlists, exact origins, sandbox CSP, safe absolute HTTP(S) links, bounded height, and initialization timeout. It forwards complete browser-facing tool results—including MCP `_meta`—while `toModelOutput` excludes `_meta` from model input. Failures retain a readable non-interactive tool-result fallback. Because the React renderer is experimental, keep its version pinned and rerun the security and browser tests before upgrading it.

For a production build, serve the widget files/API from your chat origin and run `npm run start:sandbox` behind the configured sandbox origin. Never collapse the sandbox onto the widget origin or replace it with direct `srcdoc` in the host page.

## Embed on a website

`npm run build` produces app pages plus `dist/embed.js`; build output is ignored and is not committed. Serve `embed.js`, `embed.html`, generated assets, `/api/chat`, and `/api/mcp/apps/*` from infrastructure you operate.

```html
<script
  src="https://chat.example.com/embed.js"
  data-widget-url="https://chat.example.com/embed.html"
  data-title="Acme support"
></script>
```

```js
window.AgentWidget.open();
window.AgentWidget.open({ message: 'Help me choose a plan' });
window.AgentWidget.close();
window.AgentWidget.toggle();
```

The launcher uses a closed shadow root and chat runs in an iframe. Parent and child validate exact message origin and window source. Pin `data-widget-url` to an origin you operate; configure non-wildcard CORS deliberately if API and widget origins differ.

## Production responsibilities

This is a starter, not an authorization gateway. Before production:

- Authenticate every browser request and derive user/tenant identity server-side. Bind app capabilities to that authenticated session and conversation; never trust browser identity or assume this sample proxy grants tenant access.
- Authorize each MCP server, model-visible tool, resource, and app-initiated tool call for the current tenant and user. Add approval for consequential actions.
- Store MCP/provider credentials in a secret manager. Redact logs and errors; never put credentials in `VITE_*` variables or app resources.
- Add per-user/IP/tenant rate limits, request/tool-result/token size limits, timeouts, concurrency and spend budgets. The sample has basic body, app HTML, CSP, and message limits only.
- Add persistence, consent, retention/deletion, moderation, structured audit logs, tracing, health checks, and safe retry policy appropriate to your product.
- Review requested app domains/permissions against your own allow/block policy. Sandboxing limits technical access but does not prevent deceptive UI or all resource-exhaustion attacks.

## Checks

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit
```

Tests cover ordinary chat with MCP disabled, standard SSE transport, server-owned tool history, browser-history forgery rejection, `_meta` separation, real fixture discovery/resource/tool calls, delayed app initialization, app/model error semantics, denied capabilities/tools, exact source/origin checks, restrictive CSP parsing, embed behavior, and streaming races.

## License and provenance

Original project code is MIT licensed; see [LICENSE](LICENSE). Dependency licenses and behavioral-reference provenance are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
