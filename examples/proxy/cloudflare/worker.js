/**
 * ibh LLM proxy for Cloudflare Workers — zero dependencies, fail-closed.
 *
 * ibh talks to THIS worker (llm: { baseUrl: 'https://your-site.com/api/ibh-llm' });
 * the browser never sees the OpenRouter key. Your existing session cookie
 * authenticates the user (same-origin route on your zone), and this worker
 * forwards exactly two paths to OpenRouter:
 *
 *   POST /api/v1/chat/completions      (ibh's model client)
 *   POST /api/v1/audio/transcriptions  (ibh's ui.stt voice input)
 *
 * Required configuration (env / [vars] + secrets — see wrangler.toml):
 *   OPENROUTER_KEY          (secret)  server-side OpenRouter key
 *   AUTH_MODE               "jwt-hs256" | "remote"        — fail-closed if unset
 *   AUTH_SECRET             (jwt-hs256) HMAC secret for the session JWT
 *   AUTH_VERIFY_URL         (remote)    your app's session-verify endpoint;
 *                                       receives the caller's Cookie header,
 *                                       must answer 2xx (ok) or 4xx/5xx (reject)
 *   ALLOWED_MODELS          (var)     comma-separated model allowlist — the real
 *                                     server-side gate (the client manifest is
 *                                     advisory). Unset = allow any model.
 *   COOKIE_NAME             (var)     session cookie name (default "sid")
 *   ALLOWED_ORIGIN          (var)     optional: reject requests whose Origin
 *                                     header mismatches (defense in depth;
 *                                     same-origin deployments need no CORS)
 *
 * Rate limiting: prefer a Cloudflare WAF rate-limiting rule on the route (see
 * README). The in-isolate counter below is a best-effort fallback ONLY —
 * isolates churn and counters are per-colo, not global.
 */

// ibh appends /chat/completions (and /audio/transcriptions) to llm.baseUrl —
// by default '/api/ibh-llm'. The worker strips that mount prefix and forwards
// the suffix to OpenRouter's /api/v1/*.
const MOUNT_PATH_DEFAULT = '/api/ibh-llm';
const FORWARDED_PATHS = {
  // Chat carries multimodal messages: images are base64 data URLs (~1.37x raw
  // size), so the chat cap is generous; STT audio is compact and stays smaller.
  '/chat/completions': 25 * 1024 * 1024, // 25 MB
  '/audio/transcriptions': 8 * 1024 * 1024, // 8 MB
};

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/** Read the request body with a hard cap enforced DURING the read, so an
 * oversized chunked body is rejected before it is fully buffered. */
async function readBodyCapped(request, maxBody) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBody) return null;
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Best-effort per-isolate fallback limiter (see module docstring).
const fallbackHits = new Map();
const FALLBACK_LIMIT = 60; // requests per minute per IP

function fallbackRateOk(ip) {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `${ip}:${minute}`;
  const count = (fallbackHits.get(key) ?? 0) + 1;
  fallbackHits.set(key, count);
  if (fallbackHits.size > 10_000) fallbackHits.clear();
  return count <= FALLBACK_LIMIT;
}

function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function base64UrlToBytes(s) {
  let str = s.replaceAll('-', '+').replaceAll('_', '/');
  while (str.length % 4 !== 0) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.codePointAt(i);
  return bytes;
}

async function verifyJwtHS256(token, secret, env) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts;
  try {
    // explicit algorithm pinning (defense in depth — the verify key below is
    // imported as HMAC, so alg confusion is impossible, but make it explicit)
    const headerJson = JSON.parse(new TextDecoder().decode(base64UrlToBytes(header)));
    if (headerJson.alg !== 'HS256') return false;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(signature),
      new TextEncoder().encode(`${header}.${payload}`)
    );
    if (!valid) return false;
    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return false;
    if (env.AUTH_ISS && claims.iss !== env.AUTH_ISS) return false;
    if (env.AUTH_AUD && claims.aud !== env.AUTH_AUD) return false;
    return true;
  } catch {
    return false;
  }
}

async function verifySession(request, env) {
  const mode = env.AUTH_MODE;
  const cookieName = env.COOKIE_NAME || 'sid';
  const token = cookieValue(request.headers.get('cookie') || '', cookieName);
  if (!token) return false;

  if (mode === 'jwt-hs256') {
    if (!env.AUTH_SECRET) return false; // misconfigured -> fail closed
    return verifyJwtHS256(token, env.AUTH_SECRET, env);
  }
  if (mode === 'remote') {
    if (!env.AUTH_VERIFY_URL) return false; // misconfigured -> fail closed
    const res = await fetch(env.AUTH_VERIFY_URL, {
      method: 'GET',
      headers: { cookie: request.headers.get('cookie') || '' },
    });
    return res.ok;
  }
  return false; // no AUTH_MODE configured -> fail closed
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, string | undefined>} env
   */
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const mount = env.MOUNT_PATH || MOUNT_PATH_DEFAULT;
      const suffix = url.pathname.startsWith(mount) ? url.pathname.slice(mount.length) : url.pathname;
      const maxBody = FORWARDED_PATHS[suffix];
      if (maxBody === undefined) return jsonError(404, 'not found');
      const forwardPath = suffix; // OPENROUTER_BASE already includes /api/v1
      if (request.method !== 'POST') return jsonError(405, 'method not allowed');

      if (!env.OPENROUTER_KEY) {
        return jsonError(500, 'proxy misconfigured: set the OPENROUTER_KEY secret');
      }

      const origin = request.headers.get('origin');
      if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) {
        return jsonError(403, 'origin not allowed');
      }

      if (!env.AUTH_MODE) {
        return jsonError(
          500,
          'proxy misconfigured: set AUTH_MODE ("jwt-hs256" or "remote") — the proxy refuses to forward unauthenticated requests'
        );
      }
      if (!(await verifySession(request, env))) {
        return jsonError(403, 'forbidden');
      }

      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      if (!fallbackRateOk(ip)) return jsonError(429, 'rate limited');

      const declared = Number(request.headers.get('content-length') || '0');
      if (declared > maxBody) return jsonError(413, 'payload too large');
      const body = await readBodyCapped(request, maxBody);
      if (body === null) return jsonError(413, 'payload too large');

      if (env.ALLOWED_MODELS) {
        const allowed = env.ALLOWED_MODELS.split(',').map((s) => s.trim()).filter(Boolean);
        try {
          const parsed = JSON.parse(new TextDecoder().decode(body) || '{}');
          if (parsed.model && !allowed.includes(parsed.model)) {
            return jsonError(403, `model "${parsed.model}" is not allowed`);
          }
        } catch {
          /* non-JSON body: let OpenRouter produce the error */
        }
      }

      const upstream = await fetch(`${OPENROUTER_BASE}${forwardPath}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_KEY}`,
          'Content-Type': request.headers.get('content-type') ?? 'application/json',
          'X-Title': 'ibh-proxy',
        },
        body,
      });

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        },
      });
    } catch (e) {
      return jsonError(500, e instanceof Error ? e.message : String(e));
    }
  },
};
