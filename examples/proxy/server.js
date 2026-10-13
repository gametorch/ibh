// Minimal ibh LLM proxy — zero dependencies, Node >= 20.
//
//   OPENROUTER_KEY=sk-or-... AUTH_VERIFY_URL=http://127.0.0.1:3000/session/verify \
//   node examples/proxy/server.js
//
// ibh talks to THIS server (llm: { baseUrl: 'http://127.0.0.1:4180/api/v1' });
// the browser never sees the OpenRouter key. Your existing session cookie
// authenticates the user (same-origin), and you keep spend + model control
// server-side.
//
// SECURITY MODEL:
// - Binds to loopback by default; setting HOST to anything else additionally
//   requires authentication to be configured (fail-closed at startup).
// - verifyRequest() delegates to AUTH_VERIFY_URL (your app's session-verify
//   endpoint, receives the caller's Cookie header) — the ONE thing you may
//   want to replace with an inline session check.
// - ALLOW_NO_AUTH=1 explicitly opts out of authentication (local dev only).
const http = require('node:http');

const PORT = Number(process.env.PORT || 4180);
const HOST = process.env.HOST || '127.0.0.1';
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
if (!OPENROUTER_KEY) {
  console.error('Set OPENROUTER_KEY in the environment.');
  process.exit(1);
}
const AUTH_VERIFY_URL = process.env.AUTH_VERIFY_URL || '';
const ALLOW_NO_AUTH = process.env.ALLOW_NO_AUTH === '1';
const IS_LOOPBACK_HOST = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
if (!IS_LOOPBACK_HOST && !AUTH_VERIFY_URL && !ALLOW_NO_AUTH) {
  console.error(
    'Refusing to expose the proxy beyond loopback without authentication: ' +
      'set AUTH_VERIFY_URL (your session-verify endpoint) or ALLOW_NO_AUTH=1 (local dev only).'
  );
  process.exit(1);
}

/** Comma-separated allowlist, e.g. "openai/gpt-6-luna,anthropic/claude-haiku-5.5".
 *  Empty = allow everything your manifest declares (client-side); you SHOULD
 *  still set this — the client-side manifest is advisory, this is the gate. */
const ALLOWED_MODELS = new Set(
  (process.env.ALLOWED_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

/** Optional comma-separated origin allowlist (e.g. "https://gametorch.app") for
 *  cross-origin browser access to the proxy. Same-origin setups need nothing. */
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const FORWARDED_PATHS = new Set(['/api/v1/chat/completions', '/api/v1/audio/transcriptions']);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Session check. Runs BEFORE any forwarding; returning false rejects with 403.
 * With AUTH_VERIFY_URL set, the caller's Cookie header is forwarded to your
 * app's session-verify endpoint (2xx = ok). Without it, only same-origin
 * requests from a loopback bind are accepted (local dev convenience).
 */
async function verifyRequest(req) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.size > 0 && !ALLOWED_ORIGINS.has(origin)) return false;

  if (AUTH_VERIFY_URL) {
    const cookie = req.headers.cookie || '';
    if (!cookie) return false;
    try {
      const res = await fetch(AUTH_VERIFY_URL, { headers: { cookie } });
      return res.ok;
    } catch {
      return false;
    }
  }
  if (ALLOW_NO_AUTH) return true;
  if (!origin) return true; // server-side callers / direct local clients
  return origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
}

// Naive per-IP token bucket: 60 requests, refilled 1/s. Replace with whatever
// your stack already has (nginx limit_req, gateway policies, etc).
const buckets = new Map();
function rateOk(ip) {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: 60, ts: now };
  b.tokens = Math.min(60, b.tokens + ((now - b.ts) / 1000) * 1);
  b.ts = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

http
  .createServer(async (req, res) => {
    try {
      const path = (req.url || '').split('?')[0];
      if (!FORWARDED_PATHS.has(path)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      if (!(await verifyRequest(req))) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'forbidden' } }));
        return;
      }
      if (!rateOk(req.socket.remoteAddress || '?')) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limited' } }));
        return;
      }

      const body = await readBody(req);
      if (ALLOWED_MODELS.size > 0) {
        try {
          const parsed = JSON.parse(body.toString('utf8') || '{}');
          if (parsed.model && !ALLOWED_MODELS.has(parsed.model)) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `model "${parsed.model}" is not allowed` } }));
            return;
          }
        } catch {
          /* non-JSON body: let OpenRouter produce the error */
        }
      }

      const upstream = await fetch(`https://openrouter.ai${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          'Content-Type': req.headers['content-type'] ?? 'application/json',
          'X-Title': 'ibh-proxy',
        },
        body,
      });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      // stream the upstream body (bounded memory) instead of buffering it
      const { Readable } = require('node:stream');
      const upstreamStream = Readable.fromWeb(upstream.body);
      upstreamStream.on('error', () => res.destroy());
      upstreamStream.pipe(res);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } }));
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`ibh LLM proxy: http://${HOST}:${PORT}  (paths: ${[...FORWARDED_PATHS].join(', ')})`);
    if (!AUTH_VERIFY_URL) {
      console.log('NOTE: no AUTH_VERIFY_URL configured — session verification is disabled (loopback only).');
    }
  });
