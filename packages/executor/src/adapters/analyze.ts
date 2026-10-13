/**
 * Analyze sandbox: runs model-written JavaScript as a pure function over data the
 * model explicitly passes in. The sandbox is a fresh, hidden iframe with:
 *   - sandbox="allow-scripts" (opaque origin: no cookies, no storage, no DOM of the host)
 *   - CSP `default-src 'none'` (no network of any kind)
 * so the only thing it can do is compute on the data it was given and return a
 * JSON-serializable result.
 */

const MAX_CODE_CHARS = 20_000;
const TIMEOUT_MS = 5_000;

export interface AnalyzeExecutor {
  run(code: string, data: unknown): Promise<unknown>;
}

const SRCDOC = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
</head><body><script>
window.addEventListener('message', function (ev) {
  var _a = ev.data, id = _a.id, code = _a.code, data = _a.data;
  var respond = function (payload) { parent.postMessage(Object.assign({ id: id }, payload), '*'); };
  var normalize = function (r) {
    if (r === undefined) return null;
    try { return JSON.parse(JSON.stringify(r)); } catch (e) { return String(r); }
  };
  var result;
  try {
    var fn = new Function('data', '"use strict";\\n' + code);
    result = fn(data);
  } catch (e) {
    respond({ ok: false, error: String((e && e.message) || e) });
    return;
  }
  if (result && typeof result.then === 'function') {
    result.then(function (v) { respond({ ok: true, result: normalize(v) }); },
                function (e) { respond({ ok: false, error: String((e && e.message) || e) }); });
    return;
  }
  respond({ ok: true, result: normalize(result) });
});
</script></body></html>`;

export class AnalyzeAdapter implements AnalyzeExecutor {
  run(code: string, data: unknown): Promise<unknown> {
    if (typeof code !== 'string' || code.length === 0) {
      return Promise.reject(new Error('analyze: "code" must be a non-empty string'));
    }
    if (code.length > MAX_CODE_CHARS) {
      return Promise.reject(new Error(`analyze: code exceeds ${MAX_CODE_CHARS} characters`));
    }
    let safeData: unknown;
    try {
      safeData = data === undefined ? null : JSON.parse(JSON.stringify(data));
    } catch {
      return Promise.reject(new Error('analyze: "data" must be JSON-serializable'));
    }

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('data-ibh-ignore', '');
    Object.assign(iframe.style, { display: 'none', width: '0', height: '0', border: '0' });
    iframe.srcdoc = SRCDOC;

    const id = `sbx-${Math.random().toString(36).slice(2)}`;
    const cleanup = () => iframe.remove();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        cleanup();
        reject(new Error('analyze: sandbox timed out (5s) — the code likely contains an infinite loop'));
      }, TIMEOUT_MS);

      const onMessage = (ev: MessageEvent) => {
        if (ev.source !== iframe.contentWindow) return;
        const d = ev.data as { id?: string; ok?: boolean; result?: unknown; error?: string };
        if (!d || d.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        cleanup();
        if (d.ok) resolve(d.result);
        else reject(new Error(`analyze error: ${d.error ?? 'unknown sandbox error'}`));
      };

      iframe.addEventListener('load', () => {
        iframe.contentWindow?.postMessage({ id, code, data: safeData }, '*');
      });
      window.addEventListener('message', onMessage);
      document.body.append(iframe);
    });
  }
}
