import { controlMessage } from '../src/embed/protocol';
import { startWidget } from '../src/embed/loader';

describe('embed loader', () => {
  afterEach(() => {
    document.querySelector('[data-agent-widget-root]')?.remove();
  });

  it('requires both the iframe source and exact origin for close messages', () => {
    let root: ShadowRoot | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element) {
      root = original.call(this, { mode: 'open' });
      return root;
    });
    const script = document.createElement('script');
    script.src = `${window.location.origin}/embed.js`;
    script.dataset.widgetUrl = '/embed.html';
    const api = startWidget(script)!;
    api.open();

    const panel = root!.querySelector<HTMLElement>('.agent-panel')!;
    const frame = root!.querySelector<HTMLIFrameElement>('iframe')!;
    expect(panel.hidden).toBe(false);

    window.dispatchEvent(new MessageEvent('message', {
      data: controlMessage('REQUEST_CLOSE'),
      origin: window.location.origin,
      source: window,
    }));
    expect(panel.hidden).toBe(false);

    window.dispatchEvent(new MessageEvent('message', {
      data: controlMessage('REQUEST_CLOSE'),
      origin: 'https://attacker.example',
      source: frame.contentWindow,
    }));
    expect(panel.hidden).toBe(false);

    window.dispatchEvent(new MessageEvent('message', {
      data: controlMessage('REQUEST_CLOSE'),
      origin: window.location.origin,
      source: frame.contentWindow,
    }));
    expect(panel.hidden).toBe(true);
  });
});
