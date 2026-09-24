import { controlMessage, parseControlMessage, promptMessage } from './protocol';

const STYLE = `
:host{all:initial;color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
button{font:inherit}
.agent-launcher{position:fixed;z-index:2147483646;right:clamp(16px,3vw,28px);bottom:clamp(16px,3vw,28px);display:grid;place-items:center;width:58px;height:58px;border:0;border-radius:999px;background:#172b27;color:#fff;box-shadow:0 12px 36px #152b2640;cursor:pointer;transition:transform .2s ease,background .2s ease}
.agent-launcher:hover{transform:translateY(-2px);background:#21433b}.agent-launcher:focus-visible{outline:3px solid #82d5bd;outline-offset:3px}.agent-launcher svg{width:25px;height:25px}
.agent-panel{position:fixed;z-index:2147483645;right:clamp(12px,3vw,28px);bottom:clamp(86px,10vw,100px);width:min(408px,calc(100vw - 24px));height:min(660px,calc(100dvh - 112px));overflow:hidden;border:1px solid #dfe7e4;border-radius:20px;background:#fff;box-shadow:0 24px 70px #152b2638}.agent-panel[hidden]{display:none}.agent-panel iframe{display:block;width:100%;height:100%;border:0;background:#fff}
@media(max-width:520px){.agent-panel{inset:8px 8px 84px;width:auto;height:auto;border-radius:16px}.agent-launcher{right:16px;bottom:16px}}
@media(prefers-reduced-motion:no-preference){.agent-panel:not([hidden]){animation:agent-in .18s ease-out}@keyframes agent-in{from{opacity:0;transform:translateY(10px) scale(.98)}}}
`;

export type AgentWidgetApi = Readonly<{
  open(options?: { message?: string }): void;
  close(): void;
  toggle(): void;
}>;

declare global {
  interface Window { AgentWidget: AgentWidgetApi }
}

export function startWidget(script: HTMLScriptElement): AgentWidgetApi | undefined {
  if (document.querySelector('[data-agent-widget-root]')) return window.AgentWidget;
  const rawWidgetUrl = script.dataset.widgetUrl?.trim();
  if (!rawWidgetUrl) return undefined;

  let widgetUrl: URL;
  try {
    widgetUrl = new URL(rawWidgetUrl, script.src || window.location.href);
  } catch {
    return undefined;
  }
  if (widgetUrl.protocol !== 'http:' && widgetUrl.protocol !== 'https:') return undefined;
  const parentOrigin = window.location.origin;
  if (parentOrigin === 'null') return undefined;
  widgetUrl.searchParams.set('parentOrigin', parentOrigin);
  if (script.dataset.title?.trim()) widgetUrl.searchParams.set('title', script.dataset.title.trim());
  const widgetOrigin = widgetUrl.origin;

  const host = document.createElement('div');
  host.dataset.agentWidgetRoot = '';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const panel = document.createElement('section');
  panel.className = 'agent-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'AI assistant');
  const frame = document.createElement('iframe');
  frame.title = script.dataset.title?.trim() || 'AI assistant';
  frame.referrerPolicy = 'strict-origin';
  frame.addEventListener('load', () => {
    frame.contentWindow?.postMessage(controlMessage(open ? 'OPEN' : 'CLOSE'), widgetOrigin);
  });
  frame.src = widgetUrl.href;
  panel.append(frame);
  const launcher = document.createElement('button');
  launcher.className = 'agent-launcher';
  launcher.type = 'button';
  launcher.setAttribute('aria-label', 'Open chat');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/></svg>';
  shadow.append(style, panel, launcher);
  (document.body ?? document.documentElement).append(host);

  let open = false;
  let ready = false;
  const queuedPrompts: string[] = [];
  const setOpen = (next: boolean) => {
    open = next;
    panel.hidden = !next;
    launcher.setAttribute('aria-expanded', String(next));
    launcher.setAttribute('aria-label', next ? 'Close chat' : 'Open chat');
    if (ready) frame.contentWindow?.postMessage(controlMessage(next ? 'OPEN' : 'CLOSE'), widgetOrigin);
    (next ? frame : launcher).focus();
  };
  const api: AgentWidgetApi = {
    open(options) {
      setOpen(true);
      const message = options?.message?.trim();
      if (!message || message.length > 16_000) return;
      if (ready) frame.contentWindow?.postMessage(promptMessage(message), widgetOrigin);
      else queuedPrompts.push(message);
    },
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
  };
  window.AgentWidget = api;
  launcher.addEventListener('click', api.toggle);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) api.close();
  });
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.origin !== widgetOrigin) return;
    const message = parseControlMessage(event.data);
    if (message?.type === 'READY' && !ready) {
      ready = true;
      if (open) frame.contentWindow?.postMessage(controlMessage('OPEN'), widgetOrigin);
      for (const prompt of queuedPrompts.splice(0)) frame.contentWindow?.postMessage(promptMessage(prompt), widgetOrigin);
    } else if (message?.type === 'REQUEST_CLOSE' && open) {
      api.close();
    }
  });
  return api;
}

export function findLoaderScript(): HTMLScriptElement | undefined {
  if (document.currentScript instanceof HTMLScriptElement) return document.currentScript;
  return [...document.scripts].reverse().find((script) => {
    try {
      const path = new URL(script.src).pathname;
      return path.endsWith('/embed.js') || path.endsWith('/src/embed/loader.ts');
    } catch {
      return false;
    }
  });
}

function autoStart() {
  const script = findLoaderScript();
  if (script) startWidget(script);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'complete') autoStart();
  else window.addEventListener('load', autoStart, { once: true });
}
