# Agent Widget Starter

A source-first starter for a customizable AI chat widget. It includes a polished React chat, a standalone page, an iframe embed, a sample host website, and a small Node streaming backend. Everything you are expected to change is ordinary TypeScript, React, and CSS in this repository—there is no component package to publish and no hosted account to create.

## Start locally

Requirements: Node.js 20.19 or newer.

```bash
npm install
cp .env.example .env # optional
npm run dev
```

Open:

- `http://localhost:5173/` — standalone chat
- `http://localhost:5173/example.html` — sample website with the floating embed

Without `OPENAI_API_KEY`, the backend streams deterministic mock responses. With a key, it uses the model in `OPENAI_MODEL` (default: `gpt-4o-mini`). The browser never receives the provider key.

`server/index.ts` loads `.env` with `dotenv` in development and in the compiled server. To run the production build locally:

```bash
npm run build
npm run start:server
```

## Customize the source

| Concern | Source |
| --- | --- |
| Layout, copy, and tool cards | `src/chat/ChatWidget.tsx` |
| Colors, spacing, and responsive design | `src/styles.css` |
| React chat state | `src/chat/use-chat.ts` |
| Network/session seam | `src/chat/types.ts` and `src/transport/http-chat-transport.ts` |
| Embed launcher and panel | `src/embed/loader.ts` |
| Iframe host | `src/embed-main.tsx` |
| LLM backend and mock mode | `server/index.ts` |

The UI depends only on the small `ChatTransport` interface. To use your existing API, implement `stream()` in a new adapter and pass it to `ChatWidget`. Authentication headers can be added without touching UI code:

```ts
const transport = new HttpChatTransport({
  endpoint: '/api/my-assistant',
  getHeaders: async () => ({ authorization: `Bearer ${await getAccessToken()}` }),
});
```

The included NDJSON wire format emits one JSON object per line:

```json
{"type":"text-delta","text":"Hello"}
```

The source types also reserve a generic `tool` stream event and `ToolDisplay`. This is the intended seam for your own backend tools. It does not implement MCP Apps, remote tool execution, a proxy, or sandboxing.

## Embed on a website

`npm run build` produces the app pages plus `dist/embed.js`. Serve `embed.js`, `embed.html`, the generated assets, and `/api/chat` from your own infrastructure.

```html
<script
  src="https://chat.example.com/embed.js"
  data-widget-url="https://chat.example.com/embed.html"
  data-title="Acme support"
></script>
```

Host-page controls are available after the script loads:

```js
window.AgentWidget.open();
window.AgentWidget.open({ message: 'Help me choose a plan' });
window.AgentWidget.close();
window.AgentWidget.toggle();
```

The loader renders in a closed shadow root and the chat runs in an iframe. Both sides validate the exact message origin **and** expected window source before accepting control messages. Keep `data-widget-url` pinned to a URL you operate. If the website and widget are on different origins, configure your backend and reverse proxy deliberately; do not use wildcard credentialed CORS.

## Production responsibilities

This repository is a starter, not a hosted service. Before production, you must provide:

- **Authentication and authorization:** authenticate users at your backend, derive tenant/user identity server-side, authorize every chat and tool call, and never trust identity supplied by the browser.
- **Rate limits and budgets:** apply per-user/IP/tenant limits, request-size limits, model token limits, timeouts, concurrency limits, and spend alerts. The sample only applies basic body/message limits.
- **Persistence and privacy:** decide whether conversations should persist, obtain appropriate consent, encrypt stored data, define retention/deletion, redact logs, and keep provider keys server-side. The starter intentionally keeps messages in React memory only.
- **Abuse and safety:** add moderation appropriate to your use case, validate tool inputs and outputs, and require authorization before consequential actions.
- **Operations:** add structured logs without secrets, tracing, health checks, retries where safe, monitoring, and a deployment-specific Content Security Policy.

## Commands

```bash
npm test       # Vitest unit/component tests
npm run typecheck
npm run build  # app, iframe, embed loader, and server
```

CI runs all three checks. Build output is ignored; this repository ships editable source, not committed compiled artifacts.

## License and provenance

Original project code is MIT licensed; see [LICENSE](LICENSE). Dependency license information and design-reference provenance are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
